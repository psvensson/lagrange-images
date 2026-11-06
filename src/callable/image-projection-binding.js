import {uuid as randomUUID} from '../support/default-crypto.js';
import {canonicalizeValue, isReference, objectRef, textValue} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  normalizeObjectRef,
  resolveCallableInterface,
} from './binding-artifacts.js';
import {CALLABLE_TYPES, assertImages, canonicalToHostLeaf} from './interface-artifacts.js';
import {assertCallableInterfaceArguments} from './interface-v2-artifacts.js';
import {packCompositeValue} from './composite-codec.js';
import {resolveDeclaredType} from './type-grammar.js';

// The image as a third implementation lane for a callable interface, per ADR 0039.
//
// A projection is an ordinary callable Block: a program sends to it, receives a ref-free
// composite, and may hand that composite to a Component or foreign-runtime Block as an
// ordinary argument. Foreign code never reaches back into the image, and nothing beyond
// `require` is added to the executor context.
const IMAGE_PROJECTION_BINDING_V1 = 'image-projection-binding/v1';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeProjectionFields(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} fields must be a non-empty array`);
  }
  const names = new Set();
  const slots = new Set();
  let indexedField = null;
  const fields = values.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`${label} field ${index} must be an object`);
    }
    const keys = Object.keys(entry).sort();
    const hasIndexedKey = Object.hasOwn(entry, 'indexed');
    if (!hasIndexedKey) {
      if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'slot') {
        throw new TypeError(`${label} field ${index} must contain exactly name, slot`);
      }
    } else if (!keys.includes('name') || keys.some((key) => key !== 'name' && key !== 'slot' && key !== 'indexed')) {
      throw new TypeError(`${label} field ${index} must contain name, and either slot or indexed`);
    }
    const name = requiredText(entry.name, `${label} field ${index} name`);
    if (hasIndexedKey && typeof entry.indexed !== 'boolean') {
      throw new TypeError(`${label} field ${index} indexed must be a boolean when present`);
    }
    const indexed = entry.indexed === true;
    if (names.has(name)) throw new TypeError(`${label} maps field ${name} twice`);
    names.add(name);
    if (indexed) {
      if (Object.hasOwn(entry, 'slot')) {
        throw new TypeError(`${label} indexed field ${name} must not name a slot`);
      }
      if (indexedField !== null) {
        throw new TypeError(`${label} declares a second indexed field ${name}; at most one is allowed`);
      }
      indexedField = name;
      return Object.freeze({name, indexed: true});
    }
    if (!Object.hasOwn(entry, 'slot')) {
      throw new TypeError(`${label} field ${index} must contain exactly name, slot`);
    }
    // Stable slot IDs, not slot names: a rename must not change what a projection reads.
    const slot = requiredText(entry.slot, `${label} field ${index} slot`);
    if (slots.has(slot)) throw new TypeError(`${label} maps slot ${slot} twice`);
    slots.add(slot);
    return Object.freeze({name, slot});
  });
  return Object.freeze(fields);
}

function parseImageProjectionBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== IMAGE_PROJECTION_BINDING_V1) {
    throw new TypeError(`artifact must be ${IMAGE_PROJECTION_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('image projection binding content must be a text Value');
  // The implementation is the image itself, so there is no implementation dependency to name.
  assertBindingDependencies(artifact, [CALLABLE_INTERFACE_DEPENDENCY_ROLE], IMAGE_PROJECTION_BINDING_V1);
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('image projection binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi', 'fields'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== IMAGE_PROJECTION_BINDING_V1) {
    throw new TypeError(`unsupported image projection binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({
    fields: normalizeProjectionFields(decoded.fields, IMAGE_PROJECTION_BINDING_V1),
  });
}

function assertProjectedIndexedFieldType(field, types, label) {
  const resolved = resolveDeclaredType(field.type, types);
  if (!resolved || resolved.kind !== 'list') {
    throw new TypeError(`${label} must be a {kind:'list', element:<leaf>} type`);
  }
  const element = resolveDeclaredType(resolved.element, types);
  if (typeof element !== 'string' || !CALLABLE_TYPES.includes(element) || element === 'list<u8>') {
    throw new TypeError(
      `${label} element must be a leaf scalar (bool/s32/s64/f32/f64/string); nested composites are not projected`,
    );
  }
}

// v1 is deliberately narrow: one object-id parameter in, one named record out, and every
// named-slot record field a type that corresponds directly to a canonical leaf Value. At most
// one field marked `indexed: true` in the binding may have a `list<leaf>` type to project the
// object's ordered indexed part (completing the ADR 0064/0065 triad); refs are never followed.
function assertProjectionInterface(descriptor, fields = []) {
  if (descriptor.parameters.length !== 1 || descriptor.parameters[0] !== 'string') {
    throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} requires exactly one string parameter naming the object id`);
  }
  if (typeof descriptor.result !== 'string') {
    throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} result must be a declared record type`);
  }
  const types = descriptor.types ?? {};
  const record = resolveDeclaredType(descriptor.result, types);
  if (!record || record.kind !== 'record') {
    throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} result must be a declared record type`);
  }
  const indexedFieldNames = new Set(fields.filter((f) => f.indexed === true).map((f) => f.name));
  for (const field of record.fields) {
    if (indexedFieldNames.has(field.name)) {
      assertProjectedIndexedFieldType(
        field,
        types,
        `${IMAGE_PROJECTION_BINDING_V1} indexed field ${field.name}`,
      );
      continue;
    }
    if (!CALLABLE_TYPES.includes(field.type)) {
      throw new TypeError(
        `${IMAGE_PROJECTION_BINDING_V1} field ${field.name} must be a leaf type; v1 does not project nested values`,
      );
    }
  }
  return record;
}

