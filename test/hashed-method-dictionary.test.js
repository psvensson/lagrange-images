import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  createRuntime,
  defineClass,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkEqualityProtocol,
  installSmalltalkIndexedProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  migrateMethodDictionary,
  objectRef,
  SmalltalkKernelConflictError,
  textValue,
} from '../src/runtime.js';
import {
  METHOD_DICTIONARY_SHAPE_ID,
  METHOD_DICTIONARY_TALLY_SLOT,
  SEAL_METADATA_KEY,
  buildMethodBuckets,
  isMethodDictionary,
  methodDictionaryRecordFields,
  migratedDictionaryId,
  validateMethodDictionary,
} from '../src/language/smalltalk-method-dictionary.js';
import {MethodDictionaryValidationCache} from '../src/language/smalltalk-lookup.js';
import {methodBlockRef} from '../src/language/smalltalk-class-builder.js';
import {builtInHash} from '../src/language/smalltalk-equality.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

// ADR 0049. The claim under test is narrow and total: dispatch reads a hashed selector table using
// only pure built-in helpers, so nothing a program can define changes how a method is found.

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

const PLUS = {
  selector: '+',
  program: {
    parameters: [{id: 'plus:arg', name: 'n'}],
    captures: [],
    body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
  },
};

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  return kernel;
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

const dictionaryOf = async (runtime, imageId, classRef) => {
  const behavior = await runtime.images.getObject(imageId, classRef.objectId);
  const ref = behavior.slots['behavior-methods'];
  return {ref, record: await runtime.images.getObject(ref.imageId, ref.objectId)};
};

// --- the headline ------------------------------------------------------------------------------

// The whole architectural claim in one test. If pathological overrides of exactly the protocol the
// dispatcher would otherwise depend on change nothing, the separation is real rather than asserted.
test('pathological Text >> hash and Text >> = do not affect method lookup', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app'};
    await installSmalltalkIndexedProtocol(options);
    await defineMethods({
      ...options,
      classRef: kernel.integerClass,
      methods: [{selector: 'twice', program: {parameters: [], captures: [], body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'receiver'}}}}],
    });

    await defineMethods({
      ...options,
      classRef: kernel.textClass,
      methods: [
        {selector: 'hash', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(0)}}},
        {selector: '=', program: {parameters: [{id: 'eq:0', name: 'other'}], captures: [], body: {op: 'literal', value: booleanValue(false)}}},
      ],
    });

    assert.deepEqual(await evaluate(runtime, 'app', 'add', '[ :a :b | a + b ]', [integerValue(1), integerValue(2)]), integerValue(3));
    assert.deepEqual(await evaluate(runtime, 'app', 'twice', '[ :a | a twice ]', [integerValue(5)]), integerValue(10));
    const array = await evaluate(runtime, 'app', 'arr', '[ :c | c new: 2 ]', [objectRef('app', 'smalltalk/class/Array')]);
    assert.deepEqual(await evaluate(runtime, 'app', 'size', '[ :a | a size ]', [array]), integerValue(2));
    await assert.rejects(
      evaluate(runtime, 'app', 'missing', '[ :a | a nope ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError',
      'a genuine miss must still be a miss, not corruption',
    );
    // The overrides really are installed and really are used by ordinary sends.
    assert.deepEqual(await evaluate(runtime, 'app', 'override', "[ :t | t hash ]", [textValue('x')]), integerValue(0));
  });
});

// --- representation ----------------------------------------------------------------------------

test('a class defined after this ADR gets a hashed dictionary with the fixed local Shape', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const {record} = await dictionaryOf(runtime, 'app', kernel.integerClass);

    assert.equal(record.shape.objectId, METHOD_DICTIONARY_SHAPE_ID);
    assert.equal(record.shape.imageId, 'app', 'identity is the (imageId, objectId) pair');
    assert.equal(record.behavior, null, 'a method dictionary is never dispatchable');
    assert.equal(record.indexed.length % 3, 0);
    assert.deepEqual(record.slots[METHOD_DICTIONARY_TALLY_SLOT], integerValue(1));

    const table = validateMethodDictionary(record, {imageId: 'app', objectId: record.id}, objectRef('app', 'smalltalk/nil'));
    const occupied = table.buckets.filter(({hash}) => hash !== null);
    assert.equal(occupied.length, 1);
    assert.equal(occupied[0].key.kind, 'text');
    assert.equal(occupied[0].key.value, '+');
    assert.equal(occupied[0].value.kind, 'ref');
    assert.equal(occupied[0].value.imageId, 'app', 'methods are local unpinned Block refs');
    assert.deepEqual(occupied[0].hash, builtInHash(textValue('+')), 'the stored hash is the built-in hash');
  });
});

