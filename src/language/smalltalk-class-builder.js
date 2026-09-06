import {base64urlEncode, utf8Encode} from '../support/portable-bytes.js';
import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {SHAPE_INDEXED, shapeIndexedKind} from '../object/model.js';
import {
  assembleWasmFunctionArtifact,
  describeWasmFunctionArtifact,
  moduleFunctionDescriptor,
} from '../wasm/compiler.js';
import {compileWasmModule} from '../wasm/compiler.js';
import {
  compileResumableWasmModule,
  isWasmTailEffectRestrictionError,
} from '../wasm/resumable-compiler.js';
import {lowerLagrangeCodeV0, normalizeLagrangeCodeProgram} from '../code/lagrange-code-v0.js';
import {
  LAGRANGE_CODE_V1,
  lowerLagrangeCodeV1,
  normalizeLagrangeCodeV1Program,
} from '../code/lagrange-code-v1.js';
import {NEUTRAL_EXPRESSION_V1} from '../execution/neutral-expression-v1.js';
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {
  codeArtifactProjection,
  ensureBlock as ensureBlockRecord,
  ensureCodeArtifact as ensureCodeArtifactRecord,
  ensureLexicalEnvironment as ensureLexicalEnvironmentRecord,
  ensureShape as ensureRecordShape,
  lexicalEnvironmentProjection,
} from '../graph/ensure-records.js';
import {TupleSet} from '../support/tuple-map.js';
import {sameRef} from './smalltalk-lookup.js';
import {ensureMethodDictionaryShape} from './smalltalk-method-dictionary-migration.js';
import {directNestedBlocks, installNestedPrototypes} from './smalltalk-nested-blocks.js';
import {installWasmBlockTree} from '../wasm/tree-installer.js';
import {
  METHOD_DICTIONARY_SHAPE_ID,
  buildMethodBuckets,
  entriesFromBuckets,
  isMethodDictionary,
  isSealed,
  methodDictionaryRecordFields,
  validateMethodDictionary,
} from './smalltalk-method-dictionary.js';
import {
  BEHAVIOR_SHAPE_ID,
  EMPTY_SHAPE_ID,
  SmalltalkKernelConflictError,
  assertUniqueSelectorShape,
  canonicalJson,
  ensureEmptyMethodDictionary,
  ensureObject,
  ensureShape,
  findSmalltalkKernel,
  methodDictionarySlots,
  readBehavior,
} from './smalltalk-kernel.js';
import {WASM_FUNCTION_V1} from '../code/wasm-artifacts.js';
import {WASM_MODULE_V2, readModuleDescriptor, soleModuleEntry} from '../wasm/module-contract.js';
import {assembleWasmV1FunctionArtifact} from '../wasm/tree-installer-v1.js';
import {ensureClassStateCompanion} from './smalltalk-class-state.js';
import {maintainSubclassRegistries} from './smalltalk-subclasses.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// Installing methods onto a class, and defining new classes with their metaclasses.
//
// A method is defined **semantically**, as lagrange-code/v0, and its executable Block is derived —
// ADR 0044 decision 6. Defining it directly as an executable artifact would collapse semantic
// meaning into one representation, which is the separation this substrate keeps everywhere else.
// `+` is not special: it is a method whose body happens to use `integer-add`.
//
// Both entry points write with the kernel's ensure-exact-or-create rule. Deterministic ids plus a
// plain `putObject` would let `defineClass('Point')` silently replace an existing Point, which is
// the same defect the kernel installer had before review.
function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// A method's semantic representation follows from what the program actually is, exactly as
// `selectSemanticRepresentation` decides it for a Block. ADR 0043's v1 adds temporaries, statement
// sequences and assignment; a method that needs none still lands on the v0 artifact it always did.
function methodRepresentation(program) {
  return Object.hasOwn(program ?? {}, 'temporaries') ? LAGRANGE_CODE_V1 : LAGRANGE_CODE_V0;
}

const methodsId = (ownerId) => `${ownerId}/methods`;
const methodId = (classObjectId, selector) =>
  `${classObjectId}/method/${base64urlEncode(utf8Encode(selector))}`;

// Full Behavior identity, not merely `shape.objectId`: cross-image shape refs are legal, so another
// image's `smalltalk/behavior-shape/v1` must not qualify a record as this image's Behavior.
async function requireLocalBehavior(images, imageId, ref, label) {
  if (!isObjectRef(ref) || ref.imageId !== imageId) {
    throw new TypeError(`${label} must be an unpinned ref in ${imageId}`);
  }
  const record = await images.getObject(ref.imageId, ref.objectId);
  if (!record) throw new TypeError(`${label} not found: ${ref.imageId}/${ref.objectId}`);
  // readBehavior, not merely isBehaviorObject: carrying the fixed shape is weaker than satisfying
  // the contract the dispatcher relies on, and the builder should reject anything the dispatcher
  // would later refuse.
  try {
    await readBehavior(images, ref);
  } catch (error) {
    throw new TypeError(
      `${label} is not a well-formed ${BEHAVIOR_SHAPE_ID} Behavior: ${ref.imageId}/${ref.objectId}`,
      {cause: error},
    );
  }
  return record;
}

// `defineMethods` remains add-only. `reconcileMethods` is the explicit native-owner operation for
// advancing an existing logical selector position to new immutable method material. Keeping those
// contracts separate prevents a caller that asked to define once from silently acquiring update
// semantics.
// A visible, retryable stall rather than a silent loss: the caller retries once migration has
// swapped the Behavior's methods edge, and lands in the hashed dictionary.
class SmalltalkSealedMethodDictionaryError extends TypeError {
  constructor(dictionaryRef) {
    super(
      `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId} is sealed for migration; `
      + 'retry once the Behavior points at its hashed dictionary',
    );
    this.name = 'SmalltalkSealedMethodDictionaryError';
  }
}

class SmalltalkMethodRedefinitionError extends TypeError {
  constructor(classRef, selector) {
    super(
      `${classRef.imageId}/${classRef.objectId} already implements ${selector}; `
      + 'the current native method has different semantics and was not overwritten',
    );
    this.name = 'SmalltalkMethodRedefinitionError';
    this.selector = selector;
  }
}

// The logical method position moved out from under a caller that told this owner which binding it
// had OBSERVED. Distinct from `SmalltalkMethodRedefinitionError`, which says "you asked to define
// something already defined differently" without any claim about what the caller had seen.
//
// It carries the position the caller already supplied and NOTHING it did not: no current Block ref,
// no replacement assumption, no MethodDictionary version, no backend version, and no `cause`.
// Current truth comes from a fresh read, not from the refusal — a refusal that hands back the
// winning ref would let a caller "recover" by adopting a binding it never read, which is exactly the
// observation the expectation exists to protect.
class SmalltalkStaleMethodPositionError extends TypeError {
  constructor(classRef, selector) {
    super(
      `${classRef.imageId}/${classRef.objectId} ${selector} no longer binds the method that was `
      + 'observed; the current native method was not replaced',
    );
    this.name = 'SmalltalkStaleMethodPositionError';
    this.selector = selector;
  }
}

// The guarded position never moved — that is re-asserted at every boundary including the last, so
// this outcome cannot stand in for staleness — and nothing about the request is wrong. The
// dictionary is simply being written faster than this operation can rebase onto it. A separate
// class rather than the kernel conflict, because that one says "an existing record differs from the
// definition and will not be overwritten", which is not what happened and would misdirect whoever
// reads it. A fresh attempt from a fresh observation is the correct response, and, like every other
// outcome here, this carries no backend error.
//
// It does NOT say "nothing was written". The replacement's immutable revision material is published
// BEFORE the final CAS, so by the time contention is reported that material exists and is
// addressable — it is simply not current. Promising an empty write here would reintroduce, in the
// one error the honesty rule did not cover, exactly the claim this owner refuses to make elsewhere.
class SmalltalkMethodDictionaryContentionError extends TypeError {
  constructor(dictionaryRef) {
    super(
      `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId} moved under this `
      + 'replacement more often than it could be rebased; the observed position is unchanged and was '
      + 'not advanced, retry from a fresh read',
    );
    this.name = 'SmalltalkMethodDictionaryContentionError';
  }
}

// A method's execution lane could not be established or preserved (bead lagrange-images-it3). It
// names only the position the caller already supplied, carries no storage identity and no `cause`,
// and — like every other refusal here — says nothing about what the current binding is.
class SmalltalkMethodLaneError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'SmalltalkMethodLaneError';
  }
}

const METHOD_LANES = Object.freeze(['neutral', 'wasm']);
const isMethodLane = (lane) => METHOD_LANES.includes(lane);

