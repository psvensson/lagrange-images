import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  booleanValue,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  createRuntime,
  defineClass,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  pinnedRef,
  textValue,
} from '../src/runtime.js';
import {referencesOfRecord} from '../src/graph/references.js';
import {builtInHash} from '../src/language/smalltalk-equality.js';
import {
  DICTIONARY_MINIMUM_CAPACITY,
  DICTIONARY_TABLE_SLOT,
  DICTIONARY_TALLY_SLOT,
  readTableRecord,
} from '../src/language/smalltalk-dictionary-table.js';
import {SYMMETRIC_SMALLTALK_ID} from '../src/language/symmetric-smalltalk.js';

// ADR 0048 decisions 5-9. The three things this file is really separating:
//
//   identity vs contents    a Dictionary's identity never moves; its table snapshot is replaced
//   representation          bucket triples, so `nil` is an ordinary key rather than a sentinel
//   user code mid-mutation  hash/= run between the read and the CAS, so the CAS is conditioned on
//                           the version observed before they ran

const DICTIONARY_CLASS = 'smalltalk/class/Dictionary';

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkDictionaryProtocol(options);
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

async function evaluateThroughWasm(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const tree = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef(imageId, installed.semanticArtifact.id),
    id: `${id}:wasm-tree`,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, tree.block.id), args);
  return await runtime.executor.execute(activation);
}

const newDictionary = (runtime, imageId, id) =>
  evaluate(runtime, imageId, id, '[ :c | c new ]', [objectRef(imageId, DICTIONARY_CLASS)]);

async function tableOf(runtime, imageId, dictionary) {
  const record = await runtime.images.getObject(imageId, dictionary.objectId);
  const tableRef = record.slots[DICTIONARY_TABLE_SLOT];
  return {
    record,
    tableRef,
    table: await runtime.images.getObject(tableRef.imageId, tableRef.objectId),
  };
}

// --- representation ---------------------------------------------------------------------------

test('a new Dictionary has stable identity and a complete empty table', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const {table} = await tableOf(runtime, 'app', dictionary);

    assert.equal(table.indexed.length, DICTIONARY_MINIMUM_CAPACITY * 3, 'capacity*3 indexed Values');
    assert.deepEqual(table.slots[DICTIONARY_TALLY_SLOT], integerValue(0));
    assert.equal(table.behavior, null, 'a table is an internal graph object, not a Smalltalk class instance');
    const parsed = readTableRecord(table);
    assert.equal(parsed.capacity, DICTIONARY_MINIMUM_CAPACITY);
    assert.equal(parsed.tally, 0);

    // Identity is stable across mutation: the Dictionary ref never changes, only its table slot.
    const emptyTableRef = (await tableOf(runtime, 'app', dictionary)).tableRef;
    await evaluate(runtime, 'app', 'store', "[ :d | d at: 'k' put: 1 ]", [dictionary]);
    const after = await tableOf(runtime, 'app', dictionary);
    assert.equal(after.record.id, dictionary.objectId, 'the Dictionary keeps its identity');
    assert.notEqual(after.tableRef.objectId, emptyTableRef.objectId, 'but points at a new snapshot');
    assert.equal(readTableRecord(after.table).tally, 1);
  });
});

// Occupancy is the hash cell, not the key cell, so no user key is stolen as an empty sentinel.
test('nil is an ordinary key', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');

    assert.deepEqual(
      await evaluate(runtime, 'app', 'put-nil', '[ :d :k | d at: k put: 7 ]', [dictionary, kernel.nil]),
      integerValue(7),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'get-nil', '[ :d :k | d at: k ]', [dictionary, kernel.nil]),
      integerValue(7),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'has-nil', '[ :d :k | d includesKey: k ]', [dictionary, kernel.nil]),
      booleanValue(true),
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'size', '[ :d | d size ]', [dictionary]), integerValue(1));
  });
});

// The whole point of decision 5: a reader holding an old table ref keeps seeing a complete, valid,
// unchanged mapping.
test('a published table snapshot is never modified by a later mutation', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await evaluate(runtime, 'app', 'first', "[ :d | d at: 'a' put: 1 ]", [dictionary]);
    const first = await tableOf(runtime, 'app', dictionary);
    const snapshot = JSON.stringify(first.table);

    await evaluate(runtime, 'app', 'second', "[ :d | d at: 'b' put: 2 ]", [dictionary]);
    const second = await tableOf(runtime, 'app', dictionary);
    assert.notEqual(second.tableRef.objectId, first.tableRef.objectId, 'a new snapshot, not an edit');

    const reread = await runtime.images.getObject('app', first.tableRef.objectId);
    assert.equal(JSON.stringify(reread), snapshot, 'the old snapshot must be byte-identical');
    assert.equal(readTableRecord(reread).tally, 1);
  });
});

