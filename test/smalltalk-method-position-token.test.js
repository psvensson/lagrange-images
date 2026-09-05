import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
  createRuntime,
  defineMethodsFromSource,
  findSmalltalkKernel,
  installSymmetricSmalltalkStandardImage,
  methodBlockRef,
  objectRef,
  objectResource,
  reconcileMethodsFromSource,
} from '../src/runtime.js';
// Deliberately imported from the owning module, NOT from a public root: minting and parsing a
// token are the owner's business, and a caller may only compare and round-trip one. If these ever
// become reachable through `src/runtime.js`, the module header's claim stops being true.
import {
  SMALLTALK_METHOD_POSITION_TOKEN_V0,
  parseSmalltalkMethodPositionToken,
  smalltalkMethodPositionToken,
} from '../src/language/smalltalk-method-position-token.js';

// The version-aware READ for update (bead lagrange-images-qax, Object Environment E3, Slice B).
//
// What is under test is the token's SEMANTICS, not that a call returns a string. ADR 0086 already
// decided that `{Class/Metaclass, selector}` is the logical method position and the bound Block is
// its immutable current revision, so the token represents the observed state of that position —
// nothing wider, and not the Block ref, which the caller can already obtain from the browse seam.
const CLASS_ID = 'smalltalk/class/TokenProbe';
const OTHER_CLASS_ID = 'smalltalk/class/TokenProbeOther';
const METACLASS_ID = 'smalltalk/metaclass/TokenProbe';

async function image() {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'app'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm',
  });
  const {defineClass} = await import('../src/runtime.js');
  await defineClass({images: runtime.images, imageId: 'app', name: 'TokenProbe'});
  await defineClass({images: runtime.images, imageId: 'app', name: 'TokenProbeOther'});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm'};
  await defineMethodsFromSource({
    ...options,
    classRef: objectRef('app', CLASS_ID),
    methods: [{selector: 'answer', source: '[ ^ 1 ]'}, {selector: 'other', source: '[ ^ 2 ]'}],
  });
  await defineMethodsFromSource({
    ...options,
    classRef: objectRef('app', OTHER_CLASS_ID),
    methods: [{selector: 'answer', source: '[ ^ 3 ]'}],
  });
  return runtime;
}

// A `require` granting exactly the listed object/read demands and nothing else.
function readerFor(runtime, objectIds) {
  const context = runtime.authority.issue({
    principal: 'e3-probe',
    grants: objectIds.map((objectId) => ({
      operation: OBJECT_READ_OPERATION,
      resource: objectResource('app', objectId),
    })),
  });
  return (demand) => runtime.authority.require(context, demand);
}

async function grantsFor(runtime, classObjectId, selector) {
  const method = await methodBlockRef({
    images: runtime.images, imageId: 'app', classRef: objectRef('app', classObjectId), selector,
  });
  return [classObjectId, method.objectId];
}

test('the read for update answers exactly the ADR 0087 descriptor, plus a token', async () => {
  const runtime = await image();
  try {
    const require = readerFor(runtime, await grantsFor(runtime, CLASS_ID, 'answer'));
    const args = {images: runtime.images, imageId: 'app', classRef: objectRef('app', CLASS_ID), selector: 'answer', require};

    const described = await authorizedDescribeSmalltalkMethod(args);
    const {descriptor, versionToken} = await authorizedReadSmalltalkMethodForUpdate(args);

    // The descriptor is the canonical one, not a variant: byte-for-byte what ADR 0087 answers.
    assert.deepEqual(descriptor, described);
    // ... and ADR 0087's own answer gained nothing. A reader is not a writer.
    assert.equal(Object.prototype.hasOwnProperty.call(described, 'versionToken'), false);
    assert.equal(descriptor.source, null, 'E3 is replacement from supplied source, not a source editor');
    assert.equal(typeof versionToken, 'string');
    assert.ok(Object.isFrozen(descriptor));
  } finally {
    await runtime.close();
  }
});