function assertFieldMappingCovers(record, fields, label) {
  const mapped = new Map(
    fields.map((entry) => [entry.name, entry.indexed === true ? Object.freeze({indexed: true}) : entry.slot]),
  );
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

// Shared by the projection executor and the resource provider, so the two cannot diverge on
// ref rejection, missing slots or leaf typing.
function projectObjectSlots({object, record, mapped, types = {}, imageId, objectId}) {
  const hasIndexedMapping = [...mapped.values()].some(
    (entry) => entry && typeof entry === 'object' && entry.indexed === true,
  );
  // Returning only named fields for an indexed object when the binding did not map the indexed part
  // would make a partial object look complete to foreign code, so named-slot-only projections still
  // refuse indexed objects.
  if (!hasIndexedMapping && Object.hasOwn(object, 'indexed')) {
    throw new TypeError(
      `${IMAGE_PROJECTION_BINDING_V1} cannot project indexed object ${imageId}/${objectId}; v1 maps named slots only`,
    );
  }
  const projected = {};
  for (const field of record.fields) {
    const mapping = mapped.get(field.name);
    if (mapping && typeof mapping === 'object' && mapping.indexed === true) {
      if (!Object.hasOwn(object, 'indexed') || !Array.isArray(object.indexed)) {
        throw new TypeError(
          `${IMAGE_PROJECTION_BINDING_V1} maps indexed field ${field.name}, but object ${imageId}/${objectId} is not indexed`,
        );
      }
      const resolvedList = resolveDeclaredType(field.type, types);
      const elementType = resolveDeclaredType(resolvedList.element, types);
      projected[field.name] = object.indexed.map((rawElement, index) => {
        const elementValue = canonicalizeValue(rawElement);
        if (isReference(elementValue)) {
          throw new TypeError(
            `indexed element ${index} holds a reference; ${IMAGE_PROJECTION_BINDING_V1} never follows refs`,
          );
        }
        return canonicalToHostLeaf(
          elementValue,
          elementType,
          `projected indexed field ${field.name}[${index}]`,
        );
      });
      continue;
    }
    const slot = mapping;
    if (!Object.hasOwn(object.slots ?? {}, slot)) {
      throw new TypeError(`projected object ${imageId}/${objectId} has no slot ${slot} for field ${field.name}`);
    }
    const slotValue = canonicalizeValue(object.slots[slot]);
    // Rejected, never followed: authority for this object must not imply authority for
    // whatever it points at, and there is no second require on a traversal path.
    if (isReference(slotValue)) {
      throw new TypeError(`slot ${slot} holds a reference; ${IMAGE_PROJECTION_BINDING_V1} never follows refs`);
    }
    projected[field.name] = canonicalToHostLeaf(slotValue, field.type, `projected field ${field.name}`);
  }
  return projected;
}

async function installImageProjectionBinding({
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
  const interfaceRef = normalizeObjectRef(callableInterface, 'image projection binding interface');
  const interfaceArtifact = await imageService.getCodeArtifact(interfaceRef.imageId, interfaceRef.objectId);
  if (!interfaceArtifact) {
    throw new TypeError(`callable interface not found: ${interfaceRef.imageId}/${interfaceRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;
  const normalizedFields = normalizeProjectionFields(fields, IMAGE_PROJECTION_BINDING_V1);

  // Validated at install so a malformed projection fails when it is written, not when it runs.
  const {descriptor} = await resolveCallableInterface(
    imageService,
    {dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}]},
    IMAGE_PROJECTION_BINDING_V1,
  );
  const record = assertProjectionInterface(descriptor, normalizedFields);
  assertFieldMappingCovers(record, normalizedFields, IMAGE_PROJECTION_BINDING_V1);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_PROJECTION_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_PROJECTION_BINDING_V1,
      fields: normalizedFields.map((entry) => (
        entry.indexed === true ? {name: entry.name, indexed: true} : {name: entry.name, slot: entry.slot}
      )),
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

function createImageProjectionBindingV1Executor() {
  return Object.freeze({
    async execute({activation, code}, {images, require}) {
      if (!code || code.representation !== IMAGE_PROJECTION_BINDING_V1) {
        throw new TypeError(`image projection executor requires ${IMAGE_PROJECTION_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, IMAGE_PROJECTION_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} does not accept a lexical environment`);
      }
      const binding = parseImageProjectionBindingArtifact(code);
      const {descriptor} = await resolveCallableInterface(images, code, IMAGE_PROJECTION_BINDING_V1);
      const record = assertProjectionInterface(descriptor, binding.fields);
      const mapped = assertFieldMappingCovers(record, binding.fields, IMAGE_PROJECTION_BINDING_V1);

      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const objectId = args[0].value;
      // The image comes from the binding, never from the caller, so a projection Block cannot
      // be pointed at another image by whoever invokes it.
      const imageId = code.imageId;

      // Whole-object authority, checked before a single slot is read. The field mapping is
      // projection policy and narrows nothing: object/read authorizes the object itself.
      require({operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, objectId)});

      const object = await images.getObject(imageId, objectId);
      if (!object) throw new TypeError(`projected object not found: ${imageId}/${objectId}`);

      const projected = projectObjectSlots({
        object,
        record,
        mapped,
        types: descriptor.types ?? {},
        imageId,
        objectId,
      });

      return packCompositeValue(
        projected, descriptor.result, descriptor.types ?? {}, `${descriptor.function} result`,
      );
    },
  });
}

export {
  IMAGE_PROJECTION_BINDING_V1,
  assertFieldMappingCovers,
  assertProjectedIndexedFieldType,
  assertProjectionInterface,
  normalizeProjectionFields,
  projectObjectSlots,
  createImageProjectionBindingV1Executor,
  installImageProjectionBinding,
  parseImageProjectionBindingArtifact,
};
