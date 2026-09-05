import {OBJECT_WRITE_OPERATION, objectResource} from '../authority/object-resource.js';
import {isObjectRef, objectRef} from '../value/index.js';
import {
  SmalltalkMethodDictionaryContentionError,
  SmalltalkSealedMethodDictionaryError,
  SmalltalkStaleMethodPositionError,
  methodBlockRef,
} from './smalltalk-class-builder.js';
import {reconcileMethodsFromSource} from './smalltalk-instance-variables.js';
import {parseSmalltalkMethodPositionToken} from './smalltalk-method-position-token.js';
import {sameRef} from './smalltalk-lookup.js';

// The AUTHORIZED native Symmetric Smalltalk method REPLACEMENT seam (bead lagrange-images-qax slice
// C2, Object Environment E3, GitHub #218).
//
// It replaces ONE EXISTING method at the logical position ADR 0086 already defines — `{Class or
// Metaclass, selector}` — from explicitly supplied new source, only if the binding the caller
// OBSERVED is still the current one. It adds no method, removes none, edits no class, persists no
// source, carries no protocol/category and no Cuis provenance, and publishes no compiler and no
// generic reconciliation API.
//
// THIS MODULE OWNS EXACTLY SIX THINGS, and deliberately nothing else:
//
//   1. caller-owned input validation;
//   2. the token's syntax and scope for THIS {image, class, selector};
//   3. the authority demand and its ORDER relative to every graph read;
//   4. the current-position resolution that bridges a token to an expected binding;
//   5. the pre-compilation admission of that expectation;
//   6. the public result and error contract.
//
// EVERYTHING ELSE IS SOMEONE ELSE'S. What "still current" means once a write is in flight, how a
// lost whole-dictionary CAS is rebased, how an unrelated selector's winner is preserved, how bounded
// contention is reported, how immutable revision material is published and how source is lowered to
// a native program all live at the class builder and the from-source compiler owner (slice C1). This
// module resolves the current binding through the ONE current-binding reader (`methodBlockRef`) and
// then hands the caller's ORIGINAL observation to `reconcileMethodsFromSource` as `expectedCurrent`.
// It decodes no MethodDictionary bucket, no Shape, no backend `_version`, and it never writes.
//
// WHY THERE IS AN ADMISSION CHECK HERE AT ALL, given that C1 re-asserts the same expectation. C1's
// earliest check is at plan time — which is AFTER `reconcileMethodsFromSource` has compiled the
// source. A public seam that only relied on it would answer a compiler diagnostic to a caller whose
// real problem is that its observation was overtaken, and would compile source it can already know
// is inadmissible. So this check moves the stale verdict in FRONT of compilation. It is not a second
// authority on staleness: the very same observation is then passed to C1, which re-asserts it at plan
// time and at EVERY rebase boundary, and C1's verdict is final. Removing this check would change
// which error a stale caller sees and how much work a doomed call does; it could never let a stale
// replacement land.
//
// THE EXPECTATION IS NEVER REFRESHED. The binding read in step 4 is used to ADMIT the caller's token,
// never to replace it: what reaches C1 is the token's observed revision, so a position that moved
// between the caller's read and this call is stale even though this seam has just seen the winner.
// A hidden fresh read substituted for the caller's assumption would make a stale conflict
// unobservable, which is precisely what #218 asks this operation to prove it cannot do.
//
// AUTHORITY. Replacement mutates the DECLARING Class/Metaclass's selector-binding state, so it
// demands ONE `object/write` on the Class (or Metaclass) object, before any existence is disclosed.
//
//   * NOT a write on the currently bound Block. That Block is immutable revision material (ADR 0086
//     decision 1); a replacement does not modify it, it stops pointing at it. Demanding write there
//     would authorize a mutation nobody performs and would refuse a caller who legitimately owns the
//     class but not the method's previous revision.
//   * NOT inferred from anything. Not from a class `object/read`, not from a Block `object/read`,
//     not from possession of refs, not from Project membership (ADR 0039 §2), and NOT from the
//     token: a version token is an assumption about state, and holding one confers zero authority.
//   * Authorization strictly precedes existence disclosure, exactly as ADR 0087's reads do, so a
//     denied caller cannot tell an implemented selector from an unimplemented one from a missing
//     class. All three are `AuthorityError`.
//
// NO EXECUTION LANE IS PUBLISHED, and that has an observable consequence stated here rather than
// discovered later. `reconcileMethodsFromSource` compiles in its own default lane, so a method
// originally installed in the WASM lane — every Cuis-imported method is — is replaced by one in the
// neutral lane. It dispatches and answers exactly as before, because the executor registry selects
// by the artifact's representation, but the executable representation underneath does change.
//
// The two alternatives are worse. A `lane` parameter would publish a compiler/execution knob on a
// seam whose whole point is that E3 exposes no compiler. PRESERVING the current method's lane would
// mean reading the bound Block's code artifact to discover it, making this a second CodeArtifact
// decoder — exactly the path ADR 0087 rejected for the read seam. Which lane a REPLACEMENT should
// compile in is a question for the installer that owns lanes, and a consumer that needs an answer
// is the pressure that should produce one.
//
// SOURCE IS NOT PERSISTED. `source` is the explicitly supplied NEW source and this seam is not a
// source editor: it compiles through the existing owner and retains no text, so ADR 0087's
// `source: null` stays truthful after a successful replacement. #218 scopes E3 this way on purpose.
//
// THE RESULT IS DELIBERATELY MINIMAL. `{replaced: true}`, frozen, and nothing else — no new Block
// ref, no descriptor, no replacement token, no source. The consumer has already committed to a fresh
// authorized reread as displayed truth (#218 point 4); handing back anything richer would tempt it
// to skip that reread and patch its local state from a receipt instead.
//
// It says "the position now denotes the source you supplied", NOT "a record was written". Supplying
// source that means exactly what is already bound is ADR 0086 exact replay against the very state
// the caller observed: a write-free success, the same receipt, and the binding does not move. That
// is the honest reading — the receipt is about the caller's request, and the number of records the
// image gained is the revision owner's business, not a public fact.
//
// ERROR TAXONOMY. Every outcome is an Images-native semantic one, distinguished by `error.name` —
// which is the only discriminator that works for a consumer reaching this seam through
// `src/portable-runtime.js`, where these classes are deliberately not published:
//
//   SmalltalkMethodReplacementInputError    malformed caller-owned input
//   SmalltalkMethodPositionTokenError       malformed token, or one issued for another position
//   AuthorityError                          the caller's own `require` denied `object/write`
//   SmalltalkMethodTargetError              after authorization: no such native method position
//   SmalltalkStaleMethodPositionError       the observed binding is no longer current (C1's class)
//   SmalltalkMethodReplacementContentionError  transient: the position did not move and was not advanced
//   anything else                           the native compiler/source owner rejected the source
//
// Malformed caller input has its OWN class rather than a bare `TypeError` for one concrete reason:
// the native semantic compiler also rejects bad source with `TypeError`, so a bare `TypeError` here
// would make "your call is malformed" and "your source is malformed" indistinguishable — and those
// demand opposite responses from a consumer.
//
// WHAT NEVER ESCAPES: a backend `VersionConflictError` raw or as a `cause`; a MethodDictionary ref,
// representation, bucket, tally, seal or version; a backend version; the winning Block ref in a
// stale refusal; a replacement token. Current truth comes only from a fresh authorized read.

