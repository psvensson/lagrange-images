import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  OBJECT_WRITE_OPERATION,
  SHAPE_INDEXED,
  SmalltalkIndexedBoundsError,
  SmalltalkNotIndexedError,
  SmalltalkNotInstantiableError,
  SmalltalkPrimitiveLocalityError,
  assertObjectMatchesShape,
  createAuthorityService,
  createDefaultCodeCompilerRegistry,
  createObjectRecord,
  createRuntime,
  createShapeRecord,
  defineClass,
  findSmalltalkKernel,
  installCallableInterfaceV2,
  installImageMutationBinding,
  installSmalltalkAllocationProtocol,
  installSmalltalkIndexedProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  objectVersionToken,
  packCompositeValue,
  pinnedRef,
  readBehavior,
  shapeIndexedKind,
  textValue,
} from '../src/runtime.js';
import {projectObjectSlots} from '../src/callable/image-projection-binding.js';
import {referencesOfRecord} from '../src/graph/references.js';

// ADR 0047: the generic object model gets one language-neutral indexed Value part; Array is the
// first Smalltalk class built over it. The important proofs are deliberately cross-layer because a
// correct Array primitive over an incomplete graph walker would still be a corrupt object model.

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
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

async function seedSmalltalk(runtime, imageId, lane = 'neutral') {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  await installSmalltalkAllocationProtocol({
    images: runtime.images, compilation: runtime.compilation, imageId, lane,
  });
  const indexed = await installSmalltalkIndexedProtocol({
    images: runtime.images, compilation: runtime.compilation, imageId, lane,
  });
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  return {kernel, indexed};
}

// --- generic object model ---------------------------------------------------------------------

test('indexed layout is exact while pre-0047 record absence still means none', () => {
  const legacyShape = createShapeRecord({id: 'legacy', imageId: 'app', slots: []});
  assert.equal(Object.hasOwn(legacyShape, 'indexed'), false, 'reading an old Shape must not materialize a field');
  assert.equal(shapeIndexedKind(legacyShape), SHAPE_INDEXED.NONE);

  const legacyObject = createObjectRecord({
    id: 'old', imageId: 'app', shape: objectRef('app', 'legacy'), slots: {},
  });
  assert.equal(Object.hasOwn(legacyObject, 'indexed'), false, 'reading an old Object must preserve field absence');
  assert.doesNotThrow(() => assertObjectMatchesShape(legacyObject, legacyShape));

  const indexedShape = createShapeRecord({
    id: 'indexed', imageId: 'app', slots: [{id: 'name', name: 'name'}], indexed: SHAPE_INDEXED.VALUES,
  });
  const indexedObject = createObjectRecord({
    id: 'array-like', imageId: 'app', shape: objectRef('app', 'indexed'),
    slots: {name: textValue('values')},
    indexed: [integerValue(1), objectRef('app', 'target'), pinnedRef('app', 'historic', 7)],
  });
  assert.doesNotThrow(() => assertObjectMatchesShape(indexedObject, indexedShape));

  const missingIndexed = createObjectRecord({
    id: 'missing', imageId: 'app', shape: objectRef('app', 'indexed'), slots: {name: textValue('x')},
  });
  assert.throws(() => assertObjectMatchesShape(missingIndexed, indexedShape), /indexed values part is required/);

  const extraIndexed = createObjectRecord({
    id: 'extra', imageId: 'app', shape: objectRef('app', 'legacy'), slots: {}, indexed: [],
  });
  assert.throws(() => assertObjectMatchesShape(extraIndexed, legacyShape), /declares no indexed part/);
});

test('refs held only in indexed elements are first-class graph edges', () => {
  const target = objectRef('app', 'target');
  const historic = pinnedRef('app', 'historic', 9);
  const record = createObjectRecord({
    id: 'holder', imageId: 'app', shape: objectRef('app', 'indexed'), slots: {},
    indexed: [textValue('not-an-edge'), target, historic],
  });
  assert.deepEqual(referencesOfRecord(record), [record.shape, target, historic]);
});

