import {uuid as randomUUID} from '../support/default-crypto.js';
import {objectRef, textValue} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE} from '../foreign-runtime/callable-artifacts.js';
import {ForeignRuntimeDefinitionInstanceCache} from '../foreign-runtime/callable-executor.js';
import {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  normalizeObjectRef,
  resolveBindingDependency,
  resolveCallableInterface,
} from './binding-artifacts.js';
import {assertImages} from './interface-artifacts.js';
import {assertCallableInterfaceArguments, assertCallableInterfaceValue} from './interface-v2-artifacts.js';
import {compositeEnvelopeOf, compositePayloadOf} from './composite-codec.js';
import {isCompositeType} from './type-grammar.js';

// Binds a callable-interface/v1 to a live foreign runtime. Like the Component binding it
// carries no signature: the shape comes from the shared interface. What it does carry is
// the runtime-specific address of the operation, which is meaningless to any other lane.
// The dependency role is shared with the historical foreign-runtime-callable-interface/v1
// contract on purpose: it names the same concept, so it should not be spelled twice.
const FOREIGN_RUNTIME_BINDING_V1 = 'foreign-runtime-binding/v1';

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('foreign runtime binding target must be a plain record');
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new TypeError(`foreign runtime binding target ${key} must be a non-empty string`);
    }
    normalized[key] = entry;
  }
  if (Object.keys(normalized).length === 0) {
    throw new TypeError('foreign runtime binding target must not be empty');
  }
  return Object.freeze(normalized);
}

function normalizeForeignRuntimeBindingDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('foreign runtime binding descriptor must be an object');
  }
  const expected = ['abi', 'target'];
  const actual = Object.keys(input).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`foreign runtime binding descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (input.abi !== FOREIGN_RUNTIME_BINDING_V1) {
    throw new TypeError(`unsupported foreign runtime binding ABI: ${input.abi}`);
  }
  return Object.freeze({abi: FOREIGN_RUNTIME_BINDING_V1, target: normalizeTarget(input.target)});
}

function parseForeignRuntimeBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== FOREIGN_RUNTIME_BINDING_V1) {
    throw new TypeError(`artifact must be ${FOREIGN_RUNTIME_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('foreign runtime binding content must be a text Value');
  assertBindingDependencies(
    artifact,
    [CALLABLE_INTERFACE_DEPENDENCY_ROLE, FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE],
    FOREIGN_RUNTIME_BINDING_V1,
  );
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('foreign runtime binding content must be valid JSON', {cause: error});
  }
  return normalizeForeignRuntimeBindingDescriptor(decoded);
}

async function installForeignRuntimeBinding({
  images,
  callableInterface,
  runtimeDefinition,
  target,
  imageId = null,
  bindingId = randomUUID(),
  blockId = randomUUID(),
  bindingMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const interfaceRef = normalizeObjectRef(callableInterface, 'foreign runtime binding interface');
  const definitionRef = normalizeObjectRef(runtimeDefinition, 'foreign runtime binding runtime definition');
  const definition = await imageService.getCodeArtifact(definitionRef.imageId, definitionRef.objectId);
  if (!definition) {
    throw new TypeError(`foreign runtime definition not found: ${definitionRef.imageId}/${definitionRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;
  const descriptor = normalizeForeignRuntimeBindingDescriptor({abi: FOREIGN_RUNTIME_BINDING_V1, target});

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: FOREIGN_RUNTIME_BINDING_V1,
    content: textValue(JSON.stringify(descriptor)),
    dependencies: [
      {role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef},
      {role: FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE, artifact: definitionRef},
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

function createForeignRuntimeBindingV1Executor({
  definitions,
  runtimes,
  bindings,
  instanceCache = null,
} = {}) {
  if (!runtimes || typeof runtimes.call !== 'function') {
    throw new TypeError('foreign runtime binding executor requires runtimes.call');
  }
  const cache = instanceCache ?? new ForeignRuntimeDefinitionInstanceCache({definitions, bindings});
  if (!cache || typeof cache.get !== 'function') {
    throw new TypeError('foreign runtime binding executor instanceCache must implement get');
  }

  return Object.freeze({
    instanceCache: cache,
    async execute({activation, code}, {images}) {
      if (!code || code.representation !== FOREIGN_RUNTIME_BINDING_V1) {
        throw new TypeError(`foreign runtime binding executor requires ${FOREIGN_RUNTIME_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, FOREIGN_RUNTIME_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${FOREIGN_RUNTIME_BINDING_V1} does not accept a lexical environment`);
      }
      const {target} = parseForeignRuntimeBindingArtifact(code);

      const {descriptor} = await resolveCallableInterface(images, code, FOREIGN_RUNTIME_BINDING_V1);
      // The foreign runtime speaks canonical Values already, so the shared interface is
      // enforced directly on them rather than through a lowering step.
      // A composite crosses this lane as the envelope bytes Value itself: the stdio
      // transport already carries arbitrary bytes, so it never learns a nested grammar.
      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const {artifact: definitionArtifact, ref: definitionRef} = await resolveBindingDependency(
        images,
        code,
        FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE,
        FOREIGN_RUNTIME_BINDING_V1,
      );

      const types = descriptor.types ?? {};
      // Composites travel this lane as the bare payload. The envelope header is the Block
      // edge's concern, and stripping it here means the runtime never needs to produce a
      // fingerprint of its own.
      const wireArguments = descriptor.parameters.map((type, index) => (isCompositeType(type)
        ? compositePayloadOf(args[index], `${descriptor.function} argument ${index}`)
        : args[index]));

      const instance = await cache.get({definition: definitionRef, artifact: definitionArtifact});
      const result = await runtimes.call({
        runtimeId: instance.runtimeId,
        interface: target,
        arguments: wireArguments,
      });
      if (isCompositeType(descriptor.result)) {
        return compositeEnvelopeOf(result, descriptor.result, types, `${descriptor.function} result`);
      }
      return assertCallableInterfaceValue(
        result, descriptor.result, types, `${descriptor.function} result`,
      );
    },
  });
}

export {
  FOREIGN_RUNTIME_BINDING_V1,
  createForeignRuntimeBindingV1Executor,
  installForeignRuntimeBinding,
  normalizeForeignRuntimeBindingDescriptor,
  parseForeignRuntimeBindingArtifact,
};
