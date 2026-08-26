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
import {assertImages} from './interface-artifacts.js';
import {assertCallableInterfaceArguments} from './interface-v2-artifacts.js';
import {packCompositeValue} from './composite-codec.js';
import {resolveDeclaredType} from './type-grammar.js';

// ADR 0068. The authorized whole-record object-read lane: `read-object(object-id) ->
// {version-token, value}` where `value` carries the COMPLETE generic object — every named
// slot verbatim and the indexed part verbatim. Unlike projection this lane maps nothing:
// no field list, no slot selection. Refs and pinned refs are disclosed as identity only,
// never followed, matching projection's no-follow rule.
//
// The interface descriptor must declare:
//   result: 'object-read-result'
//   types:  an `object-read-result` record {version-token: string, value: object-record},
//           an `object-record` record {slots: list<slot-entry>, indexed: list<slot-value>},
//           a `slot-entry` record {name: string, value: slot-value}, and a `slot-value`
//           record {value: string} whose `value` is the canonical JSON serialization of the
//           stored canonical Value.
//
// The composite codec cannot carry a raw ref Value or an arbitrary slot map (it is ref-free
// and schema-directed), so a whole-record is encoded as a record of lists. Each slot name is
// the durable slot id; each slot Value or indexed element is serialized with the existing
// canonical Value JSON form and carried as a string, so refs and pinned refs survive the
// ref-free boundary as identity data rather than being followed or rejected.
const IMAGE_OBJECT_READ_BINDING_V1 = 'image-object-read-binding/v1';
const VERSION_TOKEN_FIELD = 'version-token';
const VALUE_FIELD = 'value';
const SLOTS_FIELD = 'slots';
const INDEXED_FIELD = 'indexed';
const SLOT_NAME_FIELD = 'name';
const SLOT_VALUE_FIELD = 'value';

