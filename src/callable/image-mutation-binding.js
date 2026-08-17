import {randomUUID} from 'node:crypto';
import {canonicalizeValue, isReference, objectRef, textValue} from '../value/index.js';
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

function normalizeMutationFields(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} fields must be a non-empty array`);
  }
  const names = new Set();
  const slots = new Set();
  return Object.freeze(values.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`${label} field ${index} must be an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'slot') {
      throw new TypeError(`${label} field ${index} must contain exactly name, slot`);
    }
    const name = requiredText(entry.name, `${label} field ${index} name`);
    // Stable slot IDs, not slot names: a rename must not change what a mutation writes.
    const slot = requiredText(entry.slot, `${label} field ${index} slot`);
    if (names.has(name)) throw new TypeError(`${label} maps field ${name} twice`);
    if (slots.has(slot)) throw new TypeError(`${label} maps slot ${slot} twice`);
    names.add(name);
    slots.add(slot);
    return Object.freeze({name, slot});
  }));
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
function assertMutationInterface(descriptor) {
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
  for (const field of record.fields) {
    if (!CALLABLE_TYPES.includes(field.type)) {
      throw new TypeError(
        `${IMAGE_MUTATION_BINDING_V1} field ${field.name} must be a leaf type; v1 does not write nested values`,
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
  assertFieldMappingCovers(assertMutationInterface(descriptor), normalizedFields, IMAGE_MUTATION_BINDING_V1);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_MUTATION_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_MUTATION_BINDING_V1,
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
      const record = assertMutationInterface(descriptor);
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
      for (const field of record.fields) {
        const slot = mapped.get(field.name);
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
