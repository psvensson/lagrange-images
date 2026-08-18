import {createHash} from 'node:crypto';
import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {NEUTRAL_EXPRESSION_V0} from '../execution/neutral-expression-v0.js';
import {compileWasmFunctionArtifact} from '../wasm/compiler.js';
import {isObjectRef, objectRef, textValue} from '../value/index.js';
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
import {WASM_FUNCTION_V1} from '../code/wasm-artifacts.js';
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

// Create-once artifacts, made retry-safe: an identical artifact left by a partial run is reused
// rather than rewritten, and a differing one is refused rather than clobbered.
async function ensureCodeArtifact(images, imageId, desired) {
  const existing = await images.getCodeArtifact(imageId, desired.id);
  if (!existing) return await images.putCodeArtifact(imageId, desired);
  // dependencies and derivedFrom are durable semantic and provenance edges, so an artifact that
  // differs there is not the same artifact.
  const projection = (record) => canonicalJson({
    representation: record.representation ?? null,
    languageId: record.languageId ?? null,
    content: record.content ?? null,
    dependencies: record.dependencies ?? [],
    derivedFrom: record.derivedFrom ?? [],
    metadata: record.metadata ?? {},
  });
  if (projection(desired) !== projection(existing)) {
    throw new SmalltalkKernelConflictError('code artifact', imageId, desired.id);
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

// compileWasmFunctionArtifact writes its deterministic wasm-function/v1 with an unconditional
// putCodeArtifact, so a failure after that write but before the dictionary swap would make an exact
// retry collide with its own output. Reuse an existing function only when its provenance matches
// this semantic artifact; anything else is a conflict rather than something to overwrite.
async function ensureWasmFunction({images, compilation, imageId, id, semanticRef}) {
  const functionId = `${id}:wasm:function`;
  const existing = await images.getCodeArtifact(imageId, functionId);
  if (existing) {
    const derivedFromSemantic = (existing.derivedFrom ?? [])
      .some((edge) => edge.imageId === semanticRef.imageId && edge.objectId === semanticRef.objectId);
    if (existing.representation !== WASM_FUNCTION_V1 || !derivedFromSemantic) {
      throw new SmalltalkKernelConflictError('wasm function artifact', imageId, functionId);
    }
    return objectRef(imageId, existing.id);
  }
  const {functionArtifact} = await compileWasmFunctionArtifact({
    images,
    compilation,
    semanticRef,
    moduleId: `${id}:wasm:module`,
    functionId,
  });
  return objectRef(imageId, functionArtifact.id);
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
  const incoming = new Set();
  for (const {selector} of methods) {
    requiredText(selector, 'selector');
    if (incoming.has(selector)) {
      throw new TypeError(`defineMethods declares ${selector} twice in one call`);
    }
    incoming.add(selector);
    if (merged.has(selector)) throw new SmalltalkMethodRedefinitionError(classRef, selector);
  }

  for (const {selector, program} of methods) {
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
      : objectRef(imageId, (await compilation.compileArtifact(objectRef(imageId, semantic.id), {
        id: `${id}:code`,
        targetRepresentation: NEUTRAL_EXPRESSION_V0,
      })).id);
    const block = await ensureBlock(images, imageId, {
      id,
      code: codeRef,
      metadata: {smalltalk: 'method', selector, lane},
    });
    merged.set(selector, objectRef(imageId, block.id));
  }

  // The shape id encodes the canonical selector *set*, not its cardinality. Keying on the count
  // would make two unrelated one-selector dictionaries — say a failed `foo` and a later `bar` —
  // want the same durable id and conflict.
  const selectors = [...merged.keys()];
  const slots = methodDictionarySlots(selectors);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...selectors].sort()))
    .digest('base64url')
    .slice(0, 16);
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