// ADR 0047's walker already covers indexed elements; this proves keys and values actually ride there
// rather than in metadata or some flattened encoding.
test('ref keys and values in a table are first-class graph edges', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const key = objectRef('app', 'smalltalk/class/Object');
    const value = objectRef('app', 'smalltalk/class/Boolean');
    await evaluate(runtime, 'app', 'put', '[ :d :k :v | d at: k put: v ]', [dictionary, key, value]);

    const {table} = await tableOf(runtime, 'app', dictionary);
    const refs = referencesOfRecord(table).map(({objectId}) => objectId);
    assert.ok(refs.includes(key.objectId), 'the key must be reachable');
    assert.ok(refs.includes(value.objectId), 'the value must be reachable');
  });
});

// --- protocol ---------------------------------------------------------------------------------

test('size counts unique keys rather than writes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    assert.deepEqual(await evaluate(runtime, 'app', 's0', '[ :d | d size ]', [dictionary]), integerValue(0));

    await evaluate(runtime, 'app', 'p1', "[ :d | d at: 'k' put: 1 ]", [dictionary]);
    await evaluate(runtime, 'app', 'p2', "[ :d | d at: 'k' put: 2 ]", [dictionary]);
    assert.deepEqual(await evaluate(runtime, 'app', 's1', '[ :d | d size ]', [dictionary]), integerValue(1));
    assert.deepEqual(await evaluate(runtime, 'app', 'g1', "[ :d | d at: 'k' ]", [dictionary]), integerValue(2));

    await evaluate(runtime, 'app', 'p3', "[ :d | d at: 'other' put: 3 ]", [dictionary]);
    assert.deepEqual(await evaluate(runtime, 'app', 's2', '[ :d | d size ]', [dictionary]), integerValue(2));
  });
});

test('includesKey: and at: distinguish present from absent keys', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await evaluate(runtime, 'app', 'put', "[ :d | d at: 'k' put: 1 ]", [dictionary]);

    assert.deepEqual(
      await evaluate(runtime, 'app', 'has', "[ :d | d includesKey: 'k' ]", [dictionary]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'hasnt', "[ :d | d includesKey: 'nope' ]", [dictionary]),
      booleanValue(false),
    );
    await assert.rejects(
      evaluate(runtime, 'app', 'missing', "[ :d | d at: 'nope' ]", [dictionary]),
      (error) => error.name === 'SmalltalkDictionaryKeyNotFoundError',
    );
  });
});

// Decision 7's recognized no-op. An exact caller retry after a lost acknowledgement must not publish
// a second snapshot or bump the Dictionary version.
test('storing the same canonical Value for an equal key publishes nothing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await evaluate(runtime, 'app', 'put', "[ :d | d at: 'k' put: 5 ]", [dictionary]);
    const before = await tableOf(runtime, 'app', dictionary);
    const objectCount = (await runtime.images.listObjects('app')).length;

    assert.deepEqual(
      await evaluate(runtime, 'app', 'repeat', "[ :d | d at: 'k' put: 5 ]", [dictionary]),
      integerValue(5),
    );
    const after = await tableOf(runtime, 'app', dictionary);
    assert.equal(after.record._version, before.record._version, 'no version bump');
    assert.equal(after.tableRef.objectId, before.tableRef.objectId, 'no new snapshot');
    assert.equal((await runtime.images.listObjects('app')).length, objectCount, 'no orphan table either');

    // A *different* value for the same key is an ordinary replacement, not a no-op.
    await evaluate(runtime, 'app', 'change', "[ :d | d at: 'k' put: 6 ]", [dictionary]);
    assert.notEqual((await tableOf(runtime, 'app', dictionary)).tableRef.objectId, before.tableRef.objectId);
  });
});

