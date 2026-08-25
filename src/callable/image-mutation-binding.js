import {randomUUID} from 'node:crypto';
import {canonicalizeValue, isReference, objectRef, pinnedRef, textValue} from '../value/index.js';
import {isTransientObjectId} from '../value/transient-ref.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {objectResource} from '../authority/object-resource.js';
import {objectVersionToken, parseObjectVersionToken} from '../object/version-token.js';
import {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  normalizeObjectRef,
  resolveCallableInterface,
} from './binding-artifacts.js';
import {CALLABLE_TYPES, assertImages, hostLeafToCanonical} from './interface-artifacts.js';
import {assertCallableInterfaceArguments} from './interface-v2-artifacts.js';
import {unpackCompositeValue} from './composite-codec.js';
import {resolveDeclaredType} from './type-grammar.js';

// A fourth implementation lane: mutating an image object, per ADR 0042. Symmetric with the
// projection lane — an ordinary callable Block, nothing beyond `require` in the executor
// context, and no privileged write API for foreign code.
const IMAGE_MUTATION_BINDING_V1 = 'image-mutation-binding/v1';
const OBJECT_WRITE_OPERATION = 'object/write';
// ADR 0065 §2: adding a ref element to an existing object's indexed part is edge creation, honored
// per ADR 0042 §7 with the same per-target grant creation uses (ADR 0062 §4) — never plain object/write.
const OBJECT_EDGE_WRITE_OPERATION = 'object/edge-write';
const PIN_PREFIX = 'pin:';

