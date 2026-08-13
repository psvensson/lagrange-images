import {createBackend} from './backend/create-backend.js';
import {ImageService} from './image/image-service.js';
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
    async close() {
      await backend.stop();
    },
  };
}

export * from './backend/index.js';
export * from './image/image-service.js';
export * from './language/index.js';
export {createRuntime};