const REPLACED = Object.freeze({replaced: true});

// Caller-owned input only. Every check below is pure — it reads no record — so a refusal here can
// never be an existence oracle, and it happens before the token is even looked at.
class SmalltalkMethodReplacementInputError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'SmalltalkMethodReplacementInputError';
  }
}

// After authorization: there is no such native method position to replace — the named Behavior is
// absent or is not a well-formed Class/Metaclass, or its method storage cannot be read as one.
//
// It names ONLY the position the caller already supplied. There is deliberately no `cause` and no
// underlying message: the resolution failures underneath name the class's MethodDictionary record,
// and this seam does not disclose storage identity. A caller that needs to diagnose a corrupt class
// browses it through the ADR 0087 read seam, which is where that diagnosis belongs.
class SmalltalkMethodTargetError extends TypeError {
  constructor(classRef, selector) {
    super(
      `${classRef.imageId}/${classRef.objectId} is not a native class whose ${selector} method `
      + 'position can be resolved',
    );
    this.name = 'SmalltalkMethodTargetError';
    this.selector = selector;
  }
}

// Transient, and NOT staleness: the observed position is exactly what the caller observed and was
// not advanced. Two owner outcomes reach it, and they are merged because the caller's response to
// both is the same and neither is a statement about the request: the whole-dictionary CAS moved
// under the write more often than the owner could rebase onto it, or the class's method storage is
// SEALED for migration and refuses writes until the Behavior points at its hashed dictionary.
//
// It is a public restatement of the owner's outcome rather than the owner's own error, because that
// one names the class's MethodDictionary record — storage identity this seam does not publish. Like
// every refusal here it carries no `cause`, so no backend conflict can travel out inside one.
//
// It deliberately does NOT claim that nothing was written: ADR 0086 publishes immutable revision
// material before the final CAS, so by now the replacement's Block may exist, addressable and not
// current. The invariant that holds is the narrow one — the current binding did not move.
class SmalltalkMethodReplacementContentionError extends TypeError {
  constructor(classRef, selector) {
    super(
      `${classRef.imageId}/${classRef.objectId} ${selector} could not be advanced right now; the `
      + 'observed method position is unchanged, retry from a fresh authorized read',
    );
    this.name = 'SmalltalkMethodReplacementContentionError';
    this.selector = selector;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SmalltalkMethodReplacementInputError(`${label} must be a non-empty string`);
  }
  return value;
}

// The same rule the browse seam applies to a class ref, for the same reason: `classRef.imageId` is
// part of the position's identity, so a ref into another image must be refused rather than compared
// by object id alone.
function assertLocalClassRef(classRef, imageId) {
  if (!isObjectRef(classRef) || classRef.imageId !== imageId) {
    throw new SmalltalkMethodReplacementInputError(
      `authorizedReplaceSmalltalkMethod classRef must be an unpinned object ref in ${imageId}`,
    );
  }
  return classRef;
}