// The backend's conflict error carries collection, key, expectedVersion and actualVersion, and
// puts both numbers in its message. Propagating it — even as a `cause`, which would leave
// actualVersion reachable — would defeat the opaque token outright. The lane translates instead:
// a conflict says only that the caller's assumption was stale.
class ObjectMutationConflictError extends Error {
  constructor(imageId, objectId) {
    super(`object mutation conflict: the supplied version token is stale for ${imageId}/${objectId}`);
    this.name = 'ObjectMutationConflictError';
    this.imageId = imageId;
    this.objectId = objectId;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

// ADR 0065: a field marked `indexed: true` is the indexed-part field. It names no slot; its value
// is a ref-free `list` replacing the indexed part under the version-token CAS. `edge` on it marks a
// ref-list (each added string element is a ref target, authorized per-target). At most one indexed
// field per binding; it is mutually exclusive with naming a slot. A plain `{name, slot}` field is a
// leaf slot write exactly as ADR 0042.
function normalizeMutationFields(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} fields must be a non-empty array`);
  }
  const names = new Set();
  const slots = new Set();
  let indexedField = null;
  const normalized = values.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`${label} field ${index} must be an object`);
    }
    const keys = Object.keys(entry).sort();
    const allowed = ['edge', 'indexed', 'name', 'slot'];
    if (!keys.includes('name') || keys.some((key) => !allowed.includes(key))) {
      throw new TypeError(`${label} field ${index} must contain name, optionally slot, and optionally edge/indexed`);
    }
    const name = requiredText(entry.name, `${label} field ${index} name`);
    const edge = entry.edge === undefined ? false : entry.edge === true;
    const indexed = entry.indexed === undefined ? false : entry.indexed === true;
    if (typeof edge !== 'boolean') throw new TypeError(`${label} field ${index} edge must be a boolean when present`);
    if (typeof indexed !== 'boolean') throw new TypeError(`${label} field ${index} indexed must be a boolean when present`);
    if (names.has(name)) throw new TypeError(`${label} maps field ${name} twice`);
    names.add(name);

    if (indexed) {
      if (Object.hasOwn(entry, 'slot')) throw new TypeError(`${label} indexed field ${name} must not name a slot`);
      if (indexedField) throw new TypeError(`${label} declares a second indexed field ${name}; at most one is allowed`);
      indexedField = name;
      return Object.freeze({name, indexed: true, edge});
    }

    // A leaf slot field. Stable slot IDs, not slot names: a rename must not change what a mutation writes.
    if (edge) throw new TypeError(`${label} slot field ${name} must not be an edge field; v1 slot writes are leaf-only (ADR 0042 §7)`);
    if (!keys.includes('slot')) throw new TypeError(`${label} field ${index} (${name}) must name a slot unless it is the indexed field`);
    const slot = requiredText(entry.slot, `${label} field ${index} slot`);
    if (slots.has(slot)) throw new TypeError(`${label} maps slot ${slot} twice`);
    slots.add(slot);
    return Object.freeze({name, slot});
  });
  return Object.freeze(normalized);
}

function parseImageMutationBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== IMAGE_MUTATION_BINDING_V1) {
    throw new TypeError(`artifact must be ${IMAGE_MUTATION_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('image mutation binding content must be a text Value');
  assertBindingDependencies(artifact, [CALLABLE_INTERFACE_DEPENDENCY_ROLE], IMAGE_MUTATION_BINDING_V1);
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('image mutation binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi', 'fields'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${IMAGE_MUTATION_BINDING_V1} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== IMAGE_MUTATION_BINDING_V1) {
    throw new TypeError(`unsupported image mutation binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({fields: normalizeMutationFields(decoded.fields, IMAGE_MUTATION_BINDING_V1)});
}

// write-item(object-id: string, version-token: string, value: <record>) -> string
// `fields` is the binding's field mapping, so the indexed field's list type can be carved out of the
// leaf-type rule precisely: only the field the binding marks `indexed` may be a non-leaf list.
function assertMutationInterface(descriptor, fields = []) {
  const {parameters, result, types = {}} = descriptor;
  if (parameters.length !== 3 || parameters[0] !== 'string' || parameters[1] !== 'string') {
    throw new TypeError(
      `${IMAGE_MUTATION_BINDING_V1} requires parameters (object-id: string, version-token: string, value: record)`,
    );
  }
  if (result !== 'string') {
    throw new TypeError(`${IMAGE_MUTATION_BINDING_V1} must return the next version token as string`);
  }
  const record = resolveDeclaredType(parameters[2], types);
  if (!record || record.kind !== 'record') {
    throw new TypeError(`${IMAGE_MUTATION_BINDING_V1} value parameter must be a declared record type`);
  }
  const indexedFields = new Map(fields.filter((f) => f.indexed).map((f) => [f.name, f.edge]));
  for (const field of record.fields) {
    if (indexedFields.has(field.name)) {
      assertIndexedFieldType(field, types, `${IMAGE_MUTATION_BINDING_V1} indexed field ${field.name}`, indexedFields.get(field.name));
      continue;
    }
    if (!CALLABLE_TYPES.includes(field.type)) {
      throw new TypeError(
        `${IMAGE_MUTATION_BINDING_V1} field ${field.name} must be a leaf type; v1 does not write nested values`,
      );
    }
  }
  return record;
}

// ADR 0065 §1: the indexed field is a ref-free `list` whose elements are leaf scalars or (for an
// `edge` list) ref-target strings — never a nested composite (ADR 0035). An `edge` list's element
// must be `string`, since ref targets travel as strings (ADR 0042 §7).
function assertIndexedFieldType(field, types, label, edge) {
  const resolved = resolveDeclaredType(field.type, types);
  if (!resolved || resolved.kind !== 'list') {
    throw new TypeError(`${label} must be a {kind:'list', element:<leaf>} type`);
  }
  const element = resolveDeclaredType(resolved.element, types);
  if (typeof element !== 'string' || !CALLABLE_TYPES.includes(element) || element === 'list<u8>') {
    throw new TypeError(`${label} element must be a leaf scalar (bool/s32/s64/f32/f64/string); nested composites are not writable`);
  }
  if (edge && element !== 'string') {
    throw new TypeError(`${label} is an edge (ref) list, so its element type must be string, got ${element}`);
  }
}

function assertFieldMappingCovers(record, fields, label) {
  const mapped = new Map(fields.map((f) => [f.name, f.indexed ? {indexed: true, edge: f.edge} : {slot: f.slot}]));
  for (const field of record.fields) {
    if (!mapped.has(field.name)) throw new TypeError(`${label} does not map record field ${field.name}`);
  }
  for (const name of mapped.keys()) {
    if (!record.fields.some((field) => field.name === name)) {
      throw new TypeError(`${label} maps ${name}, which the interface record does not declare`);
    }
  }
  return mapped;
}

async function installImageMutationBinding({
  images,
  callableInterface,
  fields,
  imageId = null,
  bindingId = randomUUID(),
  blockId = randomUUID(),
  bindingMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const interfaceRef = normalizeObjectRef(callableInterface, 'image mutation binding interface');
  const interfaceArtifact = await imageService.getCodeArtifact(interfaceRef.imageId, interfaceRef.objectId);
  if (!interfaceArtifact) {
    throw new TypeError(`callable interface not found: ${interfaceRef.imageId}/${interfaceRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;
  const normalizedFields = normalizeMutationFields(fields, IMAGE_MUTATION_BINDING_V1);

  const {descriptor} = await resolveCallableInterface(
    imageService,
    {dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}]},
    IMAGE_MUTATION_BINDING_V1,
  );
  assertFieldMappingCovers(assertMutationInterface(descriptor, normalizedFields), normalizedFields, IMAGE_MUTATION_BINDING_V1);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_MUTATION_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_MUTATION_BINDING_V1,
      fields: normalizedFields.map((f) => (f.indexed ? {name: f.name, indexed: true, edge: f.edge} : {name: f.name, slot: f.slot})),
    })),
    dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}],
    metadata: bindingMetadata,
  });
  const block = await imageService.putBlock(targetImageId, {
    id: blockId,
    code: objectRef(targetImageId, bindingArtifact.id),
    environment: null,
    metadata: blockMetadata,
  });
  return Object.freeze({bindingArtifact, block, interfaceRef});
}