// Distinct keys deliberately sharing a hash must both be stored and both be findable, which is what
// exercises linear probing rather than a lucky one-bucket-per-key layout.
test('colliding keys probe correctly', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'clash-shape', slots: []})).id);
    const clash = await defineClass({images: runtime.images, imageId: 'app', name: 'Clash', instanceShapeRef: shape});
    // Same hash for every instance, but identity equality inherited from Object — so they are
    // distinct keys that always collide.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: clash.classRef,
      methods: [{selector: 'hash', program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(42)}}}],
    });

    const dictionary = await newDictionary(runtime, 'app', 'd');
    const keys = [];
    for (let index = 0; index < 5; index += 1) {
      const key = await evaluate(runtime, 'app', `key-${index}`, '[ :c | c basicNew ]', [clash.classRef]);
      keys.push(key);
      await evaluate(runtime, 'app', `put-${index}`, '[ :d :k :v | d at: k put: v ]', [dictionary, key, integerValue(index)]);
    }
    assert.deepEqual(await evaluate(runtime, 'app', 'size', '[ :d | d size ]', [dictionary]), integerValue(5));
    for (const [index, key] of keys.entries()) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `get-${index}`, '[ :d :k | d at: k ]', [dictionary, key]),
        integerValue(index),
        `colliding key ${index} must still be found`,
      );
    }
  });
});

test('growth past the load factor doubles capacity and preserves every mapping', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const entries = 20;
    for (let index = 0; index < entries; index += 1) {
      await evaluate(runtime, 'app', `put-${index}`, `[ :d | d at: ${index} put: ${index * 3} ]`, [dictionary]);
    }

    const {table} = await tableOf(runtime, 'app', dictionary);
    const parsed = readTableRecord(table);
    assert.equal(parsed.tally, entries);
    assert.ok(parsed.capacity >= entries * 4 / 3, `capacity ${parsed.capacity} must keep the load under 3/4`);
    assert.equal(parsed.capacity & (parsed.capacity - 1), 0, 'capacity stays a power of two');
    assert.equal(table.indexed.length, parsed.capacity * 3);

    for (let index = 0; index < entries; index += 1) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `get-${index}`, `[ :d | d at: ${index} ]`, [dictionary]),
        integerValue(index * 3),
        `mapping ${index} must survive growth`,
      );
    }
  });
});

// --- user code during mutation ------------------------------------------------------------------

// Decision 8. A `hash` method that mutates the same Dictionary is the sharpest version of the
// problem: the initial read is stale by the time the swap happens, and installing the snapshot
// anyway would lose the mutation the user's own code performed.
test('a conflict caused by user hash code is surfaced, never silently retried', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'meddler-shape', slots: []})).id);
    const meddler = await defineClass({images: runtime.images, imageId: 'app', name: 'Meddler', instanceShapeRef: shape});
    // `at:put:` answers the stored value, so this both mutates the Dictionary and answers an Integer
    // hash — all inside one lagrange-code/v0 expression.
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: meddler.classRef,
      methods: [{
        selector: 'hash',
        program: {
          parameters: [],
          captures: [{id: 'meddler/dictionary', name: 'target'}],
          body: {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: {op: 'binding', id: 'meddler/dictionary'},
            message: textValue('at:put:'),
            arguments: [{op: 'literal', value: textValue('side-effect')}, {op: 'literal', value: integerValue(11)}],
          },
        },
        captures: [{id: 'meddler/dictionary', name: 'target', value: dictionary}],
      }],
    });

    const key = await evaluate(runtime, 'app', 'meddle-key', '[ :c | c basicNew ]', [meddler.classRef]);
    await assert.rejects(
      evaluate(runtime, 'app', 'store', '[ :d :k | d at: k put: 1 ]', [dictionary, key]),
      (error) => error.name === 'SmalltalkDictionaryConflictError',
    );

    // The mutation the user's own code performed survives; the outer store did not land.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'side', "[ :d | d at: 'side-effect' ]", [dictionary]),
      integerValue(11),
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'size', '[ :d | d size ]', [dictionary]), integerValue(1));
  });
});

test('a refused mutation leaves the old mapping complete and its orphan table unreachable', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await evaluate(runtime, 'app', 'seed', "[ :d | d at: 'kept' put: 1 ]", [dictionary]);
    const before = await tableOf(runtime, 'app', dictionary);

    // Force the CAS to fail by bumping the Dictionary version behind the primitive's back is not
    // expressible from Smalltalk, so this uses the meddler shape again in miniature: a second store
    // performed by the key's own `hash`.
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'm2-shape', slots: []})).id);
    const meddler = await defineClass({images: runtime.images, imageId: 'app', name: 'M2', instanceShapeRef: shape});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: meddler.classRef,
      methods: [{
        selector: 'hash',
        program: {
          parameters: [],
          captures: [{id: 'm2/dictionary', name: 'target'}],
          body: {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: {op: 'binding', id: 'm2/dictionary'},
            message: textValue('at:put:'),
            arguments: [{op: 'literal', value: textValue('by-hash')}, {op: 'literal', value: integerValue(2)}],
          },
        },
        captures: [{id: 'm2/dictionary', name: 'target', value: dictionary}],
      }],
    });
    const key = await evaluate(runtime, 'app', 'm2-key', '[ :c | c basicNew ]', [meddler.classRef]);
    await assert.rejects(
      evaluate(runtime, 'app', 'refused', '[ :d :k | d at: k put: 9 ]', [dictionary, key]),
      (error) => error.name === 'SmalltalkDictionaryConflictError',
    );

    // The original mapping is intact and readable, and the Dictionary points at a valid table.
    assert.deepEqual(await evaluate(runtime, 'app', 'kept', "[ :d | d at: 'kept' ]", [dictionary]), integerValue(1));
    const after = await tableOf(runtime, 'app', dictionary);
    assert.doesNotThrow(() => readTableRecord(after.table));
    assert.notEqual(after.tableRef.objectId, before.tableRef.objectId, 'the hash side effect did publish');
  });
});

