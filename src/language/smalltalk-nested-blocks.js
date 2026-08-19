import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {LAGRANGE_CODE_V1} from '../code/lagrange-code-v1.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {NEUTRAL_EXPRESSION_V1} from '../execution/neutral-expression-v1.js';
import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {objectRef, textValue} from '../value/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// Nested Block publication, shared by standalone Block installation and by method installation.
//
// One implementation on purpose. Two recursive installers would eventually disagree about v0/v1
// selection, capture handling, deterministic ids or which executable target a nested Block gets —
// and the disagreement would surface as a Block that runs correctly in one path and not the other.
//
// Every write is ensure-exact-or-create, because a method's nested ids are derived from the method's
// own deterministic id: a partial install must converge on an identical retry rather than collide
// with its own earlier output.

// The semantic representation is chosen once for the whole tree, so the executable target follows
// from it rather than being decided independently per node.
const EXECUTABLE_TARGET = Object.freeze({
  [LAGRANGE_CODE_V0]: NEUTRAL_EXPRESSION_V0,
  [LAGRANGE_CODE_V1]: NEUTRAL_EXPRESSION_V1,
});

function executableTargetFor(representation) {
  const target = EXECUTABLE_TARGET[representation];
  if (!target) throw new TypeError(`no executable target for semantic representation ${representation}`);
  return target;
}

function blockSuffix(blockId) {
  return blockId.replace(/[^A-Za-z0-9_-]+/g, '_');
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
    // A Block is very often the right-hand side of an assignment or a statement of a sequence, so
    // omitting these would silently install no prototype for it.
    case 'binding-write':
      directNestedBlocks(expression.value, result);
      return result;
    case 'sequence':
      for (const statement of expression.statements) directNestedBlocks(statement, result);
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

// Nested identity is derived from the root's identity plus the *semantic* block id, so a method's
// nested Blocks inherit the method's deterministic naming and a rebuild lands on the same records.
function nestedIds(rootId, blockId) {
  const suffix = blockSuffix(blockId);
  return Object.freeze({
    semanticId: `${rootId}:semantic:${suffix}`,
    codeId: `${rootId}:code:${suffix}`,
    prototypeId: `${rootId}:prototype:${suffix}`,
  });
}

async function installNestedPrototypes({
  images,
  compilation,
  imageId,
  rootId,
  parentSemanticRef,
  program,
  representation,
}) {
  const prototypes = {};
  for (const nested of directNestedBlocks(program.body)) {
    const ids = nestedIds(rootId, nested.blockId);
    const semanticArtifact = await ensureCodeArtifact(images, imageId, {
      id: ids.semanticId,
      languageId: SYMMETRIC_SMALLTALK_ID,
      representation,
      content: textValue(JSON.stringify(nested.program)),
      derivedFrom: [parentSemanticRef],
      metadata: {semanticBlockId: nested.blockId},
    });
    // Depth first: a child's prototype must exist before its parent's executable artifact names it.
    const childPrototypes = await installNestedPrototypes({
      images,
      compilation,
      imageId,
      rootId,
      parentSemanticRef: objectRef(imageId, semanticArtifact.id),
      program: nested.program,
      representation,
    });
    const codeArtifact = await compilation.compileArtifact(
      objectRef(imageId, semanticArtifact.id),
      {
        id: ids.codeId,
        targetRepresentation: executableTargetFor(representation),
        options: {blockPrototypes: childPrototypes},
        metadata: {semanticBlockId: nested.blockId},
      },
    );
    const prototype = await ensureBlock(images, imageId, {
      id: ids.prototypeId,
      code: objectRef(imageId, codeArtifact.id),
      metadata: {prototype: true, semanticBlockId: nested.blockId},
    });
    prototypes[nested.blockId] = objectRef(imageId, prototype.id);
  }
  return Object.freeze(prototypes);
}

export {
  EXECUTABLE_TARGET,
  blockSuffix,
  directNestedBlocks,
  executableTargetFor,
  installNestedPrototypes,
  nestedIds,
};