// Parse an added ref element's string into a canonical ref/pinned-ref, refusing a transient target
// before any grant check or write (the write-seam guard is the backstop). Same seam as creation.
function parseEdgeTarget(imageId, text, label) {
  if (text.startsWith(PIN_PREFIX)) {
    const rest = text.slice(PIN_PREFIX.length);
    const at = rest.lastIndexOf('@');
    if (at <= 0 || at === rest.length - 1) {
      throw new TypeError(`${label} must be pin:<object-id>@<revision>, got ${text}`);
    }
    const objectId = rest.slice(0, at);
    const revision = rest.slice(at + 1);
    if (isTransientObjectId(objectId)) {
      throw new TypeError(`${label} target ${objectId} is transient; only durable objects can be edge targets`);
    }
    return pinnedRef(imageId, objectId, revision);
  }
  if (isTransientObjectId(text)) {
    throw new TypeError(`${label} target ${text} is transient; only durable objects can be edge targets`);
  }
  return objectRef(imageId, text);
}

// ADR 0065 §3 element identity: canonical-Value identity. Two refs are the same element iff they
// share (imageId, objectId); two pinned-refs iff they also share revision; a ref never equals a
// pinned-ref; two leaves iff canonically equal. This is what makes the no-removal and reorder rules
// sound (a ref->pin swap is a removal + addition, not a no-op re-pin).
function sameElement(left, right) {
  const a = canonicalizeValue(left);
  const b = canonicalizeValue(right);
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ref') return a.imageId === b.imageId && a.objectId === b.objectId;
  if (a.kind === 'pinned-ref') {
    return a.imageId === b.imageId && a.objectId === b.objectId && a.revision === b.revision;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// Count how many elements of `list` match `element` under sameElement (multiset membership). An
// explicit loop, because this counter is the no-removal invariant's enforcement: a miscount is not a
// list bug but an authority-semantics bug (a caller could drop an edge without the removal authority).
function countOf(list, element) {
  let count = 0;
  for (const candidate of list) {
    if (sameElement(candidate, element)) count += 1;
  }
  return count;
}

// ADR 0065 §2–3. Validate and build the replacement indexed part. The new list may append leaf
// elements (object/write alone), append ref elements (each authorized per-target), and reorder —
// but must contain every element of the old part (multiset), so it can never remove an edge. Added
// refs are canonicalized with the per-target grant firing at that point.
function buildNewIndexedPart(imageId, oldIndexed, listValue, field, edge, types, require) {
  if (!Array.isArray(listValue)) {
    throw new TypeError(`indexed field ${field.name} must be a list, got ${typeof listValue}`);
  }
  const elementType = resolveDeclaredType(field.type, types).element;
  // Canonicalize the new list: leaves host-side, added ref targets parsed (transient refused here).
  const newElements = listValue.map((element, index) => {
    const label = `indexed field ${field.name}[${index}]`;
    if (!edge) return hostLeafToCanonical(element, elementType, label);
    return {added: parseEdgeTarget(imageId, element, label)};
  });

  if (edge) {
    // For each old element, it must still be present in the new list (by identity); if so, the new
    // list reuses the OLD canonical element (preserving its exact form). Anything in the new list
    // not matched to an old element is an ADDED ref and needs the per-target grant.
    const oldList = oldIndexed ?? [];
    const result = [];
    const usedOld = new Array(oldList.length).fill(false);
    for (const {added} of newElements) {
      const matchIndex = oldList.findIndex((oldEl, i) => !usedOld[i] && sameElement(oldEl, added));
      if (matchIndex >= 0) {
        usedOld[matchIndex] = true;
        result.push(canonicalizeValue(oldList[matchIndex]));
      } else {
        // An added edge: authorize the parsed target before committing it.
        require({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, added.objectId)});
        result.push(added);
      }
    }
    // No-removal: every old element must have been matched.
    if (usedOld.some((used) => !used)) {
      const missing = oldList.filter((_, i) => !usedOld[i]).map((el) => canonicalizeValue(el).objectId ?? '?');
      throw new TypeError(
        `${IMAGE_MUTATION_BINDING_V1} cannot remove indexed element(s) ${missing.join(', ')}: element removal is edge removal, deferred (ADR 0065 §3)`,
      );
    }
    return result;
  }

  // A leaf list: no edges anywhere, so any list is allowed — but no-removal still holds, so the new
  // list must contain every old element (by canonical identity).
  const oldList = oldIndexed ?? [];
  for (const oldEl of oldList) {
    if (countOf(newElements, oldEl) < countOf(oldList, oldEl)) {
      throw new TypeError(
        `${IMAGE_MUTATION_BINDING_V1} cannot remove an indexed element: element removal is edge removal, deferred (ADR 0065 §3)`,
      );
    }
  }
  return newElements;
}

function createImageMutationBindingV1Executor() {
  return Object.freeze({
    async execute({activation, code}, {images, require}) {
      if (!code || code.representation !== IMAGE_MUTATION_BINDING_V1) {
        throw new TypeError(`image mutation executor requires ${IMAGE_MUTATION_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, IMAGE_MUTATION_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${IMAGE_MUTATION_BINDING_V1} does not accept a lexical environment`);
      }
      const binding = parseImageMutationBindingArtifact(code);
      const {descriptor} = await resolveCallableInterface(images, code, IMAGE_MUTATION_BINDING_V1);
      const record = assertMutationInterface(descriptor, binding.fields);
      const mapped = assertFieldMappingCovers(record, binding.fields, IMAGE_MUTATION_BINDING_V1);

      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const objectId = args[0].value;
      const token = args[1].value;
      // The image comes from the binding, never the caller.
      const imageId = code.imageId;

      // Authority first: a caller without object/write learns nothing, not even whether the
      // object exists. object/write alone suffices — the read below is read-for-write and is
      // not an exposure of state to the caller.
      require({operation: OBJECT_WRITE_OPERATION, resource: objectResource(imageId, objectId)});

      // Then the token, still before any fetch. A token issued for another object fails here
      // rather than silently matching a coincidentally equal version.
      const expectedVersion = parseObjectVersionToken(token, imageId, objectId);

      const value = unpackCompositeValue(
        args[2], descriptor.parameters[2], descriptor.types ?? {}, `${descriptor.function} value`,
      );

      const object = await images.getObject(imageId, objectId);
      if (!object) throw new TypeError(`object not found: ${imageId}/${objectId}`);

      // Unmapped slots are preserved rather than cleared.
      const slots = {...(object.slots ?? {})};
      // ADR 0065: when the binding has an indexed field, the indexed part is replaced by the field's
      // list (append/reorder, never shrink); otherwise it is preserved verbatim as before.
      let indexed = Object.hasOwn(object, 'indexed') ? object.indexed : undefined;
      for (const field of record.fields) {
        const mapping = mapped.get(field.name);
        if (mapping.indexed) {
          if (!Object.hasOwn(object, 'indexed')) {
            throw new TypeError(
              `${IMAGE_MUTATION_BINDING_V1} supplies indexed field ${field.name}, but ${imageId}/${objectId} has no indexed part`,
            );
          }
          indexed = buildNewIndexedPart(imageId, object.indexed, value[field.name], field, mapping.edge, descriptor.types ?? {}, require);
          continue;
        }
        const slot = mapping.slot;
        if (Object.hasOwn(slots, slot)) {
          const current = canonicalizeValue(slots[slot]);
          // Rejected, never followed or overwritten through: authority for this object must not
          // imply authority for whatever it points at.
          if (isReference(current)) {
            throw new TypeError(
              `slot ${slot} holds a reference; ${IMAGE_MUTATION_BINDING_V1} never writes through refs`,
            );
          }
        }
        slots[slot] = hostLeafToCanonical(value[field.name], field.type, `mutated field ${field.name}`);
      }

      let stored;
      try {
        stored = await images.putObject(imageId, {
          id: objectId,
          shape: object.shape,
          behavior: object.behavior,
          slots,
          // The indexed part is part of the same object record: preserved verbatim when untouched,
          // or the new append/reorder value when the binding has an indexed field (ADR 0065).
          ...(indexed === undefined ? {} : {indexed}),
          metadata: object.metadata,
        }, {expectedVersion});
      } catch (error) {
        if (error?.name === 'VersionConflictError') {
          // Deliberately no cause: attaching it would leave actualVersion reachable.
          throw new ObjectMutationConflictError(imageId, objectId);
        }
        throw error;
      }

      return textValue(objectVersionToken(imageId, objectId, stored._version));
    },
  });
}

export {
  IMAGE_MUTATION_BINDING_V1,
  OBJECT_WRITE_OPERATION,
  ObjectMutationConflictError,
  createImageMutationBindingV1Executor,
  installImageMutationBinding,
  parseImageMutationBindingArtifact,
};
