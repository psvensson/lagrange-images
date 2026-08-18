import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
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
import {canonicalizeValue, isObjectRef, objectRef, textValue} from '../value/index.js';
import {
  BEHAVIOR_SHAPE_ID,
  EMPTY_SHAPE_ID,
  SmalltalkKernelConflictError,
  assertUniqueSelectorShape,
  canonicalJson,
  ensureObject,
  ensureShape,
  findSmalltalkKernel,
  methodDictionarySlots,
  readBehavior,
} from './smalltalk-kernel.js';
import {WASM_FUNCTION_V1, WASM_MODULE_V1} from '../code/wasm-artifacts.js';
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

const methodsId = (ownerId) => `${ownerId}/methods`;
const methodId = (classObjectId, selector) =>
  `${classObjectId}/method/${Buffer.from(selector, 'utf8').toString('base64url')}`;

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

// One definition of "exact" for a code artifact, used by every reuse decision here. Representation,
// content, provenance and metadata all participate: matching provenance is not matching output, so
// an artifact with the right `derivedFrom` but stale content is stale, not reusable.
function codeArtifactProjection(record) {
  return canonicalJson({
    representation: record.representation ?? null,
    languageId: record.languageId ?? null,
    content: record.content ?? null,
    dependencies: record.dependencies ?? [],
    derivedFrom: record.derivedFrom ?? [],
    metadata: record.metadata ?? {},
  });
}