// SCOPE. A token is an assumption about ONE position. Handed a different class or a different
// selector it must be refused, never reinterpreted — otherwise a caller could carry an assumption
// about `answer` into a write against `other`.
test('a token is refused for any position other than the one it was issued for', async () => {
  const runtime = await image();
  try {
    const classRef = objectRef('app', CLASS_ID);
    const {versionToken} = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef,
      selector: 'answer',
      require: readerFor(runtime, await grantsFor(runtime, CLASS_ID, 'answer')),
    });

    // Its own position parses.
    assert.ok(parseSmalltalkMethodPositionToken(versionToken, {imageId: 'app', classRef, selector: 'answer'}));

    for (const [label, position] of [
      ['another selector on the same class', {imageId: 'app', classRef, selector: 'other'}],
      ['the same selector on another class', {imageId: 'app', classRef: objectRef('app', OTHER_CLASS_ID), selector: 'answer'}],
      ['another image', {imageId: 'elsewhere', classRef: objectRef('elsewhere', CLASS_ID), selector: 'answer'}],
    ]) {
      assert.throws(
        () => parseSmalltalkMethodPositionToken(versionToken, position),
        (error) => error.name === 'SmalltalkMethodPositionTokenError'
          && /issued for a different method position/.test(error.message),
        label,
      );
    }

    // LOCALITY, asserted separately because it raises a different message and would silently pass
    // the loop's regex above. The two axes must not move together: hold imageId at `app` and move
    // ONLY the class ref. Without the locality check a token minted for `{app, C}` is accepted
    // against `{app, elsewhere/C}`, because only the objectId would have been compared — and every
    // other case in this file still passes with that check reverted.
    assert.throws(
      () => parseSmalltalkMethodPositionToken(versionToken, {
        imageId: 'app', classRef: objectRef('elsewhere', CLASS_ID), selector: 'answer',
      }),
      (error) => error.name === 'SmalltalkMethodPositionTokenError'
        && /is not local to app/.test(error.message),
      'a class ref in another image is not this image\'s position',
    );
    // The same rule on the minting side.
    assert.throws(
      () => smalltalkMethodPositionToken({
        imageId: 'app', classRef: objectRef('elsewhere', CLASS_ID), selector: 'answer',
        method: objectRef('app', 'blk'),
      }),
      (error) => error.name === 'SmalltalkMethodPositionTokenError'
        && /is not local to app/.test(error.message),
      'a non-local class ref cannot mint a token either',
    );
  } finally {
    await runtime.close();
  }
});

// THE TOKEN IS NOT THE BLOCK REF, and is not a ref at all. If it were, it would be locally
// derivable by a caller that already browsed the method, and would prove nothing about having read
// this position through this owner.
test('the token is not the Block ref and carries no storage version', async () => {
  const runtime = await image();
  try {
    const classRef = objectRef('app', CLASS_ID);
    const [classObjectId, methodObjectId] = await grantsFor(runtime, CLASS_ID, 'answer');
    const {descriptor, versionToken} = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef,
      selector: 'answer',
      require: readerFor(runtime, [classObjectId, methodObjectId]),
    });

    assert.notDeepEqual(versionToken, descriptor.method, 'a token is not a ref');
    assert.equal(typeof versionToken, 'string');
    assert.ok(versionToken.startsWith(`${SMALLTALK_METHOD_POSITION_TOKEN_V0}:`), 'it names its own format');

    // NO STORAGE VERSION LEAKS, asserted semantically rather than by searching the token for a
    // digit — a substring check against a small integer like a `_version` is a faulty oracle, since
    // base64url text contains most short strings by chance.
    //
    // The real property is that the token is a FUNCTION OF EXACTLY FOUR THINGS: image, class,
    // selector and the observed binding. Recomputing it from those alone reproduces it, so nothing
    // else — no MethodDictionary version, no Class record version, no storage identity — can be
    // inside it.
    assert.equal(
      versionToken,
      smalltalkMethodPositionToken({imageId: 'app', classRef, selector: 'answer', method: descriptor.method}),
      'the token is exactly a function of the position and its observed revision',
    );
    // ... and those storage facts really do exist to have leaked, so the assertion is not vacuous.
    const behavior = await runtime.images.getObject('app', classObjectId);
    const dictionaryRef = behavior.slots['behavior-methods'];
    const dictionary = await runtime.images.getObject(dictionaryRef.imageId, dictionaryRef.objectId);
    assert.equal(typeof dictionary._version, 'number');
    assert.equal(typeof behavior._version, 'number');
  } finally {
    await runtime.close();
  }
});

