// Portable runtime composition root (bead lagrange-images-16q).
//
// ONE public composition root for the subset of lagrange-images a portable JS host
// (native or future WASM) needs to drive the Image/authority/dispatch/observation
// acceptance — WITHOUT a Node personality. Its complete STATIC transitive ESM
// closure contains no `node:crypto`, `node:buffer`, `node:child_process`,
// `node:readline`, `node:fs`, `node:path`, `node:os`, or process-dependent
// toolchain runner. A structural test (`test/portable-runtime.test.js`) walks this
// closure and fails on any forbidden `node:*` import.
//
// THIS IS WIRING/EXPORT SELECTION, NOT A SECOND IMPLEMENTATION. Every semantic
// subsystem is the same module the Node composition root (`src/runtime.js`) uses;
// this root simply (a) imports the narrow registry/service owners directly instead
// of the broad `foreign-runtime`/`toolchain`/`wasm` barrels that also export
// host-specific process/OCI providers, and (b) composes only the portable-relevant
// lanes (image create/read/mutate/observe, neutral expression, the Smalltalk
// kernel), leaving foreign-runtime/toolchain/WASM-component executors to the Node
// root that actually has those hosts.
//
// CRYPTO. A portable host MUST install its synchronous crypto provider via
// `setDefaultCryptoProvider(nativeProvider)` BEFORE calling `createPortableRuntime`
// (or before any semantic work needing UUID/SHA/AES). That configuration seam is
// re-exported from THIS root — the same function `support/default-crypto.js` owns,
// not a wrapper, second registry or host object — so a portable host composes the
// runtime entirely through this public entrypoint and never needs a private module
// path. Provider validation stays in `support/crypto-provider.js`; installation of
// the active provider stays in `support/default-crypto.js`. This module never
// imports the Node provider; the Node root installs it automatically instead.
//
// ENVIRONMENT COMPOSITION. A portable Object Environment needs the same public
// adapter-construction helpers that the Node root exposes, but must not import
// private `src/...` paths from a shipped artifact. The exact named re-exports
// below expose those existing owner functions through this one public root.
// They are identities, not wrappers: their language/callable/value/authority/
// object modules retain all semantics and validation.

import {getDefaultCryptoProvider, setDefaultCryptoProvider} from './support/default-crypto.js';
import {createBackend} from './backend/create-backend.js';
import {ImageService} from './image/graph-image-service.js';
import {createAuthorityService} from './authority/authority-service.js';
import {DispatchRegistry, InvocationService} from './dispatch/invocation-service.js';
import {ActivationExecutor} from './execution/activation-executor.js';
import {CodeExecutorRegistry} from './execution/executor-registry.js';
import {NEUTRAL_EXPRESSION_V0, neutralExpressionV0Executor} from './execution/neutral-expression-v0.js';
import {NEUTRAL_EXPRESSION_V1, neutralExpressionV1Executor} from './execution/neutral-expression-v1.js';
import {
  IMAGE_PROJECTION_BINDING_V1,
  createImageProjectionBindingV1Executor,
} from './callable/image-projection-binding.js';
import {
  IMAGE_MUTATION_BINDING_V1,
  createImageMutationBindingV1Executor,
  installImageMutationBinding,
} from './callable/image-mutation-binding.js';
import {
  IMAGE_CREATION_BINDING_V1,
  createImageCreationBindingV1Executor,
  installImageCreationBinding,
} from './callable/image-creation-binding.js';
import {
  IMAGE_CREATION_BATCH_BINDING_V1,
  createImageCreationBatchBindingV1Executor,
} from './callable/image-creation-batch-binding.js';
import {
  IMAGE_VERSIONED_PROJECTION_BINDING_V1,
  createImageVersionedProjectionBindingV1Executor,
} from './callable/image-versioned-projection-binding.js';
import {
  IMAGE_OBJECT_READ_BINDING_V1,
  createImageObjectReadBindingV1Executor,
  installImageObjectReadBinding,
} from './callable/image-object-read-binding.js';
import {
  IMAGE_OBSERVATION_BINDING_V1,
  createImageObservationBindingV1Executor,
  installImageObservationBinding,
} from './callable/image-observation-binding.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  createSmalltalkKernelPrimitiveV1Executor,
} from './language/smalltalk-primitives.js';
import {
  createSmalltalkTemporaryInitializer,
  findSmalltalkKernel,
  installSmalltalkKernel,
} from './language/smalltalk-kernel.js';
import {defineClass} from './language/smalltalk-class-builder.js';
import {
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
} from './language/smalltalk-browse.js';
import {
  authorizedReplaceSmalltalkMethod,
} from './language/smalltalk-authorized-method-replacement.js';
import {createDefaultLanguagePlatform} from './language/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './language/symmetric-smalltalk.js';
import {createSymmetricSmalltalkDispatcher} from './language/symmetric-smalltalk-dispatcher.js';
import {installCallableInterfaceV2} from './callable/interface-v2-artifacts.js';
import {packCompositeValue, unpackCompositeValue} from './callable/composite-codec.js';
import {normalizeTypeDeclarations} from './callable/type-grammar.js';
import {objectRef, referencesOfValue, textValue} from './value/scalars.js';
import {objectResource, parseObjectResource} from './authority/object-resource.js';
import {objectVersionToken} from './object/version-token.js';
import {
  addProjectMember,
  authorizedReadProject,
  authorizedReadProjectDescriptor,
  authorizedRenameProject,
  createProject,
  projectObjectId,
} from './project/working-state.js';

