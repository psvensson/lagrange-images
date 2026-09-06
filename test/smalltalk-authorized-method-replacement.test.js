import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
  authorizedReplaceSmalltalkMethod,
  createRuntime,
  defineMethodsFromSource,
  findSmalltalkKernel,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  methodBlockRef,
  objectRef,
  objectResource,
  reconcileMethodsFromSource,
  SEAL_METADATA_KEY,
} from '../src/runtime.js';
// The C2 module's own error classes are deliberately NOT published through any root — the public
// taxonomy is discriminated by `error.name` — so the proofs import them from the owner directly,
// exactly as the Slice B proofs import the token helpers.
import {
  SmalltalkMethodReplacementContentionError,
  SmalltalkMethodReplacementInputError,
  SmalltalkMethodTargetError,
  authorizedReplaceSmalltalkMethod as ownedReplace,
} from '../src/language/smalltalk-authorized-method-replacement.js';
import {SmalltalkStaleMethodPositionError} from '../src/language/smalltalk-class-builder.js';
// Minting is the token owner's business and is not published either. A few proofs need a token
// whose SCOPE names a position the public read cannot issue one for — a class that does not exist,
// a selector nothing implements, another image — so they mint it here rather than editing the text
// of a real one, which would only prove something about string surgery.
import {smalltalkMethodPositionToken} from '../src/language/smalltalk-method-position-token.js';

// C2 of bead lagrange-images-qax: the AUTHORIZED public seam for replacing ONE existing native
// method (Object Environment E3, GitHub #218).
//
// WHAT THIS FILE DOES NOT DO. It does not re-prove C1. Expected-binding semantics, stale-position
// meaning, immutable revision publication, unrelated-selector CAS rebase, bounded contention and
// winner preservation are owned and proven by test/smalltalk-expected-current-binding.test.js;
// reproducing those interleavings here would create a second copy to drift. What is proven here is
// the PUBLIC SEAM: its authority rule and ordering, the token -> expected-binding bridge, that the
// stale verdict precedes compilation, the error taxonomy, the export boundary, and that the wrapper
// cannot bypass C1 or convert C1's selector-position semantics back into whole-dictionary ones.
//
// Competing bindings are made OBSERVABLY different — each answers a distinct integer through a real
// send — because several of the wrong implementations these tests exist to kill reach the same
// final ref and differ only in whether they should have.

const GUARDED = 'guardedAnswer';
const UNRELATED = 'unrelatedAnswer';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

async function withFixture(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const classRef = kernel.integerClass;
    const options = {
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef,
    };
    // A -> 1 at the guarded position, X -> 10 beside it.
    await defineMethodsFromSource({
      ...options,
      methods: [{selector: GUARDED, source: '[ ^ 1 ]'}, {selector: UNRELATED, source: '[ ^ 10 ]'}],
    });
    return await body(runtime, options, kernel);
  } finally {
    await runtime.close();
  }
}

let sends = 0;
async function answerOf(runtime, selector) {
  sends += 1;
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: 'app', id: `send-${sends}`, source: `[ :receiver | receiver ${selector} ]`,
  });
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(
    objectRef('app', installed.block.id), [integerValue(0)],
  ));
}

const answers = async (runtime, selector, expected, message) =>
  assert.deepEqual(await answerOf(runtime, selector), integerValue(expected), message);

const readDemand = (imageId, objectId) => ({
  operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, objectId),
});
const writeDemand = (imageId, objectId) => ({
  operation: OBJECT_WRITE_OPERATION, resource: objectResource(imageId, objectId),
});

// The caller-side `require` closure over a freshly issued LIVE authority context, exactly as an
// Object Environment host builds one. Every demand it is asked is recorded, so a proof can assert
// WHAT was demanded and in what order, not merely that the call succeeded.
function requireFor(runtime, grants) {
  const context = runtime.authority.issue({principal: 'alice', grants});
  const demands = [];
  const require = (demand) => {
    demands.push(demand);
    return runtime.authority.require(context, demand);
  };
  require.demands = demands;
  return require;
}

// Everything the ADR 0087 read-for-update needs: the class's own read plus the current method
// Block's independent read.
async function readerFor(runtime, options, selector) {
  const method = await methodBlockRef({...options, selector});
  return requireFor(runtime, [
    readDemand('app', options.classRef.objectId),
    readDemand(method.imageId, method.objectId),
  ]);
}

// The token comes from the PUBLIC read for update, never minted by hand: what E3 promises is that
// the pair (read, replace) works, and a hand-minted token would prove nothing about that.
async function tokenFor(runtime, options, selector = GUARDED) {
  return (await authorizedReadSmalltalkMethodForUpdate({
    images: runtime.images,
    imageId: 'app',
    classRef: options.classRef,
    selector,
    require: await readerFor(runtime, options, selector),
  })).versionToken;
}

const writerFor = (runtime, options) => requireFor(runtime, [writeDemand('app', options.classRef.objectId)]);

const replace = (runtime, options, extra) => authorizedReplaceSmalltalkMethod({
  images: runtime.images,
  compilation: runtime.compilation,
  imageId: 'app',
  classRef: options.classRef,
  selector: GUARDED,
  ...extra,
});

const failure = (promise) => promise.then(() => null, (error) => error);

// Every record in the image, by id and version. A "published nothing" claim is counted BEFORE any
// send, because resolving a send installs a Block of its own and would mask the point.
const recordFingerprint = async (runtime) =>
  (await runtime.images.listRecords('app')).map(({id, _version}) => [id, _version]).sort();

// A delegate image service that counts the reads made THROUGH it. Prototype delegation, so every
// other method keeps working and the service's own state is untouched.
function countingImages(images) {
  const counts = {reads: 0};
  const delegate = Object.create(images);
  for (const name of ['getObject', 'getBlock', 'getShape', 'getCodeArtifact', 'listRecords', 'listCodeArtifacts']) {
    if (typeof images[name] !== 'function') continue;
    delegate[name] = async (...args) => {
      counts.reads += 1;
      return await images[name](...args);
    };
  }
  return {images: delegate, counts};
}

