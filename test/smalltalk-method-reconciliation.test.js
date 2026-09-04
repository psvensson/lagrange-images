import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SmalltalkMethodRedefinitionError,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  methodBlockRef,
  objectRef,
  readBehavior,
  reconcileMethods,
} from '../src/runtime.js';

const method = (answer) => ({
  selector: 'reconciledValue',
  program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(answer)}},
});

async function withFixture(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const options = {
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: kernel.integerClass,
      lane: 'wasm',
    };
    await defineMethods({...options, methods: [method(1)]});
    return await body(runtime, kernel, options);
  } finally {
    await runtime.close();
  }
}

async function execute(runtime, selector, id) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: 'app', id, source: `[ :receiver | receiver ${selector} ]`,
  });
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(
    objectRef('app', installed.block.id), [integerValue(0)],
  ));
}

async function dictionaryRecord(runtime, classRef) {
  const behavior = await readBehavior(runtime.images, classRef);
  return await runtime.images.getObject(behavior.methods.imageId, behavior.methods.objectId);
}

test('native method owner advances A to immutable B once; A and B replays are authoritative-write-free', async () => {
  await withFixture(async (runtime, kernel, options) => {
    const classRef = kernel.integerClass;
    const blockARef = await methodBlockRef({...options, selector: 'reconciledValue'});
    const blockA = await runtime.images.getBlock(blockARef.imageId, blockARef.objectId);
    const semanticA = await runtime.images.getCodeArtifact('app', `${blockA.id}:semantic`);
    const dictionaryA = await dictionaryRecord(runtime, classRef);
    assert.deepEqual(await execute(runtime, 'reconciledValue', 'execute-a'), integerValue(1));

    const historyA = await runtime.images.history('app');
    await reconcileMethods({...options, methods: [method(1)]});
    assert.equal((await runtime.images.history('app')).length, historyA.length);
    assert.deepEqual(await methodBlockRef({...options, selector: 'reconciledValue'}), blockARef);
    assert.equal((await dictionaryRecord(runtime, classRef))._version, dictionaryA._version);

    await reconcileMethods({...options, methods: [method(2)]});
    const blockBRef = await methodBlockRef({...options, selector: 'reconciledValue'});
    const blockB = await runtime.images.getBlock(blockBRef.imageId, blockBRef.objectId);
    const semanticB = await runtime.images.getCodeArtifact('app', `${blockB.id}:semantic`);
    const dictionaryB = await dictionaryRecord(runtime, classRef);
    assert.deepEqual(classRef, kernel.integerClass);
    assert.notDeepEqual(blockBRef, blockARef, 'B is a new immutable native Block revision');
    assert.notEqual(semanticB.id, semanticA.id, 'B is a new immutable semantic artifact revision');
    assert.notDeepEqual(blockB.code, blockA.code, 'B is a new derived executable artifact');
    assert.equal(dictionaryB._version, dictionaryA._version + 1, 'only the current selector binding advances');
    assert.ok(await runtime.images.getBlock(blockARef.imageId, blockARef.objectId), 'immutable A remains present');
    assert.ok(await runtime.images.getCodeArtifact('app', semanticA.id), 'immutable A semantics remain present');
    assert.deepEqual(await execute(runtime, 'reconciledValue', 'execute-b'), integerValue(2));

    const historyB = await runtime.images.history('app');
    await reconcileMethods({...options, methods: [method(2)]});
    assert.equal((await runtime.images.history('app')).length, historyB.length);
    assert.deepEqual(await methodBlockRef({...options, selector: 'reconciledValue'}), blockBRef);
    assert.equal((await dictionaryRecord(runtime, classRef))._version, dictionaryB._version);
  });
});

test('concurrent identical native method revisions converge on the winning dictionary CAS', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const reconcileB = () => reconcileMethods({...options, methods: [method(2)]});
    const putObject = runtime.images.putObject.bind(runtime.images);
    let winner = null;
    runtime.images.putObject = async (imageId, input, writeOptions) => {
      if (winner === null && input.id === `${options.classRef.objectId}/methods`
        && writeOptions?.expectedVersion !== undefined) {
        runtime.images.putObject = putObject;
        winner = await reconcileB();
      }
      return await putObject(imageId, input, writeOptions);
    };

    const loserResult = await reconcileB();
    runtime.images.putObject = putObject;
    assert.ok(winner, 'the identical contender won between validation and publication');
    assert.deepEqual(loserResult, winner, 'the stale contender adopted the complete semantic winner');
    assert.deepEqual(await execute(runtime, 'reconciledValue', 'execute-identical-winner'), integerValue(2));
    // Boundary falsifier: deleting the class-builder VersionConflictError translation makes the
    // stale outer CAS escape raw here instead of reaching these assertions.
    for (const record of (await runtime.images.listRecords('app')).filter(({id}) => id.includes('/revision/'))) {
      assert.equal(record._version, 1, `${record.kind} ${record.id} was admitted exactly once`);
    }
  });
});

test('a divergent native method revision winner is never overwritten and no backend conflict escapes', async () => {
  await withFixture(async (runtime, _kernel, options) => {
    const putObject = runtime.images.putObject.bind(runtime.images);
    let winner = null;
    runtime.images.putObject = async (imageId, input, writeOptions) => {
      if (winner === null && input.id === `${options.classRef.objectId}/methods`
        && writeOptions?.expectedVersion !== undefined) {
        runtime.images.putObject = putObject;
        winner = await reconcileMethods({...options, methods: [method(3)]});
      }
      return await putObject(imageId, input, writeOptions);
    };

    const error = await reconcileMethods({...options, methods: [method(2)]}).then(() => null, (cause) => cause);
    runtime.images.putObject = putObject;
    assert.ok(winner, 'C won between B validation and publication');
    assert.ok(error instanceof SmalltalkMethodRedefinitionError);
    assert.notEqual(error?.name, 'VersionConflictError');
    assert.equal(error?.cause, undefined, 'the backend conflict is not exposed as a cause');
    assert.deepEqual(await execute(runtime, 'reconciledValue', 'execute-divergent-winner'), integerValue(3));
    const winnerRef = await methodBlockRef({...options, selector: 'reconciledValue'});
    assert.deepEqual(await methodBlockRef({...options, selector: 'reconciledValue'}), winnerRef);
    assert.equal((await dictionaryRecord(runtime, options.classRef))._version, 3,
      'A and C each moved the dictionary once; losing B did not overwrite C');
  });
});
