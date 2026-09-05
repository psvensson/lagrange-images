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
export * from './smalltalk-browse.js';
export * from './smalltalk-method-position-token.js';
export * from './smalltalk-control-flow.js';
export * from './smalltalk-allocation.js';
export * from './smalltalk-block-protocol.js';
export * from './smalltalk-integer.js';
export * from './smalltalk-conditions.js';
export * from './smalltalk-globals.js';
export * from './smalltalk-dictionary.js';
export * from './smalltalk-dictionary-table.js';
export * from './smalltalk-equality.js';
export * from './smalltalk-instance-variables.js';
export * from './smalltalk-library.js';
export * from './smalltalk-method-dictionary.js';
export * from './smalltalk-method-dictionary-migration.js';
export * from './smalltalk-indexed.js';
export * from './smalltalk-primitives.js';
export * from './smalltalk-primitives-symbol.js';
export * from './smalltalk-lookup.js';
export * from './smalltalk-class-variables.js';
export * from './smalltalk-class-state.js';
export * from './smalltalk-symbol.js';
export * from './smalltalk-subclasses.js';
export * from './smalltalk-text-bytearray.js';
export * from './smalltalk-write-stream.js';
export * from './smalltalk-standard-image.js';
export * from './cuis-export-materialization.js';