// The no-op path is a claim about durable state made *after* arbitrary user code ran. If it returns
// from the stale snapshot alone, a re-entrant hash can mutate the Dictionary while the outer
// operation reports success — a false success, which is worse than the conflict it hides.
//
// The setup is deliberately real user code: a key whose `hash` both writes a side effect and answers
// the hash it was originally stored under, so the key is still *found*, the stored value is still
// exactly equal, and the fast path is genuinely the branch under test.
test('the same-value no-op refuses a re-entrant mutation instead of reporting false success', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'reentrant-shape', slots: []})).id);
    const plain = await defineClass({images: runtime.images, imageId: 'app', name: 'Plain', instanceShapeRef: shape});

    const key = await evaluate(runtime, 'app', 'key', '[ :c | c basicNew ]', [plain.classRef]);
    await evaluate(runtime, 'app', 'store', '[ :d :k | d at: k put: 1 ]', [dictionary, key]);
    const storedHash = builtInHash(key);

    // A same-shape class whose `hash` answers the *original* hash — `at:put:` answers its value —
    // while also mutating this Dictionary.
    const sneaky = await defineClass({images: runtime.images, imageId: 'app', name: 'Sneaky', instanceShapeRef: shape});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: sneaky.classRef,
      methods: [{
        selector: 'hash',
        program: {
          parameters: [],
          captures: [{id: 'sneaky/dictionary', name: 'target'}],
          body: {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: {op: 'binding', id: 'sneaky/dictionary'},
            message: textValue('at:put:'),
            arguments: [
              {op: 'literal', value: textValue('side-effect')},
              {op: 'literal', value: storedHash},
            ],
          },
        },
        captures: [{id: 'sneaky/dictionary', name: 'target', value: dictionary}],
      }],
    });
    const keyRecord = await runtime.images.getObject('app', key.objectId);
    await runtime.images.putObject('app', {
      id: keyRecord.id,
      shape: keyRecord.shape,
      behavior: sneaky.classRef,
      slots: keyRecord.slots,
      metadata: keyRecord.metadata,
    }, {expectedVersion: keyRecord._version});

    // Exactly the value already stored, so this is the no-op branch and nothing else.
    await assert.rejects(
      evaluate(runtime, 'app', 'noop-conflict', '[ :d :k | d at: k put: 1 ]', [dictionary, key]),
      (error) => error.name === 'SmalltalkDictionaryConflictError',
      'a no-op must not report success over a mutation its own hash performed',
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'side', "[ :d | d at: 'side-effect' ]", [dictionary]),
      storedHash,
      'the side effect the user code performed must survive',
    );
  });
});

// Deterministic ids mean a record can already occupy this one. Carrying the right instance Shape is
// not the same as being this class: adopting a differently-defined Behavior would then publish
// Dictionary methods onto it.
test('a Dictionary class id occupied by a differently-defined class is refused', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app'};
    await installSmalltalkAllocationProtocol(options);
    await installSmalltalkEqualityProtocol(options);

    // The right shape at the right id, but under the wrong superclass.
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'smalltalk/dictionary-shape/v1', slots: [{id: DICTIONARY_TABLE_SLOT, name: 'table'}],
    })).id);
    await defineClass({
      images: runtime.images, imageId: 'app', name: 'Dictionary',
      superclassRef: kernel.integerClass, instanceShapeRef: shape,
    });

    await assert.rejects(
      installSmalltalkDictionaryProtocol(options),
      (error) => error.name === 'SmalltalkKernelConflictError',
      'a class graph that differs anywhere immutable must be refused, not adopted',
    );
  });
});