test('image storage and history round-trip an indexed object without flattening or omission', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const shape = await runtime.images.putShape('app', {
      id: 'indexed-shape', slots: [], indexed: SHAPE_INDEXED.VALUES,
    });
    const stored = await runtime.images.putObject('app', {
      id: 'holder', shape: objectRef('app', shape.id), slots: {},
      indexed: [textValue('a'), objectRef('app', 'only-indexed-edge'), pinnedRef('app', 'old', 'r1')],
    });

    const loaded = await runtime.images.getObject('app', 'holder');
    assert.deepEqual(loaded.indexed, stored.indexed);
    const event = (await runtime.images.history('app')).find(({type, objectId}) => type === 'object.put' && objectId === 'holder');
    assert.ok(event, 'the object.put history event must exist');
    assert.deepEqual(event.object, stored, 'history clones the whole stored object, including indexed Values');
  });
});

// ADR 0039 has no indexed mapping syntax. The shared projection helper is used by the ordinary,
// versioned and resource projection lanes, so this one refusal guards all three readers.
test('named-slot projection refuses an indexed object instead of returning a partial object', () => {
  assert.throws(() => projectObjectSlots({
    object: {slots: {name: textValue('Ada')}, indexed: []},
    record: {fields: [{name: 'name', type: 'string'}]},
    mapped: new Map([['name', 'name']]),
    imageId: 'app',
    objectId: 'person',
  }), /cannot project indexed object app\/person/);
});

const MUTATION_TYPES = normalizeTypeDeclarations({
  update: {kind: 'record', fields: [{name: 'name', type: 'string'}]},
});

test('authorized named-slot mutation preserves the indexed part byte-for-byte in meaning', async () => {
  const authority = createAuthorityService();
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const shape = await runtime.images.putShape('app', {
      id: 'indexed-item', slots: [{id: 'name', name: 'name'}], indexed: SHAPE_INDEXED.VALUES,
    });
    const edge = objectRef('app', 'edge');
    const stored = await runtime.images.putObject('app', {
      id: 'item', shape: objectRef('app', shape.id), slots: {name: textValue('before')},
      indexed: [integerValue(7), edge, pinnedRef('app', 'historic', 3)],
    });
    const callableInterface = await installCallableInterfaceV2({
      images: runtime.images,
      imageId: 'app',
      interfaceId: 'update-item',
      functionName: 'update-item',
      parameters: ['string', 'string', 'update'],
      result: 'string',
      types: MUTATION_TYPES,
    });
    await installImageMutationBinding({
      images: runtime.images,
      callableInterface: objectRef('app', callableInterface.id),
      fields: [{name: 'name', slot: 'name'}],
      bindingId: 'update-binding',
      blockId: 'update-block',
    });
    const context = authority.issue({
      principal: 'alice',
      grants: [{operation: OBJECT_WRITE_OPERATION, resource: objectResource('app', 'item')}],
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', 'update-block'), [
      textValue('item'),
      textValue(objectVersionToken('app', 'item', stored._version)),
      packCompositeValue({name: 'after'}, 'update', MUTATION_TYPES),
    ]);
    await runtime.executor.execute(activation, {authority: context});

    const updated = await runtime.images.getObject('app', 'item');
    assert.deepEqual(updated.slots.name, textValue('after'));
    assert.deepEqual(updated.indexed, stored.indexed, 'mapped mutation must carry the indexed part forward');
  }, {authority});
});

// --- Smalltalk layout and Array ---------------------------------------------------------------

test('a concrete subclass cannot drop an inherited indexed declaration, even across an abstract class', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});

    const indexedShape = await runtime.images.putShape('app', {
      id: 'indexed-parent-shape', slots: [], indexed: SHAPE_INDEXED.VALUES,
    });
    const parent = await defineClass({
      images: runtime.images,
      imageId: 'app',
      name: 'IndexedParent',
      instanceShapeRef: objectRef('app', indexedShape.id),
    });
    const abstractMiddle = await defineClass({
      images: runtime.images,
      imageId: 'app',
      name: 'AbstractMiddle',
      superclassRef: parent.classRef,
    });
    const plainShape = await runtime.images.putShape('app', {id: 'plain-child-shape', slots: []});

    await assert.rejects(
      defineClass({
        images: runtime.images,
        imageId: 'app',
        name: 'BadChild',
        superclassRef: abstractMiddle.classRef,
        instanceShapeRef: objectRef('app', plainShape.id),
      }),
      /drops the inherited indexed values declaration/,
    );
  });
});