// The token tracks the POSITION's revision. Replacing the method must change it; changing an
// unrelated selector must not — that is the difference between selector-position scope and
// whole-MethodDictionary scope, and it is the reason the token is not the dictionary's version.
test('the token follows the position revision, and an unrelated selector does not move it', async () => {
  const runtime = await image();
  try {
    const classRef = objectRef('app', CLASS_ID);
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm'};
    const read = async () => (await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef,
      selector: 'answer',
      require: readerFor(runtime, await grantsFor(runtime, CLASS_ID, 'answer')),
    }));

    const first = await read();
    // Reading again without any change answers the same token: it describes state, not the read.
    assert.equal((await read()).versionToken, first.versionToken);

    // An UNRELATED selector changes. The dictionary record necessarily moves underneath — that is
    // the persistence mechanism — but this position did not, so its token must not move either.
    //
    // The unrelated edit must be PROVEN to have landed, or this arm is vacuous: if reconcile
    // converged, no-opped or was skipped, the token would be unchanged for the trivial reason that
    // nothing happened, and the selector-position-vs-dictionary-scope claim would go untested.
    const otherBefore = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef, selector: 'other',
    });
    await reconcileMethodsFromSource({
      ...options, classRef, methods: [{selector: 'other', source: '[ ^ 22 ]'}],
    });
    const otherAfter = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef, selector: 'other',
    });
    assert.notDeepEqual(otherAfter, otherBefore, 'the unrelated edit must really have moved `other`');
    assert.equal(
      (await read()).versionToken,
      first.versionToken,
      'an unrelated selector edit must not invalidate this position',
    );

    // THIS selector changes. The bound revision is new, so the token must be new.
    await reconcileMethodsFromSource({
      ...options, classRef, methods: [{selector: 'answer', source: '[ ^ 11 ]'}],
    });
    const after = await read();
    assert.notEqual(after.versionToken, first.versionToken, 'replacing the method must move its token');
    assert.notDeepEqual(after.descriptor.method, first.descriptor.method, 'ADR 0086: a new revision identity');
  } finally {
    await runtime.close();
  }
});

// AUTHORITY. Reading in order to write is still only reading: this demands exactly what ADR 0087's
// method read demands — the Class read and, independently, the method's Block read — and it grants
// nothing. In particular holding a token is not authority to do anything.
test('the read for update demands the same two independent reads and no write', async () => {
  const runtime = await image();
  try {
    const classRef = objectRef('app', CLASS_ID);
    const [classObjectId, methodObjectId] = await grantsFor(runtime, CLASS_ID, 'answer');
    const args = {images: runtime.images, imageId: 'app', classRef, selector: 'answer'};

    // Class-read authority alone is not enough: the Block is an independent object.
    await assert.rejects(
      authorizedReadSmalltalkMethodForUpdate({...args, require: readerFor(runtime, [classObjectId])}),
      (error) => error?.name === 'AuthorityError',
      'class authority must not yield the Block',
    );
    // Neither is Block authority alone.
    await assert.rejects(
      authorizedReadSmalltalkMethodForUpdate({...args, require: readerFor(runtime, [methodObjectId])}),
      (error) => error?.name === 'AuthorityError',
    );
    // A denied caller cannot distinguish an existing method from a missing one.
    for (const selector of ['answer', 'neverImplemented']) {
      await assert.rejects(
        authorizedReadSmalltalkMethodForUpdate({...args, selector, require: readerFor(runtime, [])}),
        (error) => error?.name === 'AuthorityError',
      );
    }

    // The demands it makes are READS. A require that grants both reads but refuses any write still
    // satisfies it, which is what proves this seam asserts no write authority.
    const demands = [];
    const context = runtime.authority.issue({
      principal: 'e3-probe',
      grants: [classObjectId, methodObjectId].map((objectId) => ({
        operation: OBJECT_READ_OPERATION,
        resource: objectResource('app', objectId),
      })),
    });
    await authorizedReadSmalltalkMethodForUpdate({
      ...args,
      require: (demand) => {
        demands.push(demand);
        return runtime.authority.require(context, demand);
      },
    });
    assert.deepEqual(demands.map(({operation}) => operation), [OBJECT_READ_OPERATION, OBJECT_READ_OPERATION]);
    assert.equal(demands.some(({operation}) => operation === OBJECT_WRITE_OPERATION), false, 'reading is not writing');
  } finally {
    await runtime.close();
  }
});

