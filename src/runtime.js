import {createBackend} from './backend/create-backend.js';
import {ImageService} from './image/graph-image-service.js';
import {createDefaultLanguagePlatform} from './language/index.js';

async function createRuntime(options = {}) {
  const backend = await createBackend(options.backend ?? {});
  await backend.start();
  const images = new ImageService({backend, clock: options.clock});
  const languages = createDefaultLanguagePlatform();
  return {
    backend,
    images,
    languages,
    async close() { await backend.stop(); },
  };
}

export * from './backend/index.js';
export {ImageService};
export * from './execution/model.js';
export * from './language/index.js';
export * from './object/index.js';
export * from './value/index.js';
export {createRuntime};
