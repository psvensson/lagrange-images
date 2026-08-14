import {randomUUID} from 'node:crypto';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {integerValue, objectRef, textValue} from '../value/index.js';
import {parseSymmetricSmalltalkBlock} from './symmetric-smalltalk-parser.js';

const SYMMETRIC_SMALLTALK_ID = 'symmetric-smalltalk';
const SYMMETRIC_SMALLTALK_SOURCE_V0 = 'symmetric-smalltalk/source-v0';
const SYMMETRIC_SMALLTALK_SYNTAX_V0 = 'symmetric-smalltalk/syntax-v0';

function normalizeCaptures(captures) {
  if (!captures || typeof captures !== 'object' || Array.isArray(captures)) {
    throw new TypeError('captures must be an object mapping source name to stable binding id');
  }
  const normalized = new Map();
  for (const [name, bindingId] of Object.entries(captures)) {
    if (!name) throw new TypeError('capture name must not be empty');
    if (typeof bindingId !== 'string' || bindingId.length === 0) {
      throw new TypeError(`capture binding id for ${name} must be a non-empty string`);
    }
    normalized.set(name, bindingId);
  }
  return normalized;
}

function compileExpression(syntax, scope) {
  switch (syntax.kind) {
    case 'integer':
      return Object.freeze({op: 'literal', value: integerValue(syntax.value)});
    case 'string':
      return Object.freeze({op: 'literal', value: textValue(syntax.value)});
    case 'self':
      return Object.freeze({op: 'receiver'});
    case 'name': {
      if (scope.parameters.has(syntax.name)) {
        return Object.freeze({op: 'argument', index: scope.parameters.get(syntax.name)});
      }
      if (scope.captures.has(syntax.name)) {
        return Object.freeze({op: 'binding', id: scope.captures.get(syntax.name)});
      }
      throw new TypeError(`unbound Symmetric Smalltalk name: ${syntax.name}`);
    }
    case 'send':
      return Object.freeze({
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: compileExpression(syntax.receiver, scope),
        message: textValue(syntax.selector),
        arguments: Object.freeze(syntax.arguments.map((argument) => compileExpression(argument, scope))),
      });
    case 'block':
      throw new TypeError('nested block literals are parsed but not executable in the first seed');
    default:
      throw new TypeError(`unsupported Symmetric Smalltalk syntax kind: ${syntax.kind}`);
  }
}

function compileSymmetricSmalltalkBlock(source, {captures = {}} = {}) {
  const syntax = parseSymmetricSmalltalkBlock(source);
  const parameters = new Map();
  syntax.parameters.forEach((name, index) => parameters.set(name, index));
  const scope = Object.freeze({parameters, captures: normalizeCaptures(captures)});
  const program = Object.freeze({
    parameters: syntax.parameters.length,
    body: compileExpression(syntax.body, scope),
  });
  return Object.freeze({syntax, program});
}

async function installSymmetricSmalltalkBlock({
  images,
  imageId,
  source,
  id = randomUUID(),
  captures = {},
  environment = null,
  metadata = {},
} = {}) {
  if (!images || typeof images.putCodeArtifact !== 'function' || typeof images.putBlock !== 'function') {
    throw new TypeError('images service with code-artifact and block persistence is required');
  }
  const {syntax, program} = compileSymmetricSmalltalkBlock(source, {captures});

  const sourceArtifact = await images.putCodeArtifact(imageId, {
    id: `${id}:source`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SYMMETRIC_SMALLTALK_SOURCE_V0,
    content: textValue(source),
    metadata,
  });
  const syntaxArtifact = await images.putCodeArtifact(imageId, {
    id: `${id}:syntax`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SYMMETRIC_SMALLTALK_SYNTAX_V0,
    content: textValue(JSON.stringify(syntax)),
    derivedFrom: [objectRef(imageId, sourceArtifact.id)],
  });
  const codeArtifact = await images.putCodeArtifact(imageId, {
    id: `${id}:code`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: NEUTRAL_EXPRESSION_V0,
    content: textValue(JSON.stringify(program)),
    derivedFrom: [objectRef(imageId, syntaxArtifact.id)],
  });
  const block = await images.putBlock(imageId, {
    id,
    code: objectRef(imageId, codeArtifact.id),
    environment,
    metadata,
  });
  return Object.freeze({syntax, program, sourceArtifact, syntaxArtifact, codeArtifact, block});
}

async function evaluateSymmetricSmalltalkBlock({runtime, arguments: args = [], ...installOptions} = {}) {
  if (!runtime?.images || !runtime?.invocations || !runtime?.executor) {
    throw new TypeError('runtime with images, invocations and executor is required');
  }
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, ...installOptions});
  const activation = await runtime.invocations.invokeBlock(
    objectRef(installed.block.imageId, installed.block.id),
    args,
  );
  return await runtime.executor.execute(activation);
}

export {
  SYMMETRIC_SMALLTALK_ID,
  SYMMETRIC_SMALLTALK_SOURCE_V0,
  SYMMETRIC_SMALLTALK_SYNTAX_V0,
  compileSymmetricSmalltalkBlock,
  evaluateSymmetricSmalltalkBlock,
  installSymmetricSmalltalkBlock,
};
