import {randomUUID} from 'node:crypto';
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
  const fields = values.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`${label} field ${index} must be an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'slot') {
      throw new TypeError(`${label} field ${index} must contain exactly name, slot`);
    }
    const name = requiredText(entry.name, `${label} field ${index} name`);
    // Stable slot IDs, not slot names: a rename must not change what a projection reads.
    const slot = requiredText(entry.slot, `${label} field ${index} slot`);
    if (names.has(name)) throw new TypeError(`${label} maps field ${name} twice`);
    if (slots.has(slot)) throw new TypeError(`${label} maps slot ${slot} twice`);
    names.add(name);
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

// v1 is deliberately narrow: one object-id parameter in, one named record out, and every
// record field a type that corresponds directly to a canonical leaf Value. No nesting, and
// therefore no way for a projection to reach a second object.
function assertProjectionInterface(descriptor) {
  if (descriptor.parameters.length !== 1 || descriptor.parameters[0] !== 'string') {
    throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} requires exactly one string parameter naming the object id`);
  }
  if (typeof descriptor.result !== 'string') {
    throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} result must be a declared record type`);
  }
  const record = resolveDeclaredType(descriptor.result, descriptor.types ?? {});
  if (!record || record.kind !== 'record') {
    throw new TypeError(`${IMAGE_PROJECTION_BINDING_V1} result must be a declared record type`);
  }
  for (const field of record.fields) {
    if (!CALLABLE_TYPES.includes(field.type)) {
      throw new TypeError(
        `${IMAGE_PROJECTION_BINDING_V1} field ${field.name} must be a leaf type; v1 does not project nested values`,
      );
    }
  }
  return record;
}

function assertFieldMappingCovers(record, fields, label) {
  const mapped = new Map(fields.map(({name, slot}) => [name, slot]));
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
  const record = assertProjectionInterface(descriptor);
  assertFieldMappingCovers(record, normalizedFields, IMAGE_PROJECTION_BINDING_V1);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_PROJECTION_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_PROJECTION_BINDING_V1,
      fields: normalizedFields.map(({name, slot}) => ({name, slot})),
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
      const record = assertProjectionInterface(descriptor);
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

      const projected = {};
      for (const field of record.fields) {
        const slot = mapped.get(field.name);
        if (!Object.hasOwn(object.slots ?? {}, slot)) {
          throw new TypeError(`projected object ${imageId}/${objectId} has no slot ${slot} for field ${field.name}`);
        }
        const slotValue = canonicalizeValue(object.slots[slot]);
        // Rejected, never followed: authority for this object must not imply authority for
        // whatever it points at, and there is no second require on a traversal path.
        if (isReference(slotValue)) {
          throw new TypeError(
            `slot ${slot} holds a reference; ${IMAGE_PROJECTION_BINDING_V1} never follows refs`,
          );
        }
        projected[field.name] = canonicalToHostLeaf(
          slotValue, field.type, `projected field ${field.name}`,
        );
      }

      return packCompositeValue(
        projected, descriptor.result, descriptor.types ?? {}, `${descriptor.function} result`,
      );
    },
  });
}

export {
  IMAGE_PROJECTION_BINDING_V1,
  createImageProjectionBindingV1Executor,
  installImageProjectionBinding,
  parseImageProjectionBindingArtifact,
};