for (const lane of ['neutral', 'wasm']) {
  test(`Array fixed-size semantics execute through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const imageId = `array-${lane}`;
      const {kernel, indexed} = await seedSmalltalk(runtime, imageId, lane);
      const run = lane === 'wasm' ? evaluateThroughWasm : evaluate;

      // `new:` is an ordinary class-side send; allocation fills every element with this image's nil.
      const array = await run(runtime, imageId, `new-${lane}`, '[ :c | c new: 3 ]', [indexed.arrayClass]);
      const record = await runtime.images.getObject(imageId, array.objectId);
      assert.deepEqual(record.indexed, [kernel.nil, kernel.nil, kernel.nil]);
      assert.deepEqual(await run(runtime, imageId, `size-${lane}`, '[ :a | a size ]', [array]), integerValue(3));
      assert.deepEqual(await run(runtime, imageId, `first-${lane}`, '[ :a | a at: 1 ]', [array]), kernel.nil);

      // The Smalltalk method translates 1-based indexing to the primitive's language-neutral 0 base.
      // No authority context is supplied: indexed mutation is image-native language semantics.
      const stored = await run(
        runtime, imageId, `put-${lane}`, '[ :a :v | a at: 2 put: v ]', [array, kernel.true],
      );
      assert.deepEqual(stored, kernel.true);
      assert.deepEqual(
        await run(runtime, imageId, `read-${lane}`, '[ :a | a at: 2 ]', [array]),
        kernel.true,
      );

      // The result of at:put: feeds a further send. In the WASM case this is specifically the
      // resumable non-tail path rather than a host shortcut.
      const resultClass = await run(
        runtime,
        imageId,
        `non-tail-${lane}`,
        '[ :a :v | (a at: 2 put: v) class ]',
        [array, kernel.false],
      );
      assert.deepEqual(resultClass, objectRef(imageId, 'smalltalk/class/False'));

      // `basicNew` is the zero-length indexed form.
      const empty = await run(runtime, imageId, `empty-${lane}`, '[ :c | c basicNew ]', [indexed.arrayClass]);
      assert.deepEqual((await runtime.images.getObject(imageId, empty.objectId)).indexed, []);

      // A concrete non-indexed class and a non-instantiable class fail for different reasons.
      const plainShape = await runtime.images.putShape(imageId, {id: `plain-shape-${lane}`, slots: []});
      const plain = await defineClass({
        images: runtime.images, imageId, name: `Plain${lane}`, instanceShapeRef: objectRef(imageId, plainShape.id),
      });
      const abstract = await defineClass({images: runtime.images, imageId, name: `Abstract${lane}`});
      await assert.rejects(
        run(runtime, imageId, `plain-sized-${lane}`, '[ :c | c basicNew: 1 ]', [plain.classRef]),
        SmalltalkNotIndexedError,
      );
      await assert.rejects(
        run(runtime, imageId, `abstract-sized-${lane}`, '[ :c | c basicNew: 1 ]', [abstract.classRef]),
        SmalltalkNotInstantiableError,
      );

      // The visible Smalltalk contract is 1..size: zero and size+1 both fail, for reads and writes.
      for (const source of [
        '[ :a | a at: 0 ]',
        '[ :a | a at: 4 ]',
        '[ :a :v | a at: 0 put: v ]',
        '[ :a :v | a at: 4 put: v ]',
      ]) {
        const args = source.includes(':v') ? [array, kernel.true] : [array];
        await assert.rejects(run(runtime, imageId, `bounds-${lane}-${source.length}-${args.length}-${Math.random()}`, source, args),
          SmalltalkIndexedBoundsError);
      }

      // Equal contents do not create value equality. Arrays retain object identity, and this
      // installer deliberately adds no element-wise `=` method.
      const other = await run(runtime, imageId, `other-${lane}`, '[ :c | c new: 3 ]', [indexed.arrayClass]);
      await run(runtime, imageId, `other-put-${lane}`, '[ :a :v | a at: 2 put: v ]', [other, kernel.false]);
      assert.notEqual(array.objectId, other.objectId);
      assert.deepEqual(
        (await runtime.images.getObject(imageId, array.objectId)).indexed,
        (await runtime.images.getObject(imageId, other.objectId)).indexed,
      );
      const arrayBehavior = await readBehavior(runtime.images, indexed.arrayClass);
      const dictionary = await runtime.images.getObject(arrayBehavior.methods.imageId, arrayBehavior.methods.objectId);
      const dictionaryShape = await runtime.images.getShape(dictionary.shape.imageId, dictionary.shape.objectId);
      assert.equal(dictionaryShape.slots.some(({name}) => name === '='), false);
    });
  });
}

test('a primitive Block from another image refuses an otherwise local Array', async () => {
  await withRuntime(async (runtime) => {
    const local = await seedSmalltalk(runtime, 'local');
    const foreign = await seedSmalltalk(runtime, 'foreign');
    const array = await evaluate(runtime, 'local', 'local-array', '[ :c | c new: 1 ]', [local.indexed.arrayClass]);
    const activation = await runtime.invocations.invokeBlock(foreign.indexed.indexedSizePrimitive, [array]);
    await assert.rejects(runtime.executor.execute(activation), SmalltalkPrimitiveLocalityError);
  });
});

test('the source compiler leaves collection selectors as ordinary semantic sends', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'app',
      id: 'generic-selectors',
      source: '[ :a :v | (a at: 1 put: v) size ]',
    });
    const program = JSON.parse(installed.semanticArtifact.content.value);
    assert.equal(program.body.op, 'send');
    assert.deepEqual(program.body.message, textValue('size'));
    assert.equal(program.body.receiver.op, 'send');
    assert.deepEqual(program.body.receiver.message, textValue('at:put:'));
  });
});

// --- installer recovery -----------------------------------------------------------------------

// Same exhaustive publication proof style as ADR 0046: count the writes from a successful install,
// then fail before and after every one of them. An identical retry has to finish and produce a usable
// Array. Sampling a few checkpoints would leave exactly the create-once/rewrite seams unproven.
const INSTALL_WRITE_METHODS = ['putCodeArtifact', 'putBlock', 'putShape', 'putObject', 'putLexicalEnvironment'];

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
  for (const method of INSTALL_WRITE_METHODS) {
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

function servicesFor(images) {
  return new CompilationService({images, compilers: createDefaultCodeCompilerRegistry()});
}

async function indexedInstallWriteCount(lane) {
  return await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'count'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'count'});
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'count', lane,
    });
    const {images, writeCount} = faultingImages(runtime.images);
    await installSmalltalkIndexedProtocol({
      images, compilation: servicesFor(images), imageId: 'count', lane,
    });
    return writeCount();
  });
}

for (const lane of ['neutral', 'wasm']) {
  test(`every write installing the ${lane} indexed protocol is recoverable by an identical retry`, async () => {
    const total = await indexedInstallWriteCount(lane);
    assert.ok(total > 10, `expected a multi-record publication in the ${lane} lane, saw ${total} writes`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await withRuntime(async (runtime) => {
          await runtime.images.createImage({id: 'app'});
          await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
          await installSmalltalkAllocationProtocol({
            images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
          });
          const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

          await assert.rejects(
            installSmalltalkIndexedProtocol({images, compilation: servicesFor(images), imageId: 'app', lane}),
            /injected/,
            `${lane}: write ${failAt} (commitThenThrow=${commitThenThrow}) should fail`,
          );

          const indexed = await installSmalltalkIndexedProtocol({
            images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane,
          });
          const array = await evaluate(
            runtime,
            'app',
            `retry-${lane}-${failAt}-${commitThenThrow}`,
            '[ :c | c new: 2 ]',
            [indexed.arrayClass],
          );
          assert.equal((await runtime.images.getObject('app', array.objectId)).indexed.length, 2);
        });
      }
    }
  });
}
