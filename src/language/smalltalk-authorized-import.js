import {OBJECT_WRITE_OPERATION, objectResource} from '../authority/object-resource.js';
import {OBJECT_CREATE_OPERATION} from '../callable/image-creation-binding.js';
import {
  importCuisNativePackage,
  isMappedCuisClass,
  mappedCuisClassName,
  planCuisNativeImport,
} from './cuis-native-import.js';
import {smalltalkClassObjectId} from './smalltalk-class-builder.js';
import {NAMESPACE_OBJECT_ID} from './smalltalk-globals.js';

// The AUTHORIZED Cuis native import seam (ADR 0094; Object Environment E4, bead eij.4).
//
// It brings ONE canonical Cuis package manifest (or a caller-declared scope of it) into an image
// through the existing Cuis native-import adapter, under ordinary authority, with progress,
// cancellation and a truthful partial-result contract. It owns no import semantics: the adapter
// owns translation, scope, preflight, ordering and the partial-publication rule; the class builder,
// namespace and method owners own admission. This module owns exactly five things:
//
//   1. caller-owned input validation, including the pure import plan (the adapter's own preflight
//      of the caller's manifest, run BEFORE authority because it reads nothing);
//   2. the authority demand SET, computed purely from that plan, and its ORDER before any read;
//   3. the progress and cancellation plumbing between the caller and the adapter;
//   4. the partial-result contract: what was admitted when an import stops, and why;
//   5. the public result and error taxonomy.
//
// AUTHORITY. An import mutates three kinds of state, and the demands name each through resources
// the caller can compute from its own manifest, never from anything read out of the image:
//
//   * every class the manifest declares becomes a native Class object at the class builder's
//     deterministic identity `smalltalk/class/<name>`: `object/create` on that object. Its
//     Metaclass, Shapes, MethodDictionary, class-state companion, class-variable bindings and
//     subclass registry are that Class's storage representation (the ADR 0087/0088 rule), so one
//     demand covers them;
//   * defining a class appends it to its SUPERCLASS's subclass registry, which is the superclass's
//     storage representation: `object/write` on every mapped superclass (`Object`, `Array2D`,
//     `TextModel`) a declaration names. An in-manifest superclass is covered by its own create;
//   * an extension method on a mapped existing class (`Integer`) advances that class's
//     selector-binding state: `object/write` on that Class, exactly as ADR 0088 demands for a
//     replacement;
//   * publishing the declared names into the root namespace rebinds the namespace object:
//     `object/write` on `smalltalk-global-namespace/v1` whenever the plan declares a class.
//
// The set is deduplicated and demanded in canonical order BEFORE the adapter reads the kernel, so a
// denied caller learns nothing the manifest did not already say: whether the image has a kernel, a
// namespace or any of the named classes stays undisclosed (`AuthorityError` either way).
//
// PARTIAL RESULTS are the adapter's rule, restated once here and never widened: an adapter refusal
// (`CuisNativeImportError`) happens before the first native write and admits nothing; a
// cancellation (`CuisNativeImportAbortedError`) happens between declarations and reports exactly
// what landed; a native owner's refusal of a covered declaration after earlier ones were admitted is
// `SmalltalkImportRefusedError`, which names the declaration that was being admitted, what had
// already landed, and carries the owner's own refusal as `cause` — a compiler diagnostic or an
// admission conflict is exactly what the caller needs to correct the package, and the identities
// it names are the caller's own. In every case the image is not corrupt and a corrected retry
// converges through the owners' admission rules (exact replay is write-free). Nothing here rolls
// back, retries or skips.

class SmalltalkImportInputError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'SmalltalkImportInputError';
  }
}

