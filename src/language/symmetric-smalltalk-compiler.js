import {randomUUID} from 'node:crypto';
import {ensureBlock, ensureCodeArtifact, ensureLexicalEnvironment} from '../graph/ensure-records.js';
import {NIL_BINDING_ID} from './symmetric-smalltalk-semantic.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {LAGRANGE_CODE_V1} from '../code/lagrange-code-v1.js';
import {CompilationService, createDefaultCodeCompilerRegistry} from '../compilation/index.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {NEUTRAL_EXPRESSION_V1} from '../execution/neutral-expression-v1.js';
import {objectRef, textValue} from '../value/index.js';
import {
  executableTargetFor,
  installNestedPrototypes,
} from './smalltalk-nested-blocks.js';
import {compileSymmetricSmalltalkSemanticBlock} from './symmetric-smalltalk-semantic.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

const SYMMETRIC_SMALLTALK_SOURCE_V0 = 'symmetric-smalltalk/source-v0';
const SYMMETRIC_SMALLTALK_SYNTAX_V0 = 'symmetric-smalltalk/syntax-v0';

function compileSymmetricSmalltalkBlock(source, options = {}) {
  // `nil` needs nothing here: the semantic compiler owns that intrinsic and offers it to every
  // compilation (ADR 0056), so this wrapper cannot get it wrong or out of step.
  const {syntax, program, representation} = compileSymmetricSmalltalkSemanticBlock(source, options);
  return Object.freeze({syntax, semanticProgram: program, program, representation});
}

// Deterministic per Block, so an identical retry converges like every other write here.
async function ensureNilEnvironment({images, imageId, id, parent}) {
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel; nil has no value there`);
  const record = await ensureLexicalEnvironment(images, imageId, {
    id: `${id}:nil-environment`,
    ...(parent ? {parent} : {}),
    bindings: {[NIL_BINDING_ID]: {name: 'nil', value: kernel.nil}},
  });
  return objectRef(imageId, record.id);
}

function resolveCompilation(images, compilation) {
  if (compilation) {
    if (typeof compilation.compileArtifact !== 'function') throw new TypeError('compilation service must implement compileArtifact');
    return compilation;
  }
  return new CompilationService({images, compilers: createDefaultCodeCompilerRegistry()});
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
  const {syntax, semanticProgram, representation} = compileSymmetricSmalltalkBlock(source, {captures});

  // Ensure-exact-or-create, like every other deterministic-id write in this repository. These were
  // direct `put`s, which made an *identical* retry fail on the first record — so a partially
  // completed installation could not be completed by repeating it. Pre-existing and unrelated to
  // any one feature; converted here because ADR 0056 is the first thing to depend on it.
  const sourceArtifact = await ensureCodeArtifact(images, imageId, {
    id: `${id}:source`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SYMMETRIC_SMALLTALK_SOURCE_V0,
    content: textValue(source),
    metadata,
  });
  const syntaxArtifact = await ensureCodeArtifact(images, imageId, {
    id: `${id}:syntax`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SYMMETRIC_SMALLTALK_SYNTAX_V0,
    content: textValue(JSON.stringify(syntax)),
    derivedFrom: [objectRef(imageId, sourceArtifact.id)],
  });
  const semanticArtifact = await ensureCodeArtifact(images, imageId, {
    id: `${id}:semantic`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation,
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
    representation,
  });
  const codeArtifact = await compiler.compileArtifact(
    objectRef(imageId, semanticArtifact.id),
    {
      id: `${id}:code`,
      targetRepresentation: executableTargetFor(representation),
      options: {blockPrototypes},
    },
  );
  // ADR 0056 decision 2a. Only a program that actually binds the nil intrinsic needs an
  // environment, so a Block without `nil` keeps today's path exactly and writes no extra record.
  //
  // When one is needed it *parents* the caller's rather than copying its bindings: the caller's
  // environment is a record with its own lifecycle, and a copy would be a second answer to the same
  // question that could later drift from it. The chain walk is already the composition mechanism.
  const blockEnvironment = semanticProgram.captures?.some(({id: captureId}) => captureId === NIL_BINDING_ID)
    ? await ensureNilEnvironment({images, imageId, id, parent: environment})
    : environment;

  const block = await ensureBlock(images, imageId, {
    id,
    code: objectRef(imageId, codeArtifact.id),
    environment: blockEnvironment,
    metadata,
  });
  return Object.freeze({
    syntax,
    semanticProgram,
    representation,
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