// A delegate compilation service that records every artifact compilation it is asked for. This is
// the compiler owner's admission point: if it never records a call, the seam never asked anything
// to be compiled.
function countingCompilation(compilation) {
  const compiled = [];
  const delegate = Object.create(compilation);
  delegate.compileArtifact = async (...args) => {
    compiled.push(args[1]?.id ?? null);
    return await compilation.compileArtifact(...args);
  };
  return {compilation: delegate, compiled};
}

// Run `actions[n]` immediately before this operation's (n+1)th MethodDictionary CAS, with the real
// backend restored so the interleaved actor writes normally. Mirrors the harness C1's proofs use;
// it is the only way to place an external write INSIDE a guarded operation.
function interleaveAtDictionaryCas(runtime, classObjectId, actions) {
  const putObject = runtime.images.putObject.bind(runtime.images);
  let attempts = 0;
  const hook = async (imageId, input, options) => {
    if (input.id === `${classObjectId}/methods` && options?.expectedVersion !== undefined) {
      const action = actions[attempts];
      attempts += 1;
      if (action) {
        runtime.images.putObject = putObject;
        await action();
        runtime.images.putObject = hook;
      }
    }
    return await putObject(imageId, input, options);
  };
  runtime.images.putObject = hook;
  return {
    restore: () => { runtime.images.putObject = putObject; },
    attempts: () => attempts,
  };
}

const versionConflict = () => Object.assign(new Error('simulated backend conflict'), {
  name: 'VersionConflictError',
});