// The execution lane a native method revision was compiled in — the ONE question bead
// lagrange-images-it3 exists to give an owner.
//
// `installMethods` publishes `metadata: {smalltalk: 'method', selector, lane}` on every method Block
// it installs, and `isSameInstalledMethod` already compares that same field to decide whether a
// definition is the one already installed. So this owner is reading back a fact IT WROTE ITSELF.
// That is what makes the question answerable here and not at a public seam: nothing below opens the
// Block's code artifact, decodes an executable representation or consults an executor registry, so
// no second CodeArtifact decoder is created — the path ADR 0087 rejected for the read seam and ADR
// 0088 rejected for the write seam.
//
// There is deliberately NO default. A Block whose method lane metadata is missing, malformed or
// unknown cannot have its lane preserved, and answering "neutral because we could not tell" would
// migrate the execution representation of exactly the methods whose records are least trustworthy.
// Every method binding this owner writes carries its lane, so a binding without one arrived through
// a generic graph write — the threat model `assertUniqueSelectorShape` already exists for.
//
// `block` is an observation `readExpectedCurrentBindings` has already accepted as an unpinned local
// ref, so that rule is NOT restated here: one owner for "what shape may an observed binding be",
// exactly as bead lagrange-images-jtz.2 required for "which selectors does this Behavior bind".
async function installedMethodLane({images, classRef, selector, block}) {
  const record = await images.getBlock(block.imageId, block.objectId);
  const lane = record?.metadata?.lane;
  if (!isMethodLane(lane)) {
    throw new SmalltalkMethodLaneError(
      `${classRef.imageId}/${classRef.objectId} ${selector} does not record the execution lane of `
      + 'the method revision being replaced, so a replacement cannot preserve it',
    );
  }
  return lane;
}

// A logical method position is class + selector (`methodId`). A changed definition receives an
// immutable revision identity beneath that position. The encoded material is the class builder's
// existing semantic input after capture normalization: compiled native program, lane and capture
// bindings. It is deliberately NOT Cuis source and not a probabilistic digest. Canonical JSON plus
// base64url is injective for these normalized Values, so concurrent equal revisions select the same
// create-once records while different revisions cannot alias.
function methodRevisionId(classObjectId, selector, program, captures, lane) {
  const material = canonicalJson({
    captures,
    lane,
    representation: methodRepresentation(program),
    semanticContent: JSON.stringify(program),
  });
  return `${methodId(classObjectId, selector)}/revision/${base64urlEncode(utf8Encode(material))}`;
}

// The generic ensure-exact-or-create helpers, with this layer's conflict error so callers and tests
// keep the wording they depend on. The definition of "exact" now lives in one neutral place, because
// the WASM tree installers owe the same convergence guarantee for the same reason.
const smalltalkConflict = (kind, imageId, id) => new SmalltalkKernelConflictError(kind, imageId, id);

const ensureCodeArtifact = (images, imageId, desired) =>
  ensureCodeArtifactRecord(images, imageId, desired, {conflict: smalltalkConflict});

// ADR 0045 decision 6. A method may carry captures, which is how a kernel method names an object —
// `nil`, for the untaken arm of a one-arm conditional — without the common IR learning what that
// object means. The durable side is an ordinary lexical environment, so neither lane needs a change:
// the neutral executor resolves a `binding` through it, and the WASM lane reads the same bindings to
// fill its trailing capture parameters.
//
// Order is part of the contract, not a convenience. The WASM lane derives capture parameter
// positions from `program.captures`, so requiring the supplied values to match that list exactly —
// same ids, same names, same order — makes a mismatch a builder error rather than a silently
// misaddressed local.
function normalizeMethodCaptures(selector, program, captures) {
  if (!Array.isArray(captures)) throw new TypeError(`method ${selector} captures must be an array`);
  const declared = program?.captures ?? [];
  if (captures.length !== declared.length) {
    // Name the unsupplied ids. A program compiled elsewhere may declare a binding identity this
    // image does not have — an ADR 0057 global, say — and "1 captures but 0 values" leaves the
    // reader to guess which. The identity is exactly what has to be reported, because matching a
    // *name* is not evidence the identity is the same one.
    const supplied = new Set(captures.map((capture) => capture?.id));
    const missing = declared.map(({id}) => id).filter((id) => !supplied.has(id));
    throw new TypeError(
      `method ${selector} declares ${declared.length} captures but supplies ${captures.length} values`
      + (missing.length > 0 ? `; no value for ${missing.join(', ')}` : ''),
    );
  }
  // Matching counts is not matching bindings. The environment is keyed by capture id, so two
  // captures sharing an id collapse into one binding — the earlier value is lost, and in the WASM
  // lane two distinct parameter positions resolve to the same binding. `createClosure` refuses this
  // for a closure; the builder has to refuse it for a method.
  const seen = new Set();
  for (const {id} of declared) {
    if (seen.has(id)) throw new TypeError(`method ${selector} declares duplicate capture id: ${id}`);
    seen.add(id);
  }
  return captures.map((capture, index) => {
    if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
      throw new TypeError(`method ${selector} capture ${index} must be an object`);
    }
    const {id, name} = declared[index];
    if (capture.id !== id || capture.name !== name) {
      throw new TypeError(
        `method ${selector} capture ${index} must be ${id}/${name}, matching the semantic program`,
      );
    }
    return Object.freeze({id, name, value: canonicalizeValue(capture.value)});
  });
}

function environmentBindings(captures) {
  return Object.fromEntries(captures.map(({id, name, value}) => [id, {name, value}]));
}

// The complete durable description of a method's capture environment, written once here so that the
// write and every later exactness check compare the same contract rather than two similar subsets.
// A capture-free method has no environment at all — `null`, never an empty one.
function describeMethodEnvironment({methodObjectId, selector, captures}) {
  if (captures.length === 0) return null;
  return {
    id: `${methodObjectId}:environment`,
    bindings: environmentBindings(captures),
    metadata: {smalltalk: 'method-environment', selector},
  };
}

// "Exact" for a lexical environment, to the same standard as `codeArtifactProjection`: `metadata` is
// a durable field of the record, so an environment differing only there is a different environment.
// Comparing bindings alone would let a squatter with the right bindings and foreign metadata pass as
// identical, which is precisely the blind spot the ensure-exact-or-create rule exists to remove.

function sameOptionalRef(left, right) {
  const from = left ?? null;
  const to = right ?? null;
  if (from === null || to === null) return from === to;
  return isObjectRef(from) && isObjectRef(to) && from.imageId === to.imageId && from.objectId === to.objectId;
}

// Method-environment admission is owned by graph/ensure-records.js (insert-only; convergent on
// an identical concurrent winner; conflict on a divergent one). Only the conflict class is ours.
const ensureLexicalEnvironment = (images, imageId, desired) =>
  ensureLexicalEnvironmentRecord(images, imageId, desired, {conflict: smalltalkConflict});

const ensureBlock = (images, imageId, desired) =>
  ensureBlockRecord(images, imageId, desired, {conflict: smalltalkConflict});

// The neutral lane has the same shape of problem as the WASM one: compileArtifact writes its
// deterministic output unconditionally, so a failure after it but before the dictionary swap makes
// an exact retry of the same selector collide with its own output.
//
// Reuse compares the *whole* artifact against a freshly derived one rather than trusting
// representation plus a provenance edge, which would let stale content through.
async function ensureNeutralCode({
  images, compilation, imageId, id, semanticRef, target = NEUTRAL_EXPRESSION_V0, blockPrototypes = {},
}) {
  const codeId = `${id}:code`;
  const options = {blockPrototypes};
  const existing = await images.getCodeArtifact(imageId, codeId);
  if (!existing) {
    const code = await compilation.compileArtifact(semanticRef, {id: codeId, targetRepresentation: target, options});
    return objectRef(imageId, code.id);
  }
  // Derive under a scratch id so the comparison is against what a fresh compile actually produces.
  const probeId = `${codeId}:probe`;
  const fresh = await images.getCodeArtifact(imageId, probeId)
    ?? await compilation.compileArtifact(semanticRef, {id: probeId, targetRepresentation: target, options});
  const rebase = (record) => ({...record, derivedFrom: record.derivedFrom ?? []});
  if (codeArtifactProjection(rebase(fresh)) !== codeArtifactProjection(rebase(existing))) {
    throw new SmalltalkKernelConflictError('code artifact', imageId, codeId);
  }
  return objectRef(imageId, existing.id);
}

