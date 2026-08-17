import {randomUUID} from 'node:crypto';
import {
  booleanValue,
  bytesValue,
  float64ToNumber,
  float64Value,
  integerValue,
  objectRef,
  textValue,
} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {WASM_COMPONENT_V1} from '../wasm/component-artifacts.js';
import {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  normalizeObjectRef,
  resolveBindingDependency,
  resolveCallableInterface,
} from './binding-artifacts.js';
import {assertImages} from './interface-artifacts.js';
import {isCompositeType} from './type-grammar.js';
import {packCompositeValue, unpackCompositeValue} from './composite-codec.js';
import {assertCallableInterfaceArguments, assertCallableInterfaceValue} from './interface-v2-artifacts.js';

// Binds a callable-interface/v1 to a WASM Component implementation. The binding holds no
// signature of its own: the shape comes from the interface it depends on, so the same
// interface artifact can also be bound to a completely different lane.
const WASM_COMPONENT_BINDING_V1 = 'wasm-component-binding/v1';
const WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE = 'implementation';

function assertWasmComponentArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_COMPONENT_V1) {
    throw new TypeError(`artifact must be ${WASM_COMPONENT_V1}`);
  }
  if (artifact.content?.kind !== 'bytes') throw new TypeError('WASM Component content must be a bytes Value');
  return artifact;
}

// Lowering a canonical Value into what the Component canonical ABI expects. The type has
// already been validated against the shared interface, so this only converts.
function toComponentValue(value, type) {
  switch (type) {
    case 'bool':
      return value.value;
    case 's32':
      return Number(BigInt(value.value));
    case 's64':
      return BigInt(value.value);
    case 'f32':
      return Math.fround(float64ToNumber(value));
    case 'f64':
      return float64ToNumber(value);
    case 'string':
      return value.value;
    case 'list<u8>':
      return new Uint8Array(Buffer.from(value.base64, 'base64'));
    default:
      throw new TypeError(`unsupported callable type: ${type}`);
  }
}

function fromComponentValue(raw, type) {
  switch (type) {
    case 'bool':
      if (typeof raw !== 'boolean') throw new TypeError('Component bool result must be a boolean');
      return booleanValue(raw);
    case 's32':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new TypeError('Component s32 result must be an integer number');
      return integerValue(raw);
    case 's64':
      if (typeof raw !== 'bigint' && !(typeof raw === 'number' && Number.isInteger(raw))) {
        throw new TypeError('Component s64 result must be a bigint or integer number');
      }
      return integerValue(typeof raw === 'bigint' ? raw : BigInt(raw));
    case 'f32':
    case 'f64':
      if (typeof raw !== 'number') throw new TypeError(`Component ${type} result must be a number`);
      return float64Value(raw);
    case 'string':
      if (typeof raw !== 'string') throw new TypeError('Component string result must be a string');
      return textValue(raw);
    case 'list<u8>':
      if (!(raw instanceof Uint8Array) && !Array.isArray(raw)) {
        throw new TypeError('Component list<u8> result must be a Uint8Array or array');
      }
      return bytesValue(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
    default:
      throw new TypeError(`unsupported callable type: ${type}`);
  }
}

function parseWasmComponentBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_COMPONENT_BINDING_V1) {
    throw new TypeError(`artifact must be ${WASM_COMPONENT_BINDING_V1}`);
  }
  assertBindingDependencies(
    artifact,
    [CALLABLE_INTERFACE_DEPENDENCY_ROLE, WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE],
    WASM_COMPONENT_BINDING_V1,
  );
  return artifact;
}

async function installWasmComponentBinding({
  images,
  callableInterface,
  component,
  imageId = null,
  bindingId = randomUUID(),
  blockId = randomUUID(),
  bindingMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const interfaceRef = normalizeObjectRef(callableInterface, 'WASM Component binding interface');
  const implementationRef = normalizeObjectRef(component, 'WASM Component binding implementation');
  const implementation = await imageService.getCodeArtifact(implementationRef.imageId, implementationRef.objectId);
  if (!implementation) {
    throw new TypeError(`WASM Component not found: ${implementationRef.imageId}/${implementationRef.objectId}`);
  }
  assertWasmComponentArtifact(implementation);
  const targetImageId = imageId ?? interfaceRef.imageId;

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: WASM_COMPONENT_BINDING_V1,
    content: textValue(JSON.stringify({abi: WASM_COMPONENT_BINDING_V1})),
    dependencies: [
      {role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef},
      {role: WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE, artifact: implementationRef},
    ],
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

function createWasmComponentBindingV1Executor({componentRuntime = null} = {}) {
  if (componentRuntime !== null && (typeof componentRuntime !== 'object' || typeof componentRuntime.invoke !== 'function')) {
    throw new TypeError('WASM Component binding executor componentRuntime must implement invoke(component, function, args)');
  }
  return Object.freeze({
    componentRuntime,
    async execute({activation, code}, {images}) {
      if (!code || code.representation !== WASM_COMPONENT_BINDING_V1) {
        throw new TypeError(`WASM Component binding executor requires ${WASM_COMPONENT_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, WASM_COMPONENT_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${WASM_COMPONENT_BINDING_V1} does not accept a lexical environment`);
      }
      parseWasmComponentBindingArtifact(code);

      const {descriptor} = await resolveCallableInterface(images, code, WASM_COMPONENT_BINDING_V1);
      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const {artifact: implementation} = await resolveBindingDependency(
        images,
        code,
        WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE,
        WASM_COMPONENT_BINDING_V1,
      );
      assertWasmComponentArtifact(implementation);

      if (!componentRuntime) {
        throw new TypeError('no Component runtime registered; pass componentRuntime to createRuntime to execute WASM Component bindings');
      }
      // The canonical ABI wants real host values, so a composite is unpacked here. The
      // envelope exists for the Block edge, not for the lane.
      const types = descriptor.types ?? {};
      const lowered = descriptor.parameters.map((type, index) => (isCompositeType(type)
        ? unpackCompositeValue(args[index], type, types, `${descriptor.function} argument ${index}`)
        : toComponentValue(args[index], type)));
      const raw = await componentRuntime.invoke(implementation, descriptor.function, lowered);
      if (isCompositeType(descriptor.result)) {
        return packCompositeValue(raw, descriptor.result, types, `${descriptor.function} result`);
      }
      const result = fromComponentValue(raw, descriptor.result);
      return assertCallableInterfaceValue(result, descriptor.result, types, `${descriptor.function} result`);
    },
  });
}

export {
  WASM_COMPONENT_BINDING_V1,
  WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE,
  assertWasmComponentArtifact,
  createWasmComponentBindingV1Executor,
  fromComponentValue,
  installWasmComponentBinding,
  parseWasmComponentBindingArtifact,
  toComponentValue,
};
