import {createBackend} from './backend/create-backend.js';
import {DispatchRegistry, InvocationService} from './dispatch/invocation-service.js';
import {ActivationExecutor, createDefaultCodeExecutorRegistry} from './execution/executor.js';
import {ImageService} from './image/graph-image-service.js';
import {createDefaultLanguagePlatform} from './language/index.js';

async function createRuntime(options = {}) {
  const backend = await createBackend(options.backend ?? {});
  await backend.start();
  const images = new ImageService({backend, clock: options.clock});
  const languages = createDefaultLanguagePlatform();

  const dispatchers = new DispatchRegistry();
  for (const [languageId, dispatcher] of Object.entries(options.dispatchers ?? {})) {
    dispatchers.register(languageId, dispatcher);
  }
  const invocations = new InvocationService({images, dispatchers});

  const codeExecutors = createDefaultCodeExecutorRegistry();
  for (const [representation, executor] of Object.entries(options.codeExecutors ?? {})) {
    codeExecutors.register(representation, executor);
  }
  const executor = new ActivationExecutor({images, executors: codeExecutors});

  return {
    backend,
    images,
    languages,
    dispatchers,
    invocations,
    codeExecutors,
    executor,
    async close() { await backend.stop(); },
  };
}

export * from './backend/index.js';
export * from './dispatch/invocation-service.js';
export {ImageService};
export * from './execution/executor.js';
export * from './execution/model.js';
export * from './language/index.js';
export * from './object/index.js';
export * from './value/index.js';
export {createRuntime};