// The WASM function artifact is deterministic and written unconditionally by the assembler, so a
// failure between that write and the dictionary swap would make an exact retry collide with its own
// output.
//
// Reuse therefore has to be *exact*, to the same standard as ensureCodeArtifact: the module a fresh
// compile would select is resolved first, and an existing function must point at that module and
// carry the same entry, not merely mention the semantic artifact in its provenance. Provenance
// alone would let a function with stale compiled output be reused rather than rebuilt.
async function ensureWasmFunction({images, compilation, imageId, id, semanticRef, representation}) {
  const functionId = `${id}:wasm:function`;
  // ADR 0043's v1 semantics reach the WASM lane through their own assembler. There is no `describe`
  // helper for it, so reuse compares against a freshly assembled probe — the same trick
  // `ensureNeutralCode` uses, and for the same reason: matching provenance is not matching output.
  if (representation === LAGRANGE_CODE_V1) {
    const moduleArtifact = await compilation.compileArtifact(semanticRef, {
      targetRepresentation: WASM_MODULE_V2,
      id: `${id}:wasm:module`,
    });
    const moduleRef = objectRef(moduleArtifact.imageId ?? imageId, moduleArtifact.id);
    const assemble = async (target) => (await assembleWasmV1FunctionArtifact({
      images,
      semanticRef,
      moduleRef,
      functionId: target,
      entry: soleModuleEntry(readModuleDescriptor(moduleArtifact)),
    })).functionArtifact;

    const existing = await images.getCodeArtifact(imageId, functionId);
    if (!existing) return objectRef(imageId, (await assemble(functionId)).id);
    const probeId = `${functionId}:probe`;
    const fresh = await images.getCodeArtifact(imageId, probeId) ?? await assemble(probeId);
    const rebase = (record) => ({...record, derivedFrom: record.derivedFrom ?? []});
    if (codeArtifactProjection(rebase(fresh)) !== codeArtifactProjection(rebase(existing))) {
      throw new SmalltalkKernelConflictError('wasm function artifact', imageId, functionId);
    }
    return objectRef(imageId, existing.id);
  }
  const moduleArtifact = await compilation.compileArtifact(semanticRef, {
    targetRepresentation: WASM_MODULE_V2,
    id: `${id}:wasm:module`,
  });
  const moduleRef = objectRef(moduleArtifact.imageId ?? imageId, moduleArtifact.id);

  const existing = await images.getCodeArtifact(imageId, functionId);
  if (existing) {
    // The description the assembler would write, compared in full — ABI, parameters, captures,
    // closure prototypes and every provenance edge, not just module and entry.
    const semantic = await images.getCodeArtifact(semanticRef.imageId, semanticRef.objectId);
    const expected = describeWasmFunctionArtifact({
      functionId,
      languageId: semantic?.languageId ?? null,
      semanticRef,
      moduleRef,
      descriptor: moduleFunctionDescriptor(moduleArtifact, soleModuleEntry(readModuleDescriptor(moduleArtifact))),
      closurePrototypes: [],
    });
    if (codeArtifactProjection(expected) !== codeArtifactProjection(existing)) {
      throw new SmalltalkKernelConflictError('wasm function artifact', imageId, functionId);
    }
    return objectRef(imageId, existing.id);
  }

  const {functionArtifact} = await assembleWasmFunctionArtifact({
    images,
    semanticRef,
    moduleRef,
    functionId,
    entry: soleModuleEntry(readModuleDescriptor(moduleArtifact)),
  });
  return objectRef(imageId, functionArtifact.id);
}

// Is the selector already bound to exactly this definition? The first definition uses the legacy
// class+selector Block id; an evolved definition uses the deterministic immutable revision id.
// Both are native-owner identities, and the complete Block/semantic/environment contract must
// still agree. Merely finding equal source or an arbitrary Block with equal-looking content is not
// convergence.
async function isSameInstalledMethod({images, imageId, classRef, selector, program, captures, lane, installed}) {
  const baseId = methodId(classRef.objectId, selector);
  const revisionId = methodRevisionId(classRef.objectId, selector, program, captures, lane);
  if (!isObjectRef(installed) || installed.imageId !== imageId
    || (installed.objectId !== baseId && installed.objectId !== revisionId)) return false;
  const id = installed.objectId;
  const block = await images.getBlock(imageId, id);
  if (!block || block.metadata?.lane !== lane) return false;
  const semantic = await images.getCodeArtifact(imageId, `${id}:semantic`);
  if (!semantic || semantic.representation !== methodRepresentation(program)) return false;
  if (semantic.content?.value !== JSON.stringify(program)) return false;
  // The semantic program names its captures but does not contain their values, so two definitions
  // differing only in what `nil` they capture would otherwise look identical here and the second
  // would be silently accepted as already installed.
  //
  // Identity is the environment this definition *would* write, not merely an environment whose
  // bindings happen to match: the Block must point at the deterministic id, and that record must
  // satisfy the whole contract. A capture-free method must therefore carry no environment at all —
  // accepting an arbitrary empty one would call two different Blocks the same method.
  const expected = describeMethodEnvironment({methodObjectId: id, selector, captures});
  if (!sameOptionalRef(block.environment, expected ? objectRef(imageId, expected.id) : null)) return false;
  if (!expected) return true;
  const environment = await images.getLexicalEnvironment(imageId, expected.id);
  if (!environment) return false;
  return lexicalEnvironmentProjection(environment) === lexicalEnvironmentProjection(expected);
}

// Validate a program and every nested Block program it contains, publishing nothing. Lowering
// resolves a `block` op through a prototype map, so preflight supplies placeholders — the point is
// to reject an unknown op or a malformed nested program before any create-once artifact claims a
// deterministic id, not to produce executable output.
function validateProgramTree(program, imageId) {
  const v1 = methodRepresentation(program) === LAGRANGE_CODE_V1;
  if (v1) normalizeLagrangeCodeV1Program(program); else normalizeLagrangeCodeProgram(program);
  const nested = directNestedBlocks(program.body);
  const blockPrototypes = Object.fromEntries(
    nested.map(({blockId}) => [blockId, objectRef(imageId, 'preflight-placeholder')]),
  );
  if (v1) lowerLagrangeCodeV1(program, {blockPrototypes});
  else lowerLagrangeCodeV0(program, {blockPrototypes});
  for (const child of nested) validateProgramTree(child.program, imageId);
}

// THE CURRENT BINDING. What Block is bound at `{Class, selector}` right now is ONE question, so it
// has one answer here, whichever of the two ADR 0049 representations the record uses. Everything
// that needs it goes through this: the published-protocol reader the browse seam is built on
// (`selectorBindings` -> `methodBindings`/`methodBlockRef`), and the read-for-update the write
// planner uses before planning a definition and after a lost dictionary CAS.
//
// They used to be two implementations that disagreed. The write planner built its legacy map
// straight from `record.slots[...]` with no check on the value, while the browse reader refused any
// declared slot not holding an unpinned Block ref. On a malformed legacy dictionary that made the
// same class WRITABLE BUT UNBROWSABLE — and worse, a write rewrote the record carrying the
// malformed slot forward, making the corruption durable. A caller asking "what is bound here" got
// different answers depending on which owner it asked, which is a correctness problem the moment
// anything wants to REPLACE a binding (bead lagrange-images-jtz.2).
//
// The surviving rule is the stricter one, deliberately, so this reader is never a laxer way to read
// the same records than dispatch is. How it relates to dispatch differs BY REPRESENTATION, and the
// difference is worth stating exactly rather than generalising:
//
//   hashed   dispatch validates the WHOLE table (`validateMethodDictionary`), so it already refuses
//            a dictionary with any corrupt bucket — reader and dispatch refuse together.
//   legacy   dispatch validates only the slot for the selector being SENT, because it is answering
//            one send rather than describing a class, so it can still resolve a good selector in a
//            dictionary this reader refuses whole.
//
// Those are consistent, not contradictory: the invariant is that this reader never ACCEPTS what
// dispatch would reject, not that the two refuse identically.
//
// STILL A SEPARATE IMPLEMENTATION, and named here rather than left to be discovered: the migration
// reader (`smalltalk-method-dictionary-migration.js`) reads all of a legacy dictionary's bindings
// too, and `isLegacyMethodDictionary` (`smalltalk-kernel.js`) validates the shape of one. Their
// rules now MATCH this reader's, but they are not this function, so "one reader" is a claim about
// what the browse seam and the write planner share, not yet about the whole file.
async function currentSelectorBindings({images, dictionaryRef, record, nilRef}) {
  if (isMethodDictionary(record)) {
    const table = validateMethodDictionary(record, dictionaryRef, nilRef);
    return new Map(entriesFromBuckets(table.buckets).map(([selector, method]) => [selector.value, method]));
  }
  // The legacy branch owes the same corruption semantics as dispatch: a missing Shape is a dangling
  // edge rather than a miss, and duplicate selector names are refused rather than resolved
  // first-wins. Every declared slot is checked, not only the one a single-selector caller happened
  // to ask for, because this answers what the class binds.
  const shape = await images.getShape(record.shape.imageId, record.shape.objectId);
  if (!shape) throw new TypeError(`method dictionary shape not found: ${record.shape.objectId}`);
  assertUniqueSelectorShape(shape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  const bindings = new Map();
  for (const {id, name} of shape.slots) {
    const label = `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`;
    // ONE rule set, not one per representation. The hashed branch has always required a non-empty
    // selector and a LOCAL method ref (`validateMethodDictionary`), and so does the migration
    // reader; the legacy branch here required neither, which left the same asymmetry one field
    // over from the one this reader was unified to remove.
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`${label} selector must be non-empty text`);
    }
    const method = record.slots[id];
    if (!isObjectRef(method)) {
      throw new TypeError(`${label} slot for ${name} must contain an unpinned Block ref`);
    }
    if (method.imageId !== record.imageId) {
      throw new TypeError(
        `${label} slot for ${name} refers to ${method.imageId}/${method.objectId}, `
        + `which is not local to ${record.imageId}`,
      );
    }
    bindings.set(name, method);
  }
  return bindings;
}

