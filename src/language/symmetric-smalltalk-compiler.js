import {randomUUID} from 'node:crypto';
import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {CompilationService, createDefaultCodeCompilerRegistry} from '../compilation/index.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {objectRef, textValue} from '../value/index.js';
import {compileSymmetricSmalltalkSemanticBlock} from './symmetric-smalltalk-semantic.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

const SYMMETRIC_SMALLTALK_SOURCE_V0 = 'symmetric-smalltalk/source-v0';
const SYMMETRIC_SMALLTALK_SYNTAX_V0 = 'symmetric-smalltalk/syntax-v0';

function compileSymmetricSmalltalkBlock(source, options = {}) {
  const {syntax, program} = compileSymmetricSmalltalkSemanticBlock(source, options);
  return Object.freeze({syntax, semanticProgram: program, program});
}

function directNestedBlocks(expression, result = []) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return result;
  switch (expression.op) {
    case 'block':
      result.push(expression);
      return result;
    case 'send':
      directNestedBlocks(expression.receiver, result);
      for (const argument of expression.arguments) directNestedBlocks(argument, result);
      return result;
    case 'integer-add':
    case 'equals':
      directNestedBlocks(expression.left, result);
      directNestedBlocks(expression.right, result);
      return result;
    case 'if':
      directNestedBlocks(expression.condition, result);
      directNestedBlocks(expression.then, result);
      directNestedBlocks(expression.else, result);
      return result;
    default:
      return result;
  }
}

function blockSuffix(blockId) {
  return blockId.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function resolveCompilation(images, compilation) {
  if (compilation) {
    if (typeof compilation.compileArtifact !== 'function') throw new TypeError('compilation service must implement compileArtifact');
    return compilation;
  }
  return new CompilationService({images, compilers: createDefaultCodeCompilerRegistry()});
}

async function installNestedPrototypes({images, compilation, imageId, rootId, parentSemanticRef, program}) {
  const prototypes = {};
  for (const nested of directNestedBlocks(program.body)) {
    const suffix = blockSuffix(nested.blockId);
    const semanticArtifact = await images.putCodeArtifact(imageId, {
      id: `${rootId}:semantic:${suffix}`,
      languageId: SYMMETRIC_SMALLTALK_ID,
      representation: LAGRANGE_CODE_V0,
      content: textValue(JSON.stringify(nested.program)),
      derivedFrom: [parentSemanticRef],
      metadata: {semanticBlockId: nested.blockId},
    });
    const childPrototypes = await installNestedPrototypes({
      images,
      compilation,
      imageId,
      rootId,
      parentSemanticRef: objectRef(imageId, semanticArtifact.id),
      program: nested.program,
    });
    const codeArtifact = await compilation.compileArtifact(
      objectRef(imageId, semanticArtifact.id),
      {
        id: `${rootId}:code:${suffix}`,
        targetRepresentation: NEUTRAL_EXPRESSION_V0,
        options: {blockPrototypes: childPrototypes},
        metadata: {semanticBlockId: nested.blockId},
      },
    );
    const prototype = await images.putBlock(imageId, {
      id: `${rootId}:prototype:${suffix}`,
      code: objectRef(imageId, codeArtifact.id),
      metadata: {prototype: true, semanticBlockId: nested.blockId},
    });
    prototypes[nested.blockId] = objectRef(imageId, prototype.id);
  }
  return Object.freeze(prototypes);
}

async function installSymmetricSmalltalkBlock({
  images,
  compilation = null,
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
  const compiler = resolveCompilation(images, compilation);
  const {syntax, semanticProgram} = compileSymmetricSmalltalkBlock(source, {captures});

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
  const semanticArtifact = await images.putCodeArtifact(imageId, {
    id: `${id}:semantic`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify(semanticProgram)),
    derivedFrom: [objectRef(imageId, syntaxArtifact.id)],
  });

  const blockPrototypes = await installNestedPrototypes({
    images,
    compilation: compiler,
    imageId,
    rootId: id,
    parentSemanticRef: objectRef(imageId, semanticArtifact.id),
    program: semanticProgram,
  });
  const codeArtifact = await compiler.compileArtifact(
    objectRef(imageId, semanticArtifact.id),
    {
      id: `${id}:code`,
      targetRepresentation: NEUTRAL_EXPRESSION_V0,
      options: {blockPrototypes},
    },
  );
  const block = await images.putBlock(imageId, {
    id,
    code: objectRef(imageId, codeArtifact.id),
    environment,
    metadata,
  });
  return Object.freeze({
    syntax,
    semanticProgram,
    sourceArtifact,
    syntaxArtifact,
    semanticArtifact,
    codeArtifact,
    blockPrototypes,
    block,
  });
}

async function evaluateSymmetricSmalltalkBlock({runtime, arguments: args = [], ...installOptions} = {}) {
  if (!runtime?.images || !runtime?.invocations || !runtime?.executor) {
    throw new TypeError('runtime with images, invocations and executor is required');
  }
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation ?? null,
    ...installOptions,
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef(installed.block.imageId, installed.block.id),
    args,
  );
  return await runtime.executor.execute(activation);
}

export {
  SYMMETRIC_SMALLTALK_SOURCE_V0,
  SYMMETRIC_SMALLTALK_SYNTAX_V0,
  compileSymmetricSmalltalkBlock,
  evaluateSymmetricSmalltalkBlock,
  installSymmetricSmalltalkBlock,
};
