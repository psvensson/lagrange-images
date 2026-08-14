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
export * from './symmetric-smalltalk-tokenizer.js';
export {createDefaultLanguagePlatform};
