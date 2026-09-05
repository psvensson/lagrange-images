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
    await reconcileMethodsFromSource({
      ...options, classRef, methods: [{selector: 'other', source: '[ ^ 22 ]'}],
    });
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
  } finally {
    await runtime.close();
  }
});

// A malformed token is refused as a malformed token, not treated as an absent one.
test('a malformed token is refused rather than ignored', async () => {
  const classRef = objectRef('app', CLASS_ID);
  const position = {imageId: 'app', classRef, selector: 'answer'};
  // Including tokens whose parts are not base64url at all: the byte decoder raises a plain
  // TypeError for those, and it must not cross this seam — a malformed token is an Images-native
  // semantic outcome, not a foreign error from a helper.
  const wrongScope = `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:!!!:!!!`;
  for (const bad of [
    '', 'nonsense', 'object-version/v0:a:b',
    `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:only-two`,
    wrongScope,
    `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:${wrongScope.split(':')[1]}:not base64url!`,
  ]) {
    assert.throws(
      () => parseSmalltalkMethodPositionToken(bad, position),
      (error) => error.name === 'SmalltalkMethodPositionTokenError',
      `${JSON.stringify(bad)} must be refused as a malformed token, not as a foreign error`,
    );
  }
});