// --- enumeration --------------------------------------------------------------------------------
//
// Workstream 3: `keysAndValuesDo:`, the one representation-aware enumeration primitive. What these
// tests pin down: every pair is visited exactly once (in no promised order), the pairs are a
// snapshot so mutation from inside the Block never invalidates the traversal, and enumeration
// re-sends neither `hash` nor `=`.

test('keysAndValuesDo: visits every pair exactly once and answers the receiver', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await evaluate(runtime, 'app', 'p1', "[ :d | d at: 'a' put: 1 ]", [dictionary]);
    await evaluate(runtime, 'app', 'p2', "[ :d | d at: 'b' put: 2 ]", [dictionary]);
    await evaluate(runtime, 'app', 'p3', "[ :d | d at: 'c' put: 3 ]", [dictionary]);
    const acc = await newDictionary(runtime, 'app', 'acc');
    const seen = await newDictionary(runtime, 'app', 'seen');

    // `seen at: k` records whether the key had been visited before — a second visit would store true.
    const result = await evaluate(
      runtime, 'app', 'enumerate',
      '[ :d :acc :seen | d keysAndValuesDo: [ :k :v | seen at: k put: (seen includesKey: k). acc at: k put: v ] ]',
      [dictionary, acc, seen],
    );
    assert.deepEqual(result, dictionary, 'keysAndValuesDo: answers the receiver');

    assert.deepEqual(await evaluate(runtime, 'app', 'acc-size', '[ :d | d size ]', [acc]), integerValue(3));
    for (const [key, value] of [['a', 1], ['b', 2], ['c', 3]]) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `acc-${key}`, `[ :d | d at: '${key}' ]`, [acc]),
        integerValue(value),
        `the pair ${key} must be visited with its stored value`,
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `seen-${key}`, `[ :d | d at: '${key}' ]`, [seen]),
        booleanValue(false),
        `the pair ${key} must be visited exactly once`,
      );
    }
  });
});

test('an empty Dictionary enumerates nothing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const acc = await newDictionary(runtime, 'app', 'acc');
    await evaluate(
      runtime, 'app', 'enumerate',
      "[ :d :acc | d keysAndValuesDo: [ :k :v | acc at: 'ran' put: 1 ] ]",
      [dictionary, acc],
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'acc-size', '[ :d | d size ]', [acc]), integerValue(0));
  });
});

// The snapshot promise. The Block mutates the very Dictionary being enumerated — overwriting an
// existing key and adding a new one — and the traversal still visits exactly the complete mapping
// it started from, with the values it started from. The mutations land: they swap the `table` ref
// to new snapshots while the enumeration keeps reading the one it loaded.
test('mutation from inside the Block never invalidates the in-progress traversal', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await evaluate(runtime, 'app', 'p1', "[ :d | d at: 'a' put: 1 ]", [dictionary]);
    await evaluate(runtime, 'app', 'p2', "[ :d | d at: 'b' put: 2 ]", [dictionary]);
    const acc = await newDictionary(runtime, 'app', 'acc');

    await evaluate(
      runtime, 'app', 'enumerate',
      "[ :d :acc | d keysAndValuesDo: [ :k :v | d at: 'a' put: 100. d at: 'later' put: 9. acc at: k put: v ] ]",
      [dictionary, acc],
    );

    // The traversal saw the snapshot: both original pairs, original values, and never 'later'.
    assert.deepEqual(await evaluate(runtime, 'app', 'acc-size', '[ :d | d size ]', [acc]), integerValue(2));
    assert.deepEqual(await evaluate(runtime, 'app', 'acc-a', "[ :d | d at: 'a' ]", [acc]), integerValue(1));
    assert.deepEqual(await evaluate(runtime, 'app', 'acc-b', "[ :d | d at: 'b' ]", [acc]), integerValue(2));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'acc-later', "[ :d | d includesKey: 'later' ]", [acc]),
      booleanValue(false),
    );

    // The mutations the Block performed all landed in the Dictionary itself.
    assert.deepEqual(await evaluate(runtime, 'app', 'd-size', '[ :d | d size ]', [dictionary]), integerValue(3));
    assert.deepEqual(await evaluate(runtime, 'app', 'd-a', "[ :d | d at: 'a' ]", [dictionary]), integerValue(100));
    assert.deepEqual(await evaluate(runtime, 'app', 'd-later', "[ :d | d at: 'later' ]", [dictionary]), integerValue(9));
  });
});