test("another image's method-dictionary Shape does not qualify a record", async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const {record} = await dictionaryOf(runtime, 'app', objectRef('app', 'smalltalk/class/Integer'));
    assert.equal(isMethodDictionary(record), true);
    // The same object with a foreign shape ref is not this image's method dictionary.
    assert.equal(isMethodDictionary({...record, shape: objectRef('other', METHOD_DICTIONARY_SHAPE_ID)}), false);
  });
});

test('colliding selectors probe correctly and growth preserves every mapping', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const selectors = Array.from({length: 20}, (unused, index) => `sel${index}`);
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass,
      methods: selectors.map((selector, index) => ({
        selector,
        program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(index)}},
      })),
    });

    const {record} = await dictionaryOf(runtime, 'app', kernel.integerClass);
    const table = validateMethodDictionary(record, {imageId: 'app', objectId: record.id}, objectRef('app', 'smalltalk/nil'));
    assert.ok(table.capacity >= (selectors.length + 1) * 4 / 3, 'the load factor is respected after growth');
    assert.equal(table.capacity & (table.capacity - 1), 0, 'capacity stays a power of two');

    for (const [index, selector] of selectors.entries()) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `call-${index}`, `[ :a | a ${selector} ]`, [integerValue(0)]),
        integerValue(index),
        `${selector} must survive growth`,
      );
    }
    assert.deepEqual(await evaluate(runtime, 'app', 'still-plus', '[ :a :b | a + b ]', [integerValue(1), integerValue(1)]), integerValue(2));
  });
});

// --- lookup ------------------------------------------------------------------------------------

// The second record read the legacy path spends on a Shape is where the saving is.
test('lookup fetches no Shape for a hashed dictionary', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    let shapeReads = 0;
    const original = runtime.images.getShape.bind(runtime.images);
    runtime.images.getShape = async (...args) => {
      shapeReads += 1;
      return await original(...args);
    };
    // Compilation and installation read Shapes; only the send itself is measured.
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'measured', source: '[ :a :b | a + b ]',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), [integerValue(1), integerValue(2)]);
    shapeReads = 0;
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(3));
    assert.equal(shapeReads, 0, 'a hashed lookup reads one record and no Shape');
  });
});

const CORRUPTIONS = {
  'duplicate selector': (record, table) => {
    const indexed = [...record.indexed];
    const occupied = [];
    for (let index = 0; index < indexed.length; index += 3) if (indexed[index].kind === 'integer') occupied.push(index);
    // Copy the first entry into a free bucket, keeping its hash so the probe finds both.
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index].kind !== 'integer') {
        indexed[index] = indexed[occupied[0]];
        indexed[index + 1] = indexed[occupied[0] + 1];
        indexed[index + 2] = indexed[occupied[0] + 2];
        break;
      }
    }
    return {indexed, tally: integerValue(occupied.length + 1)};
  },
  'wrong stored hash': (record) => {
    const indexed = [...record.indexed];
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index].kind === 'integer') {
        indexed[index] = integerValue(BigInt(indexed[index].value) + 1n);
        break;
      }
    }
    return {indexed};
  },
  'tally disagreement': (record) => ({tally: integerValue(99)}),
  'non-Text selector': (record) => {
    const indexed = [...record.indexed];
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index].kind === 'integer') {
        indexed[index + 1] = integerValue(7);
        break;
      }
    }
    return {indexed};
  },
};

test('a malformed hashed dictionary is structural corruption, never message-not-understood', async () => {
  for (const [label, corrupt] of Object.entries(CORRUPTIONS)) {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app');
      const {record} = await dictionaryOf(runtime, 'app', kernel.integerClass);
      const patch = corrupt(record);
      await runtime.images.putObject('app', {
        id: record.id,
        shape: record.shape,
        slots: patch.tally ? {[METHOD_DICTIONARY_TALLY_SLOT]: patch.tally} : record.slots,
        indexed: patch.indexed ?? record.indexed,
        metadata: record.metadata,
      }, {expectedVersion: record._version});

      await assert.rejects(
        evaluate(runtime, 'app', 'corrupt', '[ :a :b | a + b ]', [integerValue(1), integerValue(2)]),
        (error) => error.name === 'SmalltalkMalformedMethodDictionaryError',
        `${label} must fail as corruption`,
      );
    });
  }
});