function assertServices(images, compilation) {
  if (!images || typeof images.getObject !== 'function') {
    throw new SmalltalkMethodReplacementInputError('authorizedReplaceSmalltalkMethod requires an image service');
  }
  if (!compilation || typeof compilation.compileArtifact !== 'function') {
    throw new SmalltalkMethodReplacementInputError('authorizedReplaceSmalltalkMethod requires a compilation service');
  }
}

function assertRequire(require) {
  if (typeof require !== 'function') {
    throw new SmalltalkMethodReplacementInputError(
      'authorizedReplaceSmalltalkMethod requires a require(demand) authority-check function',
    );
  }
  return require;
}

// The current binding at this position, through the ONE representation-neutral current-binding
// reader the browse seam and the write planner already share (bead lagrange-images-jtz.2). This
// module never opens a method dictionary itself, so "which Block does this selector bind" has one
// answer for the reader, this admission check and the write planner alike.
async function currentBinding({images, imageId, classRef, selector}) {
  try {
    return await methodBlockRef({images, imageId, classRef, selector});
  } catch (error) {
    // Only the reader's own semantic refusals become a target verdict. Anything else — a host or
    // transport failure from the image service, say — is not a statement about this position and is
    // not this seam's to reinterpret, so it propagates as it was raised.
    if (!(error instanceof TypeError)) throw error;
    throw new SmalltalkMethodTargetError(classRef, selector);
  }
}

// Only PUBLIC SEMANTIC outcomes cross this boundary. The owner's own dictionary-scoped errors name
// the class's MethodDictionary record, so they are restated in terms of the caller's position; every
// other outcome — the stale verdict, a compile/source rejection, a code-artifact conflict — is
// already an Images-native semantic error from its own owner and is passed through unchanged, with
// its identity intact.
function publicOutcome(error, classRef, selector) {
  if (error instanceof SmalltalkMethodDictionaryContentionError
    || error instanceof SmalltalkSealedMethodDictionaryError) {
    return new SmalltalkMethodReplacementContentionError(classRef, selector);
  }
  return error;
}

// AUTHORIZED replacement of ONE existing native method.
//
// Order, and the order is the contract:
//
//   1. validate caller-owned shape                     (pure; discloses nothing)
//   2. validate the token's syntax and scope           (pure; discloses nothing)
//   3. require `object/write` on the Class/Metaclass   (before ANY read)
//   4. resolve the current binding                     (the one current-binding reader)
//   5. admit the token's observed binding against it
//   6. stale -> refuse, BEFORE any compilation
//   7. reconcile from source WITH the caller's ORIGINAL observation
//   8. map only public semantic outcomes
//
// Steps 1 and 2 come before step 3 so that a malformed call is diagnosed as a malformed call rather
// than as an authority failure, and step 3 comes before step 4 so that existence is never disclosed
// to a caller who may not write the class.
async function authorizedReplaceSmalltalkMethod({
  images, compilation, imageId, classRef, selector, source, expectedVersionToken, require,
} = {}) {
  assertServices(images, compilation);
  requiredText(imageId, 'imageId');
  assertLocalClassRef(classRef, imageId);
  requiredText(selector, 'selector');
  requiredText(source, 'source');
  assertRequire(require);

  // Scope-checked against the position the CALLER named, never against anything read from the
  // image: a token minted for another image, class or selector is refused here, before authority is
  // even demanded, and the refusal discloses nothing about that other position.
  //
  // The parser answers the observed binding as `{imageId, objectId}` — a token is deliberately not
  // a ref and does not carry one — so the ref the binding owner compares against is BUILT HERE,
  // through the value owner's own constructor. This is the whole of the token -> expected-binding
  // bridge, and it is the only place in the operation where a ref is constructed rather than read.
  const parsed = parseSmalltalkMethodPositionToken(expectedVersionToken, {imageId, classRef, selector});
  const observed = objectRef(parsed.imageId, parsed.objectId);

  require({
    operation: OBJECT_WRITE_OPERATION,
    resource: objectResource(imageId, classRef.objectId),
  });

  const current = await currentBinding({images, imageId, classRef, selector});
  // An ABSENT selector is stale, not a fresh definition — the same rule C1 applies, for the same
  // reason: the caller said it was replacing something it had observed, and E3 adds no method.
  if (!sameRef(current, observed)) throw new SmalltalkStaleMethodPositionError(classRef, selector);

  try {
    await reconcileMethodsFromSource({
      images,
      compilation,
      imageId,
      classRef,
      // `observed` and not `current`: the caller's assumption is what C1 must keep re-asserting.
      methods: [{selector, source, expectedCurrent: observed}],
    });
  } catch (error) {
    throw publicOutcome(error, classRef, selector);
  }
  return REPLACED;
}

export {
  SmalltalkMethodReplacementContentionError,
  SmalltalkMethodReplacementInputError,
  SmalltalkMethodTargetError,
  authorizedReplaceSmalltalkMethod,
};
