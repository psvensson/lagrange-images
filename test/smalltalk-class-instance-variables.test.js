import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineClass,
  defineMethodsFromSource,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkClassVariableSupport,
  installSmalltalkControlFlow,
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSmalltalkSymbolProtocol,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
} from '../src/runtime.js';
import {classStateObjectId} from '../src/language/smalltalk-class-state.js';

// Class-instance variables: dynamic-self routing through the per-class companion.
//
// This is the completion proof for the class-instance-variable model whose
// representation PR #147 established but did not close. The invariant under test:
//
//   a class-side method names a class-instance slot according to its DEFINING
//   metaclass, but reads/writes the slot belonging to its DYNAMIC self class.
//
// An inherited `actionMap` therefore accesses the SubA companion when `self` is
// SubA and the SubB companion when `self` is SubB. Each proof below maps to one
// line of the required RED/GREEN list; the falsifier test deliberately breaks the
// routing and shows the isolation/inheritance proof going red.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
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
  await installSmalltalkControlFlow(options);
  await installSmalltalkDictionaryProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkSymbolProtocol(options);
  await installSmalltalkClassVariableSupport(options);
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// Build a Base/SubA/SubB hierarchy in which Base declares class-instance
// `actionMap`, Base class-side `actionMap` lazily assigns it via `createActionMap`,
// and each subclass overrides `createActionMap`. Returns the refs and companions.
async function buildHierarchy(runtime, imageId) {
  const baseMetaShape = await ensureSmalltalkShape(runtime.images, imageId, {
    id: `test/${imageId}/base-ms`, slots: [{id: 'civ-actionMap', name: 'actionMap'}],
  });
  const base = await defineClass({images: runtime.images, imageId, name: 'Base', metaclassInstanceShapeRef: baseMetaShape});
  await defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId, classRef: base.metaclassRef,
    methods: [
      {selector: 'actionMap', source: '[ ^ actionMap ifNil: [ actionMap := self createActionMap ] ]'},
      {selector: 'createActionMap', source: '[ ^ 0 ]'},
    ],
  });

  const subAMetaShape = await ensureSmalltalkShape(runtime.images, imageId, {
    id: `test/${imageId}/suba-ms`, slots: [{id: 'civ-actionMap', name: 'actionMap'}],
  });
  const subA = await defineClass({
    images: runtime.images, imageId, name: 'SubA', superclassRef: base.classRef, metaclassInstanceShapeRef: subAMetaShape,
  });
  await defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId, classRef: subA.metaclassRef,
    methods: [{selector: 'createActionMap', source: '[ ^ 111 ]'}],
  });

  const subBMetaShape = await ensureSmalltalkShape(runtime.images, imageId, {
    id: `test/${imageId}/subb-ms`, slots: [{id: 'civ-actionMap', name: 'actionMap'}],
  });
  const subB = await defineClass({
    images: runtime.images, imageId, name: 'SubB', superclassRef: base.classRef, metaclassInstanceShapeRef: subBMetaShape,
  });
  await defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId, classRef: subB.metaclassRef,
    methods: [{selector: 'createActionMap', source: '[ ^ 222 ]'}],
  });

  return {base, subA, subB};
}

// 1+2+3: base declares the slot and the lazy method; two subclasses inherit it and
// override createActionMap; each initializes and returns its own distinct value.
test('inherited class-side actionMap routes to the dynamic self class companion', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {base, subA, subB} = await buildHierarchy(runtime, 'app');

    assert.deepEqual(await evaluate(runtime, 'app', 'a1', '[ :c | c actionMap ]', [subA.classRef]), integerValue(111));
    assert.deepEqual(await evaluate(runtime, 'app', 'a2', '[ :c | c actionMap ]', [subB.classRef]), integerValue(222));
    // Subsequently: the cached per-class value is returned, not recomputed.
    assert.deepEqual(await evaluate(runtime, 'app', 'a3', '[ :c | c actionMap ]', [subA.classRef]), integerValue(111));
    assert.deepEqual(await evaluate(runtime, 'app', 'a4', '[ :c | c actionMap ]', [base.classRef]), integerValue(0));
    // Writing through Base does not disturb SubA.
    assert.deepEqual(await evaluate(runtime, 'app', 'a5', '[ :c | c actionMap ]', [subA.classRef]), integerValue(111));
  });
});

// 4: the three companions are distinct, durable objects holding the isolated values.
test('Base/SubA/SubB companions are distinct and durable with isolated values', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {base, subA, subB} = await buildHierarchy(runtime, 'app');
    await evaluate(runtime, 'app', 'b1', '[ :c | c actionMap ]', [base.classRef]);
    await evaluate(runtime, 'app', 'b2', '[ :c | c actionMap ]', [subA.classRef]);
    await evaluate(runtime, 'app', 'b3', '[ :c | c actionMap ]', [subB.classRef]);

    const baseC = await runtime.images.getObject('app', classStateObjectId('Base'));
    const subAC = await runtime.images.getObject('app', classStateObjectId('SubA'));
    const subBC = await runtime.images.getObject('app', classStateObjectId('SubB'));
    assert.ok(baseC && subAC && subBC, 'all three companions exist');
    assert.ok(baseC.id !== subAC.id && subAC.id !== subBC.id && baseC.id !== subBC.id, 'companions are distinct');
    assert.deepEqual(baseC.slots['civ-actionMap'], integerValue(0));
    assert.deepEqual(subAC.slots['civ-actionMap'], integerValue(111));
    assert.deepEqual(subBC.slots['civ-actionMap'], integerValue(222));
  });
});