// ---------------------------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a seam whose expectation can never be satisfied, so no
// authorized replacement ever lands; and one whose receipt is a second description API — a Block
// ref, a descriptor, a replacement token or the source would each tempt the consumer to skip the
// fresh authorized reread it has already committed to (#218 point 4).
test('an authorized replacement of a still-current position advances exactly that position', async () => {
  await withFixture(async (runtime, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const token = await tokenFor(runtime, options);

    const result = await replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    });

    assert.deepEqual(result, {replaced: true}, 'the receipt is minimal');
    assert.deepEqual(Object.keys(result), ['replaced'], 'and carries nothing else at all');
    assert.ok(Object.isFrozen(result), 'and is frozen');
    await answers(runtime, GUARDED, 7, 'the guarded position advanced');
    await answers(runtime, UNRELATED, 10, 'the sibling position did not move');
    assert.notDeepEqual(await methodBlockRef({...options, selector: GUARDED}), observed,
      'a successful replacement legitimately rebinds to a FRESH Block identity');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a seam that makes the receipt a claim about STORAGE
// rather than about the caller's request. Supplying source that means exactly what is already bound
// is ADR 0086 exact replay against the very state the caller observed — a write-free success — and
// an implementation that reported failure, or that forced a write to make `replaced: true` true,
// would break the idempotence a consumer needs after a lost acknowledgement of its own read.
test('replacing a method with what it already means is a write-free success with the same receipt', async () => {
  await withFixture(async (runtime, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const before = await recordFingerprint(runtime);
    const history = (await runtime.images.history('app')).length;

    const result = await replace(runtime, options, {
      source: '[ ^ 1 ]',
      expectedVersionToken: await tokenFor(runtime, options),
      require: writerFor(runtime, options),
    });

    assert.deepEqual(result, {replaced: true}, 'the receipt is about the request, not about storage');
    assert.deepEqual(await recordFingerprint(runtime), before, 'and nothing at all was written');
    assert.equal((await runtime.images.history('app')).length, history);
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), observed,
      'the binding did not move, because it already denoted this source');
    await answers(runtime, GUARDED, 1);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: making E3 a source editor. #218 point 5 scopes this as
// replacement FROM explicitly supplied source, and ADR 0087's `source: null` is not a precondition
// to change — a seam that started persisting the supplied text would quietly make Images a source
// database and change what the browse seam means.
test('a successful replacement persists no source: the descriptor still reports none', async () => {
  await withFixture(async (runtime, options) => {
    await replace(runtime, options, {
      source: '[ ^ 7 ]',
      expectedVersionToken: await tokenFor(runtime, options),
      require: writerFor(runtime, options),
    });

    const descriptor = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      require: await readerFor(runtime, options, GUARDED),
    });
    assert.equal(descriptor.source, null, 'still absent, and that is the truthful answer');
    assert.equal(descriptor.provenance, null);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a seam that silently refuses, silently breaks, or
// silently MIGRATES a method that was installed in the WASM lane — which is every Cuis-imported
// method, and therefore the whole target of slice D.
//
// The third of those shipped. Publishing no lane knob is still the contract, but the consequence
// this test used to pin — the replacement landing in the from-source owner's neutral default — was
// never the E3 contract: a replacement says "make this position mean this source", not "and also
// change its executable representation", and a caller with no lane knob could not have asked for the
// second thing or observed that it happened. Bead lagrange-images-it3 gave the question its owner:
// the native method evolution owner preserves the lane of the revision the caller OBSERVED, read
// back from the `metadata.lane` that owner itself publishes on every method Block. This seam is
// unchanged and still passes only the observed binding down; `test/smalltalk-replacement-lane.test.js`
// owns the rule and its refusals.
test('a method installed in the WASM lane is replaced by one in the WASM lane', async () => {
  await withFixture(async (runtime, options) => {
    const WASM_LANE = 'wasmLaneAnswer';
    await defineMethodsFromSource({...options, lane: 'wasm', methods: [{selector: WASM_LANE, source: '[ ^ 1 ]'}]});
    const before = await methodBlockRef({...options, selector: WASM_LANE});
    const representationOf = async (method) => {
      const block = await runtime.images.getBlock(method.imageId, method.objectId);
      return (await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId)).representation;
    };
    assert.equal(await representationOf(before), 'wasm-function/v2', 'the fixture really is WASM-lane');

    const result = await authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: options.classRef,
      selector: WASM_LANE,
      source: '[ ^ 7 ]',
      expectedVersionToken: await tokenFor(runtime, options, WASM_LANE),
      require: writerFor(runtime, options),
    });

    assert.deepEqual(result, {replaced: true});
    await answers(runtime, WASM_LANE, 7, 'and the replaced method still dispatches and answers');
    const after = await methodBlockRef({...options, selector: WASM_LANE});
    assert.notDeepEqual(after, before, 'the position advanced to a fresh revision');
    assert.equal(await representationOf(after), 'wasm-function/v2',
      'and the replacement preserves the execution lane of the revision the caller observed');
    assert.equal((await runtime.images.getBlock(after.imageId, after.objectId)).metadata?.lane, 'wasm');
  });
});

// ---------------------------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: authorizing AFTER the lookup. Such a seam is an
// existence oracle — a denied caller learns whether the class exists and whether it implements the
// selector by which failure it gets — and it reads graph state on behalf of someone who may not
// write it.
test('authorization precedes existence: denied existing, denied missing selector and denied missing class are one answer', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    // Everything EXCEPT the write. A caller holding both reads can already browse this method.
    const method = await methodBlockRef({...options, selector: GUARDED});
    const denied = () => requireFor(runtime, [
      readDemand('app', options.classRef.objectId),
      readDemand(method.imageId, method.objectId),
    ]);
    const before = await recordFingerprint(runtime);
    const {images, counts} = countingImages(runtime.images);

    // The refusal is a pure function of what the CALLER supplied. Two of the three cases name the
    // same class, so their refusals must be byte-identical; the third names a different class, so
    // its demand names that class — the caller's own input, never anything read from the image.
    const outcomes = [];
    for (const [label, target] of [
      ['an implemented selector', {selector: GUARDED, classRef: options.classRef}],
      ['an unimplemented selector', {selector: 'neverImplemented', classRef: options.classRef}],
      ['a class that does not exist', {selector: GUARDED, classRef: objectRef('app', 'smalltalk/class/Absent')}],
    ]) {
      const error = await failure(authorizedReplaceSmalltalkMethod({
        images,
        compilation: runtime.compilation,
        imageId: 'app',
        classRef: target.classRef,
        selector: target.selector,
        source: '[ ^ 7 ]',
        // A token whose SCOPE matches the target, so the refusal cannot come from token scope and
        // the three cases differ only in what the image holds.
        expectedVersionToken: target.selector === GUARDED && target.classRef === options.classRef
          ? token
          : smalltalkMethodPositionToken({
            imageId: 'app', classRef: target.classRef, selector: target.selector, method,
          }),
        require: denied(),
      }));
      assert.equal(error?.name, 'AuthorityError', `${label}: ${error}`);
      assert.deepEqual(
        {operation: error.operation, resource: error.resource},
        {operation: OBJECT_WRITE_OPERATION, resource: objectResource('app', target.classRef.objectId)},
        `${label}: the refusal restates only the demand the caller's own input produced`,
      );
      outcomes.push(`${error.name}: ${error.message}`);
    }

    assert.equal(new Set(outcomes.slice(0, 2)).size, 1,
      'an implemented and an unimplemented selector on the SAME class are literally one answer');
    assert.equal(new Set(outcomes).size, 2,
      'and the missing class differs only where the caller\'s own classRef differs');
    assert.equal(counts.reads, 0, 'a denied caller caused NO graph read at all');
    assert.deepEqual(await recordFingerprint(runtime), before, 'and nothing was written');
    await answers(runtime, GUARDED, 1, 'the method is untouched');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: three of them.
//   (a) demanding `object/read` — reading a class must never authorize rebinding its protocol;
//   (b) demanding write on the OLD BLOCK — that Block is immutable revision material and is not
//       what a replacement mutates, so requiring it authorizes a mutation nobody performs;
//   (c) inferring write from any combination of reads.
test('read is not write, and write on the old Block is not write on the class', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const method = await methodBlockRef({...options, selector: GUARDED});

    for (const [label, grants] of [
      ['class read alone', [readDemand('app', options.classRef.objectId)]],
      ['class read + Block read', [
        readDemand('app', options.classRef.objectId),
        readDemand(method.imageId, method.objectId),
      ]],
      ['write on the old Block, not the class', [
        readDemand('app', options.classRef.objectId),
        readDemand(method.imageId, method.objectId),
        writeDemand(method.imageId, method.objectId),
      ]],
    ]) {
      const error = await failure(replace(runtime, options, {
        source: '[ ^ 7 ]', expectedVersionToken: token, require: requireFor(runtime, grants),
      }));
      assert.equal(error?.name, 'AuthorityError', `${label} must not permit replacement: ${error}`);
    }

    // And the grant that IS the rule succeeds — otherwise the three refusals above could be
    // explained by an operation that refuses everyone.
    await replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    });
    await answers(runtime, GUARDED, 7);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: treating the token as a capability. A version token is
// an assumption ABOUT state; it is minted by a read that asserts no write authority, and a seam that
// accepted it as permission would let every reader rewrite every method it had browsed.
test('a valid current token confers no authority', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const before = await recordFingerprint(runtime);

    const error = await failure(replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: requireFor(runtime, []),
    }));

    assert.equal(error?.name, 'AuthorityError', `holding the token is not permission: ${error}`);
    assert.deepEqual(await recordFingerprint(runtime), before);
    await answers(runtime, GUARDED, 1);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a seam that demands the right operation but at the
// wrong moment or alongside extra demands. The exact demand SET is the contract: one `object/write`
// on the Class/Metaclass the caller named, issued before any record has been read.
test('the operation demands exactly one object/write on the declaring class, before any read', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const {images, counts} = countingImages(runtime.images);
    let readsWhenDemanded = null;
    const grants = [writeDemand('app', options.classRef.objectId)];
    const context = runtime.authority.issue({principal: 'alice', grants});
    const demands = [];
    const require = (demand) => {
      demands.push(demand);
      if (readsWhenDemanded === null) readsWhenDemanded = counts.reads;
      return runtime.authority.require(context, demand);
    };

    await authorizedReplaceSmalltalkMethod({
      images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      source: '[ ^ 7 ]',
      expectedVersionToken: token,
      require,
    });

    assert.deepEqual(demands, [writeDemand('app', options.classRef.objectId)],
      'exactly one demand, and it is the class write');
    assert.equal(readsWhenDemanded, 0, 'demanded before a single record was read');
    assert.ok(counts.reads > 0, 'and the operation really did read afterwards');
  });
});

