import {randomUUID} from 'node:crypto';
import {ensureBlock, ensureCodeArtifact, ensureLexicalEnvironment} from '../graph/ensure-records.js';
import {NIL_BINDING_ID} from './symmetric-smalltalk-semantic.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {globalDeclarations} from './smalltalk-globals.js';
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
  //
  // Globals are different: they are image state, so an image-scoped caller reads them and hands the
  // resolved declarations down. This function stays synchronous and storage-free (ADR 0057), and a
  // caller with no declarations gets exactly today's behaviour.
  const {syntax, program, representation, globalBindingIdsUsed} =
    compileSymmetricSmalltalkSemanticBlock(source, options);
  return Object.freeze({syntax, semanticProgram: program, program, representation, globalBindingIdsUsed});
}

// Deterministic per Block, so an identical retry converges like every other write here.
//
// The identity is deliberately conditional. A Block that uses only `nil` keeps ADR 0056's existing
// `${id}:nil-environment`, because renaming it would change the durable definition of every
// pre-0057 nil Block and stop reinstallation converging. A Block that uses globals gets the broader
// identity instead.
async function ensureCompilerSuppliedEnvironment({
  images, imageId, id, parent, program, globalBindingIdsUsed,
}) {
  const captures = program.captures ?? [];
  const captureIds = new Set(captures.map(({id: captureId}) => captureId));
  const usesNil = captureIds.has(NIL_BINDING_ID);
  // Exactly the globals compilation resolved — never every published id that happens to appear
  // among the captures. An explicit caller capture may legitimately use an id that is also a
  // published binding, and substituting the binding object for the caller's value would collapse
  // two meanings onto one identity.
  //
  // The *name* comes from the semantic program's capture descriptor, not from the current namespace.
  // Namespace aliases are compile-time lookup affordances; once a name resolved to identity X, adding
  // another alias for X must not change the durable definition of an already-compiled Block on retry.
  const resolved = new Set(globalBindingIdsUsed ?? []);
  const globalCaptures = [];
  for (const bindingId of resolved) {
    const capture = captures.find(({id}) => id === bindingId);
    if (!capture) {
      throw new TypeError(`global binding ${bindingId} was resolved but is absent from the semantic capture list`);
    }
    globalCaptures.push(capture);
  }
  if (!usesNil && globalCaptures.length === 0) return parent;

  const bindings = {};
  if (usesNil) {
    const kernel = await findSmalltalkKernel({images, imageId});
    if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel; nil has no value there`);
    bindings[NIL_BINDING_ID] = {name: 'nil', value: kernel.nil};
  }
  for (const {id: bindingId, name} of globalCaptures) {
    // The image-local ref lives here, in the environment — never in the semantic artifact.
    bindings[bindingId] = {name, value: objectRef(imageId, bindingId)};
  }

  const environmentId = globalCaptures.length === 0 ? `${id}:nil-environment` : `${id}:compiler-environment`;
  const record = await ensureLexicalEnvironment(images, imageId, {
    id: environmentId,
    ...(parent ? {parent} : {}),
    bindings,
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
  // The image-scoped seam: the namespace is read here, asynchronously, and passed into the
  // synchronous compiler as a transient name -> binding-id map.
  const globals = await globalDeclarations({images, imageId});
  const {syntax, semanticProgram, representation, globalBindingIdsUsed} =
    compileSymmetricSmalltalkBlock(source, {captures, globals});

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
  // ADR 0056 decision 2a, generalised by ADR 0057. Only a program that actually binds something the
  // compiler supplies needs an environment, so a Block using neither `nil` nor a global keeps
  // today's path exactly and writes no extra record.
  //
  // When one is needed it *parents* the caller's rather than copying its bindings: the caller's
  // environment is a record with its own lifecycle, and a copy would be a second answer to the same
  // question that could later drift from it. The chain walk is already the composition mechanism.
  //
  // One environment, not two wrappers, when a program uses both.
  const blockEnvironment = await ensureCompilerSuppliedEnvironment({
    images, imageId, id, parent: environment, program: semanticProgram, globalBindingIdsUsed,
  });

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
    // Transient provenance: which global bindings this compilation actually resolved. It is not
    // written to any artifact — lagrange-code stays a language-neutral representation — but callers
    // that bind captures need it, because a capture id alone never says why the capture exists.
    globalBindingIdsUsed,
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