// `bucketsFromIndexed` reads any non-Integer hash cell as an empty bucket — right for a table this
// code built, wrong as a validation input. With a consistent tally, a corrupted hash cell would
// otherwise erase its own evidence and, because an empty bucket ends a probe, make the selector
// report as an ordinary miss. Corruption laundered into message-not-understood is exactly what the
// malformed/not-understood split exists to prevent.
test('a corrupted hash cell is corruption, even when the tally agrees with it', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const {record} = await dictionaryOf(runtime, 'app', kernel.integerClass);
    const indexed = [...record.indexed];
    let corrupted = 0;
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index].kind === 'integer') {
        indexed[index] = textValue('not-a-hash');
        corrupted += 1;
      }
    }
    assert.ok(corrupted > 0, 'the fixture needs an occupied bucket to corrupt');

    // The tally is adjusted to match what a lenient reader would count, so nothing else catches it.
    await runtime.images.putObject('app', {
      id: record.id,
      shape: record.shape,
      slots: {[METHOD_DICTIONARY_TALLY_SLOT]: integerValue(0)},
      indexed,
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'hidden', '[ :a :b | a + b ]', [integerValue(1), integerValue(2)]),
      (error) => error.name === 'SmalltalkMalformedMethodDictionaryError',
      'a hidden selector must be reported as corruption, not as a miss',
    );
  });
});

test('a partially-nil bucket is corruption rather than an empty bucket', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const {record} = await dictionaryOf(runtime, 'app', kernel.integerClass);
    const indexed = [...record.indexed];
    // An "empty" bucket whose key cell holds something other than nil.
    for (let index = 0; index < indexed.length; index += 3) {
      if (indexed[index].kind !== 'integer') {
        indexed[index + 1] = textValue('leftover');
        break;
      }
    }
    await runtime.images.putObject('app', {
      id: record.id, shape: record.shape, slots: record.slots, indexed, metadata: record.metadata,
    }, {expectedVersion: record._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'partial', '[ :a :b | a + b ]', [integerValue(1), integerValue(2)]),
      (error) => error.name === 'SmalltalkMalformedMethodDictionaryError',
    );
  });
});

// Deterministic ids mean a record can already occupy one. Reuse is for a *provably* valid legacy
// dictionary, not for anything that merely is not hashed.
test('a squatter at the methods id is refused rather than adopted as a legacy dictionary', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const shape = await runtime.images.putShape('app', {id: 'squat-shape', slots: []});
    // An unrelated object sitting where a new class's method dictionary would go.
    await runtime.images.putObject('app', {
      id: 'smalltalk/class/Point/methods',
      shape: objectRef('app', shape.id),
      slots: {},
      metadata: {planted: 'by something else'},
    });

    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'Point'}),
      (error) => error.name === 'SmalltalkKernelConflictError',
      'an unrelated record must not be adopted as this class method dictionary',
    );
    const squatter = await runtime.images.getObject('app', 'smalltalk/class/Point/methods');
    assert.deepEqual(squatter.metadata, {planted: 'by something else'}, 'and must be left untouched');
  });
});

// A foreign method ref cannot exist in the hashed representation, and that is knowable in step 1.
// Discovering it after the seal would stall the class for a reason reportable before any write.
test('migration rejects a foreign method ref before sealing anything', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await seed(runtime, 'other');
    const foreignBlock = await methodBlockRef({
      images: runtime.images, imageId: 'other', classRef: objectRef('other', 'smalltalk/class/Integer'), selector: '+',
    });
    const legacyRef = await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': foreignBlock});

    await assert.rejects(
      migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass}),
      /not local to app/,
    );

    // Nothing was sealed and nothing was written: the class still accepts methods.
    const legacy = await runtime.images.getObject('app', legacyRef.objectId);
    assert.equal(legacy.metadata?.[SEAL_METADATA_KEY], undefined, 'the legacy dictionary must not be sealed');
    assert.equal(
      await runtime.images.getObject('app', migratedDictionaryId(kernel.integerClass.objectId)),
      null,
      'and no target may be published',
    );
  });
});