// ---------------------------------------------------------------------------------------------
// The token bridge
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: reinterpreting a token issued for a different position
// as though it named this one, and letting a helper's foreign `TypeError` (the base64url decoder
// raises one for text that is not base64url at all) cross the public seam as though it were a
// caller-input verdict.
test('a token for another position, or no token at all, refuses before any mutation', async () => {
  await withFixture(async (runtime, options, kernel) => {
    const before = await recordFingerprint(runtime);
    const writer = () => writerFor(runtime, options);

    const method = await methodBlockRef({...options, selector: GUARDED});
    const cases = [
      ['a token for another selector on this class', await tokenFor(runtime, options, UNRELATED)],
      ['a token for another class', smalltalkMethodPositionToken({
        imageId: 'app', classRef: kernel.metaclassClass, selector: GUARDED, method,
      })],
      ['a token for another image', smalltalkMethodPositionToken({
        imageId: 'elsewhere',
        classRef: objectRef('elsewhere', options.classRef.objectId),
        selector: GUARDED,
        method,
      })],
      ['text that is not a token', 'not-a-token'],
      ['text that is not base64url at all', (await tokenFor(runtime, options)).replace(/:[^:]*$/, ':***.***')],
      ['no token', undefined],
    ];

    for (const [label, token] of cases) {
      const error = await failure(replace(runtime, options, {
        source: '[ ^ 7 ]', expectedVersionToken: token, require: writer(),
      }));
      assert.equal(error?.name, 'SmalltalkMethodPositionTokenError',
        `${label} must be a token verdict, not a foreign error: ${error?.name}: ${error?.message}`);
      assert.ok(!(error instanceof SmalltalkMethodReplacementInputError),
        `${label}: a token is not caller-owned shape`);
      assert.ok(!(error instanceof SmalltalkStaleMethodPositionError),
        `${label}: a wrong-scope token is refused, never reinterpreted as staleness`);
    }

    assert.deepEqual(await recordFingerprint(runtime), before, 'no refusal mutated anything');
    await answers(runtime, GUARDED, 1);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: evaluating the caller's expectation only where C1 does
// — at plan time, which is AFTER `reconcileMethodsFromSource` has compiled the source. Such a seam
// answers a compiler diagnostic to a caller whose real problem is that its observation was
// overtaken, and it compiles source it could already know is inadmissible.
//
// This is DISTINCT from C1's mid-flight stale case, where immutable material legitimately already
// exists: here nothing may be compiled at all.
test('a stale position is refused BEFORE the compiler is invoked', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    // An external actor moves the position to B.
    await reconcileMethodsFromSource({...options, methods: [{selector: GUARDED, source: '[ ^ 2 ]'}]});
    const winner = await methodBlockRef({...options, selector: GUARDED});
    const before = await recordFingerprint(runtime);
    const {compilation, compiled} = countingCompilation(runtime.compilation);

    // The source is deliberately UNCOMPILABLE. An implementation that compiles first cannot answer
    // staleness here — it answers a syntax error — so the two orderings are distinguishable by the
    // verdict alone, which no assertion about final state could separate.
    const error = await failure(authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      source: '[ 3 + ]',
      expectedVersionToken: token,
      require: writerFor(runtime, options),
    }));

    assert.ok(error instanceof SmalltalkStaleMethodPositionError,
      `an overtaken observation is stale even when the source is also bad; got ${error?.name}: ${error?.message}`);
    assert.deepEqual(compiled, [], 'the compiler owner was never invoked');
    assert.deepEqual(await recordFingerprint(runtime), before, 'and nothing was published');
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), winner, 'B is still current');
    await answers(runtime, GUARDED, 2, 'and B is still what a send resolves to');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: parsing the caller's token, then performing a fresh
// read and passing THAT as the expectation. Such a seam makes a stale conflict impossible to
// observe — every replacement succeeds, because the expectation is always whatever was just read —
// which is exactly the failure #218 point 2 asks this operation to prove it cannot have. It is
// invisible to any assertion about the final value, because the final value is what the caller
// asked for; only the VERDICT separates the two implementations.
test('the caller token remains the assumption: no hidden fresh read is substituted for it', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    await reconcileMethodsFromSource({...options, methods: [{selector: GUARDED, source: '[ ^ 2 ]'}]});
    const winner = await methodBlockRef({...options, selector: GUARDED});
    const before = await recordFingerprint(runtime);

    const error = await failure(replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    }));

    assert.ok(error instanceof SmalltalkStaleMethodPositionError, `unexpected: ${error}`);
    assert.deepEqual(await recordFingerprint(runtime), before, 'a pre-compilation refusal publishes nothing');
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), winner, 'B was not overwritten');
    await answers(runtime, GUARDED, 2);
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a stale refusal that hands back the winning binding, a
// replacement token or a storage version, letting a caller "recover" by adopting state it never
// read. Current truth must come only from a fresh authorized read.
test('a stale refusal through the public seam discloses no winning ref, version or backend cause', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    await reconcileMethodsFromSource({...options, methods: [{selector: GUARDED, source: '[ ^ 2 ]'}]});
    const winner = await methodBlockRef({...options, selector: GUARDED});

    const error = await failure(replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    }));

    assert.ok(error instanceof SmalltalkStaleMethodPositionError);
    assert.equal(error.cause, undefined);
    const disclosed = JSON.stringify({message: error.message, ...error});
    assert.ok(!disclosed.includes(winner.objectId), 'the winning Block ref is not disclosed');
    assert.ok(!disclosed.includes('_version'));
    assert.ok(!disclosed.includes('/methods'), 'nor the class\'s MethodDictionary record');
    assert.deepEqual(Object.keys(error), ['name', 'selector'], 'only the caller\'s own position');
  });
});