// The portable code-executor registry: neutral expression + the image lanes +
// (via composition) the Smalltalk kernel primitive. It deliberately omits the
// WASM-component and foreign-runtime executors, which require hosts a portable
// runtime does not have. This is the portable-relevant subset of
// `createDefaultCodeExecutorRegistry`, built from the same executor factories.
function createPortableCodeExecutorRegistry({creationObjectIds, observationCrypto} = {}) {
  const registry = new CodeExecutorRegistry();
  registry.register(NEUTRAL_EXPRESSION_V0, neutralExpressionV0Executor);
  registry.register(NEUTRAL_EXPRESSION_V1, neutralExpressionV1Executor);
  registry.register(IMAGE_PROJECTION_BINDING_V1, createImageProjectionBindingV1Executor());
  registry.register(IMAGE_MUTATION_BINDING_V1, createImageMutationBindingV1Executor());
  // ADR 0062. The creation lane mints object identity; injectable through the same
  // option the Smalltalk allocation lane uses (a test has to be able to force a
  // collision).
  registry.register(
    IMAGE_CREATION_BINDING_V1,
    createImageCreationBindingV1Executor(
      creationObjectIds === undefined ? {} : {newObjectId: creationObjectIds},
    ),
  );
  registry.register(
    IMAGE_CREATION_BATCH_BINDING_V1,
    createImageCreationBatchBindingV1Executor(
      creationObjectIds === undefined ? {} : {newObjectId: creationObjectIds},
    ),
  );
  registry.register(
    IMAGE_VERSIONED_PROJECTION_BINDING_V1,
    createImageVersionedProjectionBindingV1Executor(),
  );
  registry.register(IMAGE_OBJECT_READ_BINDING_V1, createImageObjectReadBindingV1Executor());
  // ADR 0070. The observation cursor secret defaults to a random per-registry value;
  // inject one only to share cursors across installs.
  registry.register(
    IMAGE_OBSERVATION_BINDING_V1,
    createImageObservationBindingV1Executor(
      observationCrypto === undefined ? {} : {crypto: observationCrypto},
    ),
  );
  return registry;
}