// The write planner's read-for-update: the same current bindings, plus the representation facts it
// needs to plan the next write. The seal check stays here because it is a write-path rule — a
// sealed dictionary may still be READ and browsed, it may just not be written.
async function readMethodBindings({images, imageId, dictionaryRef, record}) {
  if (isSealed(record)) throw new SmalltalkSealedMethodDictionaryError(dictionaryRef);
  const hashed = isMethodDictionary(record);
  const dictionaryKernel = await findSmalltalkKernel({images, imageId});
  if (hashed && !dictionaryKernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  return {
    hashed,
    dictionaryKernel,
    merged: await currentSelectorBindings({
      images, dictionaryRef, record, nilRef: dictionaryKernel ? dictionaryKernel.nil : null,
    }),
  };
}

// EXPECTED CURRENT BINDING — "replace `foo`, but only if `foo` is still bound to exactly the Block
// I observed" (bead lagrange-images-qax, slice C1).
//
// This is the class builder's own optimistic-concurrency precondition, and it lives here for the
// same reason the CAS classification does: what is bound at `{Class, selector}` right now, what a
// changed definition is allowed to overwrite and what a lost dictionary CAS means are one owner's
// questions. A caller that wanted to express this outside the owner would have to read the binding,
// decide staleness and then hope nothing moved before its write — a second decider of the same rule
// and a race in the gap. Nothing about the precondition is authority-aware; an authorized wrapper
// supplies the observation it verified and adds no concurrency semantics of its own.
//
// It is deliberately NOT the same question as ADR 0086 convergence. Convergence asks "is the
// desired semantics already current"; the expectation asks "is the binding I SAW still current".
// Those differ exactly when someone else replaced the method with something that happens to match
// what this caller wanted, and that case must still be stale: the caller's observation history is
// what it holds, not its luck. So the precondition is checked BEFORE the exact-replay branch, and
// exact replay stays a write-free success only when the expectation ALSO holds — which is the
// genuine replay ADR 0086 decided, an identical definition against the state the caller read.
//
// A caller may supply the expectation for every method in the call or for none. Mixed is refused
// rather than interpreted: a call in which some positions are guarded and some are not has no
// single meaning for a lost CAS, and choosing one silently would be the owner inventing policy.
function readExpectedCurrentBindings({methods, imageId, allowRedefinition, operation}) {
  const expected = new Map();
  let guarded = 0;
  for (const {selector, expectedCurrent} of methods) {
    if (expectedCurrent === undefined || expectedCurrent === null) continue;
    guarded += 1;
    if (!allowRedefinition) {
      throw new TypeError(
        `${operation} does not accept expectedCurrent: an expected current binding is a `
        + 'replacement precondition, and defining a method is add-only',
      );
    }
    if (!isObjectRef(expectedCurrent) || expectedCurrent.imageId !== imageId) {
      throw new TypeError(`method ${selector} expectedCurrent must be an unpinned ref in ${imageId}`);
    }
    expected.set(selector, expectedCurrent);
  }
  if (guarded !== 0 && guarded !== methods.length) {
    throw new TypeError(
      `${operation} must supply expectedCurrent for every method in the call or for none; `
      + `${guarded} of ${methods.length} were guarded`,
    );
  }
  return expected;
}

// The lane a call compiles in, which for a GUARDED call is the lane of the revision it observed.
//
// ADR 0086 decision 1 makes `{Class/Metaclass, selector}` the logical position and the Block bound
// there the immutable current revision. A replacement says "make this position mean this source
// instead"; it does not say "and move it to a different execution representation". Execution-lane
// migration is a separate operation with its own policy, and there is none today — so this owner
// preserves what it finds and NEVER falls back to the other lane. If the observed lane cannot
// compile the replacement source, the replacement fails and the observed revision stays current;
// trying WASM and settling for neutral would perform silently the very migration E3 does not offer.
//
// One lane per call, because `installMethods` derives revision identity, exact replay and code
// production from a single lane. Two guarded positions whose observed revisions sit in different
// lanes therefore cannot both be preserved, and are refused rather than half-migrated. A caller
// that also NAMES a lane must name the observed one: any other value is a migration request.
async function replacementLane({images, classRef, expected, requested}) {
  if (expected.size === 0) return requested ?? 'neutral';
  let preserved = null;
  let preservedSelector = null;
  for (const [selector, block] of expected) {
    const lane = await installedMethodLane({images, classRef, selector, block});
    if (preserved !== null && lane !== preserved) {
      throw new SmalltalkMethodLaneError(
        `${classRef.imageId}/${classRef.objectId} cannot replace ${preservedSelector} and ${selector} `
        + `in one call: the revisions observed at those positions are in different execution lanes `
        + `(${preserved} and ${lane}), and replacement preserves the lane it finds`,
      );
    }
    preserved = lane;
    preservedSelector = selector;
  }
  if (requested !== undefined && requested !== preserved) {
    throw new SmalltalkMethodLaneError(
      `${classRef.imageId}/${classRef.objectId} ${preservedSelector} was observed in the ${preserved} `
      + `execution lane, so a replacement cannot be compiled in ${requested}; changing the execution `
      + 'lane of an existing method is not part of replacing its semantics',
    );
  }
  return preserved;
}

// Every guarded position, against the bindings just read. Applied at plan time and again at every
// rebase boundary, ALWAYS against the caller's original expectation — never against a binding
// observed later, which would silently refresh the assumption the caller is holding and turn an
// optimistic write into a blind one.
//
// An absent selector is stale too, not a fresh definition: the caller said it was replacing
// something it had seen.
function assertExpectedCurrentBinding({classRef, selector, expectedCurrent, bindings}) {
  if (!expectedCurrent) return;
  if (!sameRef(bindings.get(selector) ?? null, expectedCurrent)) {
    throw new SmalltalkStaleMethodPositionError(classRef, selector);
  }
}

function assertExpectedCurrentBindings({classRef, expected, bindings}) {
  for (const [selector, expectedCurrent] of expected) {
    assertExpectedCurrentBinding({classRef, selector, expectedCurrent, bindings});
  }
}

// What a lost CAS means for an UNGUARDED write, which is ADR 0086 decision 4 exactly: the backend
// remains authoritative for the conditional write; this reads the Behavior's CURRENT dictionary
// once and adopts only a complete semantic winner. There is deliberately no retry loop on this
// path. An unrelated/different winner is a visible Smalltalk-domain conflict and an explicit caller
// retry may start a fresh definition attempt.
//
// A write that supplied an expected current binding does NOT come here: it has a per-position
// precondition rather than a whole-dictionary one, so it rebases instead (`commitMethodDictionary`).
async function classifyLostMethodDictionaryCas({
  images, imageId, classRef, methods, capturesBySelector, lane,
}) {
  const {dictionaryRef: currentRef, existing: current, merged} =
    await readMethodDictionaryForUpdate({images, imageId, classRef});

  for (const {selector, program} of methods) {
    const installed = merged.get(selector);
    if (!installed) {
      throw new SmalltalkKernelConflictError('method dictionary', currentRef.imageId, currentRef.objectId);
    }
    if (!await isSameInstalledMethod({
      images,
      imageId,
      classRef,
      selector,
      program,
      captures: capturesBySelector.get(selector),
      lane,
      installed,
    })) {
      throw new SmalltalkMethodRedefinitionError(classRef, selector);
    }
  }
  return current;
}

// The Behavior's current method dictionary, read for update. One place, because a rebase after a
// lost CAS has to reread exactly what the first plan read — including the Behavior's methods edge,
// which a concurrent migration may have moved to a hashed dictionary.
async function readMethodDictionaryForUpdate({images, imageId, classRef}) {
  const behavior = await requireLocalBehavior(images, imageId, classRef, 'defineMethods class');
  const dictionaryRef = behavior.slots['behavior-methods'];
  const existing = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!existing) throw new TypeError(`method dictionary not found: ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  return {
    dictionaryRef,
    existing,
    ...await readMethodBindings({images, imageId, dictionaryRef, record: existing}),
  };
}

// The record this write would publish, derived from a COMPLETE selector -> Block map. Both ADR 0049
// representations are built from that one map, so rebuilding after a rebase differs from the first
// attempt only in which bindings the map holds.
async function methodDictionaryInput({
  images, imageId, classRef, dictionaryRef, existing, hashed, dictionaryKernel, bindings,
}) {
  // ADR 0049: a hashed dictionary carries its selector set in its own indexed part, so there is no
  // per-selector-set Shape to derive and no new Shape written per method.
  if (hashed) {
    const {buckets} = buildMethodBuckets(
      [...bindings.entries()].map(([selector, method]) => [textValue(selector), method]),
    );
    return {
      id: dictionaryRef.objectId,
      ...methodDictionaryRecordFields({
        buckets,
        shapeRef: objectRef(imageId, METHOD_DICTIONARY_SHAPE_ID),
        nilRef: dictionaryKernel.nil,
        metadata: existing.metadata,
      }),
    };
  }

  // The shape id encodes the canonical selector *set*, not its cardinality. Keying on the count
  // would make two unrelated one-selector dictionaries — say a failed `foo` and a later `bar` —
  // want the same durable id and conflict.
  // Sorted once, and used for BOTH the identity and the persisted slot array. Fingerprinting a
  // sorted list while building slots in insertion order would give [foo, bar] and [bar, foo] the
  // same shape id but different slot arrays, so ensureShape would reject the second description of
  // what is meant to be the same canonical selector set.
  const selectors = [...bindings.keys()].sort();
  const slots = methodDictionarySlots(selectors);
  // Injective, not probabilistic: this is durable identity, and the canonical selector array
  // encodes directly. A truncated digest would make two distinct selector sets collide with some
  // small probability, which is not a property durable ids should have.
  const fingerprint = base64urlEncode(utf8Encode(JSON.stringify(selectors)));
  const shape = await ensureShape(images, imageId, {
    id: `${methodsId(classRef.objectId)}/shape/${fingerprint}`,
    slots,
  });
  const bySelector = new Map(slots.map((slot) => [slot.name, slot.id]));
  return {
    id: dictionaryRef.objectId,
    shape: objectRef(imageId, shape.id),
    slots: Object.fromEntries(selectors.map((selector) => [bySelector.get(selector), bindings.get(selector)])),
    metadata: existing.metadata,
  };
}

// How many times a guarded write may REBASE onto an unrelated winner before reporting contention.
// Bounded and owner-local: unbounded retry would let one caller spin against a busy dictionary, and
// no retry at all would make an unrelated `bar` edit fail a `foo` replacement (see below).
// Deliberately NOT exported. This barrel is re-exported by `src/language/index.js` and thence by
// `src/runtime.js` and `src/index.js`, so a named export here lands on the package's published `.`
// and `./language` surfaces — an owner's private retry-tuning knob would become public API that
// cannot then be tuned without a break. The proof that a moved position is stale at the FINAL
// boundary MEASURES the terminal attempt instead of importing this number, which is also immune to
// a restructure of the loop's terminating comparison below.
const MAX_UNRELATED_REBASE_ATTEMPTS = 4;

// Publish the new bindings through the ONE MethodDictionary CAS, and own what losing it means.
//
// UNGUARDED (no expectedCurrent) — exactly ADR 0086 decision 4, unchanged: classify the winner once,
// adopt an identical one, refuse a divergent one, never retry.
//
// GUARDED — the storage CAS covers the WHOLE dictionary while the caller's precondition covers ONE
// selector position, and conflating the two is the defect this slice fixes. An unrelated actor
// binding `bar` moves the dictionary's version without touching `foo`, so treating that lost CAS as
// staleness would report a semantic conflict for a change that never reached the caller's position.
// So on a lost CAS this rereads through the same read-for-update, re-asserts the caller's ORIGINAL
// expectation, and — if it still holds — REBASES: the freshly read bindings are the base, this
// operation's published Blocks are laid over them, and the write is retried against the new version.
// Rebuilding from the stale map instead would republish `bar`'s old binding and silently destroy the
// unrelated winner.
//
// If the expectation has stopped holding at any boundary, that is a stale method position and the
// loop ends immediately — the winner at that position is never overwritten, and the expectation is
// never quietly refreshed to whatever is current now.
//
// COMPILATION HAS ALREADY PUBLISHED by the time this runs. The immutable revision material for the
// desired definition — the `:semantic` CodeArtifact, the derived code/WASM artifacts, the capture
// environment and the Block — was written before the final CAS, and a stale or exhausted outcome
// leaves it in the image, addressable but not current. That is ADR 0086's stated create-before-
// publication property and this slice adds no rollback or transaction to hide it. The load-bearing
// invariant is narrower and exact: a failed or stale replacement never makes its revision CURRENT.
async function commitMethodDictionary({
  images, imageId, classRef, methods, capturesBySelector, lane, expected, installedRefs, read,
}) {
  let attempt = read;
  for (let rebases = MAX_UNRELATED_REBASE_ATTEMPTS; ; rebases -= 1) {
    const input = await methodDictionaryInput({images, imageId, classRef, ...attempt});
    try {
      return await images.putObject(imageId, input, {expectedVersion: attempt.existing._version});
    } catch (error) {
      // Embedders may supply their own backend implementation through the public service seam, so
      // match the backend contract by error name rather than by this package's class identity.
      if (error?.name !== 'VersionConflictError') throw error;
      if (expected.size === 0) {
        return await classifyLostMethodDictionaryCas({
          images, imageId, classRef, methods, capturesBySelector, lane,
        });
      }
      // EVERY boundary re-asserts the expectation, INCLUDING THE LAST one. Checking the budget
      // first would leave exactly one lost CAS — the final one — unchecked, and a position that
      // moved on that attempt would be reported as contention: "the dictionary is busy" when the
      // truth is "your observation was overtaken". Contention may only be claimed once this reread
      // has proven the guarded position is still exactly what the caller observed.
      const current = await readMethodDictionaryForUpdate({images, imageId, classRef});
      assertExpectedCurrentBindings({classRef, expected, bindings: current.merged});
      // Only now is it true that the guarded position never moved and nothing about the request is
      // wrong — the dictionary is simply being written faster than this operation can rebase.
      if (rebases <= 0) throw new SmalltalkMethodDictionaryContentionError(attempt.dictionaryRef);
      for (const [selector, method] of installedRefs) current.merged.set(selector, method);
      attempt = {...current, bindings: current.merged};
    }
  }
}

// Installing or reconciling a method rewrites the dictionary (and the legacy representation's
// shape), per ADR 0044 decision 2 — visible and confined to one object kind. The Behavior itself is
// untouched, which is the point of giving it a fixed shape.
async function installMethods({
  images,
  compilation,
  imageId,
  classRef,
  methods,
  lane: requestedLane,
  allowRedefinition,
  operation,
} = {}) {
  // Caller-owned input, and deliberately still a bare TypeError with its existing wording: ten
  // sibling protocol installers spell this same check, and renaming one of them is a separate
  // cleanup. `SmalltalkMethodLaneError` answers a different question — what lane an ALREADY
  // INSTALLED revision is in — which no caller supplied.
  if (requestedLane !== undefined && !isMethodLane(requestedLane)) {
    throw new TypeError(`unknown method lane: ${requestedLane}`);
  }
  requiredText(imageId, 'image id');
  if (!Array.isArray(methods) || methods.length === 0) throw new TypeError('methods must be a non-empty array');
  // Caller-supplied input first, before anything is read: a malformed or mixed expectation is a
  // malformed CALL, and diagnosing it must not depend on what the image currently holds.
  const expected = readExpectedCurrentBindings({methods, imageId, allowRedefinition, operation});

  // Whichever representation the record says it is. Both are readable throughout migration, so a
  // class that has not been migrated keeps accepting methods exactly as before.
  const read = await readMethodDictionaryForUpdate({images, imageId, classRef});
  const {existing, merged} = read;
  // Which lane a REPLACEMENT compiles in (bead lagrange-images-it3), decided here because this is
  // where the lane is already used for revision identity, exact replay and Block/code production.
  //
  // `expected` and never `merged`, deliberately, even though the current bindings are now in hand:
  // the lane to preserve belongs to the immutable revision the caller told this owner it SAW.
  // Taking it from the current binding would refresh half of the caller's assumption while still
  // enforcing the other half, and on a moved position would compile against a lane nobody observed.
  // An unguarded call has nothing to preserve and keeps the requested lane, or the neutral default
  // it always had.
  const lane = await replacementLane({images, classRef, expected, requested: requestedLane});

  // Preflight covers duplicates *within this call* as well as against what is stored: two new
  // entries naming the same selector would otherwise both pass and the second silently win.
  // Plan every method before publishing any of it. The `:semantic` artifact is create-once at a
  // deterministic id, so writing it before the body has been validated would let a bad program
  // occupy that selector's id permanently — correcting the program and retrying would then be a
  // conflict rather than a fix. Validation is pure, so it costs nothing to do first.
  const incoming = new Set();
  const alreadyInstalled = new Set();
  const capturesBySelector = new Map();
  for (const {selector, program, captures = []} of methods) {
    requiredText(selector, 'selector');
    if (incoming.has(selector)) {
      throw new TypeError(`${operation} declares ${selector} twice in one call`);
    }
    incoming.add(selector);
    capturesBySelector.set(selector, normalizeMethodCaptures(selector, program, captures));
    // BEFORE the exact-replay branch below, deliberately. A guarded caller that observed A and asks
    // for C must be refused when someone else has already moved the position to B — INCLUDING when
    // that B happens to mean the same thing as C. Checking convergence first would silently report
    // success for a replacement that never applied and was never even needed, erasing the one fact
    // an optimistic write exists to detect. Nothing has been published at this point, so a plan-time
    // refusal leaves no new immutable material behind at all.
    assertExpectedCurrentBinding({
      classRef, selector, expectedCurrent: expected.get(selector), bindings: merged,
    });
    if (merged.has(selector)) {
      // A lost acknowledgement leaves the dictionary already updated while the caller believes it
      // failed, so an identical definition must be an idempotent success. Only a different program
      // or lane for an existing selector is replacement.
      if (await isSameInstalledMethod({
        images, imageId, classRef, selector, program,
        captures: capturesBySelector.get(selector), lane, installed: merged.get(selector),
      })) {
        alreadyInstalled.add(selector);
        continue;
      }
      if (!allowRedefinition) throw new SmalltalkMethodRedefinitionError(classRef, selector);
    }
    // Walks the body, so an unknown op is rejected here rather than during compilation — after the
    // create-once `:semantic` artifact has already claimed the selector's deterministic id.
    //
    // Nested Block literals are validated the same way, level by level, against placeholder
    // prototypes: lowering needs *a* prototype per nested block id to check the surrounding body,
    // and nothing may be published before the whole tree is known to be valid.
    validateProgramTree(program, imageId);
    // Lane restrictions are part of validity too, and the backends decide them from the program
    // alone — so a program the WASM lane cannot compile is rejected before anything is written.
    if (lane === 'wasm' && methodRepresentation(program) === LAGRANGE_CODE_V0
      && directNestedBlocks(program.body).length === 0) {
      try {
        compileWasmModule(program);
      } catch (error) {
        if (!isWasmTailEffectRestrictionError(error)) throw error;
        compileResumableWasmModule(program);
      }
    }
  }

  if (alreadyInstalled.size === methods.length) return existing;

  const installedRefs = new Map();
  for (const {selector, program} of methods) {
    if (alreadyInstalled.has(selector)) continue;
    const captures = capturesBySelector.get(selector);
    const id = merged.has(selector)
      ? methodRevisionId(classRef.objectId, selector, program, captures, lane)
      : methodId(classRef.objectId, selector);
    const semantic = await ensureCodeArtifact(images, imageId, {
      id: `${id}:semantic`,
      languageId: SYMMETRIC_SMALLTALK_ID,
      representation: methodRepresentation(program),
      content: textValue(JSON.stringify(program)),
      metadata: {smalltalk: 'method', selector},
    });
    // ADR 0044 decision 6: one semantic method, an executable Block derived per lane. The WASM
    // lane's Block points at a wasm-function artifact, not at the module it references.
    // Written before the code, because the WASM tree installer publishes the method's Block itself
    // and therefore needs the environment its captures resolve through.
    const desiredEnvironment = describeMethodEnvironment({methodObjectId: id, selector, captures});
    const environment = desiredEnvironment === null
      ? null
      : await ensureLexicalEnvironment(images, imageId, desiredEnvironment);
    const environmentRef = environment ? objectRef(imageId, environment.id) : null;

    const representation = methodRepresentation(program);
    const semanticRef = objectRef(imageId, semantic.id);
    const nested = directNestedBlocks(program.body).length > 0;

    // A method with nested Block literals goes through the same publication the standalone Block
    // installer uses: one recursive implementation, deterministic ids derived from this method's own
    // id, and every write ensure-exact-or-create so a partial install converges on retry.
    //
    // The WASM lane hands the whole tree to `installWasmBlockTree`, which already plans a shared
    // module for a nested tree and already dispatches on v0 vs v1. Publishing the method's own Block
    // through it keeps one tree planner rather than a second one that only methods use.
    let codeRef = null;
    let treeBlock = null;
    if (lane === 'wasm' && nested) {
      treeBlock = (await installWasmBlockTree({
        images,
        compilation,
        semanticRef,
        id,
        environment: environmentRef,
        metadata: {smalltalk: 'method', selector, lane},
      })).block;
    } else {
      const blockPrototypes = nested
        ? await installNestedPrototypes({
          images, compilation, imageId, rootId: id, parentSemanticRef: semanticRef, program, representation,
        })
        : {};
      codeRef = lane === 'wasm'
        ? await ensureWasmFunction({images, compilation, imageId, id, semanticRef, representation})
        : await ensureNeutralCode({
          images,
          compilation,
          imageId,
          id,
          semanticRef,
          target: representation === LAGRANGE_CODE_V1 ? NEUTRAL_EXPRESSION_V1 : NEUTRAL_EXPRESSION_V0,
          blockPrototypes,
        });
    }
    // The tree installer already published the method's Block; otherwise publish it here.
    const block = treeBlock ?? await ensureBlock(images, imageId, {
      id,
      code: codeRef,
      environment: environmentRef,
      metadata: {smalltalk: 'method', selector, lane},
    });
    // What this operation wants bound, kept separately from the planning snapshot. A rebase after a
    // lost CAS lays exactly these over FRESHLY read bindings; replaying the whole snapshot instead
    // would carry every unrelated selector's stale binding back over an unrelated winner.
    installedRefs.set(selector, objectRef(imageId, block.id));
    merged.set(selector, objectRef(imageId, block.id));
  }

  return await commitMethodDictionary({
    images,
    imageId,
    classRef,
    methods,
    capturesBySelector,
    lane,
    expected,
    installedRefs,
    read: {...read, bindings: merged},
  });
}

async function defineMethods(options = {}) {
  return await installMethods({
    ...options,
    allowRedefinition: false,
    operation: 'defineMethods',
  });
}

// Native method evolution, owned at the same boundary as selector definition and the dictionary
// CAS. Exact current semantics are a write-free success; changed semantics publish immutable
// revision material and move the one authoritative selector binding. The importer only requests
// this operation and owns none of its identity, history or concurrency decisions.
//
// A method entry may carry `expectedCurrent`: the binding the caller OBSERVED at that position,
// which this owner then requires to still be current — at plan time and again at every rebase
// boundary — before the position advances. Unguarded calls (the importer's, and every existing
// caller) behave exactly as they did. The guarded form is a trusted internal operation with no
// authority of its own; a later authorized wrapper supplies an observation it has verified and adds
// no concurrency semantics, because all of them are here.
async function reconcileMethods(options = {}) {
  return await installMethods({
    ...options,
    allowRedefinition: true,
    operation: 'reconcileMethods',
  });
}

// Every selector a Behavior's OWN method dictionary binds, read through whichever representation
// that dictionary actually uses. ADR 0049 makes two of those legal at once, so anything that reaches
// into a method dictionary should ask rather than assume a layout — and there is ONE such reader,
// so a caller that asks "which selectors" and a caller that asks "which Block for this selector"
// cannot disagree about what a class implements.
//
// Inheritance is deliberately absent. This answers what THIS Behavior implements; an inherited
// selector belongs to the Behavior that declares it and is read from there. The lookup walk
// (smalltalk-lookup.js) remains the sole owner of what a SEND resolves to.
//
// `behavior` is an optional already-read (and already-validated) Behavior, so a caller that has just
// read the Class record for its own reasons describes it from ONE read rather than reading it again
// here — the same single-read discipline the authorized Project read keeps.
async function selectorBindings({images, imageId, classRef, behavior: readAlready = null}) {
  const behavior = readAlready ?? await readBehavior(images, classRef);
  const dictionaryRef = behavior.methods;
  const record = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!record) throw new TypeError(`method dictionary not found: ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  // A sealed dictionary is readable: sealing forbids writing it, not describing it.
  return await currentSelectorBindings({images, dictionaryRef, record, nilRef: kernel.nil});
}

// The Block installed for a selector on a class. `null` is an ordinary "this class does not
// implement it", never a way to read a corrupt dictionary quietly.
async function methodBlockRef({images, imageId, classRef, selector, behavior = null} = {}) {
  requiredText(selector, 'selector');
  return (await selectorBindings({images, imageId, classRef, behavior})).get(selector) ?? null;
}

// The selectors a class itself implements, in canonical (sorted) order, each with the exact Block
// ref it is bound to. Sorted here rather than in storage order because bucket/slot order is a
// representation artifact and no caller may come to depend on it.
//
// This is the class builder's public answer to "what does this class implement": the MethodDictionary
// representation, its buckets and its slot ids stay private to this owner.
async function methodBindings({images, imageId, classRef, behavior = null} = {}) {
  const bindings = await selectorBindings({images, imageId, classRef, behavior});
  return Object.freeze([...bindings.keys()].sort().map((selector) => Object.freeze({
    selector,
    method: bindings.get(selector),
  })));
}

// Ensure-exact-or-create for a Smalltalk instance Shape. One implementation, because "the same
// layout" has to mean one thing: a Shape carrying the right slots but a different indexed
// declaration is a different layout, and adopting it would silently change what its instances are.
async function ensureSmalltalkShape(images, imageId, desired) {
  const shape = await ensureRecordShape(images, imageId, desired, {
    conflict: (kind, image, id) => new SmalltalkKernelConflictError(kind, image, id),
  });
  return objectRef(imageId, shape.id);
}

// A declaration names local instance variables; it does not choose durable slot or Shape ids.
// Initial slot identity belongs to the native class owner and follows from the defining Class
// identity plus the declared name. The name remains a separate Shape field: a later rename is an
// explicit migration that preserves this id, never a second declaration inferred to be equivalent.
const declaredInstanceShapeId = (classObjectId) => `${classObjectId}/instance-shape`;
const declaredInstanceSlotId = (classObjectId, name) =>
  `${classObjectId}/instance-slot/${base64urlEncode(utf8Encode(name))}`;

function normalizeLocalInstanceVariables(instanceVariables) {
  if (!Array.isArray(instanceVariables)) throw new TypeError('instanceVariables must be an array of names');
  const seen = new Set();
  return instanceVariables.map((name) => {
    requiredText(name, 'instance variable name');
    if (seen.has(name)) throw new TypeError(`duplicate local instance variable: ${name}`);
    seen.add(name);
    return name;
  });
}

// Build an instantiable native class from language declarations while keeping Shape admission and
// class convergence in their existing owners. The caller supplies local names only. This owner
// validates the superclass graph, preserves the nearest complete inherited layout, assigns initial
// stable slot identities, and publishes the resulting immutable Shape before asking the ordinary
// named-class owner to create or rediscover the Class/Metaclass pair.
async function ensureClassFromDeclaration({
  images,
  imageId,
  name,
  superclassRef = null,
  instanceVariables = [],
} = {}) {
  requiredText(name, 'class name');
  requiredText(imageId, 'image id');
  const localNames = normalizeLocalInstanceVariables(instanceVariables);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const superclass = superclassRef ?? kernel.objectClass;

  // Match defineClass's pre-write checks before admitting a declaration Shape. A malformed direct
  // superclass or metaclass must not leave even unreferenced immutable material behind.
  const superBehavior = await requireLocalBehavior(
    images, imageId, superclass, 'ensureClassFromDeclaration superclass',
  );
  await requireLocalBehavior(
    images, imageId, superBehavior.behavior, 'ensureClassFromDeclaration superclass metaclass',
  );

  const inherited = await nearestDeclaredInstanceShape({
    images, superclassRef: superclass, nilRef: kernel.nil, name,
  });
  const inheritedNames = new Set();
  for (const {name: inheritedName} of inherited?.slots ?? []) {
    if (inheritedNames.has(inheritedName)) {
      throw new TypeError(
        `ensureClassFromDeclaration ${name} inherited instance shape declares duplicate slot name: ${inheritedName}`,
      );
    }
    inheritedNames.add(inheritedName);
  }
  for (const localName of localNames) {
    if (inheritedNames.has(localName)) {
      throw new TypeError(`class ${name} duplicates inherited instance variable: ${localName}`);
    }
  }

  let instanceShapeRef;
  if (localNames.length === 0) {
    // No new layout means reuse the inherited Shape exactly. At the root, the kernel's explicit
    // empty Shape makes a zero-slot declaration instantiable without minting a duplicate layout.
    instanceShapeRef = inherited
      ? objectRef(inherited.imageId, inherited.id)
      : objectRef(imageId, EMPTY_SHAPE_ID);
  } else {
    const classObjectId = `smalltalk/class/${name}`;
    const slots = [
      ...(inherited?.slots ?? []),
      ...localNames.map((localName) => ({
        id: declaredInstanceSlotId(classObjectId, localName),
        name: localName,
      })),
    ];
    instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
      id: declaredInstanceShapeId(classObjectId),
      slots,
      ...(inherited && shapeIndexedKind(inherited) === SHAPE_INDEXED.VALUES
        ? {indexed: SHAPE_INDEXED.VALUES}
        : {}),
    });
  }

  return await ensureNamedClass({
    images, imageId, name, superclassRef: superclass, instanceShapeRef,
  });
}