// Create-once artifacts, made retry-safe: an identical artifact left by a partial run is reused
// rather than rewritten, and a differing one is refused rather than clobbered.
async function ensureCodeArtifact(images, imageId, desired) {
  const existing = await images.getCodeArtifact(imageId, desired.id);
  if (!existing) return await images.putCodeArtifact(imageId, desired);
  if (codeArtifactProjection(desired) !== codeArtifactProjection(existing)) {
    throw new SmalltalkKernelConflictError('code artifact', imageId, desired.id);
  }
  return existing;
}

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
    throw new TypeError(
      `method ${selector} declares ${declared.length} captures but supplies ${captures.length} values`,
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

// `putLexicalEnvironment` is an upsert with a layout-compatibility check, so a plain write would
// quietly replace the bindings of an existing method environment. Same rule as everywhere else in
// this sequence: reuse an identical record, refuse a differing one, create an absent one.
async function ensureLexicalEnvironment(images, imageId, desired) {
  const existing = await images.getLexicalEnvironment(imageId, desired.id);
  if (!existing) return await images.putLexicalEnvironment(imageId, desired, {expectedVersion: 0});
  if (lexicalEnvironmentProjection(desired) !== lexicalEnvironmentProjection(existing)) {
    throw new SmalltalkKernelConflictError('lexical environment', imageId, desired.id);
  }
  return existing;
}

async function ensureBlock(images, imageId, desired) {
  const existing = await images.getBlock(imageId, desired.id);
  if (!existing) return await images.putBlock(imageId, desired);
  const projection = (record) => canonicalJson({
    code: record.code ?? null,
    environment: record.environment ?? null,
    metadata: record.metadata ?? {},
  });
  if (projection(desired) !== projection(existing)) {
    throw new SmalltalkKernelConflictError('block', imageId, desired.id);
  }
  return existing;
}

// The neutral lane has the same shape of problem as the WASM one: compileArtifact writes its
// deterministic output unconditionally, so a failure after it but before the dictionary swap makes
// an exact retry of the same selector collide with its own output.
//
// Reuse compares the *whole* artifact against a freshly derived one rather than trusting
// representation plus a provenance edge, which would let stale content through.
async function ensureNeutralCode({images, compilation, imageId, id, semanticRef}) {
  const codeId = `${id}:code`;
  const existing = await images.getCodeArtifact(imageId, codeId);
  if (!existing) {
    const code = await compilation.compileArtifact(semanticRef, {id: codeId, targetRepresentation: NEUTRAL_EXPRESSION_V0});
    return objectRef(imageId, code.id);
  }
  // Derive under a scratch id so the comparison is against what a fresh compile actually produces.
  const probeId = `${codeId}:probe`;
  const fresh = await images.getCodeArtifact(imageId, probeId)
    ?? await compilation.compileArtifact(semanticRef, {id: probeId, targetRepresentation: NEUTRAL_EXPRESSION_V0});
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
async function ensureWasmFunction({images, compilation, imageId, id, semanticRef}) {
  const functionId = `${id}:wasm:function`;
  const moduleArtifact = await compilation.compileArtifact(semanticRef, {
    targetRepresentation: WASM_MODULE_V1,
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
      moduleArtifact,
      descriptor: moduleFunctionDescriptor(moduleArtifact, moduleArtifact.metadata.entry),
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
    entry: moduleArtifact.metadata.entry,
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
  if (!semantic || semantic.representation !== LAGRANGE_CODE_V0) return false;
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
  const existingShape = await images.getShape(existing.shape.imageId, existing.shape.objectId);
  if (!existingShape) throw new TypeError(`method dictionary shape not found: ${existing.shape.objectId}`);

  // Validate the stored dictionary against the same global invariant the dispatcher enforces,
  // rather than letting a Map silently normalize a corrupt one while extending it.
  assertUniqueSelectorShape(existingShape, `method dictionary ${dictionaryRef.imageId}/${dictionaryRef.objectId}`);
  const merged = new Map(existingShape.slots.map((slot) => [slot.name, existing.slots[slot.id]]));

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
    normalizeLagrangeCodeProgram(program);
    // Walks the body, so an unknown op is rejected here rather than during compilation — after the
    // create-once `:semantic` artifact has already claimed the selector's deterministic id.
    lowerLagrangeCodeV0(program, {});
    // Lane restrictions are part of validity too, and the backends decide them from the program
    // alone — so a program the WASM lane cannot compile is rejected before anything is written.
    if (lane === 'wasm') {
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
      representation: LAGRANGE_CODE_V0,
      content: textValue(JSON.stringify(program)),
      metadata: {smalltalk: 'method', selector},
    });
    // ADR 0044 decision 6: one semantic method, an executable Block derived per lane. The WASM
    // lane's Block points at a wasm-function/v1, not at the module it references.
    const codeRef = lane === 'wasm'
      ? await ensureWasmFunction({images, compilation, imageId, id, semanticRef: objectRef(imageId, semantic.id)})
      : await ensureNeutralCode({images, compilation, imageId, id, semanticRef: objectRef(imageId, semantic.id)});
    // Written before the Block, because `putBlock` requires the environment it points at to resolve.
    const captures = capturesBySelector.get(selector);
    const desiredEnvironment = describeMethodEnvironment({methodObjectId: id, selector, captures});
    const environment = desiredEnvironment === null
      ? null
      : await ensureLexicalEnvironment(images, imageId, desiredEnvironment);
    const block = await ensureBlock(images, imageId, {
      id,
      code: codeRef,
      environment: environment ? objectRef(imageId, environment.id) : null,
      metadata: {smalltalk: 'method', selector, lane},
    });
    merged.set(selector, objectRef(imageId, block.id));
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
  const fingerprint = Buffer.from(JSON.stringify(selectors), 'utf8').toString('base64url');
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

// A new class and its metaclass, wired by decision 4's chain rule. The installer applies the same
// rule with forward references, because its objects do not resolve until the whole graph exists;
// here the superclass already resolves, so its metaclass is read from it. Two encodings of one
// invariant, which is why both are proven rather than only asserted.
async function defineClass({images, imageId, name, superclassRef = null} = {}) {
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

  const classObjectId = `smalltalk/class/${name}`;
  const metaclassObjectId = `smalltalk/metaclass/${name}`;

  for (const [id, behaviorName, superRef, behaviorRef] of [
    [metaclassObjectId, `${name} class`, superMetaclass, kernel.metaclassClass],
    [classObjectId, name, superclass, ref(metaclassObjectId)],
  ]) {
    await ensureObject(images, imageId, {
      id: methodsId(id),
      shape: ref(EMPTY_SHAPE_ID),
      slots: {},
      metadata: {smalltalk: 'method-dictionary', owner: id},
    });
    await ensureObject(images, imageId, {
      id,
      shape: ref(BEHAVIOR_SHAPE_ID),
      behavior: behaviorRef,
      slots: {
        'behavior-name': textValue(behaviorName),
        'behavior-superclass': superRef,
        'behavior-methods': ref(methodsId(id)),
        'behavior-instance-shape': kernel.nil,
      },
      metadata: {smalltalk: 'behavior', name: behaviorName},
    });
  }
  return Object.freeze({classRef: ref(classObjectId), metaclassRef: ref(metaclassObjectId)});
}

export {SmalltalkMethodRedefinitionError, defineClass, defineMethods};