// The shared runtime core: every language-neutral, portable semantic subsystem the
// Image/authority/dispatch/observation acceptance needs. BOTH composition roots use
// this single core — the portable root returns it directly; the Node root
// (`src/runtime.js`) calls it and then layers the Node-only foreign-runtime,
// toolchain and WASM-component services/executors on top. One implementation of
// each subsystem; no second Images runtime.
//
// `registerExtraCodeExecutors` is the seam the Node root uses to add host-specific
// executors (WASM-component, foreign-runtime) that a portable host does not have.
async function createRuntimeCore(options = {}, {registerExtraCodeExecutors} = {}) {
  const backend = await createBackend(options.backend ?? {mode: 'mock'});
  await backend.start();
  const images = new ImageService({backend, clock: options.clock});
  const languages = createDefaultLanguagePlatform();

  const dispatchers = new DispatchRegistry();
  for (const [languageId, dispatcher] of Object.entries(options.dispatchers ?? {})) {
    dispatchers.register(languageId, dispatcher);
  }
  if (!dispatchers.has(SYMMETRIC_SMALLTALK_ID)) {
    dispatchers.register(SYMMETRIC_SMALLTALK_ID, createSymmetricSmalltalkDispatcher());
  }
  const invocations = new InvocationService({images, dispatchers});

  const codeExecutors = createPortableCodeExecutorRegistry({
    creationObjectIds: options.smalltalkObjectIds,
    observationCrypto: options.observationCrypto,
  });
  // The Node root registers its WASM-component/foreign-runtime executors here,
  // BEFORE the embedder's overrides and the default Smalltalk kernel primitive.
  if (typeof registerExtraCodeExecutors === 'function') {
    registerExtraCodeExecutors(codeExecutors, options);
  }
  for (const [representation, executor] of Object.entries(options.codeExecutors ?? {})) {
    codeExecutors.register(representation, executor);
  }
  if (!codeExecutors.has(SMALLTALK_KERNEL_PRIMITIVE_V1)) {
    codeExecutors.register(
      SMALLTALK_KERNEL_PRIMITIVE_V1,
      createSmalltalkKernelPrimitiveV1Executor(
        options.smalltalkObjectIds === undefined ? {} : {newObjectId: options.smalltalkObjectIds},
      ),
    );
  }

  // The authority service is a control-plane surface: the embedder may issue and
  // revoke contexts through `runtime.authority`, and executors never see it.
  const authority = options.authority ?? createAuthorityService();
  const executor = new ActivationExecutor({
    images,
    executors: codeExecutors,
    invocations,
    authority,
    // ADR 0044 decision 8. The policy is the language's; the mechanism is the
    // execution layer's.
    temporaryInitializer: createSmalltalkTemporaryInitializer(),
  });

  return {
    backend,
    images,
    languages,
    dispatchers,
    invocations,
    codeExecutors,
    authority,
    executor,
  };
}

async function createPortableRuntime(options = {}) {
  // Fail fast with a clear message if the host forgot to install its crypto
  // provider — rather than a confusing error deep inside the first UUID/SHA call.
  getDefaultCryptoProvider();

  const core = await createRuntimeCore(options);
  return {
    ...core,
    async close() {
      await core.backend.stop();
    },
  };
}

export {
  createPortableRuntime,
  createPortableCodeExecutorRegistry,
  createRuntimeCore,
  // Re-export, NOT a re-implementation: the identical function owned by
  // `support/default-crypto.js`. The portable root owns exposing the configuration
  // seam a portable host needs to compose it; it owns no crypto semantics.
  setDefaultCryptoProvider,
  // Exact existing owner bindings needed to construct ImageClientAdapter in a
  // portable Object Environment. Public exposure does not move their semantics
  // into this composition root.
  installSmalltalkKernel,
  findSmalltalkKernel,
  defineClass,
  installCallableInterfaceV2,
  installImageCreationBinding,
  installImageMutationBinding,
  installImageObjectReadBinding,
  installImageObservationBinding,
  objectRef,
  textValue,
  referencesOfValue,
  objectResource,
  parseObjectResource,
  objectVersionToken,
  packCompositeValue,
  unpackCompositeValue,
  normalizeTypeDeclarations,
  // The authorized Project reads (version-aware and descriptor-only) and the
  // authorized Project rename are the Object Environment's production seams.
  // The other three bindings are bounded host/control-plane setup helpers used
  // by the native acceptance composition. All six are exact owner-function
  // identities, never portable-runtime wrappers.
  authorizedReadProject,
  authorizedReadProjectDescriptor,
  authorizedRenameProject,
  createProject,
  addProjectMember,
  projectObjectId,
  // The authorized native Smalltalk browsing seam (bead lagrange-images-jtz): the Object
  // Environment's production read for a native class and for one of its methods. Exact owner
  // functions from src/language/smalltalk-browse.js, never portable-runtime wrappers.
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
  // The authorized native method REPLACEMENT seam (bead lagrange-images-qax, Object Environment
  // E3). The exact owner function from src/language/smalltalk-authorized-method-replacement.js;
  // that module's error classes stay internal and are distinguished by `error.name`.
  authorizedReplaceSmalltalkMethod,
};