// Define a class, or rediscover one and validate its whole immutable definition.
//
// `defineClass` alone is not usable for rediscovery: it also ensures an *empty* method dictionary,
// which conflicts once methods have been published. So rediscovery checks everything that cannot
// change — names, the class/metaclass behavior edges, superclass, both instance Shapes — and
// deliberately excludes the method dictionary, which is the mutable part with its own retry-safe
// installer. Carrying the right instance Shape is not the same as being this class.
async function ensureNamedClass({images, imageId, name, superclassRef = null, instanceShapeRef = null, metaclassInstanceShapeRef = null} = {}) {
  requiredText(name, 'class name');
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const classRef = objectRef(imageId, `smalltalk/class/${name}`);
  const metaclassRef = objectRef(imageId, `smalltalk/metaclass/${name}`);
  const superclass = superclassRef ?? kernel.objectClass;
  const instanceShape = instanceShapeRef ?? kernel.nil;
  const metaclassInstanceShape = metaclassInstanceShapeRef ?? kernel.nil;

  const existing = await images.getObject(imageId, classRef.objectId);
  if (!existing) {
    const defined = await defineClass({images, imageId, name, superclassRef: superclass, instanceShapeRef, metaclassInstanceShapeRef});
    return Object.freeze({classRef: defined.classRef, metaclassRef: defined.metaclassRef});
  }

  const conflict = () => new SmalltalkKernelConflictError('class', imageId, classRef.objectId);
  let behavior;
  let metaclass;
  try {
    behavior = await readBehavior(images, classRef);
    metaclass = await readBehavior(images, metaclassRef);
  } catch (error) {
    throw new SmalltalkKernelConflictError('class', imageId, classRef.objectId, {cause: error});
  }
  if (behavior.name.value !== name || metaclass.name.value !== `${name} class`) throw conflict();
  // `defineClass` writes this deterministically, so it is part of what "the same class" means. The
  // method dictionary is excluded above because it has a legitimate lifecycle of its own; metadata
  // has none.
  if (canonicalJson(behavior.record.metadata) !== canonicalJson({smalltalk: 'behavior', name})) throw conflict();
  if (canonicalJson(metaclass.record.metadata) !== canonicalJson({smalltalk: 'behavior', name: `${name} class`})) {
    throw conflict();
  }
  if (!sameRef(behavior.record.behavior, metaclassRef)) throw conflict();
  if (!sameRef(behavior.superclass, superclass)) throw conflict();
  if (!sameRef(behavior.instanceShape, instanceShape)) throw conflict();

  const superBehavior = await readBehavior(images, superclass);
  if (!sameRef(metaclass.record.behavior, kernel.metaclassClass)) throw conflict();
  if (!sameRef(metaclass.superclass, superBehavior.record.behavior)) throw conflict();
  if (!sameRef(metaclass.instanceShape, metaclassInstanceShape)) throw conflict();

  // Class/Metaclass publication precedes hierarchy maintenance in defineClass. If an interruption
  // lands between them, immutable rediscovery is not complete until the existing registry owner
  // has repaired both this class's registry and its superclass membership. The registry owner
  // retains all validation, CAS classification and idempotence policy.
  await maintainSubclassRegistries({
    images,
    imageId,
    className: name,
    classRef,
    superclassRef: superclass,
    nilRef: kernel.nil,
  });
  return Object.freeze({classRef, metaclassRef});
}