class SmalltalkImportRefusedError extends Error {
  constructor({identity, phase, admitted, cause}) {
    super(`Cuis native import refused at ${phase ?? 'an unknown phase'} ${identity ?? ''}`.trim()
      + `: ${cause?.message ?? cause}`, {cause});
    this.name = 'SmalltalkImportRefusedError';
    this.identity = identity;
    this.phase = phase;
    this.admitted = Object.freeze({classes: Object.freeze([...admitted.classes]), methods: Object.freeze([...admitted.methods])});
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new SmalltalkImportInputError(`${label} must be non-empty text`);
  return value;
}

function assertServices(images, compilation, require) {
  if (!images || typeof images !== 'object' || typeof images.getObject !== 'function') {
    throw new SmalltalkImportInputError('authorizedImportCuisPackage requires an image service');
  }
  if (!compilation || typeof compilation.compileArtifact !== 'function') {
    throw new SmalltalkImportInputError('authorizedImportCuisPackage requires a compilation service');
  }
  if (typeof require !== 'function') {
    throw new SmalltalkImportInputError('authorizedImportCuisPackage requires a require(demand) authority-check function');
  }
}

function assertProgressOptions(signal, onProgress) {
  if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
    throw new SmalltalkImportInputError('signal must be null or an AbortSignal-like object with a boolean aborted');
  }
  if (onProgress !== null && typeof onProgress !== 'function') {
    throw new SmalltalkImportInputError('onProgress must be null or a function');
  }
}

// The authority demand set of a plan: pure, deterministic, computed from the caller's manifest.
// Exported so the contract can be pinned as data.
function importDemandsFor({imageId, plan}) {
  const demands = new Map();
  const add = (operation, objectId) => {
    const resource = objectResource(imageId, objectId);
    demands.set(`${operation}\u0000${resource}`, Object.freeze({operation, resource}));
  };
  const declared = new Set(plan.classes.map(({name}) => name));
  for (const {name} of plan.classes) add(OBJECT_CREATE_OPERATION, smalltalkClassObjectId(name));
  for (const declaration of plan.ordered) {
    if (isMappedCuisClass(declaration.superclass)) {
      add(OBJECT_WRITE_OPERATION, smalltalkClassObjectId(mappedCuisClassName(declaration.superclass)));
    }
  }
  for (const method of plan.methods) {
    if (isMappedCuisClass(method.classIdentity)) {
      add(OBJECT_WRITE_OPERATION, smalltalkClassObjectId(mappedCuisClassName(method.classIdentity)));
    }
  }
  if (declared.size > 0) add(OBJECT_WRITE_OPERATION, NAMESPACE_OBJECT_ID);
  return Object.freeze([...demands.values()].sort((left, right) =>
    (left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : 0)));
}

async function authorizedImportCuisPackage({
  images, compilation, imageId, manifest, scope = null, require, signal = null, onProgress = null,
} = {}) {
  // 1. Caller-owned input, then the pure plan (the adapter's own preflight; no graph read).
  assertServices(images, compilation, require);
  requiredText(imageId, 'imageId');
  assertProgressOptions(signal, onProgress);
  if (!manifest || typeof manifest !== 'object') throw new SmalltalkImportInputError('manifest must be a canonical Cuis semantic export manifest');
  const plan = planCuisNativeImport(manifest, scope);

  // 2. Authority: every demand, in canonical order, before anything is read.
  for (const demand of importDemandsFor({imageId, plan})) require(demand);

  // 3. Progress plumbing: remember what is being admitted so a refusal can name it.
  const admitted = {classes: [], methods: []};
  let current = null;
  const tracker = (event) => {
    if (event.event === 'begin') current = event;
    if (event.event === 'admitted') {
      if (event.phase === 'class') admitted.classes.push(event.identity);
      if (event.phase === 'methods') admitted.methods.push(...event.methods);
      current = null;
    }
    if (onProgress) onProgress(event);
  };

  // 4. The import itself, at its owner; 5. the public outcome.
  let imported;
  try {
    imported = await importCuisNativePackage({images, compilation, imageId, manifest, scope, signal, onProgress: tracker});
  } catch (error) {
    if (error?.name === 'CuisNativeImportError' || error?.name === 'CuisNativeImportAbortedError') throw error;
    throw new SmalltalkImportRefusedError({
      identity: current?.identity ?? null, phase: current?.phase ?? null, admitted, cause: error,
    });
  }
  return Object.freeze({
    imported,
    admitted: Object.freeze({classes: Object.freeze([...admitted.classes]), methods: Object.freeze([...admitted.methods])}),
  });
}

export {
  SmalltalkImportInputError,
  SmalltalkImportRefusedError,
  authorizedImportCuisPackage,
  importDemandsFor,
};
