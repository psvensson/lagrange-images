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
  lookupSelectorInTable,
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

// Add-only for this landing. The semantic, code and Block artifacts are create-once and their ids
// are derived from class and selector, so a redefinition would fail partway through — after new
// artifacts, before the dictionary swap — leaving the class inconsistent. Rejecting up front is
// honest; real replacement needs versioned method identity and gets it deliberately later.
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
      + 'method replacement needs versioned method identity and is not supported yet',
    );
    this.name = 'SmalltalkMethodRedefinitionError';
    this.selector = selector;
  }
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
function lexicalEnvironmentProjection(record) {
  return canonicalJson({
    parent: record.parent ?? null,
    bindings: record.bindings ?? {},
    metadata: record.metadata ?? {},
  });
}

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

// Is the selector already bound to exactly this definition? The Block id is deterministic from
// class and selector, so identity is: the dictionary points at that Block, the Block was installed
// for this lane, and its semantic artifact holds this program.
async function isSameInstalledMethod({images, imageId, classRef, selector, program, captures, lane, installed}) {
  const id = methodId(classRef.objectId, selector);
  if (!isObjectRef(installed) || installed.imageId !== imageId || installed.objectId !== id) return false;
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

// Adding a method rewrites the dictionary and its shape, per ADR 0044 decision 2 — visible,
// confined to one object kind, and gone when collections arrive. The Behavior itself is untouched,
// which is the point of giving it a fixed shape.
async function defineMethods({
  images,
  compilation,
  imageId,
  classRef,
  methods,
  lane = 'neutral',
} = {}) {
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  requiredText(imageId, 'image id');
  if (!Array.isArray(methods) || methods.length === 0) throw new TypeError('methods must be a non-empty array');
  const behavior = await requireLocalBehavior(images, imageId, classRef, 'defineMethods class');

  const dictionaryRef = behavior.slots['behavior-methods'];
  const existing = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!existing) throw new TypeError(`method dictionary not found: ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);

  // ADR 0049 decision 7. A sealed dictionary is mid-migration: the Behavior is about to stop
  // pointing at it, so writing here would land in a record that is being abandoned. Refusing
  // explicitly is what turns a lost method into a visible stall the caller can retry.
  if (isSealed(existing)) throw new SmalltalkSealedMethodDictionaryError(dictionaryRef);

  // Whichever representation the record says it is. Both are readable throughout migration, so a
  // class that has not been migrated keeps accepting methods exactly as before.
  const hashed = isMethodDictionary(existing);
  const dictionaryKernel = await findSmalltalkKernel({images, imageId});
  if (hashed && !dictionaryKernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  let merged;
  if (hashed) {
    const table = validateMethodDictionary(existing, dictionaryRef, dictionaryKernel.nil);
    merged = new Map(entriesFromBuckets(table.buckets).map(([selector, method]) => [selector.value, method]));
  } else {
    const existingShape = await images.getShape(existing.shape.imageId, existing.shape.objectId);
    if (!existingShape) throw new TypeError(`method dictionary shape not found: ${existing.shape.objectId}`);
    // Validate the stored dictionary against the same global invariant the dispatcher enforces,
    // rather than letting a Map silently normalize a corrupt one while extending it.
    assertUniqueSelectorShape(existingShape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
    merged = new Map(existingShape.slots.map((slot) => [slot.name, existing.slots[slot.id]]));
  }

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
      throw new TypeError(`defineMethods declares ${selector} twice in one call`);
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
      throw new SmalltalkMethodRedefinitionError(classRef, selector);
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
    const id = methodId(classRef.objectId, selector);
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
    const captures = capturesBySelector.get(selector);
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
    return await images.putObject(imageId, {
      id: dictionaryRef.objectId,
      ...methodDictionaryRecordFields({
        buckets,
        shapeRef: objectRef(imageId, METHOD_DICTIONARY_SHAPE_ID),
        nilRef: kernel.nil,
        metadata: existing.metadata,
      }),
    }, {expectedVersion: existing._version});
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

  return await images.putObject(imageId, {
    id: dictionaryRef.objectId,
    shape: objectRef(imageId, shape.id),
    slots: Object.fromEntries(selectors.map((selector) => [bySelector.get(selector), merged.get(selector)])),
    metadata: existing.metadata,
  }, {expectedVersion: existing._version});
}

// The Block installed for a selector on a class, read through whichever representation the
// dictionary actually uses. ADR 0049 makes two of those legal at once, so anything that reaches into
// a method dictionary should ask rather than assume a layout.
async function methodBlockRef({images, imageId, classRef, selector} = {}) {
  const behavior = await readBehavior(images, classRef);
  const dictionaryRef = behavior.methods;
  const record = await images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
  if (!record) throw new TypeError(`method dictionary not found: ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  if (isMethodDictionary(record)) {
    const table = validateMethodDictionary(record, dictionaryRef, kernel.nil);
    return lookupSelectorInTable(table, textValue(selector));
  }
  // The legacy branch owes the same corruption semantics as dispatch: a missing Shape is a dangling
  // edge rather than a miss, and duplicate selector names are refused rather than resolved
  // first-wins. This is now the recommended representation-neutral reader, so it must not be a
  // laxer way to read the same records.
  const shape = await images.getShape(record.shape.imageId, record.shape.objectId);
  if (!shape) throw new TypeError(`method dictionary shape not found: ${record.shape.objectId}`);
  assertUniqueSelectorShape(shape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  const slot = shape.slots.find(({name}) => name === selector);
  if (!slot) return null;
  const method = record.slots[slot.id];
  // Dispatch treats a slot holding something other than an unpinned Block ref as a malformed
  // dictionary rather than a miss, and this reader owes the same semantics.
  if (!isObjectRef(method)) {
    throw new TypeError(
      `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId} slot for ${selector} `
      + 'must contain an unpinned Block ref',
    );
  }
  return method;
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
  // class's own empty registry. Lazy and tolerant — bootstrap classes are defined before the
  // registry's Shape exists, and a foreign squatter on the deterministic id is left alone;
  // absence reads as empty, so this converges on retry rather than failing the definition.
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
  ensureBlock,
  ensureNamedClass,
  ensureSmalltalkShape,
  methodBlockRef,
  ensureCodeArtifact,
};