// The descriptor and the token must describe the SAME resolved binding. They come from one
// resolution, so this asserts the property that factoring is there to guarantee.
test('the descriptor and the token describe the same resolved binding', async () => {
  const runtime = await image();
  try {
    const classRef = objectRef('app', CLASS_ID);
    const {descriptor, versionToken} = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef,
      selector: 'answer',
      require: readerFor(runtime, await grantsFor(runtime, CLASS_ID, 'answer')),
    });
    assert.deepEqual(
      parseSmalltalkMethodPositionToken(versionToken, {imageId: 'app', classRef, selector: 'answer'}),
      {imageId: descriptor.method.imageId, objectId: descriptor.method.objectId},
    );

    // The above is a witness in a quiescent image: a SECOND resolution would agree with the first,
    // so it would stay green even if the token were minted from its own separate read. What makes
    // the one-read property observable is a binding that MOVES between two resolutions. Replacing
    // the method under a paused read is not something this seam exposes, so assert the next best
    // thing the property implies and a two-read implementation would break: across a real change,
    // descriptor and token move TOGETHER, never one without the other.
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef,
      methods: [{selector: 'answer', source: '[ ^ 99 ]'}],
      lane: 'neutral',
    });
    const moved = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef,
      selector: 'answer',
      require: readerFor(runtime, await grantsFor(runtime, CLASS_ID, 'answer')),
    });
    assert.notDeepEqual(moved.descriptor.method, descriptor.method, 'the binding really moved');
    assert.notEqual(moved.versionToken, versionToken, 'so the token moved too');
    assert.deepEqual(
      parseSmalltalkMethodPositionToken(moved.versionToken, {imageId: 'app', classRef, selector: 'answer'}),
      {imageId: moved.descriptor.method.imageId, objectId: moved.descriptor.method.objectId},
      'and they still name the SAME binding, not two resolutions of it',
    );

    // The result envelope is frozen, as docs/ownership.md claims.
    assert.ok(Object.isFrozen(moved), 'the {descriptor, versionToken} result is frozen');
  } finally {
    await runtime.close();
  }
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: minting the token from a SECOND resolution of the same
// position — e.g. a second `methodBindings` read — instead of from the binding the descriptor
// reports. `smalltalk-browse.js` already imports `methodBindings`, so that is a two-line drift.
//
// Every value-equality assertion is blind to it: a second resolution of an unchanged image agrees
// with the first, so descriptor and token still name the same ref and every deepEqual stays green.
// Even the authority-demand count misses a raw re-read, because a second `methodBindings` call
// issues no new demand. The observable difference is that the same records are FETCHED TWICE, so
// that is what this asserts: one resolution reads each record once.
//
// docs/ownership.md says these "can never name different revisions". This is the assertion that
// makes that sentence enforceable rather than aspirational.
test('the descriptor and the token come from ONE resolution, not two that agree', async () => {
  const runtime = await image();
  try {
    const classRef = objectRef('app', CLASS_ID);
    const fetched = [];
    const counting = new Proxy(runtime.images, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (property === 'getObject') fetched.push(`${args[0]}/${args[1]}`);
          return value.apply(target, args);
        };
      },
    });

    await authorizedReadSmalltalkMethodForUpdate({
      images: counting,
      imageId: 'app',
      classRef,
      selector: 'answer',
      require: readerFor(runtime, await grantsFor(runtime, CLASS_ID, 'answer')),
    });

    // The kernel record is deliberately excluded, and only it: `findSmalltalkKernel` is
    // unmemoized by design and is reached twice on this path, which is the separately tracked
    // read amplification of bead lagrange-images-jtz.3 — a cost, not a second resolution of the
    // BINDING. Everything else here is the binding: the Behavior and its method dictionary, which
    // are exactly what a second `methodBindings` call would fetch again.
    const binding = fetched.filter((id) => !id.endsWith('/smalltalk-kernel/v1'));
    const twice = binding.filter((id, at) => binding.indexOf(id) !== at);
    assert.deepEqual(
      twice, [],
      `one resolution reads each binding record once; these were read again: ${JSON.stringify(twice)}`,
    );
    // Non-vacuous: the read really did fetch the Behavior and its dictionary, so an implementation
    // that fetched nothing could not pass by having nothing to repeat.
    assert.ok(binding.length >= 2, `the read must actually have fetched binding records: ${JSON.stringify(binding)}`);
  } finally {
    await runtime.close();
  }
});