// ---------------------------------------------------------------------------------------------
// The wrapper cannot bypass C1
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: dropping `expectedCurrent` on the way to the from-source
// owner — a seam whose own admission check looks sufficient because it passes in the quiescent case.
// Here the position moves INSIDE the operation, after this seam's check and before the dictionary
// CAS, so only C1's re-assertion at the rebase boundary can catch it. An unguarded call reaches
// ADR 0086 decision 4 instead and reports a redefinition conflict, or overwrites the winner.
test('a position that moves mid-flight is still refused, and the winner survives', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const race = interleaveAtDictionaryCas(runtime, options.classRef.objectId, [
      () => reconcileMethodsFromSource({...options, methods: [{selector: GUARDED, source: '[ ^ 2 ]'}]}),
    ]);

    const error = await failure(replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    }));
    race.restore();

    assert.ok(error instanceof SmalltalkStaleMethodPositionError,
      `the mid-flight move must reach the caller as staleness; got ${error?.name}: ${error?.message}`);
    await answers(runtime, GUARDED, 2, 'the mid-flight winner is current and was never overwritten');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a wrapper that converts C1's SELECTOR-position semantics
// back into whole-dictionary ones. The dictionary CAS underneath covers every selector, so a seam
// that treated any lost CAS as staleness would refuse a replacement nothing ever touched, and one
// that retried by replaying its own planning snapshot would silently carry the unrelated selector
// back to its pre-race binding. Both are killed here: the call must SUCCEED and the unrelated
// winner must survive.
test('an unrelated selector moving under the authorized write is not staleness, and its winner survives', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const race = interleaveAtDictionaryCas(runtime, options.classRef.objectId, [
      () => reconcileMethodsFromSource({...options, methods: [{selector: UNRELATED, source: '[ ^ 20 ]'}]}),
    ]);

    await replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    });
    race.restore();

    assert.equal(race.attempts(), 2, 'the storage CAS lost once and the owner rebased and retried');
    await answers(runtime, GUARDED, 7, 'foo reached C despite the unrelated race');
    await answers(runtime, UNRELATED, 20, 'and bar kept the winner Y');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: letting the backend's conflict out through the public
// seam once C1's guarded path stops classifying and starts retrying — raw, smuggled as a `cause`,
// or wearing the owner's own dictionary-scoped error, which names the class's MethodDictionary
// RECORD and would publish storage identity this seam does not disclose.
test('sustained contention driven through the public seam leaks no backend conflict and no storage identity', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const putObject = runtime.images.putObject.bind(runtime.images);
    let attempts = 0;
    runtime.images.putObject = async (imageId, input, writeOptions) => {
      if (input.id === `${options.classRef.objectId}/methods` && writeOptions?.expectedVersion !== undefined) {
        attempts += 1;
        throw versionConflict();
      }
      return await putObject(imageId, input, writeOptions);
    };

    const error = await failure(replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    }));
    runtime.images.putObject = putObject;

    assert.ok(attempts > 1, 'the owner did retry rather than give up on the first loss');
    assert.ok(error instanceof SmalltalkMethodReplacementContentionError, `unexpected: ${error?.name}: ${error?.message}`);
    assert.notEqual(error.name, 'VersionConflictError');
    assert.equal(error.cause, undefined, 'no backend conflict smuggled out as a cause');
    const disclosed = JSON.stringify({message: error.message, ...error});
    assert.ok(!disclosed.includes('/methods'), 'the MethodDictionary record is not named');
    assert.ok(!disclosed.includes('_version'));
    assert.ok(!(error instanceof SmalltalkStaleMethodPositionError),
      'contention must never stand in for staleness: the position did not move');
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), observed,
      'and the guarded position is exactly what the caller observed');
    await answers(runtime, GUARDED, 1);
  });
});

// A legacy MethodDictionary left SEALED, which is what an interrupted migration leaves behind: it
// stays readable and dispatchable and refuses writes. Built directly rather than by interrupting a
// migration, because the state under test is the sealed record, not how it came to be sealed.
async function sealedLegacyDictionaryFor(runtime, classRef, selectorToBlock) {
  const slots = {};
  const shapeSlots = [];
  for (const [selector, block] of Object.entries(selectorToBlock)) {
    const id = `selector:${Buffer.from(selector, 'utf8').toString('base64url')}`;
    shapeSlots.push({id, name: selector});
    slots[id] = block;
  }
  const shape = await runtime.images.putShape('app', {
    id: `sealed-legacy-shape-${classRef.objectId.replace(/\W/g, '_')}`, slots: shapeSlots,
  });
  const dictionary = await runtime.images.putObject('app', {
    id: `${classRef.objectId}/legacy-methods`,
    shape: objectRef('app', shape.id),
    slots,
    metadata: {smalltalk: 'method-dictionary', owner: classRef.objectId, [SEAL_METADATA_KEY]: true},
  });
  const behavior = await runtime.images.getObject('app', classRef.objectId);
  await runtime.images.putObject('app', {
    id: behavior.id,
    shape: behavior.shape,
    behavior: behavior.behavior,
    slots: {...behavior.slots, 'behavior-methods': objectRef('app', dictionary.id)},
    metadata: behavior.metadata,
  }, {expectedVersion: behavior._version});
  return objectRef('app', dictionary.id);
}