// It is the recommended representation-neutral reader, so it must not be a laxer way to read the
// same records than dispatch is.
test('methodBlockRef preserves dispatch corruption semantics on the legacy path', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
    });
    // A legacy dictionary whose Shape names one selector twice.
    const shape = await runtime.images.putShape('app', {
      id: 'dup-legacy-shape',
      slots: [{id: 'a', name: 'dup'}, {id: 'b', name: 'dup'}],
    });
    const dictionary = await runtime.images.putObject('app', {
      id: 'dup-legacy-methods',
      shape: objectRef('app', shape.id),
      slots: {a: plusBlock, b: plusBlock},
      metadata: {smalltalk: 'method-dictionary'},
    });
    const behavior = await runtime.images.getObject('app', kernel.integerClass.objectId);
    await runtime.images.putObject('app', {
      id: behavior.id,
      shape: behavior.shape,
      behavior: behavior.behavior,
      slots: {...behavior.slots, 'behavior-methods': objectRef('app', dictionary.id)},
      metadata: behavior.metadata,
    }, {expectedVersion: behavior._version});

    await assert.rejects(
      methodBlockRef({images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'dup'}),
      /duplicate selector/,
      'duplicate selectors must be refused, never resolved first-wins',
    );
  });
});

test('a behavior edge on a method dictionary makes it malformed', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const {record} = await dictionaryOf(runtime, 'app', kernel.integerClass);
    await runtime.images.putObject('app', {
      id: record.id,
      shape: record.shape,
      // A generic write that would otherwise make a method dictionary answer messages.
      behavior: kernel.objectClass,
      slots: record.slots,
      indexed: record.indexed,
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'dispatchable', '[ :a :b | a + b ]', [integerValue(1), integerValue(2)]),
      (error) => error.name === 'SmalltalkMalformedMethodDictionaryError' && /behavior edge/.test(error.message),
    );
  });
});

// --- validation cache --------------------------------------------------------------------------

// A direct unit test of the contract, because the whole point is *when* validation happens.
test('validation happens once per record version, and a new version revalidates', () => {
  const cache = new MethodDictionaryValidationCache();
  const {buckets} = buildMethodBuckets([[textValue('a'), objectRef('app', 'block-a')]]);
  const fields = methodDictionaryRecordFields({
    buckets, shapeRef: objectRef('app', METHOD_DICTIONARY_SHAPE_ID), nilRef: objectRef('app', 'smalltalk/nil'),
  });
  const record = {kind: 'object', id: 'd', imageId: 'app', _version: 1, behavior: null, ...fields};
  const ref = {imageId: 'app', objectId: 'd'};

  const nilRef = objectRef('app', 'smalltalk/nil');
  const first = cache.read(record, ref, nilRef);
  assert.equal(cache.read(record, ref, nilRef), first, 'the same version is validated once');

  // Corrupt the record *without* changing its version: the cache legitimately keeps its answer,
  // which is exactly why the version has to be part of the key.
  const corrupted = {...record, slots: {[METHOD_DICTIONARY_TALLY_SLOT]: integerValue(99)}};
  assert.equal(cache.read(corrupted, ref, nilRef), first, 'same key, cached structure');

  // A real durable change bumps the version, so it is validated again — and caught.
  assert.throws(
    () => cache.read({...corrupted, _version: 2}, ref, nilRef),
    (error) => error.name === 'SmalltalkMalformedMethodDictionaryError',
  );
});

// It caches structure, never a lookup answer, so a method addition is visible on the very next send.
test('the cache never masks a method addition', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await assert.rejects(
      evaluate(runtime, 'app', 'before', '[ :a | a later ]', [integerValue(1)]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError',
    );
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass,
      methods: [{selector: 'later', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(9)}}}],
    });
    assert.deepEqual(await evaluate(runtime, 'app', 'after', '[ :a | a later ]', [integerValue(1)]), integerValue(9));
  });
});

// --- mutation ----------------------------------------------------------------------------------

test('adding a method rewrites the dictionary and never the Behavior', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const before = await runtime.images.getObject('app', kernel.integerClass.objectId);
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass,
      methods: [{selector: 'extra', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(1)}}}],
    });
    const after = await runtime.images.getObject('app', kernel.integerClass.objectId);
    assert.equal(after._version, before._version, 'the Behavior record must not be rewritten');
  });
});

