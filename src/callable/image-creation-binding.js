import {randomUUID} from 'node:crypto';
import {isTransientObjectId} from '../value/transient-ref.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {objectRef, pinnedRef, textValue} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {objectResource} from '../authority/object-resource.js';
import {objectVersionToken} from '../object/version-token.js';
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

// A fifth implementation lane: creating an image object, per ADR 0062. Symmetric with the
// projection/mutation lanes — an ordinary callable Block, nothing beyond `require` in the executor
// context, and no privileged write API for foreign code.
//
// The grant is per (image, class): `object/create` on `objectResource(imageId, classId)`. The lane
// derives `shape = class.instanceShape` and `behavior = class` exactly as `basicNew` does (ADR 0046),
// nil-fills the complete layout, mints the id itself, and commits insert-only in one transaction.
// Initial ref slots are authorized separately, per target, by `object/edge-write`.
const IMAGE_CREATION_BINDING_V1 = 'image-creation-binding/v1';
const OBJECT_CREATE_OPERATION = 'object/create';
const OBJECT_EDGE_WRITE_OPERATION = 'object/edge-write';

// The callable layer must not import `src/language` (it would close a dependency cycle through
// `src/execution` — see the composition-root note in runtime.js). These are the kernel's fixed,
// well-known ids, duplicated here with that constraint named. They are stable by ADR 0044 decision
// 1 (a Behavior's Shape never changes); if the kernel ever reissues them, this lane must move.
const BEHAVIOR_SHAPE_ID = 'smalltalk/behavior-shape/v1';
const BEHAVIOR_INSTANCE_SHAPE_SLOT = 'behavior-instance-shape';
const KERNEL_NIL_ID = 'smalltalk/nil';

// The string form of an edge field's value: either a plain object id (a plain ref) or
// `pin:<objectId>@<revision>` (a pinned ref). The callable type language has no ref type (ADR 0042
// §7), so a ref target can only arrive as text; the lane parses and canonicalizes it host-side.
const PIN_PREFIX = 'pin:';

class ObjectCreationConflictError extends Error {
  // The mutation lane translates VersionConflictError so the backend's actualVersion stays
  // unreachable. Here embedding the class/image id is safe: the caller already supplied the class id,
  // so nothing new leaks. The terminal id-exhaustion path reports only the attempt count.
  constructor(imageId, detail) {
    super(`object creation conflict in ${imageId}: ${detail}`);
    this.name = 'ObjectCreationConflictError';
    this.imageId = imageId;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

// Field mapping, mirroring the mutation lane's, plus two optional flags. `edge: true` marks a slot
// field whose string value is a ref *target id*: the lane canonicalizes it to a ref/pinned-ref and
// requires a separate per-target `object/edge-write` grant. A non-edge field stores its string as
// text and can never mint a graph edge — the composite codec already refuses embedded refs.
//
// ADR 0064: a field marked `indexed: true` is the indexed-part field. It names no slot; its value
// is a `list<leaf-or-ref-string>` whose elements populate the ordered indexed part. At most one
// field may be the indexed field, it cannot also be a slot field, and it is mutually exclusive with
// `edge` on the same field (edge-ness is per-element, decided when each string is parsed).
function normalizeCreationFields(values, label) {
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
      // The indexed field names no slot. `edge` on it marks a ref-list: every (string) element is a
      // ref target authorized per-element. Without `edge` it is a leaf-list. There is exactly one.
      if (Object.hasOwn(entry, 'slot')) throw new TypeError(`${label} indexed field ${name} must not name a slot`);
      if (indexedField) throw new TypeError(`${label} declares a second indexed field ${name}; at most one is allowed`);
      indexedField = name;
      return Object.freeze({name, indexed: true, edge});
    }

    // A slot field: stable slot IDs, not slot names — a rename must not change what a creation writes.
    if (!keys.includes('slot')) throw new TypeError(`${label} field ${index} (${name}) must name a slot unless it is the indexed field`);
    const slot = requiredText(entry.slot, `${label} field ${index} slot`);
    if (slots.has(slot)) throw new TypeError(`${label} maps slot ${slot} twice`);
    slots.add(slot);
    return Object.freeze({name, slot, edge});
  });
  return Object.freeze(normalized);
}

function parseImageCreationBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== IMAGE_CREATION_BINDING_V1) {
    throw new TypeError(`artifact must be ${IMAGE_CREATION_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('image creation binding content must be a text Value');
  assertBindingDependencies(artifact, [CALLABLE_INTERFACE_DEPENDENCY_ROLE], IMAGE_CREATION_BINDING_V1);
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('image creation binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi', 'fields'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${IMAGE_CREATION_BINDING_V1} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== IMAGE_CREATION_BINDING_V1) {
    throw new TypeError(`unsupported image creation binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({fields: normalizeCreationFields(decoded.fields, IMAGE_CREATION_BINDING_V1)});
}

// create-item(class-id: string, value: <record>) -> string (the initial object-scoped version token)
// `fields` is the binding's field mapping, so the indexed field's list type can be carved out of the
// leaf-type rule precisely: only the field the binding marks `indexed` may be a non-leaf list.
function assertCreationInterface(descriptor, fields = []) {
  const {parameters, result, types = {}} = descriptor;
  if (parameters.length !== 2 || parameters[0] !== 'string') {
    throw new TypeError(
      `${IMAGE_CREATION_BINDING_V1} requires parameters (class-id: string, value: record)`,
    );
  }
  if (result !== 'string') {
    throw new TypeError(`${IMAGE_CREATION_BINDING_V1} must return the initial version token as string`);
  }
  const record = resolveDeclaredType(parameters[1], types);
  if (!record || record.kind !== 'record') {
    throw new TypeError(`${IMAGE_CREATION_BINDING_V1} value parameter must be a declared record type`);
  }
  const indexedFields = new Map(fields.filter((f) => f.indexed).map((f) => [f.name, f.edge]));
  for (const field of record.fields) {
    if (indexedFields.has(field.name)) {
      assertIndexedFieldType(field, types, `${IMAGE_CREATION_BINDING_V1} indexed field ${field.name}`, indexedFields.get(field.name));
      continue;
    }
    // Ref targets travel as strings; every other field must be a leaf type (no nested writes in v1).
    if (!CALLABLE_TYPES.includes(field.type)) {
      throw new TypeError(
        `${IMAGE_CREATION_BINDING_V1} field ${field.name} must be a leaf type; v1 does not write nested values`,
      );
    }
  }
  return record;
}

// ADR 0064 §1: the indexed field is a `list` whose elements are leaf scalars or ref-target strings —
// never a nested record/list (that would violate ADR 0035's Value model). `list<u8>` is bytes, not
// an element list, so it is refused here for the same reason it is not a slot. An `edge` indexed
// field is a ref-list: its elements are ref-target strings, so its element type must be `string`.
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
  const mapped = new Map(fields.map((f) => [f.name, f.indexed ? {indexed: true, edge: f.edge} : {slot: f.slot, edge: f.edge}]));
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

async function installImageCreationBinding({
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
  const interfaceRef = normalizeObjectRef(callableInterface, 'image creation binding interface');
  const interfaceArtifact = await imageService.getCodeArtifact(interfaceRef.imageId, interfaceRef.objectId);
  if (!interfaceArtifact) {
    throw new TypeError(`callable interface not found: ${interfaceRef.imageId}/${interfaceRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;
  const normalizedFields = normalizeCreationFields(fields, IMAGE_CREATION_BINDING_V1);

  const {descriptor} = await resolveCallableInterface(
    imageService,
    {dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}]},
    IMAGE_CREATION_BINDING_V1,
  );
  assertFieldMappingCovers(assertCreationInterface(descriptor, normalizedFields), normalizedFields, IMAGE_CREATION_BINDING_V1);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_CREATION_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_CREATION_BINDING_V1,
      fields: normalizedFields.map((f) => (f.indexed ? {name: f.name, indexed: true, edge: f.edge} : {name: f.name, slot: f.slot, edge: f.edge})),
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

// Parse an edge field's string into a canonical ref or pinned-ref in `imageId`, enforcing that the
// target is durable (never a reserved transient id) before any grant check or write.
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
      throw new ObjectCreationConflictError(imageId, `edge target ${objectId} is transient; only durable objects can be edge targets`);
    }
    return pinnedRef(imageId, objectId, revision);
  }
  if (isTransientObjectId(text)) {
    throw new ObjectCreationConflictError(imageId, `edge target ${text} is transient; only durable objects can be edge targets`);
  }
  return objectRef(imageId, text);
}

// ADR 0064 §2–3. Build the ordered indexed part from the field's list value. Each element is either
// a leaf scalar (canonicalized host-side, no edge) or — when the binding marks the field `edge` — a
// ref-target string canonicalized with a separate per-target `object/edge-write` grant. The grant
// fires at exactly the canonicalize step, so no edge is created without it, and a transient-looking
// element is refused before any write (parseEdgeTarget), with the write-seam guard as backstop.
function buildIndexedPart(imageId, listValue, field, edge, types, require) {
  if (!Array.isArray(listValue)) {
    throw new TypeError(`indexed field ${field.name} must be a list, got ${typeof listValue}`);
  }
  const elementType = resolveDeclaredType(field.type, types).element;
  return listValue.map((element, index) => {
    const label = `indexed field ${field.name}[${index}]`;
    if (edge) {
      const parsed = parseEdgeTarget(imageId, element, label);
      require({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, parsed.objectId)});
      return parsed;
    }
    return hostLeafToCanonical(element, elementType, label);
  });
}

// A Behavior is a record in THIS image whose Shape is THIS image's fixed behavior Shape, and whose
// instanceShape slot is a local unpinned ref (or nil). This is `isBehaviorObject` plus the
// instanceShape half of `readBehavior` — deliberately narrower than `readBehavior`, which also
// checks name/superclass/methods. Creation never reads those, so a Behavior with a foreign methods
// edge is usable here even though `readBehavior` would refuse it; that is intentional, not a gap.
function assertBehaviorRecord(record, imageId, classId) {
  const shapeRef = record.shape;
  const isLocalBehaviorShape = shapeRef
    && shapeRef.kind === 'ref'
    && shapeRef.imageId === imageId
    && shapeRef.objectId === BEHAVIOR_SHAPE_ID;
  if (!isLocalBehaviorShape) {
    throw new TypeError(`object ${imageId}/${classId} is not a Behavior in ${imageId}`);
  }
  const instanceShapeRef = record.slots?.[BEHAVIOR_INSTANCE_SHAPE_SLOT];
  if (instanceShapeRef === undefined || instanceShapeRef.kind !== 'ref' || instanceShapeRef.imageId !== imageId) {
    throw new TypeError(`Behavior ${imageId}/${classId} has no local instanceShape`);
  }
  return instanceShapeRef;
}

function createImageCreationBindingV1Executor({newObjectId = randomUUID, maxIdentityAttempts = 8} = {}) {
  return Object.freeze({
    async execute({activation, code}, {images, require}) {
      if (!code || code.representation !== IMAGE_CREATION_BINDING_V1) {
        throw new TypeError(`image creation executor requires ${IMAGE_CREATION_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, IMAGE_CREATION_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${IMAGE_CREATION_BINDING_V1} does not accept a lexical environment`);
      }
      const binding = parseImageCreationBindingArtifact(code);
      const {descriptor} = await resolveCallableInterface(images, code, IMAGE_CREATION_BINDING_V1);
      const record = assertCreationInterface(descriptor, binding.fields);
      const mapped = assertFieldMappingCovers(record, binding.fields, IMAGE_CREATION_BINDING_V1);

      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const classId = args[0].value;
      // The image comes from the binding, never the caller.
      const imageId = code.imageId;

      // Authority first: a caller without object/create learns nothing, not even whether the class
      // exists. This is the only grant needed to create with no edges.
      require({operation: OBJECT_CREATE_OPERATION, resource: objectResource(imageId, classId)});

      // Then the class read, within the granted scope: naming a wrong id is an existence oracle over
      // ids the caller already supplied, which ADR 0062 §3 accepts.
      const classRecord = await images.getObject(imageId, classId);
      if (!classRecord) throw new TypeError(`class not found: ${imageId}/${classId}`);
      const instanceShapeRef = assertBehaviorRecord(classRecord, imageId, classId);
      if (instanceShapeRef.objectId === KERNEL_NIL_ID) {
        throw new TypeError(`class ${imageId}/${classId} is not instantiable: instanceShape is nil`);
      }
      const shape = await images.getShape(instanceShapeRef.imageId, instanceShapeRef.objectId);
      if (!shape) throw new TypeError(`instance Shape not found: ${instanceShapeRef.imageId}/${instanceShapeRef.objectId}`);

      const value = unpackCompositeValue(
        args[1], descriptor.parameters[1], descriptor.types ?? {}, `${descriptor.function} value`,
      );

      // Build the complete layout: every Shape slot nil-filled (as basicNew), then the mapped
      // fields. A field for a slot the Shape does not declare is an extra slot and fails the shape
      // match below; a non-edge field stores text and can never mint an edge.
      const nil = objectRef(imageId, KERNEL_NIL_ID);
      const slots = Object.fromEntries((shape.slots ?? []).map(({id}) => [id, nil]));
      const shapeSlotIds = new Set((shape.slots ?? []).map(({id}) => id));
      // ADR 0064: the indexed part is built from the indexed field's list, not nil-filled. An indexed
      // class with no indexed field supplied begins at the zero-length form (basicNew parity).
      const isIndexed = shape.indexed === SHAPE_INDEXED.VALUES;
      let indexed = isIndexed ? [] : null;
      for (const field of record.fields) {
        if (!Object.hasOwn(value, field.name)) continue;
        const mapping = mapped.get(field.name);
        if (mapping.indexed) {
          // The indexed field routes to the indexed part. Refusing a non-indexed class here — before
          // any element is authorized or written — keeps the failure clean rather than a shape-match
          // surprise at commit (ADR 0064 §1).
          if (!isIndexed) {
            throw new TypeError(`${IMAGE_CREATION_BINDING_V1} supplies indexed field ${field.name}, but class ${imageId}/${classId} is not indexed`);
          }
          indexed = buildIndexedPart(imageId, value[field.name], field, mapping.edge, descriptor.types ?? {}, require);
          continue;
        }
        const {slot, edge} = mapping;
        if (!shapeSlotIds.has(slot)) {
          throw new TypeError(`${IMAGE_CREATION_BINDING_V1} maps field ${field.name} to slot ${slot}, which the instance Shape does not declare`);
        }
        if (edge) {
          // A separate per-target grant: create-on-class must not become broad reach (ADR 0042 §7).
          // Parse first, then authorize the canonical TARGET id — for a pinned spelling the raw
          // string is `pin:<id>@<revision>`, and the grant is scoped to the target, not the pin text.
          const parsed = parseEdgeTarget(imageId, value[field.name], `edge field ${field.name}`);
          require({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, parsed.objectId)});
          slots[slot] = parsed;
        } else {
          slots[slot] = hostLeafToCanonical(value[field.name], field.type, `field ${field.name}`);
        }
      }

      // The lane mints the candidate id and passes it explicitly — never putObject's default — so a
      // retry after a lost acknowledgement preserves the identity (ADR 0046 §6). Insert-only, and
      // state + history commit in one backend transaction (or neither) via putWithHistory.
      const behavior = objectRef(imageId, classId);
      for (let attempt = 0; attempt < maxIdentityAttempts; attempt += 1) {
        const candidate = newObjectId();
        if (typeof candidate !== 'string' || candidate.length === 0) {
          throw new TypeError('object identity generator must answer non-empty text');
        }
        try {
          const stored = await images.putObject(imageId, {
            id: candidate,
            shape: instanceShapeRef,
            behavior,
            slots,
            ...(indexed === null ? {} : {indexed}),
            metadata: {},
          }, {expectedVersion: 0});
          return textValue(objectVersionToken(imageId, stored.id, stored._version));
        } catch (error) {
          if (error?.name !== 'VersionConflictError') throw error;
        }
      }
      throw new ObjectCreationConflictError(
        imageId,
        `could not find a free object identity after ${maxIdentityAttempts} attempts`,
      );
    },
  });
}

export {
  IMAGE_CREATION_BINDING_V1,
  OBJECT_CREATE_OPERATION,
  OBJECT_EDGE_WRITE_OPERATION,
  ObjectCreationConflictError,
  createImageCreationBindingV1Executor,
  installImageCreationBinding,
  parseImageCreationBindingArtifact,
};