// A new class and its metaclass, wired by decision 4's chain rule. The installer applies the same
// rule with forward references, because its objects do not resolve until the whole graph exists;
// here the superclass already resolves, so its metaclass is read from it. Two encodings of one
// invariant, which is why both are proven rather than only asserted.
// ADR 0046 decision 4: `instanceShape` is the *complete* immutable layout of an instance, inherited
// slots included, so allocation never reconstructs it by walking superclasses. Composition is this
// path's job, and the check is by stable slot **id** — a renamed slot with a preserved id is still
// the same slot, while two slots sharing a name and differing in id are two different slots.
// The nearest ancestor that actually declares a layout, which is not always the direct superclass.
// A non-instantiable class in the middle of a chain — `instanceShape` of `nil` — declares no layout
// of its own but does not cancel the one above it: its subclasses still inherit every method of
// every ancestor, so their instances still need every ancestor's slots. Stopping at the direct
// superclass would let one `nil` link silently erase the invariant for everything below it.
//
// `null` means exactly one thing: the walk reached the kernel's `nil` terminator having found no
// declared layout. Every other outcome raises. A corrupt chain must not be reported as "nothing to
// inherit", because that is indistinguishable from the legitimate answer and would let a subclass
// publish while the invariant it claims was never actually checked. Only the *direct* superclass has
// been validated by the caller, so every ancestor above it is validated here rather than read as a
// raw record.
async function nearestDeclaredInstanceShape({images, superclassRef, nilRef, name}) {
  const visited = new TupleSet(2);
  let currentRef = superclassRef;

  while (!sameRef(currentRef, nilRef)) {
    if (!isObjectRef(currentRef)) {
      throw new TypeError(`defineClass ${name} superclass chain contains a non-ref superclass edge`);
    }
    const key = [currentRef.imageId, currentRef.objectId];
    if (visited.has(key)) {
      throw new TypeError(
        `defineClass ${name} superclass chain has a cycle at ${currentRef.imageId}/${currentRef.objectId}; `
        + 'the inherited instance layout cannot be determined',
      );
    }
    visited.add(key);

    const record = await images.getObject(currentRef.imageId, currentRef.objectId);
    if (!record) {
      throw new TypeError(
        `defineClass ${name} superclass chain has a dangling edge to `
        + `${currentRef.imageId}/${currentRef.objectId}; the inherited instance layout cannot be determined`,
      );
    }
    let ancestor;
    try {
      // readBehavior, not isBehaviorObject: the walk relies on `superclass` and `instanceShape`
      // being local unpinned refs, which is exactly what it validates.
      ancestor = await readBehavior(images, currentRef);
    } catch (error) {
      throw new TypeError(
        `defineClass ${name} superclass chain reaches a malformed Behavior at `
        + `${currentRef.imageId}/${currentRef.objectId}`,
        {cause: error},
      );
    }

    if (!sameRef(ancestor.instanceShape, nilRef)) {
      const shape = await images.getShape(ancestor.instanceShape.imageId, ancestor.instanceShape.objectId);
      if (!shape) {
        throw new TypeError(
          `defineClass ${name} superclass ${currentRef.imageId}/${currentRef.objectId} has a dangling `
          + `instanceShape: ${ancestor.instanceShape.imageId}/${ancestor.instanceShape.objectId}`,
        );
      }
      return shape;
    }
    currentRef = ancestor.superclass;
  }
  return null;
}