// Never a lost method: the second writer's stale version is refused rather than overwriting.
test('a concurrent method addition conflicts rather than losing a method', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: kernel.integerClass};
    const method = (selector) => ({
      selector,
      program: {parameters: [], captures: [], body: {op: 'literal', value: textValue(selector)}},
    });

    // Interleave: while `alpha` is publishing, `beta` lands first.
    let injected = false;
    const original = runtime.images.putObject.bind(runtime.images);
    runtime.images.putObject = async (imageId, input, opts) => {
      if (!injected && input.id === `${kernel.integerClass.objectId}/methods` && opts?.expectedVersion !== undefined) {
        injected = true;
        runtime.images.putObject = original;
        await defineMethods({...options, methods: [method('beta')]});
        runtime.images.putObject = async (...args) => {
          runtime.images.putObject = original;
          return await original(...args);
        };
      }
      return await original(imageId, input, opts);
    };

    await assert.rejects(
      defineMethods({...options, methods: [method('alpha')]}),
      (error) => error instanceof SmalltalkKernelConflictError && error.name !== 'VersionConflictError',
    );
    runtime.images.putObject = original;

    // beta survived, and alpha can be installed by an ordinary retry.
    assert.deepEqual(await evaluate(runtime, 'app', 'beta', '[ :a | a beta ]', [integerValue(1)]), textValue('beta'));
    await defineMethods({...options, methods: [method('alpha')]});
    assert.deepEqual(await evaluate(runtime, 'app', 'alpha', '[ :a | a alpha ]', [integerValue(1)]), textValue('alpha'));
  });
});

// --- migration ---------------------------------------------------------------------------------

// A legacy dictionary, built the way ADR 0044 built them, so migration has something real to convert.
async function legacyDictionaryFor(runtime, imageId, classRef, selectorToBlock) {
  const slots = {};
  const shapeSlots = [];
  for (const [selector, block] of Object.entries(selectorToBlock)) {
    const id = `selector:${Buffer.from(selector, 'utf8').toString('base64url')}`;
    shapeSlots.push({id, name: selector});
    slots[id] = block;
  }
  const shape = await runtime.images.putShape(imageId, {id: `legacy-shape-${classRef.objectId.replace(/\W/g, '_')}`, slots: shapeSlots});
  const dictionary = await runtime.images.putObject(imageId, {
    id: `${classRef.objectId}/legacy-methods`,
    shape: objectRef(imageId, shape.id),
    slots,
    metadata: {smalltalk: 'method-dictionary', owner: classRef.objectId},
  });
  const behavior = await runtime.images.getObject(imageId, classRef.objectId);
  await runtime.images.putObject(imageId, {
    id: behavior.id,
    shape: behavior.shape,
    behavior: behavior.behavior,
    slots: {...behavior.slots, 'behavior-methods': objectRef(imageId, dictionary.id)},
    metadata: behavior.metadata,
  }, {expectedVersion: behavior._version});
  return objectRef(imageId, dictionary.id);
}

test('legacy and hashed dictionaries coexist in one superclass chain', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
    });
    // Put Integer back on the legacy representation while Object stays hashed.
    await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': plusBlock});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.objectClass,
      methods: [{selector: 'inherited', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('from Object')}}}],
    });

    assert.deepEqual(await evaluate(runtime, 'app', 'legacy', '[ :a :b | a + b ]', [integerValue(2), integerValue(3)]), integerValue(5));
    assert.deepEqual(await evaluate(runtime, 'app', 'hashed', '[ :a | a inherited ]', [integerValue(1)]), textValue('from Object'));
  });
});

test('migration preserves every mapping and is idempotent', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
    });
    await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': plusBlock});

    const first = await migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass});
    assert.equal(first.migrated, true);
    assert.equal(first.dictionary.objectId, migratedDictionaryId(kernel.integerClass.objectId));
    assert.deepEqual(await evaluate(runtime, 'app', 'after', '[ :a :b | a + b ]', [integerValue(2), integerValue(3)]), integerValue(5));

    const again = await migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass});
    assert.equal(again.migrated, false, 'already hashed is a success, not an error');
  });
});

// The race the seal exists for. An addition landing between migration's read and its seal must not
// disappear: the seal's CAS fails, and a retry includes it.
test('a method added before the seal is included rather than lost', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
    });
    const legacyRef = await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': plusBlock});
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: kernel.integerClass};

    let injected = false;
    const original = runtime.images.putObject.bind(runtime.images);
    runtime.images.putObject = async (imageId, input, opts) => {
      if (!injected && input.id === legacyRef.objectId && input.metadata?.[SEAL_METADATA_KEY]) {
        injected = true;
        runtime.images.putObject = original;
        await defineMethods({
          ...options,
          methods: [{selector: 'sneakedIn', program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('present')}}}],
        });
        runtime.images.putObject = async (...args) => {
          runtime.images.putObject = original;
          return await original(...args);
        };
      }
      return await original(imageId, input, opts);
    };

    await assert.rejects(
      migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass}),
      (error) => error.name === 'SmalltalkMigrationConflictError' && error.kind === 'method-addition',
    );
    runtime.images.putObject = original;

    // The addition survived, and a retry migrates a dictionary that contains it.
    assert.deepEqual(await evaluate(runtime, 'app', 'pre', '[ :a | a sneakedIn ]', [integerValue(1)]), textValue('present'));
    await migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass});
    assert.deepEqual(await evaluate(runtime, 'app', 'post', '[ :a | a sneakedIn ]', [integerValue(1)]), textValue('present'));
    assert.deepEqual(await evaluate(runtime, 'app', 'post-plus', '[ :a :b | a + b ]', [integerValue(1), integerValue(1)]), integerValue(2));
  });
});

