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

// Read whichever MethodDictionary representation the Behavior currently names and expose its
// selector bindings under the class builder's one semantic view. This is used both before planning
// a definition and after a lost dictionary CAS, so winner classification cannot drift from the
// definition-time duplicate/replay rule.
async function readMethodBindings({images, imageId, dictionaryRef, record}) {
  if (isSealed(record)) throw new SmalltalkSealedMethodDictionaryError(dictionaryRef);
  const hashed = isMethodDictionary(record);
  const dictionaryKernel = await findSmalltalkKernel({images, imageId});
  if (hashed && !dictionaryKernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  if (hashed) {
    const table = validateMethodDictionary(record, dictionaryRef, dictionaryKernel.nil);
    return {
      hashed,
      dictionaryKernel,
      merged: new Map(entriesFromBuckets(table.buckets).map(([selector, method]) => [selector.value, method])),
    };
  }

  const existingShape = await images.getShape(record.shape.imageId, record.shape.objectId);
  if (!existingShape) throw new TypeError(`method dictionary shape not found: ${record.shape.objectId}`);
  assertUniqueSelectorShape(existingShape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  return {
    hashed,
    dictionaryKernel,
    merged: new Map(existingShape.slots.map((slot) => [slot.name, record.slots[slot.id]])),
  };
}

// The backend remains authoritative for the conditional write. The class builder owns what a lost
// CAS means: reread the Behavior's CURRENT dictionary once, then adopt only a complete semantic
// winner. There is deliberately no internal retry loop. An unrelated/different winner is a visible
// Smalltalk-domain conflict and an explicit caller retry may start a fresh definition attempt.
async function classifyLostMethodDictionaryCas({
  images, imageId, classRef, methods, capturesBySelector, lane,
}) {
  const currentBehavior = await requireLocalBehavior(images, imageId, classRef, 'defineMethods class');
  const currentRef = currentBehavior.slots['behavior-methods'];
  const current = await images.getObject(currentRef.imageId, currentRef.objectId);
  if (!current) throw new TypeError(`method dictionary not found: ${currentRef.imageId}/${currentRef.objectId}`);
  const {merged} = await readMethodBindings({images, imageId, dictionaryRef: currentRef, record: current});

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

async function putMethodDictionary({
  images, imageId, classRef, methods, capturesBySelector, lane, input, expectedVersion,
}) {
  try {
    return await images.putObject(imageId, input, {expectedVersion});
  } catch (error) {
    // Embedders may supply their own backend implementation through the public service seam, so
    // match the backend contract by error name rather than by this package's class identity.
    if (error?.name !== 'VersionConflictError') throw error;
    return await classifyLostMethodDictionaryCas({
      images, imageId, classRef, methods, capturesBySelector, lane,
    });
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
  lane = 'neutral',
  allowRedefinition,
  operation,
} = {}) {
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  requiredText(imageId, 'image id');
  if (!Array.isArray(methods) || methods.length === 0) throw new TypeError('methods must be a non-empty array');
  const behavior = await requireLocalBehavior(images, imageId, classRef, 'defineMethods class');

  const dictionaryRef = behavior.slots['behavior-methods'];
  const existing = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!existing) throw new TypeError(`method dictionary not found: ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);

  // Whichever representation the record says it is. Both are readable throughout migration, so a
  // class that has not been migrated keeps accepting methods exactly as before.
  const {hashed, dictionaryKernel, merged} = await readMethodBindings({
    images, imageId, dictionaryRef, record: existing,
  });

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
    merged.set(selector, objectRef(imageId, block.id));
  }

  // ADR 0049: a hashed dictionary carries its selector set in its own indexed part, so there is no
  // per-selector-set Shape to derive and no new Shape written per method.
  if (hashed) {
    const kernel = dictionaryKernel;
    const {buckets} = buildMethodBuckets([...merged.entries()].map(([selector, method]) => [textValue(selector), method]));
    return await putMethodDictionary({
      images,
      imageId,
      classRef,
      methods,
      capturesBySelector,
      lane,
      expectedVersion: existing._version,
      input: {
        id: dictionaryRef.objectId,
        ...methodDictionaryRecordFields({
          buckets,
          shapeRef: objectRef(imageId, METHOD_DICTIONARY_SHAPE_ID),
          nilRef: kernel.nil,
          metadata: existing.metadata,
        }),
      },
    });
  }

  // The shape id encodes the canonical selector *set*, not its cardinality. Keying on the count
  // would make two unrelated one-selector dictionaries — say a failed `foo` and a later `bar` —
  // want the same durable id and conflict.
  // Sorted once, and used for BOTH the identity and the persisted slot array. Fingerprinting a
  // sorted list while building slots in insertion order would give [foo, bar] and [bar, foo] the
  // same shape id but different slot arrays, so ensureShape would reject the second description of
  // what is meant to be the same canonical selector set.
  const selectors = [...merged.keys()].sort();
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

  return await putMethodDictionary({
    images,
    imageId,
    classRef,
    methods,
    capturesBySelector,
    lane,
    expectedVersion: existing._version,
    input: {
      id: dictionaryRef.objectId,
      shape: objectRef(imageId, shape.id),
      slots: Object.fromEntries(selectors.map((selector) => [bySelector.get(selector), merged.get(selector)])),
      metadata: existing.metadata,
    },
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
  if (isMethodDictionary(record)) {
    const table = validateMethodDictionary(record, dictionaryRef, kernel.nil);
    return new Map(entriesFromBuckets(table.buckets).map(([selector, method]) => [selector.value, method]));
  }
  // The legacy branch owes the same corruption semantics as dispatch: a missing Shape is a dangling
  // edge rather than a miss, and duplicate selector names are refused rather than resolved
  // first-wins. This is the recommended representation-neutral reader, so it must not be a laxer
  // way to read the same records — which is why every declared slot is checked, not only the one a
  // single-selector caller happened to ask for.
  const shape = await images.getShape(record.shape.imageId, record.shape.objectId);
  if (!shape) throw new TypeError(`method dictionary shape not found: ${record.shape.objectId}`);
  assertUniqueSelectorShape(shape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  const bindings = new Map();
  for (const {id, name} of shape.slots) {
    const method = record.slots[id];
    // Dispatch treats a slot holding something other than an unpinned Block ref as a malformed
    // dictionary rather than a miss, and this reader owes the same semantics.
    if (!isObjectRef(method)) {
      throw new TypeError(
        `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId} slot for ${name} `
        + 'must contain an unpinned Block ref',
      );
    }
    bindings.set(name, method);
  }
  return bindings;
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
  SmalltalkMethodRedefinitionError,
  SmalltalkSealedMethodDictionaryError,
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