// The token is scoped to a {Class/METACLASS, selector} position, and `descriptor.side` distinguishes
// them. Nothing else here exercises the class side at all, so a mint or a scope compare that quietly
// dropped the Metaclass half — or a descriptor reporting the wrong side for it — would pass.
test('a class-side position is its own position, distinct from the instance side', async () => {
  const runtime = await image();
  try {
    const classRef = objectRef('app', CLASS_ID);
    const metaclassRef = objectRef('app', METACLASS_ID);
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: metaclassRef,
      methods: [{selector: 'answer', source: '[ ^ 7 ]'}],
      lane: 'neutral',
    });

    const readSide = async (ref, id) => await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef: ref,
      selector: 'answer',
      require: readerFor(runtime, await grantsFor(runtime, id, 'answer')),
    });
    const instance = await readSide(classRef, CLASS_ID);
    const klass = await readSide(metaclassRef, METACLASS_ID);

    assert.equal(instance.descriptor.side, 'instance');
    assert.equal(klass.descriptor.side, 'class');
    // Same selector, same image, different Behavior: two positions, two tokens.
    assert.notEqual(klass.versionToken, instance.versionToken);
    // And neither token is accepted for the other's position.
    assert.throws(
      () => parseSmalltalkMethodPositionToken(klass.versionToken, {imageId: 'app', classRef, selector: 'answer'}),
      (error) => error.name === 'SmalltalkMethodPositionTokenError',
      'a class-side token is not an instance-side token',
    );
    assert.throws(
      () => parseSmalltalkMethodPositionToken(instance.versionToken, {imageId: 'app', classRef: metaclassRef, selector: 'answer'}),
      (error) => error.name === 'SmalltalkMethodPositionTokenError',
      'nor the reverse',
    );
  } finally {
    await runtime.close();
  }
});

// A malformed token is refused as a malformed token, not treated as an absent one.
test('a malformed token is refused rather than ignored', async () => {
  const classRef = objectRef('app', CLASS_ID);
  const position = {imageId: 'app', classRef, selector: 'answer'};
  // The position half of a REAL token, so the cases below actually reach the observed half. An
  // earlier version of this test put the bad bytes in the position half, where the scope compare
  // rejects them first — so the try/catch and the canonicality guard they were written for were
  // never executed at all, and deleting both left this test green.
  const realScope = smalltalkMethodPositionToken({
    imageId: 'app', classRef, selector: 'answer', method: objectRef('app', 'blk'),
  }).split(':')[1];
  const withObserved = (observed) => `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:${realScope}:${observed}`;
  for (const bad of [
    '', 'nonsense', 'object-version/v0:a:b',
    `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:only-two`,
    `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:!!!:!!!`,
    // Observed half is not base64url at all: the byte decoder raises a plain TypeError, which must
    // NOT cross this seam — a malformed token is an Images-native semantic outcome.
    withObserved('!!!'),
    withObserved('not base64url!'),
    // Observed half is well-formed base64url but the wrong SHAPE: one part, or three.
    withObserved('YXBw'),
    withObserved('YXBw.YmxrMQ.eA'),
    // Observed half decodes to an empty half.
    withObserved('.Ymxr'),
    // NON-CANONICAL base64url that decodes to the same bytes as a valid observed half. Base64
    // silently drops leftover bits, so without the re-encode guard this parses as if canonical.
    withObserved('YXBw.Ymxr='),
  ]) {
    assert.throws(
      () => parseSmalltalkMethodPositionToken(bad, position),
      (error) => error.name === 'SmalltalkMethodPositionTokenError',
      `${JSON.stringify(bad)} must be refused as a malformed token, not as a foreign error`,
    );
  }
});