// The other side of the seal: after it, an addition is refused explicitly rather than written into
// a record that is about to be abandoned.
test('a crash between seal and swap leaves a sealed, still-dispatching class that a retry converges', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
    });
    await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': plusBlock});

    // Fail the final Behavior CAS.
    const original = runtime.images.putObject.bind(runtime.images);
    runtime.images.putObject = async (imageId, input, opts) => {
      if (input.id === kernel.integerClass.objectId) throw new Error('injected crash before the swap');
      return await original(imageId, input, opts);
    };
    await assert.rejects(
      migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass}),
      /injected crash/,
    );
    runtime.images.putObject = original;

    // Reads still work: the seal governs writes, not lookup.
    assert.deepEqual(await evaluate(runtime, 'app', 'still', '[ :a :b | a + b ]', [integerValue(4), integerValue(4)]), integerValue(8));
    // Writes stall explicitly rather than landing in an abandoned record.
    await assert.rejects(
      defineMethods({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.integerClass,
        methods: [{selector: 'blocked', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(1)}}}],
      }),
      (error) => error.name === 'SmalltalkSealedMethodDictionaryError',
    );

    // And the retry converges, after which writes work again.
    await migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass});
    assert.deepEqual(await evaluate(runtime, 'app', 'converged', '[ :a :b | a + b ]', [integerValue(4), integerValue(4)]), integerValue(8));
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: kernel.integerClass,
      methods: [{selector: 'unblocked', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(1)}}}],
    });
    assert.deepEqual(await evaluate(runtime, 'app', 'unblocked', '[ :a | a unblocked ]', [integerValue(0)]), integerValue(1));
  });
});

// Deterministic target: a commit whose acknowledgement is lost must not leave another orphan on
// every retry, which is what a fresh id per attempt would do.
test('a lost acknowledgement on the migrated dictionary leaves no orphan', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
    });
    await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': plusBlock});
    const targetId = migratedDictionaryId(kernel.integerClass.objectId);

    const original = runtime.images.putObject.bind(runtime.images);
    runtime.images.putObject = async (imageId, input, opts) => {
      const stored = await original(imageId, input, opts);
      if (input.id === targetId) throw new Error('injected post-commit failure');
      return stored;
    };
    await assert.rejects(
      migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass}),
      /injected post-commit/,
    );
    runtime.images.putObject = original;

    const before = (await runtime.images.listObjects('app')).length;
    await migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass});
    const after = (await runtime.images.listObjects('app')).length;
    assert.equal(after, before, 'the retry reuses its own previous output rather than adding another');
    assert.deepEqual(await evaluate(runtime, 'app', 'converged', '[ :a :b | a + b ]', [integerValue(3), integerValue(3)]), integerValue(6));
  });
});

// Decision 7's second half: new work gets the new representation, and nothing short of an explicit
// migration touches an existing legacy dictionary.
test('defining a new class does not migrate an existing legacy dictionary', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+',
    });
    const legacyRef = await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': plusBlock});

    const point = await defineClass({images: runtime.images, imageId: 'app', name: 'Point'});
    const fresh = await dictionaryOf(runtime, 'app', point.classRef);
    assert.equal(isMethodDictionary(fresh.record), true, 'a class defined now gets the hashed form');

    const behavior = await runtime.images.getObject('app', kernel.integerClass.objectId);
    assert.equal(behavior.slots['behavior-methods'].objectId, legacyRef.objectId, 'the legacy edge is untouched');
    const legacy = await runtime.images.getObject('app', legacyRef.objectId);
    assert.equal(isMethodDictionary(legacy), false, 'and still legacy');
    assert.deepEqual(await evaluate(runtime, 'app', 'legacy-still', '[ :a :b | a + b ]', [integerValue(1), integerValue(1)]), integerValue(2));
  });
});