// Enumeration visits stored pairs; it looks nothing up, so user equality code must run zero times.
// The proof reuses the behavior-swap trick from the no-op test above: the key is stored under a
// well-behaved built-in hash, then its class is swapped for one whose `hash` and `=` leave loud
// markers — enumeration must leave the witness empty, while an actual lookup dirties it (which is
// also the falsification that the markers work at all).
test('keysAndValuesDo: re-sends neither hash nor =', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const witness = await newDictionary(runtime, 'app', 'witness');
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'silent-shape', slots: []})).id);
    const plain = await defineClass({images: runtime.images, imageId: 'app', name: 'PlainKey', instanceShapeRef: shape});
    const key = await evaluate(runtime, 'app', 'key', '[ :c | c basicNew ]', [plain.classRef]);
    await evaluate(runtime, 'app', 'store', '[ :d :k | d at: k put: 42 ]', [dictionary, key]);
    const storedHash = builtInHash(key);

    const loud = await defineClass({images: runtime.images, imageId: 'app', name: 'LoudKey', instanceShapeRef: shape});
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: loud.classRef,
      methods: [
        {
          selector: 'hash',
          program: {
            parameters: [],
            captures: [{id: 'loud/witness', name: 'witness'}],
            // `at:put:` answers the stored value, so this both marks the witness and answers the
            // hash the key was originally stored under — a lookup through it still finds the key.
            body: {
              op: 'send',
              languageId: SYMMETRIC_SMALLTALK_ID,
              receiver: {op: 'binding', id: 'loud/witness'},
              message: textValue('at:put:'),
              arguments: [{op: 'literal', value: textValue('hash-was-sent')}, {op: 'literal', value: storedHash}],
            },
          },
          captures: [{id: 'loud/witness', name: 'witness', value: witness}],
        },
        {
          selector: '=',
          program: {
            parameters: [{id: 'loud/equals/other', name: 'anObject'}],
            captures: [{id: 'loud/witness', name: 'witness'}],
            body: {
              op: 'send',
              languageId: SYMMETRIC_SMALLTALK_ID,
              receiver: {op: 'binding', id: 'loud/witness'},
              message: textValue('at:put:'),
              arguments: [{op: 'literal', value: textValue('equals-was-sent')}, {op: 'literal', value: booleanValue(true)}],
            },
          },
          captures: [{id: 'loud/witness', name: 'witness', value: witness}],
        },
      ],
    });
    const keyRecord = await runtime.images.getObject('app', key.objectId);
    await runtime.images.putObject('app', {
      id: keyRecord.id,
      shape: keyRecord.shape,
      behavior: loud.classRef,
      slots: keyRecord.slots,
      metadata: keyRecord.metadata,
    }, {expectedVersion: keyRecord._version});

    // Enumerate. The Block deliberately keys the accumulator by the *value*, so nothing in it can
    // send `hash` to the loud key either.
    const acc = await newDictionary(runtime, 'app', 'acc');
    await evaluate(
      runtime, 'app', 'enumerate',
      '[ :d :acc | d keysAndValuesDo: [ :k :v | acc at: v put: v ] ]',
      [dictionary, acc],
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'visited', '[ :d | d at: 42 ]', [acc]), integerValue(42));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'silent', '[ :d | d size ]', [witness]),
      integerValue(0),
      'enumeration must send neither hash nor =',
    );

    // Falsification: an actual lookup does send both, so the markers demonstrably work.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'lookup', '[ :d :k | d includesKey: k ]', [dictionary, key]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'dirty', '[ :d | d size ]', [witness]),
      integerValue(2),
      'a real lookup sends hash and =, proving the witness machinery detects them',
    );
  });
});

test('a kernel-primitive Block or a non-Block is refused as the pair block', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await assert.rejects(
      evaluate(runtime, 'app', 'prim-block', '[ :d :b | d keysAndValuesDo: b ]',
        [dictionary, objectRef('app', 'smalltalk/primitive/dictionary-at-put')]),
      (error) => error.name === 'SmalltalkPrimitiveReceiverError',
      'a kernel-primitive Block would run a primitive with Dictionary-chosen arguments',
    );
    await assert.rejects(
      evaluate(runtime, 'app', 'non-block', '[ :d :b | d keysAndValuesDo: b ]',
        [dictionary, integerValue(7)]),
      (error) => error.name === 'SmalltalkPrimitiveReceiverError',
    );
  });
});

test('a foreign primitive Block cannot enumerate a local Dictionary', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: objectRef('other', 'smalltalk/primitive/dictionary-keys-and-values-do'),
        message: textValue('value:value:'),
        arguments: [dictionary, integerValue(0)],
      })),
      (error) => error.name === 'SmalltalkPrimitiveLocalityError',
    );
  });
});