async function requireInstanceShape({images, imageId, instanceShapeRef, superclassRef, name, nilRef}) {
  if (!isObjectRef(instanceShapeRef) || instanceShapeRef.imageId !== imageId) {
    throw new TypeError(`defineClass instanceShape must be an unpinned ref in ${imageId}`);
  }
  const shape = await images.getShape(instanceShapeRef.imageId, instanceShapeRef.objectId);
  if (!shape) {
    throw new TypeError(`defineClass instanceShape not found: ${instanceShapeRef.imageId}/${instanceShapeRef.objectId}`);
  }

  // Slot ids are identity; slot names are how instance variables will be read. Generic Shapes
  // deliberately permit duplicate names — `normalizeShapeSlots` checks ids only — so uniqueness is
  // an instance-shape invariant checked here, exactly as selector uniqueness is a MethodDictionary
  // invariant rather than a generic Shape one. Without it, a subclass slot named like an inherited
  // one makes name-based access resolve by position.
  const names = new Set();
  for (const {name: slotName} of shape.slots) {
    if (names.has(slotName)) {
      throw new TypeError(`defineClass ${name} instance shape declares duplicate slot name: ${slotName}`);
    }
    names.add(slotName);
  }

  const inherited = await nearestDeclaredInstanceShape({images, superclassRef, nilRef, name});
  if (!inherited) return instanceShapeRef;
  const declared = new Set(shape.slots.map(({id}) => id));
  const missing = inherited.slots.map(({id}) => id).filter((id) => !declared.has(id));
  if (missing.length > 0) {
    throw new TypeError(
      `defineClass ${name} instance shape drops inherited slot ids: ${missing.join(', ')}; `
      + 'an instance shape is the complete layout, including everything inherited',
    );
  }
  // ADR 0047 extends the same complete-layout rule to the indexed declaration. A subclass may add
  // indexed storage to a non-indexed ancestor, but once inherited it remains part of every concrete
  // descendant layout, including across a nil-instanceShape class skipped by the ancestor walk.
  if (
    shapeIndexedKind(inherited) === SHAPE_INDEXED.VALUES
    && shapeIndexedKind(shape) !== SHAPE_INDEXED.VALUES
  ) {
    throw new TypeError(
      `defineClass ${name} instance shape drops the inherited indexed values declaration; `
      + 'an instance shape is the complete layout, including indexed storage',
    );
  }
  return instanceShapeRef;
}