// --- both lanes ---------------------------------------------------------------------------------

// This changes lookup, not execution, so the expected result is *no difference* — which is worth
// checking rather than asserting.
for (const lane of ['neutral', 'wasm']) {
  test(`the ${lane} lane is unaffected by the hashed lookup`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      assert.deepEqual(
        await evaluate(runtime, 'app', `lane-${lane}`, '[ :a :b | a + b ]', [integerValue(20), integerValue(22)]),
        integerValue(42),
      );
    });
  });
}

test('a WASM caller dispatches through a hashed dictionary unchanged', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'wasm-caller', source: '[ :a :b | (a + b) + b ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'wasm-caller-tree',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), [integerValue(1), integerValue(2)]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(5));
  });
});

// --- migration recovery ---------------------------------------------------------------------------

// Enumerated, not sampled, with a commit-then-throw variant modelling a lost acknowledgement. The
// seeded image with its legacy dictionary is prepared once and forked per iteration; only the
// migration under test repeats.
test('every write in a migration is recoverable by an identical retry', async () => {
  const base = await forkableRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const plusBlock = await methodBlockRef({images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: '+'});
    await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {'+': plusBlock});
    return kernel;
  });
  try {
    const total = await base.withFork(async (runtime, kernel) => {
      const {images, writeCount} = faultingImages(runtime.images);
      await migrateMethodDictionary({images, imageId: 'app', behaviorRef: kernel.integerClass});
      return writeCount();
    });
    assert.ok(total >= 3, `expected several writes, saw ${total}`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await base.withFork(async (runtime, kernel) => {
          const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

          await assert.rejects(
            migrateMethodDictionary({images, imageId: 'app', behaviorRef: kernel.integerClass}),
            /injected/,
            `write ${failAt} (commitThenThrow=${commitThenThrow}) should have failed`,
          );

          await migrateMethodDictionary({images: runtime.images, imageId: 'app', behaviorRef: kernel.integerClass});
          assert.deepEqual(
            await evaluate(runtime, 'app', `retry-${failAt}-${commitThenThrow}`, '[ :a :b | a + b ]', [integerValue(5), integerValue(6)]),
            integerValue(11),
            `not dispatching after retrying past write ${failAt}`,
          );
        });
      }
    }
  } finally {
    await base.close();
  }
});

// ONE CURRENT-BINDING READER (bead lagrange-images-jtz.2). "What Block is bound at
// {Class, selector} right now" is one question, and it used to have two answers: the published
// protocol reader validated every declared legacy slot, while the write planner's read-for-update
// built its map straight from the record's slots with no check. The same class was WRITABLE BUT
// UNBROWSABLE, and a write carried the malformed slot forward into the rewritten record.
//
// These tests assert the bindings themselves, not merely that a call succeeded: a reader that
// answered the WRONG Block would pass a success/failure check and fail these.
const READER_METHOD = Object.freeze({
  selector: 'readerProbe',
  program: Object.freeze({parameters: [], captures: [], body: Object.freeze({op: 'receiver'})}),
});

// A legacy dictionary whose declared slot holds something that is not a Block ref at all.
async function malformedLegacyDictionaryFor(runtime, imageId, classRef, goodBlock) {
  const shape = await runtime.images.putShape(imageId, {
    id: 'malformed-legacy-shape',
    slots: [{id: 'selector:good', name: 'good'}, {id: 'selector:bad', name: 'bad'}],
  });
  const dictionary = await runtime.images.putObject(imageId, {
    id: 'malformed-legacy-methods',
    shape: objectRef(imageId, shape.id),
    slots: {'selector:good': goodBlock, 'selector:bad': textValue('not a block ref')},
    metadata: {smalltalk: 'method-dictionary'},
  });
  const behavior = await runtime.images.getObject(imageId, classRef.objectId);
  await runtime.images.putObject(imageId, {
    id: behavior.id,
    shape: behavior.shape,
    behavior: behavior.behavior,
    slots: {...behavior.slots, 'behavior-methods': objectRef(imageId, dictionary.id)},
    metadata: behavior.metadata,
  }, {expectedVersion: behavior._version});
  return objectRef(imageId, dictionary.id);
}

