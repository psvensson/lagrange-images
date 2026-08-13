class LanguageAlreadyRegisteredError extends Error {
  constructor(id) {
    super(`language already registered: ${id}`);
    this.name = 'LanguageAlreadyRegisteredError';
  }
}

class LanguagePlatform {
  constructor() {
    this.languages = new Map();
  }

  register(descriptor) {
    if (!descriptor?.id) throw new Error('language descriptor must have an id');
    if (this.languages.has(descriptor.id)) {
      throw new LanguageAlreadyRegisteredError(descriptor.id);
    }

    const frozen = Object.freeze(structuredClone(descriptor));
    this.languages.set(frozen.id, frozen);
    return frozen;
  }

  get(id) {
    return this.languages.get(id) ?? null;
  }

  list() {
    return [...this.languages.values()];
  }
}

export {LanguageAlreadyRegisteredError, LanguagePlatform};