// WRONG IMPLEMENTATION THIS TEST MUST KILL: letting the class builder's SEALED-dictionary refusal
// out as it stands. It is an Images-native error and not a backend one, but it names the class's
// MethodDictionary RECORD — storage identity this seam does not publish, and identity a caller
// could then try to write directly. It is also not staleness: the observed position is exactly
// where the caller left it, so reporting it as a stale conflict would send the caller to re-read a
// position nothing moved.
test('a method dictionary sealed for migration is a transient verdict that names no storage record', async () => {
  await withFixture(async (runtime, options) => {
    const method = await methodBlockRef({...options, selector: GUARDED});
    const dictionary = await sealedLegacyDictionaryFor(runtime, options.classRef, {[GUARDED]: method});
    // Sealing forbids writing, not reading: the public read still issues a token for the position.
    const token = await tokenFor(runtime, options);

    const error = await failure(replace(runtime, options, {
      source: '[ ^ 7 ]', expectedVersionToken: token, require: writerFor(runtime, options),
    }));

    assert.ok(error instanceof SmalltalkMethodReplacementContentionError,
      `unexpected: ${error?.name}: ${error?.message}`);
    assert.ok(!(error instanceof SmalltalkStaleMethodPositionError),
      'the position is exactly where the caller left it; this is not staleness');
    assert.equal(error.cause, undefined);
    const disclosed = JSON.stringify({message: error.message, ...error});
    assert.ok(!disclosed.includes(dictionary.objectId), 'the sealed record is not named');
    assert.ok(!disclosed.includes('sealed'), 'nor is the seal, which is a storage fact');
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), method,
      'and the binding did not move');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: an authorized module that grew a MethodDictionary
// reader, a bucket/Shape/version decision or a CAS of its own — ownership drift that no behavioural
// test catches while the two copies still agree.
test('the authorized module composes owners and contains no MethodDictionary, CAS or retry logic', () => {
  const source = readFileSync(resolve(REPO, 'src/language/smalltalk-authorized-method-replacement.js'), 'utf8');
  // Comments describe what the module deliberately does NOT do and name those concepts, so the scan
  // is over code only.
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  const imports = [...code.matchAll(/from '([^']+)'/g)].map(([, path]) => path).sort();
  assert.deepEqual(imports, [
    '../authority/object-resource.js',
    '../value/index.js',
    './smalltalk-class-builder.js',
    './smalltalk-instance-variables.js',
    './smalltalk-lookup.js',
    './smalltalk-method-position-token.js',
  ], 'the seam reaches storage only through owners');

  assert.match(code, /reconcileMethodsFromSource\(/, 'the write goes through the from-source owner');
  assert.match(code, /expectedCurrent: observed/, 'carrying the CALLER\'s observation as the expectation');
  assert.match(code, /methodBlockRef\(/, 'and the current binding comes from the one binding reader');

  // `expectedVersion` is deliberately absent from this list: `expectedVersionToken` is the seam's
  // own parameter. The storage CAS is caught by `putObject` instead, which is the only way that
  // option could be used. `retry` is absent for the same reason — the contention error's own
  // message tells the caller to retry — and the retry LOOP is caught structurally below.
  // `lane`, `wasm`, `neutral`, `getBlock`, `getCodeArtifact`, `representation` and `metadata` are
  // here for bead lagrange-images-it3: the answer to "which lane does a replacement compile in" is
  // the native method evolution owner's, decided from the `metadata.lane` that owner published
  // itself. If it ever migrated INTO this module it would have to decode the bound Block's code
  // artifact or branch on a representation, which is the second-decoder path ADR 0087 rejected for
  // the read seam and ADR 0088 for this one. The seam still passes the observed binding down and
  // knows nothing about how it executes.
  for (const forbidden of [
    'putObject', 'putBlock', 'putShape', 'putCodeArtifact', '_version', 'bucket', 'ensureShape',
    'getShape', 'dictionaryRef', 'slots', 'VersionConflict', 'rebase', 'attempt',
    'lane', 'wasm', 'neutral', 'getBlock', 'getCodeArtifact', 'representation', 'metadata',
  ]) {
    assert.ok(!code.includes(forbidden), `the authorized module must not implement ${forbidden}`);
  }

  // No loop of any kind. A retry/rebase budget needs one, and the seam is a straight line: a lost
  // CAS is the class builder's business and is never re-driven from here.
  assert.ok(!/\b(for|while|do)\s*[({]/.test(code), 'the authorized seam runs no loop at all');
});

// ---------------------------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: refusing malformed caller input with a bare `TypeError`.
// The native semantic compiler rejects bad SOURCE with a bare `TypeError` too, so the two outcomes
// would become indistinguishable — and they demand opposite responses: fix your call versus fix
// your source. Also killed: validating input after authorizing or after reading, which would make
// a malformed call an existence oracle.
test('malformed caller input is its own verdict, refused before any authority demand or read', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const {images, counts} = countingImages(runtime.images);
    const base = {
      images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      source: '[ ^ 7 ]',
      expectedVersionToken: token,
    };

    for (const [label, override] of [
      ['no arguments at all', null],
      ['no image service', {images: null}],
      ['no compilation service', {compilation: null}],
      ['an empty imageId', {imageId: ''}],
      ['a classRef that is not a ref', {classRef: {objectId: 'x'}}],
      ['a classRef in another image', {classRef: objectRef('elsewhere', options.classRef.objectId)}],
      ['an empty selector', {selector: ''}],
      ['a non-string source', {source: 42}],
      ['an empty source', {source: ''}],
      ['no require function', {require: undefined}],
    ]) {
      const require = requireFor(runtime, [writeDemand('app', options.classRef.objectId)]);
      const error = await failure(override === null
        ? authorizedReplaceSmalltalkMethod()
        : authorizedReplaceSmalltalkMethod({...base, require, ...override}));
      assert.ok(error instanceof SmalltalkMethodReplacementInputError,
        `${label} must be a caller-input verdict; got ${error?.name}: ${error?.message}`);
      assert.equal(error.name, 'SmalltalkMethodReplacementInputError', label);
      assert.deepEqual(require.demands, [], `${label}: authority was never demanded`);
    }

    assert.equal(counts.reads, 0, 'no malformed call read anything');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a guarded path that publishes or moves the binding when
// the replacement source cannot be compiled. Compilation happens before the final CAS, so "compiled
// material may be orphaned" must never become "a rejected source can still move the position". Also
// killed: a taxonomy in which a source rejection is indistinguishable from a malformed call.
test('a valid token with invalid source is a source rejection, and the exact old binding stays current', async () => {
  await withFixture(async (runtime, options) => {
    const observed = await methodBlockRef({...options, selector: GUARDED});
    const before = await recordFingerprint(runtime);

    for (const [label, source] of [
      ['unparseable source', '[ 3 + ]'],
      ['a name nothing binds', '[ ^ noSuchGlobalName ]'],
    ]) {
      const error = await failure(replace(runtime, options, {
        source,
        expectedVersionToken: await tokenFor(runtime, options),
        require: writerFor(runtime, options),
      }));
      assert.ok(error instanceof Error, `${label} was rejected`);
      assert.ok(!(error instanceof SmalltalkMethodReplacementInputError),
        `${label}: a bad SOURCE is not a malformed CALL`);
      assert.ok(!(error instanceof SmalltalkStaleMethodPositionError), `${label}: nor staleness`);
      assert.ok(!(error instanceof SmalltalkMethodReplacementContentionError), `${label}: nor contention`);
      assert.ok(!(error instanceof SmalltalkMethodTargetError), `${label}: nor a missing target`);
    }

    assert.deepEqual(await recordFingerprint(runtime), before, 'a rejected source published nothing');
    assert.deepEqual(await methodBlockRef({...options, selector: GUARDED}), observed);
    await answers(runtime, GUARDED, 1, 'the current binding is untouched by a compile failure');
  });
});

// REPLACEMENT-ONLY. ADR 0088 states normatively that this seam replaces an EXISTING
// {Class/Metaclass, selector} position and that an absent selector is not a definition opportunity.
// Until now that rule was carried only by a probe recorded in a bead, which is not a proof.
//
// WRONG IMPLEMENTATION THIS TEST MUST KILL: the authorized seam falls through to an unguarded
// reconcile or define path and CREATES the absent selector. That is the whole failure mode — E3
// silently becoming a method-authoring API — and it is invisible to every other test here, all of
// which target a selector that already exists.
//
// The token is minted rather than read, deliberately: the public read cannot issue a token for a
// position nothing implements, which is exactly why this is a BOUNDARY proof rather than an
// ordinary user flow. Minting one is the only way to put a well-formed, correctly-scoped token in
// front of the seam and ask what it does with an absent target.
test('E3 is replacement-only: an absent selector is refused, never defined', async () => {
  await withFixture(async (runtime, options) => {
    const MISSING = 'missingSelector';
    // The class really is a live native class with real methods; only THIS selector is absent.
    assert.equal(await methodBlockRef({...options, selector: MISSING}), null, 'the fixture must start absent');
    const before = await recordFingerprint(runtime);
    const selectorsBefore = (await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: options.classRef,
      require: requireFor(runtime, [readDemand('app', options.classRef.objectId)]),
    })).selectors;
    assert.equal(selectorsBefore.includes(MISSING), false);

    const token = smalltalkMethodPositionToken({
      imageId: 'app',
      classRef: options.classRef,
      selector: MISSING,
      // Any well-formed observation; the point is that NOTHING is bound at this position.
      method: await methodBlockRef({...options, selector: GUARDED}),
    });

    const {compilation, compiled} = countingCompilation(runtime.compilation);
    const error = await failure(authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation,
      imageId: 'app',
      classRef: options.classRef,
      selector: MISSING,
      source: '[ ^ 99 ]',
      expectedVersionToken: token,
      require: writerFor(runtime, options),
    }));

    // Refused as a semantic verdict about this position, per ADR 0088.
    assert.ok(error, 'the call must not succeed');
    assert.ok(
      error instanceof SmalltalkMethodTargetError || error instanceof SmalltalkStaleMethodPositionError,
      `an absent selector must be a target or stale verdict; got ${error?.name}: ${error?.message}`,
    );

    // Nothing was defined. Each of these fails independently if the seam fell through and created it.
    assert.equal(await methodBlockRef({...options, selector: MISSING}), null,
      'the absent selector must STILL be absent');
    const selectorsAfter = (await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: options.classRef,
      require: requireFor(runtime, [readDemand('app', options.classRef.objectId)]),
    })).selectors;
    assert.deepEqual(selectorsAfter, selectorsBefore, 'the selector set is unchanged');
    assert.deepEqual(await recordFingerprint(runtime), before,
      'and no record was written at all: not the method, not the dictionary');
    // Decided before compilation, so no replacement material was even produced.
    assert.deepEqual(compiled, [], 'the source was never compiled for an absent target');
    // The neighbours are untouched.
    await answers(runtime, GUARDED, 1, 'the existing method is unaffected');
    await answers(runtime, UNRELATED, 10, 'and so is its neighbour');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: disclosing the resolution failure verbatim to an
// authorized caller. Those failures name the class's MethodDictionary RECORD — storage identity the
// seam does not publish — and a plain `TypeError` would also be indistinguishable from a source
// rejection.
test('an authorized caller whose target does not exist gets a target verdict that names only its own position', async () => {
  await withFixture(async (runtime, options) => {
    const absent = objectRef('app', 'smalltalk/class/Absent');
    const token = smalltalkMethodPositionToken({
      imageId: 'app',
      classRef: absent,
      selector: GUARDED,
      method: await methodBlockRef({...options, selector: GUARDED}),
    });

    const error = await failure(authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: absent,
      selector: GUARDED,
      source: '[ ^ 7 ]',
      expectedVersionToken: token,
      require: requireFor(runtime, [writeDemand('app', absent.objectId)]),
    }));

    assert.ok(error instanceof SmalltalkMethodTargetError, `unexpected: ${error?.name}: ${error?.message}`);
    assert.equal(error.cause, undefined);
    const disclosed = JSON.stringify({message: error.message, ...error});
    assert.ok(!disclosed.includes('/methods'), 'no MethodDictionary record is named');
    assert.ok(!disclosed.includes('behavior not found'), 'and no owner diagnostic is forwarded verbatim');
  });
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: a target verdict that swallows EVERY failure of the
// binding read. A host or transport failure is not a statement about this method position, and
// answering "no such native method position" for one would tell an Object Environment that a method
// had been deleted when the storage was merely unreachable.
test('a non-semantic failure of the binding read is not reinterpreted as a missing target', async () => {
  await withFixture(async (runtime, options) => {
    const token = await tokenFor(runtime, options);
    const unreachable = Object.create(runtime.images);
    unreachable.getObject = async () => {
      throw Object.assign(new Error('simulated transport failure'), {name: 'BackendUnavailableError'});
    };

    const error = await failure(authorizedReplaceSmalltalkMethod({
      images: unreachable,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      source: '[ ^ 7 ]',
      expectedVersionToken: token,
      require: writerFor(runtime, options),
    }));

    assert.equal(error?.name, 'BackendUnavailableError', `unexpected: ${error?.name}: ${error?.message}`);
    assert.ok(!(error instanceof SmalltalkMethodTargetError),
      'an unreachable image does not mean the method position is gone');
  });
});

// ---------------------------------------------------------------------------------------------
// The export boundary
// ---------------------------------------------------------------------------------------------

// WRONG IMPLEMENTATION THIS TEST MUST KILL: publishing the new seam by adding its module to
// `src/language/index.js`. That barrel is `export *` and `src/runtime.js` re-exports it, so every
// name in the module — the three error classes here, and any helper a later change adds — would
// silently become published API. This PR family has been bitten by exactly that three times, most
// recently by a constant whose own comment claimed it was internal, and it is caught only by
// enumerating the roots' BINDINGS. A static-closure module count cannot catch it: a module may
// legitimately sit in the closure without its helpers being public.
test('the public roots publish the four authorized seams and none of the internals behind them', async () => {
  const [runtime, index, portable, language, browse, owner, token, builder] = await Promise.all([
    import('../src/runtime.js'),
    import('../src/index.js'),
    import('../src/portable-runtime.js'),
    import('../src/language/index.js'),
    import('../src/language/smalltalk-browse.js'),
    import('../src/language/smalltalk-authorized-method-replacement.js'),
    import('../src/language/smalltalk-method-position-token.js'),
    import('../src/language/smalltalk-class-builder.js'),
  ]);

  const publicSeams = {
    authorizedDescribeSmalltalkClass: browse.authorizedDescribeSmalltalkClass,
    authorizedDescribeSmalltalkMethod: browse.authorizedDescribeSmalltalkMethod,
    authorizedReadSmalltalkMethodForUpdate: browse.authorizedReadSmalltalkMethodForUpdate,
    authorizedReplaceSmalltalkMethod: owner.authorizedReplaceSmalltalkMethod,
  };
  for (const [name, fn] of Object.entries(publicSeams)) {
    assert.equal(typeof fn, 'function', `${name} must exist at its owner`);
    for (const [root, module] of [['src/runtime.js', runtime], ['src/portable-runtime.js', portable]]) {
      assert.equal(module[name], fn, `${name} must be the owner's OWN function through ${root}`);
    }
  }
  assert.equal(runtime.authorizedReplaceSmalltalkMethod, portable.authorizedReplaceSmalltalkMethod,
    'one function through both roots, never two wrappers that could drift');
  assert.equal(ownedReplace, owner.authorizedReplaceSmalltalkMethod);

  // ABSENT, by binding, from every published root. The token helpers are the caller's contract to
  // compare and round-trip only; the C1 primitives and the C2 error classes are owner-internal.
  const internals = [
    'smalltalkMethodPositionToken',
    'parseSmalltalkMethodPositionToken',
    'SMALLTALK_METHOD_POSITION_TOKEN_V0',
    'SmalltalkMethodPositionTokenError',
    'SmalltalkMethodReplacementInputError',
    'SmalltalkMethodTargetError',
    'SmalltalkMethodReplacementContentionError',
    'MAX_UNRELATED_REBASE_ATTEMPTS',
    'readExpectedCurrentBindings',
    'assertExpectedCurrentBinding',
    'assertExpectedCurrentBindings',
    'commitMethodDictionary',
    'classifyLostMethodDictionaryCas',
    'readMethodDictionaryForUpdate',
    'methodDictionaryInput',
    'readMethodBindings',
    'currentSelectorBindings',
    'installedMethodLane',
    'replacementLane',
    'selectorBindings',
    'installMethods',
    'authorizedMethodPosition',
  ];
  for (const name of internals) {
    for (const [root, module] of [
      ['src/runtime.js', runtime],
      ['src/index.js', index],
      ['src/portable-runtime.js', portable],
      ['src/language/index.js', language],
    ]) {
      assert.equal(Object.hasOwn(module, name), false, `${name} must NOT be published through ${root}`);
    }
  }

  // The three error classes really are the owner's, so their absence above is a boundary and not a
  // typo in the list.
  for (const name of ['SmalltalkMethodReplacementInputError', 'SmalltalkMethodTargetError',
    'SmalltalkMethodReplacementContentionError']) {
    assert.equal(typeof owner[name], 'function', `${name} exists at its owner`);
  }
  assert.equal(typeof token.parseSmalltalkMethodPositionToken, 'function');
  // And the names this PR did not touch stay exactly as they were.
  assert.equal(runtime.SmalltalkStaleMethodPositionError, builder.SmalltalkStaleMethodPositionError);
  // `SmalltalkMethodLaneError` is deliberately on the SAME footing (bead lagrange-images-it3): a
  // public semantic verdict from the same owner, published as the owner's own class, while the two
  // helpers that raise it stay internal — listed above, because publishing either would put "which
  // lane is this revision in" on the package surface as an API rather than as an owner decision.
  assert.equal(runtime.SmalltalkMethodLaneError, builder.SmalltalkMethodLaneError);
  assert.equal(typeof builder.SmalltalkMethodLaneError, 'function');
});

// WRONG IMPLEMENTATION THIS TEST MUST KILL: an Object Environment forced back to a private
// `src/language/...` import because the portable root published only part of the E3 pair. Read for
// update and replace are one workflow; publishing one without the other leaves the consumer unable
// to hold a token honestly.
test('the E3 read/replace pair is usable end to end through the portable root alone', async () => {
  const portable = await import('../src/portable-runtime.js');
  await withFixture(async (runtime, options) => {
    const {descriptor, versionToken} = await portable.authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      require: await readerFor(runtime, options, GUARDED),
    });
    assert.equal(descriptor.source, null);

    const result = await portable.authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      source: '[ ^ 7 ]',
      expectedVersionToken: versionToken,
      require: writerFor(runtime, options),
    });

    assert.deepEqual(result, {replaced: true});
    await answers(runtime, GUARDED, 7);
    // The Environment's displayed truth is a fresh authorized read, and it is what moved.
    const after = await portable.authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef: options.classRef,
      selector: GUARDED,
      require: await readerFor(runtime, options, GUARDED),
    });
    assert.notDeepEqual(after.descriptor.method, descriptor.method);
    assert.notEqual(after.versionToken, versionToken);
    assert.equal(after.descriptor.source, null, 'still not a source database');
    // And the class description, read through the same public root, still lists both selectors.
    const klass = await portable.authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: options.classRef,
      require: requireFor(runtime, [readDemand('app', options.classRef.objectId)]),
    });
    assert.ok(klass.selectors.includes(GUARDED) && klass.selectors.includes(UNRELATED));
  });
});
