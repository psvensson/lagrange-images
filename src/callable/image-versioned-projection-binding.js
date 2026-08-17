import {randomUUID} from 'node:crypto';
import {objectRef, textValue} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {objectVersionToken} from '../object/version-token.js';
import {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  normalizeObjectRef,
  resolveCallableInterface,
} from './binding-artifacts.js';
import {CALLABLE_TYPES, assertImages} from './interface-artifacts.js';
import {assertCallableInterfaceArguments} from './interface-v2-artifacts.js';
import {packCompositeValue} from './composite-codec.js';
import {resolveDeclaredType} from './type-grammar.js';
import {
  assertFieldMappingCovers,
  normalizeProjectionFields,
  projectObjectSlots,
} from './image-projection-binding.js';

// A sibling of image-projection-binding/v1 that also returns the object's optimistic-concurrency
// token, closing the read/modify/write loop. Ordinary projection stays frozen and
// version-free: only interfaces that actually need a token pay for one.
//
//   read-versioned-item(id) -> {version-token, value}
//
// The token comes from the same object read that produced the value. Fetching the value and
// then separately fetching a version could return a pair that never described one actual object
// state, which would make the token worse than useless — it would be confidently wrong.
const IMAGE_VERSIONED_PROJECTION_BINDING_V1 = 'image-versioned-projection-binding/v1';
const VERSION_TOKEN_FIELD = 'version-token';
const VALUE_FIELD = 'value';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function parseVersionedProjectionBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact'
    || artifact.representation !== IMAGE_VERSIONED_PROJECTION_BINDING_V1) {
    throw new TypeError(`artifact must be ${IMAGE_VERSIONED_PROJECTION_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') {
    throw new TypeError('versioned projection binding content must be a text Value');
  }
  assertBindingDependencies(artifact, [CALLABLE_INTERFACE_DEPENDENCY_ROLE], IMAGE_VERSIONED_PROJECTION_BINDING_V1);
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('versioned projection binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi', 'fields'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${IMAGE_VERSIONED_PROJECTION_BINDING_V1} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== IMAGE_VERSIONED_PROJECTION_BINDING_V1) {
    throw new TypeError(`unsupported versioned projection binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({
    fields: normalizeProjectionFields(decoded.fields, IMAGE_VERSIONED_PROJECTION_BINDING_V1),
  });
}

// read-versioned-item(id: string) -> record { version-token: string, value: <leaf record> }
function assertVersionedProjectionInterface(descriptor) {
  const {parameters, result, types = {}} = descriptor;
  if (parameters.length !== 1 || parameters[0] !== 'string') {
    throw new TypeError(
      `${IMAGE_VERSIONED_PROJECTION_BINDING_V1} requires exactly one string parameter naming the object id`,
    );
  }
  const outer = typeof result === 'string' ? resolveDeclaredType(result, types) : null;
  if (!outer || outer.kind !== 'record') {
    throw new TypeError(`${IMAGE_VERSIONED_PROJECTION_BINDING_V1} result must be a declared record type`);
  }
  const names = outer.fields.map(({name}) => name);
  if (names.length !== 2 || names[0] !== VERSION_TOKEN_FIELD || names[1] !== VALUE_FIELD) {
    throw new TypeError(
      `${IMAGE_VERSIONED_PROJECTION_BINDING_V1} result must declare exactly ${VERSION_TOKEN_FIELD} then ${VALUE_FIELD}`,
    );
  }
  const [tokenField, valueField] = outer.fields;
  if (tokenField.type !== 'string') {
    throw new TypeError(`${IMAGE_VERSIONED_PROJECTION_BINDING_V1} ${VERSION_TOKEN_FIELD} must be string; a token is opaque text`);
  }
  const inner = typeof valueField.type === 'string' ? resolveDeclaredType(valueField.type, types) : null;
  if (!inner || inner.kind !== 'record') {
    throw new TypeError(`${IMAGE_VERSIONED_PROJECTION_BINDING_V1} ${VALUE_FIELD} must be a declared record type`);
  }
  for (const field of inner.fields) {
    if (!CALLABLE_TYPES.includes(field.type)) {
      throw new TypeError(
        `${IMAGE_VERSIONED_PROJECTION_BINDING_V1} field ${field.name} must be a leaf type; v1 does not project nested values`,
      );
    }
  }
  return {outer, inner};
}

async function installImageVersionedProjectionBinding({
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
  const interfaceRef = normalizeObjectRef(callableInterface, 'versioned projection binding interface');
  const interfaceArtifact = await imageService.getCodeArtifact(interfaceRef.imageId, interfaceRef.objectId);
  if (!interfaceArtifact) {
    throw new TypeError(`callable interface not found: ${interfaceRef.imageId}/${interfaceRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;
  const normalizedFields = normalizeProjectionFields(fields, IMAGE_VERSIONED_PROJECTION_BINDING_V1);

  const {descriptor} = await resolveCallableInterface(
    imageService,
    {dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}]},
    IMAGE_VERSIONED_PROJECTION_BINDING_V1,
  );
  const {inner} = assertVersionedProjectionInterface(descriptor);
  assertFieldMappingCovers(inner, normalizedFields, IMAGE_VERSIONED_PROJECTION_BINDING_V1);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_VERSIONED_PROJECTION_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_VERSIONED_PROJECTION_BINDING_V1,
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

function createImageVersionedProjectionBindingV1Executor() {
  return Object.freeze({
    async execute({activation, code}, {images, require}) {
      if (!code || code.representation !== IMAGE_VERSIONED_PROJECTION_BINDING_V1) {
        throw new TypeError(`versioned projection executor requires ${IMAGE_VERSIONED_PROJECTION_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, IMAGE_VERSIONED_PROJECTION_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${IMAGE_VERSIONED_PROJECTION_BINDING_V1} does not accept a lexical environment`);
      }
      const binding = parseVersionedProjectionBindingArtifact(code);
      const {descriptor} = await resolveCallableInterface(images, code, IMAGE_VERSIONED_PROJECTION_BINDING_V1);
      const {inner} = assertVersionedProjectionInterface(descriptor);
      const mapped = assertFieldMappingCovers(inner, binding.fields, IMAGE_VERSIONED_PROJECTION_BINDING_V1);

      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const objectId = requiredText(args[0].value, 'projected object id');
      // The image comes from the binding, never the caller.
      const imageId = code.imageId;

      require({operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, objectId)});

      // Read once. Both halves of the returned pair come from this single record, so the token
      // always describes the state the value was taken from.
      const object = await images.getObject(imageId, objectId);
      if (!object) throw new TypeError(`projected object not found: ${imageId}/${objectId}`);

      const value = projectObjectSlots({object, record: inner, mapped, imageId, objectId});
      // The same object-scoped codec the mutation lane accepts: no second encoding, and no
      // projection-specific token identity.
      const token = objectVersionToken(imageId, objectId, object._version);

      return packCompositeValue(
        {[VERSION_TOKEN_FIELD]: token, [VALUE_FIELD]: value},
        descriptor.result,
        descriptor.types ?? {},
        `${descriptor.function} result`,
      );
    },
  });
}

export {
  IMAGE_VERSIONED_PROJECTION_BINDING_V1,
  assertVersionedProjectionInterface,
  createImageVersionedProjectionBindingV1Executor,
  installImageVersionedProjectionBinding,
  parseVersionedProjectionBindingArtifact,
};
