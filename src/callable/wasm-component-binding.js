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
import {assertImages, canonicalToHostLeaf} from './interface-artifacts.js';
import {
  ComponentHostImportRegistry,
  UndeclaredHostImportError,
  normalizeHostImportSpecifier,
} from './host-import-registry.js';
import {isCompositeType} from './type-grammar.js';
import {packCompositeValue, unpackCompositeValue} from './composite-codec.js';
import {assertCallableInterfaceArguments, assertCallableInterfaceValue} from './interface-v2-artifacts.js';

// Binds a callable-interface/v1 to a WASM Component implementation. The binding holds no
// signature of its own: the shape comes from the interface it depends on, so the same
// interface artifact can also be bound to a completely different lane.
const WASM_COMPONENT_BINDING_V1 = 'wasm-component-binding/v1';
// v2 adds one thing: a declaration of which host interfaces the implementation may import.
// v1 is frozen and has no host authority surface at all, so a v1 binding can never wire one.
// Declaring is not granting — see ADR 0038.
const WASM_COMPONENT_BINDING_V2 = 'wasm-component-binding/v2';
const WASM_COMPONENT_BINDING_REPRESENTATIONS = Object.freeze([
  WASM_COMPONENT_BINDING_V1,
  WASM_COMPONENT_BINDING_V2,
]);
const WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE = 'implementation';

function assertWasmComponentArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_COMPONENT_V1) {
    throw new TypeError(`artifact must be ${WASM_COMPONENT_V1}`);
  }
  if (artifact.content?.kind !== 'bytes') throw new TypeError('WASM Component content must be a bytes Value');
  return artifact;
}

// Lowering a canonical Value into what the Component canonical ABI expects. The leaf
// conversion is shared with every other lane so they cannot diverge.
function toComponentValue(value, type) {
  return canonicalToHostLeaf(value, type, 'Component argument');
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

function normalizeHostImports(values, label) {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new TypeError(`${label} hostImports must be an array`);
  const seen = new Set();
  for (const value of values) {
    const specifier = normalizeHostImportSpecifier(value, `${label} host import`);
    if (seen.has(specifier)) throw new TypeError(`${label} declares duplicate host import ${specifier}`);
    seen.add(specifier);
  }
  return Object.freeze([...seen].sort());
}

// The declaration is the entire authority-relevant content of a binding, and it is
// deliberately just a list of interface names: no principal, no grants, no resources, no
// secrets and no runtime service. Anything else would put authority into the durable graph.
function parseWasmComponentBindingArtifact(artifact) {
  const representation = artifact?.representation;
  if (!artifact || artifact.kind !== 'code-artifact'
    || !WASM_COMPONENT_BINDING_REPRESENTATIONS.includes(representation)) {
    throw new TypeError(`artifact must be ${WASM_COMPONENT_BINDING_REPRESENTATIONS.join(' or ')}`);
  }
  assertBindingDependencies(
    artifact,
    [CALLABLE_INTERFACE_DEPENDENCY_ROLE, WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE],
    representation,
  );
  if (representation === WASM_COMPONENT_BINDING_V1) {
    return Object.freeze({representation, hostImports: Object.freeze([])});
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('WASM Component binding content must be a text Value');
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('WASM Component binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi', 'hostImports'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${WASM_COMPONENT_BINDING_V2} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== WASM_COMPONENT_BINDING_V2) {
    throw new TypeError(`unsupported WASM Component binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({
    representation,
    hostImports: normalizeHostImports(decoded.hostImports, WASM_COMPONENT_BINDING_V2),
  });
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

async function installWasmComponentBindingV2({
  images,
  callableInterface,
  component,
  hostImports = [],
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
  const declared = normalizeHostImports(hostImports, WASM_COMPONENT_BINDING_V2);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: WASM_COMPONENT_BINDING_V2,
    content: textValue(JSON.stringify({abi: WASM_COMPONENT_BINDING_V2, hostImports: declared})),
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

// Assembles the host implementations for one activation.
//
// Deliberately NOT `declared ∩ granted`: the concrete resource a guest will ask for is not
// known until it calls, and precomputing authorization would snapshot it at instantiation and
// silently defeat revocation. Declaration decides which interfaces are *wired*; every concrete
// operation calls require() at use time, so the effective intersection happens per call.
async function assembleHostImports({componentRuntime, hostImports, implementation, declared, require}) {
  const required = typeof componentRuntime.requiredImports === 'function'
    ? await componentRuntime.requiredImports(implementation)
    : [];
  if (required.length === 0) return {};

  const declaredSet = new Set(declared);
  const assembled = {};
  for (const specifier of required) {
    // Undeclared is a property of the durable binding contract, not of this execution, so it
    // is a linking failure rather than an authorization failure. undeclared != unauthorized.
    if (!declaredSet.has(specifier)) throw new UndeclaredHostImportError(specifier);
    assembled[specifier] = await hostImports.create(specifier, {require});
  }
  return assembled;
}

function createWasmComponentBindingV1Executor({componentRuntime = null, hostImports = null} = {}) {
  if (componentRuntime !== null && (typeof componentRuntime !== 'object' || typeof componentRuntime.invoke !== 'function')) {
    throw new TypeError('WASM Component binding executor componentRuntime must implement invoke(component, function, args)');
  }
  const registry = hostImports ?? new ComponentHostImportRegistry();
  return Object.freeze({
    componentRuntime,
    hostImports: registry,
    async execute({activation, code}, {images, require}) {
      if (!code || !WASM_COMPONENT_BINDING_REPRESENTATIONS.includes(code.representation)) {
        throw new TypeError(`WASM Component binding executor requires ${WASM_COMPONENT_BINDING_REPRESENTATIONS.join(' or ')}`);
      }
      assertBlockApplicationReceiver(activation, code.representation);
      if (activation.environment !== null) {
        throw new TypeError(`${code.representation} does not accept a lexical environment`);
      }
      const binding = parseWasmComponentBindingArtifact(code);

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
      const imports = await assembleHostImports({
        componentRuntime,
        hostImports: registry,
        implementation,
        declared: binding.hostImports,
        require,
      });
      const raw = await componentRuntime.invoke(implementation, descriptor.function, lowered, imports);
      if (isCompositeType(descriptor.result)) {
        return packCompositeValue(raw, descriptor.result, types, `${descriptor.function} result`);
      }
      const result = fromComponentValue(raw, descriptor.result);
      return assertCallableInterfaceValue(result, descriptor.result, types, `${descriptor.function} result`);
    },
  });
}

export {
  WASM_COMPONENT_BINDING_REPRESENTATIONS,
  WASM_COMPONENT_BINDING_V1,
  WASM_COMPONENT_BINDING_V2,
  installWasmComponentBindingV2,
  WASM_COMPONENT_IMPLEMENTATION_DEPENDENCY_ROLE,
  assertWasmComponentArtifact,
  createWasmComponentBindingV1Executor,
  fromComponentValue,
  installWasmComponentBinding,
  parseWasmComponentBindingArtifact,
  toComponentValue,
};