async function defineClass({images, imageId, name, superclassRef = null, instanceShapeRef = null, metaclassInstanceShapeRef = null} = {}) {
  requiredText(name, 'class name');
  requiredText(imageId, 'image id');
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const ref = (objectId) => objectRef(imageId, objectId);
  const superclass = superclassRef ?? kernel.objectClass;

  // Validated before any write, so a foreign or malformed superclass cannot create a class that
  // dispatch will later refuse.
  const superBehavior = await requireLocalBehavior(images, imageId, superclass, 'defineClass superclass');
  const superMetaclass = superBehavior.behavior;
  await requireLocalBehavior(images, imageId, superMetaclass, 'defineClass superclass metaclass');

  // Omission keeps the pre-0046 meaning and stores `nil`, so every class already in an image stays
  // exactly as non-instantiable as it was. Reinterpreting a stored `nil` as the empty Shape would be
  // migration by interpretation — the same thing decision 8 of ADR 0044 forbids for `{unbound}`.
  const instanceShape = instanceShapeRef === null
    ? kernel.nil
    : await requireInstanceShape({images, imageId, instanceShapeRef, superclassRef: superclass, name, nilRef: kernel.nil});

  // Class-instance variables: when supplied, the metaclass gets a real instance shape so
  // class-side methods can access per-class state. Default nil means no class-instance state,
  // which is what every class in an image has today. An explicitly supplied metaclass instance
  // shape obeys the SAME complete inherited-slot-id rule as an ordinary instance shape: a subclass
  // may extend the class-instance layout but must not drop inherited class-instance slots.
  const metaclassInstanceShape = metaclassInstanceShapeRef === null
    ? kernel.nil
    : await requireInstanceShape({
      images, imageId, instanceShapeRef: metaclassInstanceShapeRef,
      superclassRef: superMetaclass, name: `${name} class`, nilRef: kernel.nil,
    });

  await ensureMethodDictionaryShape(images, imageId);
  const classObjectId = `smalltalk/class/${name}`;
  const metaclassObjectId = `smalltalk/metaclass/${name}`;

  // The metaclass keeps `nil` unless a metaclass instance shape is explicitly supplied.
  for (const [id, behaviorName, superRef, behaviorRef, shapeRef] of [
    [metaclassObjectId, `${name} class`, superMetaclass, kernel.metaclassClass, metaclassInstanceShape],
    [classObjectId, name, superclass, ref(metaclassObjectId), instanceShape],
  ]) {
    await ensureEmptyMethodDictionary(images, imageId, methodsId(id), {owner: id}, kernel.nil);
    await ensureObject(images, imageId, {
      id,
      shape: ref(BEHAVIOR_SHAPE_ID),
      behavior: behaviorRef,
      slots: {
        'behavior-name': textValue(behaviorName),
        'behavior-superclass': superRef,
        'behavior-methods': ref(methodsId(id)),
        'behavior-instance-shape': shapeRef,
      },
      metadata: {smalltalk: 'behavior', name: behaviorName},
    });
  }

  // Companion lifecycle is production behavior, not fixture setup. When this class has a visible
  // class-instance layout — its own or inherited — ensure a per-class companion exists. A subclass
  // inheriting the layout needs its own companion even when it declares no new class-instance
  // variables. Rediscovery preserves any values already written. The companion's shape is the
  // *visible* class-instance layout: the explicit shape when supplied, else the nearest inherited
  // one (whose ref we recover from the ancestor that declared it).
  let companionShapeRef = null;
  if (metaclassInstanceShapeRef !== null) {
    companionShapeRef = metaclassInstanceShape; // a ref, already validated complete-inherited
  } else {
    const inheritedLayout = await nearestDeclaredInstanceShape({
      images, superclassRef: superMetaclass, nilRef: kernel.nil, name: `${name} class`,
    });
    if (inheritedLayout) companionShapeRef = objectRef(inheritedLayout.imageId ?? imageId, inheritedLayout.id);
  }
  if (companionShapeRef) {
    await ensureClassStateCompanion({
      images, imageId, classRef: ref(classObjectId), classInstanceShapeRef: companionShapeRef,
    });
  }

  // Class-hierarchy introspection: register the CLASS object's superclass edge (never the
  // metaclass's derived one) in the superclass's durable subclass registry, and ensure this
  // class's own empty registry. The registry Shape is ensured lazily for bootstrap, while the
  // registry owner validates every deterministic-id occupant and classifies one lost append CAS;
  // malformed or divergent state is a Smalltalk-domain conflict and is never overwritten.
  await maintainSubclassRegistries({
    images,
    imageId,
    className: name,
    classRef: ref(classObjectId),
    superclassRef: superclass,
    nilRef: kernel.nil,
  });
  return Object.freeze({classRef: ref(classObjectId), metaclassRef: ref(metaclassObjectId)});
}

export {
  SmalltalkMethodDictionaryContentionError,
  SmalltalkMethodLaneError,
  SmalltalkMethodRedefinitionError,
  SmalltalkSealedMethodDictionaryError,
  SmalltalkStaleMethodPositionError,
  defineClass,
  defineMethods,
  reconcileMethods,
  ensureBlock,
  ensureClassFromDeclaration,
  ensureNamedClass,
  ensureSmalltalkShape,
  methodBindings,
  methodBlockRef,
  ensureCodeArtifact,
};
