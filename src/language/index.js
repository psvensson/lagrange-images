import {LanguagePlatform} from './language-platform.js';
import {SYMMETRIC_SMALLTALK} from './symmetric-smalltalk.js';

function createDefaultLanguagePlatform() {
  const platform = new LanguagePlatform();
  platform.register(SYMMETRIC_SMALLTALK);
  return platform;
}

export * from './language-platform.js';
export * from './symmetric-smalltalk.js';
export * from './symmetric-smalltalk-compiler.js';
export * from './symmetric-smalltalk-dispatcher.js';
export * from './symmetric-smalltalk-parser.js';
export * from './symmetric-smalltalk-semantic.js';
export * from './symmetric-smalltalk-tokenizer.js';
export {createDefaultLanguagePlatform};
export * from './smalltalk-kernel.js';
export * from './smalltalk-class-builder.js';
export * from './smalltalk-control-flow.js';
export * from './smalltalk-allocation.js';
export * from './smalltalk-dictionary.js';
export * from './smalltalk-dictionary-table.js';
export * from './smalltalk-equality.js';
export * from './smalltalk-instance-variables.js';
export * from './smalltalk-method-dictionary.js';
export * from './smalltalk-method-dictionary-migration.js';
export * from './smalltalk-indexed.js';
export * from './smalltalk-primitives.js';
export * from './smalltalk-lookup.js';