// 5: an inherited method may access an inherited class-instance slot.
test('an inherited class-side method accesses an inherited class-instance slot', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {subA} = await buildHierarchy(runtime, 'app');
    // `actionMap` is defined only on Base's metaclass; SubA inherits it.
    const result = await evaluate(runtime, 'app', 'c1', '[ :c | c actionMap ]', [subA.classRef]);
    assert.deepEqual(result, integerValue(111));
  });
});

// 6: a method whose defining metaclass cannot name the slot is still refused.
test('a class-side method on a metaclass without the slot is refused', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    // Plain has NO class-instance layout; its metaclass declares no actionMap slot.
    const plain = await defineClass({images: runtime.images, imageId: 'app', name: 'Plain'});
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: plain.metaclassRef,
      // `actionMap` is unbound in this metaclass's layout, so compilation itself must refuse it.
      methods: [{selector: 'rogue', source: '[ ^ actionMap ]'}],
    }).then(
      () => { throw new Error('expected compile to refuse an undeclared class-instance slot'); },
      (error) => assert.match(String(error.message), /unbound Symmetric Smalltalk name: actionMap/),
    );
    assert.ok(kernel, 'kernel still present');
  });
});

// 7: a dynamic receiver whose class-instance layout lacks the slot is refused.
test('a subclass that narrows the class-instance layout is refused at defineClass', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await buildHierarchy(runtime, 'app');
    // A subclass supplying a metaclass shape that DROPS the inherited actionMap slot
    // must be refused by the complete-inherited-slot rule.
    const narrowShape = await ensureSmalltalkShape(runtime.images, 'app', {
      id: 'test/app/narrow-ms', slots: [{id: 'civ-other', name: 'other'}],
    });
    const {base} = await import('node:assert/strict');
    const baseClassRef = objectRef('app', 'smalltalk/class/Base');
    await assert.rejects(
      defineClass({
        images: runtime.images, imageId: 'app', name: 'Narrow', superclassRef: baseClassRef,
        metaclassInstanceShapeRef: narrowShape,
      }),
      /drops inherited slot ids/,
    );
  });
});

// 8: the companion values are durable image state — they survive the executor
// being torn down and re-entered over the same image records.
test('companion values are durable across executor re-entry over the same image', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {base, subA, subB} = await buildHierarchy(runtime, 'app');
    await evaluate(runtime, 'app', 'r1', '[ :c | c actionMap ]', [base.classRef]);
    await evaluate(runtime, 'app', 'r2', '[ :c | c actionMap ]', [subA.classRef]);
    await evaluate(runtime, 'app', 'r3', '[ :c | c actionMap ]', [subB.classRef]);

    // The companions are ordinary durable objects in the image record: a fresh
    // read of the image (not a cached in-process value) must show all three.
    for (const [name, expected] of [['Base', 0], ['SubA', 111], ['SubB', 222]]) {
      const companion = await runtime.images.getObject('app', classStateObjectId(name));
      assert.ok(companion, `${name} companion durable`);
      assert.deepEqual(companion.slots['civ-actionMap'], integerValue(expected));
    }
    // And re-sending through the (re-discovered) kernel returns the stored values.
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    assert.ok(kernel, 'kernel rediscovered');
    assert.deepEqual(await evaluate(runtime, 'app', 'r4', '[ :c | c actionMap ]', [subA.classRef]), integerValue(111));
    assert.deepEqual(await evaluate(runtime, 'app', 'r5', '[ :c | c actionMap ]', [subB.classRef]), integerValue(222));
    assert.deepEqual(await evaluate(runtime, 'app', 'r6', '[ :c | c actionMap ]', [base.classRef]), integerValue(0));
  });
});

// 9: neutral and WASM lanes agree.
test('class-instance slot read agrees across neutral and WASM lanes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {subA} = await buildHierarchy(runtime, 'app');
    const neutral = await evaluate(runtime, 'app', 'w1', '[ :c | c actionMap ]', [subA.classRef]);

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'w2', source: '[ :c | c actionMap ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images, compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'w2:tree', environment: installed.block.environment,
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), [subA.classRef]);
    const wasm = await runtime.executor.execute(activation);
    assert.deepEqual(neutral, wasm);
    assert.deepEqual(neutral, integerValue(111));
  });
});

// Replay: rediscovering an existing companion preserves its written values.
test('companion rediscovery preserves written class-instance values', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {subA} = await buildHierarchy(runtime, 'app');
    await evaluate(runtime, 'app', 'p1', '[ :c | c actionMap ]', [subA.classRef]);
    const before = await runtime.images.getObject('app', classStateObjectId('SubA'));
    assert.deepEqual(before.slots['civ-actionMap'], integerValue(111));

    // The replay contract: re-ensuring the same companion validates identity and
    // shape but MUST NOT reset the value the program already wrote.
    const subAMetaShape = await ensureSmalltalkShape(runtime.images, 'app', {
      id: 'test/app/suba-ms', slots: [{id: 'civ-actionMap', name: 'actionMap'}],
    });
    const {ensureClassStateCompanion} = await import('../src/language/smalltalk-class-state.js');
    await ensureClassStateCompanion({
      images: runtime.images, imageId: 'app', classRef: subA.classRef, classInstanceShapeRef: subAMetaShape,
    });
    const after = await runtime.images.getObject('app', classStateObjectId('SubA'));
    assert.deepEqual(after.slots['civ-actionMap'], integerValue(111), 'rediscovery preserved the written value');
    // And the value is still live through the ordinary send path.
    assert.deepEqual(await evaluate(runtime, 'app', 'p2', '[ :c | c actionMap ]', [subA.classRef]), integerValue(111));
  });
});