// --- boundaries ---------------------------------------------------------------------------------

test('Dictionary mutation needs no authority context', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'no-auth', source: "[ :c | (c new) at: 'k' put: 1 ]",
    });
    const activation = await runtime.invocations.invokeBlock(
      objectRef('app', installed.block.id), [objectRef('app', DICTIONARY_CLASS)],
    );
    // No authority argument at all; nothing on this path calls `require`.
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(1));
  });
});

test('a foreign primitive Block cannot mutate a local Dictionary', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: objectRef('other', 'smalltalk/primitive/dictionary-at-put'),
        message: textValue('value:value:value:'),
        arguments: [dictionary, textValue('k'), integerValue(1)],
      })),
      (error) => error.name === 'SmalltalkPrimitiveLocalityError',
    );
  });
});

test('a pinned ref cannot be a key', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const record = await runtime.images.getObject('app', dictionary.objectId);
    await assert.rejects(
      evaluate(runtime, 'app', 'pinned', '[ :d :k | d at: k put: 1 ]',
        [dictionary, pinnedRef('app', record.id, record._version)]),
      // The dispatcher refuses a pinned receiver before `hash` could even be looked up.
      /pinned-ref|cannot dispatch/,
    );
  });
});

test('the compiler recognizes none of the Dictionary selectors', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'shape-check',
      source: "[ :d :k | (d includesKey: k) = (d at: k put: 1) hash ]",
    });
    const semantic = await runtime.images.getCodeArtifact('app', installed.semanticArtifact.id);
    const program = JSON.parse(semantic.content.value);
    assert.equal(program.body.op, 'send');
    assert.equal(program.body.message.value, '=');
    assert.doesNotMatch(semantic.content.value, /"op":"equals"/, 'the front end must not emit the equals op');
  });
});

// --- both lanes -----------------------------------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`the Dictionary protocol runs through the ${lane} lane, including nested hash and = sends`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      const dictionary = await newDictionary(runtime, 'app', `d-${lane}`);
      await evaluate(runtime, 'app', `put-a-${lane}`, "[ :d | d at: 'a' put: 1 ]", [dictionary]);
      await evaluate(runtime, 'app', `put-b-${lane}`, "[ :d | d at: 'b' put: 2 ]", [dictionary]);
      assert.deepEqual(await evaluate(runtime, 'app', `get-${lane}`, "[ :d | d at: 'b' ]", [dictionary]), integerValue(2));
      assert.deepEqual(await evaluate(runtime, 'app', `size-${lane}`, '[ :d | d size ]', [dictionary]), integerValue(2));

      const acc = await newDictionary(runtime, 'app', `acc-${lane}`);
      await evaluate(runtime, 'app', `enum-${lane}`,
        '[ :d :acc | d keysAndValuesDo: [ :k :v | acc at: k put: v ] ]', [dictionary, acc]);
      assert.deepEqual(await evaluate(runtime, 'app', `enum-size-${lane}`, '[ :d | d size ]', [acc]), integerValue(2));
      assert.deepEqual(await evaluate(runtime, 'app', `enum-a-${lane}`, "[ :d | d at: 'a' ]", [acc]), integerValue(1));
    });
  });
}

// Each pair application suspends and resumes the enumerating WASM frame, and further sends follow.
test('enumeration whose pair Block feeds another Dictionary resumes correctly in WASM', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const dictionary = await newDictionary(runtime, 'app', 'd');
    await evaluate(runtime, 'app', 'p1', "[ :d | d at: 'a' put: 1 ]", [dictionary]);
    await evaluate(runtime, 'app', 'p2', "[ :d | d at: 'b' put: 2 ]", [dictionary]);
    const acc = await newDictionary(runtime, 'app', 'acc');

    const result = await evaluateThroughWasm(
      runtime, 'app', 'enum-tree',
      '[ :d :acc | d keysAndValuesDo: [ :k :v | acc at: k put: v ] ]',
      [dictionary, acc],
    );
    assert.deepEqual(result, dictionary);
    assert.deepEqual(await evaluate(runtime, 'app', 'acc-size', '[ :d | d size ]', [acc]), integerValue(2));
    assert.deepEqual(await evaluate(runtime, 'app', 'acc-b', "[ :d | d at: 'b' ]", [acc]), integerValue(2));
  });
});