// A lane-owned, machine-readable discriminator for "authorized but the object does not exist" —
// distinct from an AuthorityError (denied) and from an operational failure. ADR 0068 promises
// denied != not-found != operational; a stable `code` makes that promise machine-readable instead of
// message-readable, so a consumer need not match the message text at an API boundary. The message
// keeps the human-readable `object not found: <imageId>/<objectId>` form for continuity.
const OBJECT_NOT_FOUND_CODE = 'OBJECT_NOT_FOUND';
class ObjectReadNotFoundError extends TypeError {
  constructor(imageId, objectId) {
    super(`object not found: ${imageId}/${objectId}`);
    this.name = 'ObjectReadNotFoundError';
    this.code = OBJECT_NOT_FOUND_CODE;
    this.imageId = imageId;
    this.objectId = objectId;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function parseImageObjectReadBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact'
    || artifact.representation !== IMAGE_OBJECT_READ_BINDING_V1) {
    throw new TypeError(`artifact must be ${IMAGE_OBJECT_READ_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') {
    throw new TypeError('object read binding content must be a text Value');
  }
  assertBindingDependencies(artifact, [CALLABLE_INTERFACE_DEPENDENCY_ROLE], IMAGE_OBJECT_READ_BINDING_V1);
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('object read binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${IMAGE_OBJECT_READ_BINDING_V1} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== IMAGE_OBJECT_READ_BINDING_V1) {
    throw new TypeError(`unsupported object read binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({});
}

// read-object(id: string) -> record { version-token: string, value: object-record }
function assertObjectReadInterface(descriptor) {
  const {parameters, result, types = {}} = descriptor;
  if (parameters.length !== 1 || parameters[0] !== 'string') {
    throw new TypeError(
      `${IMAGE_OBJECT_READ_BINDING_V1} requires exactly one string parameter naming the object id`,
    );
  }
  const outer = typeof result === 'string' ? resolveDeclaredType(result, types) : null;
  if (!outer || outer.kind !== 'record') {
    throw new TypeError(`${IMAGE_OBJECT_READ_BINDING_V1} result must be a declared record type`);
  }
  const names = outer.fields.map(({name}) => name);
  if (names.length !== 2 || names[0] !== VERSION_TOKEN_FIELD || names[1] !== VALUE_FIELD) {
    throw new TypeError(
      `${IMAGE_OBJECT_READ_BINDING_V1} result must declare exactly ${VERSION_TOKEN_FIELD} then ${VALUE_FIELD}`,
    );
  }
  const [tokenField, valueField] = outer.fields;
  if (tokenField.type !== 'string') {
    throw new TypeError(`${IMAGE_OBJECT_READ_BINDING_V1} ${VERSION_TOKEN_FIELD} must be string; a token is opaque text`);
  }
  const recordType = typeof valueField.type === 'string' ? resolveDeclaredType(valueField.type, types) : null;
  if (!recordType || recordType.kind !== 'record') {
    throw new TypeError(`${IMAGE_OBJECT_READ_BINDING_V1} ${VALUE_FIELD} must be a declared record type`);
  }
  const recordNames = recordType.fields.map(({name}) => name);
  if (recordNames.length !== 2 || recordNames[0] !== SLOTS_FIELD || recordNames[1] !== INDEXED_FIELD) {
    throw new TypeError(
      `${IMAGE_OBJECT_READ_BINDING_V1} ${VALUE_FIELD} must declare exactly ${SLOTS_FIELD} then ${INDEXED_FIELD}`,
    );
  }
  return {outer, recordType};
}

async function installImageObjectReadBinding({
  images,
  callableInterface,
  imageId = null,
  bindingId = randomUUID(),
  blockId = randomUUID(),
  bindingMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const interfaceRef = normalizeObjectRef(callableInterface, 'object read binding interface');
  const interfaceArtifact = await imageService.getCodeArtifact(interfaceRef.imageId, interfaceRef.objectId);
  if (!interfaceArtifact) {
    throw new TypeError(`callable interface not found: ${interfaceRef.imageId}/${interfaceRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;

  const {descriptor} = await resolveCallableInterface(
    imageService,
    {dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}]},
    IMAGE_OBJECT_READ_BINDING_V1,
  );
  assertObjectReadInterface(descriptor);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_OBJECT_READ_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_OBJECT_READ_BINDING_V1,
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

function createImageObjectReadBindingV1Executor() {
  return Object.freeze({
    async execute({activation, code}, {images, require}) {
      if (!code || code.representation !== IMAGE_OBJECT_READ_BINDING_V1) {
        throw new TypeError(`object read executor requires ${IMAGE_OBJECT_READ_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, IMAGE_OBJECT_READ_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${IMAGE_OBJECT_READ_BINDING_V1} does not accept a lexical environment`);
      }
      parseImageObjectReadBindingArtifact(code);
      const {descriptor} = await resolveCallableInterface(images, code, IMAGE_OBJECT_READ_BINDING_V1);
      assertObjectReadInterface(descriptor);

      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const objectId = requiredText(args[0].value, 'read object id');
      // The image comes from the binding, never the caller.
      const imageId = code.imageId;

      // Require before any existence check: a denied caller learns AuthorityError whether or
      // not the object exists, so the lane is no existence oracle.
      require({operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, objectId)});

      // One read: the token and the value both come from this record, so the token always
      // describes the state the value was taken from.
      const object = await images.getObject(imageId, objectId);
      if (!object) throw new ObjectReadNotFoundError(imageId, objectId);

      const slots = Object.entries(object.slots ?? {}).map(([name, value]) => ({
        [SLOT_NAME_FIELD]: name,
        [SLOT_VALUE_FIELD]: {[SLOT_VALUE_FIELD]: JSON.stringify(value)},
      }));
      const indexed = (object.indexed ?? []).map((value) => ({[SLOT_VALUE_FIELD]: JSON.stringify(value)}));
      const token = objectVersionToken(imageId, objectId, object._version);

      return packCompositeValue(
        {
          [VERSION_TOKEN_FIELD]: token,
          [VALUE_FIELD]: {
            [SLOTS_FIELD]: slots,
            [INDEXED_FIELD]: indexed,
          },
        },
        descriptor.result,
        descriptor.types ?? {},
        `${descriptor.function} result`,
      );
    },
  });
}

export {
  IMAGE_OBJECT_READ_BINDING_V1,
  OBJECT_NOT_FOUND_CODE,
  ObjectReadNotFoundError,
  assertObjectReadInterface,
  createImageObjectReadBindingV1Executor,
  installImageObjectReadBinding,
  parseImageObjectReadBindingArtifact,
};