// THE DIVERGENCE THIS CLOSES, on the representation where it existed. Write planning must reach the
// same verdict as browsing, and must not make the corruption durable by rewriting the record.
test('a malformed legacy slot is refused by write planning exactly as browsing refuses it', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const good = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'reader-good-block', source: '[ 42 ]',
    });
    const dictionaryRef = await malformedLegacyDictionaryFor(
      runtime, 'app', kernel.integerClass, objectRef('app', good.block.id),
    );
    const before = await runtime.images.getObject('app', dictionaryRef.objectId);

    const browse = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'good',
    }).then(() => null, (error) => error);
    assert.ok(browse, 'browsing must refuse a dictionary with a malformed slot');
    assert.match(browse.message, /slot for bad must contain an unpinned Block ref/);

    // The write planner reads the same current bindings, so it reaches the same verdict — and it is
    // the SAME message, because it is now the same reader rather than a second one that agrees.
    const planned = await defineMethods({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      lane: 'neutral',
      classRef: kernel.integerClass,
      methods: [READER_METHOD],
    }).then(() => null, (error) => error);
    assert.ok(planned, 'write planning must refuse the same dictionary');
    assert.match(planned.message, /slot for bad must contain an unpinned Block ref/);

    // ... and nothing was written: the malformed slot is not carried forward, and the new selector
    // did not land. Before this repair the write SUCCEEDED and rewrote the record keeping the bad
    // slot, which is how a corrupt dictionary became durable.
    const after = await runtime.images.getObject('app', dictionaryRef.objectId);
    assert.equal(after._version, before._version, 'a refused write leaves the record untouched');
    assert.deepEqual(after.slots, before.slots);
  });
});

// AGREEMENT ON THE ACTUAL BINDING, both representations. The assertion is the Block ref itself:
// a reader that answered a different Block, or dropped the selector, fails here.
for (const representation of ['legacy', 'hashed']) {
  test(`browse and write planning agree on the current binding (${representation})`, async () => {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app');
      const bound = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: `agree-${representation}`, source: '[ 7 ]',
      });
      const boundRef = objectRef('app', bound.block.id);
      if (representation === 'legacy') {
        await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {agreed: boundRef});
      } else {
        // The hashed representation, reached the ordinary way.
        await defineMethods({
          images: runtime.images,
          compilation: runtime.compilation,
          imageId: 'app',
          lane: 'neutral',
          classRef: kernel.integerClass,
          methods: [{selector: 'agreed', program: {parameters: [], captures: [], body: {op: 'receiver'}}}],
        });
      }

      // What browsing says is bound.
      const browsed = await methodBlockRef({
        images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'agreed',
      });
      assert.ok(browsed, 'the selector is bound');

      // What the write planner saw. `defineMethods` is add-only: an identical redefinition is a
      // legal replay, but DIFFERENT semantics for a selector it can already see is refused. So the
      // discriminating attempt is a different program — if the planner had NOT seen the current
      // binding it would have accepted this and silently rebound the selector.
      await assert.rejects(
        defineMethods({
          images: runtime.images,
          compilation: runtime.compilation,
          imageId: 'app',
          lane: 'neutral',
          classRef: kernel.integerClass,
          methods: [{
            selector: 'agreed',
            program: {parameters: [{id: 'agreed:x', name: 'x'}], captures: [], body: {op: 'argument', index: 0}},
          }],
        }),
        (error) => error instanceof SmalltalkKernelConflictError || /already|conflict/i.test(error.message),
        'the write planner must see the same current binding browsing reports',
      );

      // And the binding did not move.
      assert.deepEqual(
        await methodBlockRef({
          images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'agreed',
        }),
        browsed,
      );
      if (representation === 'legacy') assert.deepEqual(browsed, boundRef, 'the exact Block the legacy slot holds');
    });
  });
}

// DISPATCH AGREEMENT, in the direction that matters: whatever the current-binding reader accepts,
// dispatch resolves to the SAME Block. Dispatch validates only the slot for the selector being sent
// — it answers one send rather than describing a class — so it remains able to resolve a good
// selector in a dictionary this reader refuses as a whole. That is consistent, not contradictory:
// the reader is never laxer than dispatch.
test('dispatch resolves the same Block the current-binding reader reports', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const answer = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'dispatch-agree-block', source: '[ 42 ]',
    });
    await legacyDictionaryFor(runtime, 'app', kernel.integerClass, {
      answer: objectRef('app', answer.block.id),
    });
    assert.deepEqual(
      await methodBlockRef({
        images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'answer',
      }),
      objectRef('app', answer.block.id),
    );
    // The send resolves through the lookup walk, not through this reader, and lands on that Block.
    assert.deepEqual(await evaluate(runtime, 'app', 'dispatch-agree-send', '[ :n | n answer ]', [integerValue(1)]), integerValue(42));
  });
});