// The result of at:put: feeds a further send, so the WASM lane cannot compile it as a tail call.
test('a Dictionary mutation whose result feeds another send resumes correctly in WASM', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const dictionary = await newDictionary(runtime, 'app', 'd');
    const result = await evaluateThroughWasm(
      runtime, 'app', 'nontail', "[ :d | (d at: 'k' put: 5) hash ]", [dictionary],
    );
    assert.equal(result.kind, 'integer');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'stored-once', '[ :d | d size ]', [dictionary]),
      integerValue(1),
      'the mutation must happen exactly once across suspension and resumption',
    );
  });
});

test('installing the Dictionary protocol twice changes nothing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const before = await runtime.images.getObject('app', `${DICTIONARY_CLASS}/methods`);
    await installSmalltalkDictionaryProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
    });
    const after = await runtime.images.getObject('app', `${DICTIONARY_CLASS}/methods`);
    assert.equal(after._version, before._version);
  });
});

// --- installer recovery ----------------------------------------------------------------------------

const WRITE_METHODS = ['putCodeArtifact', 'putBlock', 'putShape', 'putObject', 'putLexicalEnvironment'];

function faultingImages(images, {failAt = null, commitThenThrow = false} = {}) {
  let writes = 0;
  const wrapped = Object.create(Object.getPrototypeOf(images));
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(images))) {
    if (typeof images[key] !== 'function' || key === 'constructor') continue;
    wrapped[key] = (...args) => images[key](...args);
  }
  for (const [key, value] of Object.entries(images)) {
    if (typeof value === 'function') wrapped[key] = (...args) => images[key](...args);
    else wrapped[key] = value;
  }
  for (const method of WRITE_METHODS) {
    wrapped[method] = async (imageId, input, options) => {
      writes += 1;
      const index = writes;
      if (index === failAt && !commitThenThrow) {
        throw new Error(`injected failure at write ${index} (${method} ${input?.id})`);
      }
      const result = await images[method](imageId, input, options);
      if (index === failAt && commitThenThrow) {
        throw new Error(`injected post-commit failure at write ${index} (${method} ${input?.id})`);
      }
      return result;
    };
  }
  return {images: wrapped, writeCount: () => writes};
}

// The group compiler registry is required once the protocol installs any method *from source*:
// compiling that source to the wasm lane goes through installWasmBlockTree, which the bare
// code-compiler registry cannot serve. The Integer protocol's recovery harness already registers
// both for the same reason.
const servicesFor = (images) => new CompilationService({
  images,
  compilers: createDefaultCodeCompilerRegistry(),
  groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
});

async function installProtocols(images, compilation, imageId, lane) {
  await installSmalltalkEqualityProtocol({images, compilation, imageId, lane});
  await installSmalltalkDictionaryProtocol({images, compilation, imageId, lane});
}

async function baseImage(runtime, imageId, lane) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  await installSmalltalkAllocationProtocol({
    images: runtime.images, compilation: runtime.compilation, imageId, lane,
  });
}

async function installWriteCount(lane) {
  return await withRuntime(async (runtime) => {
    await baseImage(runtime, 'count', lane);
    const {images, writeCount} = faultingImages(runtime.images);
    await installProtocols(images, servicesFor(images), 'count', lane);
    return writeCount();
  });
}

// Enumerated rather than sampled, in both lanes, with a commit-then-throw variant that models a lost
// acknowledgement — after which the identical install must be an idempotent success.
for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write installing the ${lane} equality/Dictionary protocol`, async () => {
    const total = await installWriteCount(lane);
    assert.ok(total > 10, `expected many writes in the ${lane} lane, saw ${total}`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await withRuntime(async (runtime) => {
          await baseImage(runtime, 'app', lane);
          const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

          await assert.rejects(
            installProtocols(images, servicesFor(images), 'app', lane),
            /injected/,
            `${lane}: write ${failAt} (commitThenThrow=${commitThenThrow}) should have failed`,
          );

          await installProtocols(runtime.images, runtime.compilation, 'app', lane);
          const dictionary = await newDictionary(runtime, 'app', `retry-${lane}-${failAt}-${commitThenThrow}`);
          await evaluate(runtime, 'app', `use-${lane}-${failAt}-${commitThenThrow}`,
            "[ :d | d at: 'k' put: 1 ]", [dictionary]);
          assert.deepEqual(
            await evaluate(runtime, 'app', `read-${lane}-${failAt}-${commitThenThrow}`,
              "[ :d | d at: 'k' ]", [dictionary]),
            integerValue(1),
            `${lane}: not usable after retrying past write ${failAt}`,
          );
        });
      }
    }
  });
}
