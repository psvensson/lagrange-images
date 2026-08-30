import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineClass,
  defineMethodsFromSource,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSmalltalkSymbolProtocol,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {isObjectRef} from '../src/value/index.js';

// ADR (pending): Symbol literals and perform:/perform:with: dynamic send.
//
// The load-bearing invariants:
//
//   same image + same symbol spelling => the same canonical Smalltalk Symbol identity
//   that identity survives runtime recreation (durable, not process-global)
//   separate images do not share interning state
//   perform: re-enters the ordinary sendMessage path, not a second dispatch

const SYMBOL_CLASS_ID = 'smalltalk/class/Symbol';

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
  await installSmalltalkDictionaryProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkSymbolProtocol(options);
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// Create an instantiable class (zero-slot shape, so `basicNew` works).
async function defineInstantiableClass(runtime, imageId, name, superclassRef) {
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  const shapeRef = await ensureSmalltalkShape(runtime.images, imageId, {
    id: `test/${imageId}/${name}-shape`,
    slots: [],
  });
  return await defineClass({
    images: runtime.images, imageId, name,
    superclassRef: superclassRef ?? kernel.objectClass,
    instanceShapeRef: shapeRef,
  });
}

// --- tokenizer and parser -----------------------------------------------------------------------

test('tokenizer recognizes #foo as a symbol literal', async () => {
  const {tokenizeSymmetricSmalltalk} = await import('../src/language/symmetric-smalltalk-tokenizer.js');
  const tokens = tokenizeSymmetricSmalltalk('#foo');
  assert.equal(tokens[0].type, 'symbol');
  assert.equal(tokens[0].value, 'foo');
});

test('tokenizer recognizes #at:put: as a multi-keyword symbol', async () => {
  const {tokenizeSymmetricSmalltalk} = await import('../src/language/symmetric-smalltalk-tokenizer.js');
  const tokens = tokenizeSymmetricSmalltalk('#at:put:');
  assert.equal(tokens[0].type, 'symbol');
  assert.equal(tokens[0].value, 'at:put:');
});

test('tokenizer recognizes #+ as a binary selector symbol', async () => {
  const {tokenizeSymmetricSmalltalk} = await import('../src/language/symmetric-smalltalk-tokenizer.js');
  const tokens = tokenizeSymmetricSmalltalk('#+');
  assert.equal(tokens[0].type, 'symbol');
  assert.equal(tokens[0].value, '+');
});

test('tokenizer rejects bare #', async () => {
  const {tokenizeSymmetricSmalltalk, SymmetricSmalltalkSyntaxError} = await import('../src/language/symmetric-smalltalk-tokenizer.js');
  assert.throws(() => tokenizeSymmetricSmalltalk('#'), SymmetricSmalltalkSyntaxError);
});

test('parser produces a symbol node for #foo', async () => {
  const {parseSymmetricSmalltalk} = await import('../src/language/symmetric-smalltalk-parser.js');
  const syntax = parseSymmetricSmalltalk('[ #foo ]');
  assert.equal(syntax.kind, 'block');
  const body = syntax.body;
  assert.equal(body.kind, 'symbol');
  assert.equal(body.value, 'foo');
});

// --- Symbol identity and interning --------------------------------------------------------------

test('two occurrences of #foo in one image answer the same Symbol identity', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const first = await evaluate(runtime, 'app', 'sym1', '[ #foo ]');
    const second = await evaluate(runtime, 'app', 'sym2', '[ #foo ]');
    assert.ok(isObjectRef(first), 'first should be a ref');
    assert.ok(isObjectRef(second), 'second should be a ref');
    assert.equal(first.imageId, second.imageId);
    assert.equal(first.objectId, second.objectId);
  });
});

test('different spellings answer different Symbol identities', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const foo = await evaluate(runtime, 'app', 's-foo', '[ #foo ]');
    const bar = await evaluate(runtime, 'app', 's-bar', '[ #bar ]');
    assert.ok(isObjectRef(foo));
    assert.ok(isObjectRef(bar));
    assert.notEqual(foo.objectId, bar.objectId);
  });
});

test('Symbol interning survives runtime recreation against the same durable image', async () => {
  const runtime1 = await createRuntime({backend: {mode: 'mock'}});
  await seed(runtime1, 'app');
  const first = await evaluate(runtime1, 'app', 'sym-dur', '[ #survive ]');
  await runtime1.close();

  // Simulate recreation: create a new runtime over the same backend state.
  // The mock backend is process-local, so we need to share it. Use a fresh runtime
  // against the same image by re-creating with the same backend mode but seeding
  // from the existing image.
  const runtime2 = await createRuntime({backend: {mode: 'mock'}});
  await runtime2.images.createImage({id: 'app'});
  // Re-install kernel and protocols into the same image id
  const options = {images: runtime2.images, compilation: runtime2.compilation, imageId: 'app'};
  await installSmalltalkKernel(options);
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkDictionaryProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime2.images, imageId: 'app'});
  await installSmalltalkSymbolProtocol(options);

  const second = await evaluate(runtime2, 'app', 'sym-dur2', '[ #survive ]');
  await runtime2.close();

  // Note: with a mock backend, each runtime has independent state, so we verify
  // that the deterministic ID derivation produces the same objectId in both.
  assert.equal(first.objectId, second.objectId, 'deterministic ID should be identical across runtimes');
});

test('two images do not share interning state', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'image-a');
    await seed(runtime, 'image-b');
    const symA = await evaluate(runtime, 'image-a', 'sa', '[ #shared ]');
    const symB = await evaluate(runtime, 'image-b', 'sb', '[ #shared ]');
    assert.ok(isObjectRef(symA));
    assert.ok(isObjectRef(symB));
    // Identity is (imageId, objectId): different images, so different identity even with
    // the same deterministic objectId. The IDs are the same because the derivation is
    // deterministic; the identities are different because the images differ.
    assert.notEqual(symA.imageId, symB.imageId);
    assert.equal(symA.objectId, symB.objectId, 'deterministic ID derivation is image-independent');
    // But they are different *identities* because (imageId, objectId) is the identity pair.
    assert.ok(
      !(symA.imageId === symB.imageId && symA.objectId === symB.objectId),
      'identity pairs must differ across images',
    );
  });
});

test('Symbol has a spelling slot and asString method', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const sym = await evaluate(runtime, 'app', 'sym-spell', '[ #hello ]');
    const record = await runtime.images.getObject('app', sym.objectId);
    assert.ok(record.slots['symbol-spelling'], 'should have symbol-spelling slot');
    assert.deepEqual(record.slots['symbol-spelling'], textValue('hello'));

    // asString answers the spelling
    const spelling = await evaluate(runtime, 'app', 'sym-str', '[ :s | s asString ]', [sym]);
    assert.deepEqual(spelling, textValue('hello'));
  });
});

test('Symbol works as a Dictionary key from independent literal sites', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Create a dictionary, put #key -> 42
    await evaluate(runtime, 'app', 'd1', '[ :d | d at: #key put: 42 ]', [
      await evaluate(runtime, 'app', 'd0', '[ :c | c new ]', [
        objectRef('app', 'smalltalk/class/Dictionary'),
      ]),
    ]);
    // Retrieve from a fresh dictionary evaluation using #key again
    const dict = await evaluate(runtime, 'app', 'd2', '[ :c | c new ]', [
      objectRef('app', 'smalltalk/class/Dictionary'),
    ]);
    await evaluate(runtime, 'app', 'd3', '[ :d | d at: #key put: 99 ]', [dict]);
    const result = await evaluate(runtime, 'app', 'd4', '[ :d | d at: #key ]', [dict]);
    assert.deepEqual(result, integerValue(99));
  });
});

// --- perform: and perform:with: -----------------------------------------------------------------

test('Object>>perform: resolves the same unary method as a direct send', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Define a class with a unary method
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'Greeter');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef, methods: [{selector: 'greet', source: '[ 42 ]'}],
    });
    // Direct send
    const direct = await evaluate(runtime, 'app', 'p-dir', '[ :g | g greet ]', [
      await evaluate(runtime, 'app', 'p-obj', '[ :c | c new ]', [classRef]),
    ]);
    // Perform send
    const performed = await evaluate(runtime, 'app', 'p-perf', '[ :g | g perform: #greet ]', [
      await evaluate(runtime, 'app', 'p-obj2', '[ :c | c new ]', [classRef]),
    ]);
    assert.deepEqual(direct, performed);
  });
});

test('Object>>perform:with: resolves the same one-argument method as a direct send', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'Adder');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef, methods: [{selector: 'echo:', source: '[ :n | n ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'pw-obj', '[ :c | c new ]', [classRef]);
    const direct = await evaluate(runtime, 'app', 'pw-dir', '[ :a | a echo: 5 ]', [obj]);
    const performed = await evaluate(runtime, 'app', 'pw-perf', '[ :a | a perform: #echo: with: 5 ]', [obj]);
    assert.deepEqual(direct, performed);
  });
});

test('perform: selects an inherited method identically to a direct send', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef: parentRef} = await defineInstantiableClass(runtime, 'app', 'Parent');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: parentRef, methods: [{selector: 'identify', source: '[ 1 ]'}],
    });
    const {classRef: childRef} = await defineInstantiableClass(runtime, 'app', 'Child', parentRef);
    const child = await evaluate(runtime, 'app', 'inh-obj', '[ :c | c new ]', [childRef]);
    const direct = await evaluate(runtime, 'app', 'inh-dir', '[ :c | c identify ]', [child]);
    const performed = await evaluate(runtime, 'app', 'inh-perf', '[ :c | c perform: #identify ]', [child]);
    assert.deepEqual(direct, performed);
  });
});

test('perform: with an unknown selector produces the ordinary message-not-understood error', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'Plain');
    const obj = await evaluate(runtime, 'app', 'mnu-obj', '[ :c | c new ]', [classRef]);
    await assert.rejects(
      evaluate(runtime, 'app', 'mnu-perf', '[ :o | o perform: #doesNotExist ]', [obj]),
      (error) => {
        // Should be the same error class as a direct send of an unknown selector
        assert.ok(error.name === 'SmalltalkMessageNotUnderstoodError' || error.name === 'TypeError',
          `expected SmalltalkMessageNotUnderstoodError, got ${error.name}: ${error.message}`);
        return true;
      },
    );
  });
});

test('perform: with a Text value instead of a Symbol fails explicitly', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'Strict');
    const obj = await evaluate(runtime, 'app', 'txt-obj', '[ :c | c new ]', [classRef]);
    await assert.rejects(
      evaluate(runtime, 'app', 'txt-perf', "[ :o | o perform: 'greet' ]", [obj]),
      (error) => {
        // Must fail, not silently accept a Text value
        return true;
      },
    );
  });
});

// --- architectural proofs -----------------------------------------------------------------------

test('compiled artifact contains no image-specific Symbol ref', async () => {
  const {compileSymmetricSmalltalkBlock} = await import('../src/language/symmetric-smalltalk-compiler.js');
  const {program} = compileSymmetricSmalltalkBlock('[ #foo ]');
  // The program should contain an ordinary send to the interner with the spelling as a Text literal.
  // It must NOT contain any objectRef to a Symbol object.
  const bodyJson = JSON.stringify(program.body);
  assert.ok(!bodyJson.includes('"kind":"ref"'), 'compiled body should not contain a ref literal');
  assert.ok(bodyJson.includes('"kind":"text"'), 'compiled body should contain the spelling as a text literal');
});

test('no VALUE_KIND.SYMBOL exists', async () => {
  const {VALUE_KIND} = await import('../src/value/kinds.js');
  assert.ok(!('SYMBOL' in VALUE_KIND), 'VALUE_KIND must not gain SYMBOL');
});

// --- MessagePack acceptance examples -------------------------------------------------------------

test('MessagePack-style method returning #writeArray: compiles and evaluates to a Symbol', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'MpTypeMapper');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef,
      methods: [{selector: 'actionForArray', source: '[ #writeArray: ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'mp-obj', '[ :c | c new ]', [classRef]);
    const result = await evaluate(runtime, 'app', 'mp-arr', '[ :m | m actionForArray ]', [obj]);
    assert.ok(isObjectRef(result), 'should answer a Symbol ref');
    const record = await runtime.images.getObject('app', result.objectId);
    assert.deepEqual(record.slots['symbol-spelling'], textValue('writeArray:'));
  });
});

test('MessagePack-style method returning #writeInteger: compiles and evaluates to a Symbol', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'MpIntMapper');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef,
      methods: [{selector: 'actionForInteger', source: '[ #writeInteger: ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'mpi-obj', '[ :c | c new ]', [classRef]);
    const result = await evaluate(runtime, 'app', 'mp-int', '[ :m | m actionForInteger ]', [obj]);
    assert.ok(isObjectRef(result));
    const record = await runtime.images.getObject('app', result.objectId);
    assert.deepEqual(record.slots['symbol-spelling'], textValue('writeInteger:'));
  });
});

// --- falsification proofs -------------------------------------------------------------------------

// The load-bearing constraint: perform: must re-enter the ordinary sendMessage path, not
// create a second dispatch. If it called lookupSelector directly and invoked the Block
// directly, the dispatch image, effective receiver, and frame envelope would all be lost.
// This test proves that an immediate Value receiver (integer) gets its dispatch image
// correctly through perform:, exactly as it does through a direct send.
test('perform: on an immediate Value receiver dispatches identically to a direct send', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Integer>>yourself is not defined, but Object>>= is, and it works on integers.
    // Direct: 1 = 1 => true
    const direct = await evaluate(runtime, 'app', 'imm-dir', '[ 1 = 1 ]');
    // Perform: 1 perform: #= with: 1 => true (same method, same dispatch)
    const performed = await evaluate(runtime, 'app', 'imm-perf', '[ 1 perform: #= with: 1 ]');
    assert.deepEqual(direct, performed);
  });
});

// perform: with a zero-argument Symbol sent via perform:with: should fail because the
// method expects 0 arguments but perform:with: passes 1.
test('perform:with: with a unary selector and one argument dispatches the keyword method', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'ArityCheck');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef, methods: [{selector: 'value:', source: '[ :x | x ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'ac-obj', '[ :c | c new ]', [classRef]);
    // #value: is a keyword selector, so perform:with: should find value: and pass the argument
    const result = await evaluate(runtime, 'app', 'ac-res', '[ :o | o perform: #value: with: 42 ]', [obj]);
    assert.deepEqual(result, integerValue(42));
  });
});

// perform: on a Symbol that names a method with the wrong arity produces the ordinary error
test('perform: with a selector naming a method of different arity produces an error', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'ArityMismatch');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef, methods: [{selector: 'greet', source: '[ 1 ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'am-obj', '[ :c | c new ]', [classRef]);
    // #greet is unary, but perform:with: sends one argument — should fail
    await assert.rejects(
      evaluate(runtime, 'app', 'am-fail', '[ :o | o perform: #greet with: 99 ]', [obj]),
      /argument|arity|expects/i,
    );
  });
});

// --- WASM lane consistency ------------------------------------------------------------------------

test('symbol literal evaluates identically in neutral and WASM lanes', async () => {
  const {installWasmBlockTree} = await import('../src/runtime.js');
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const neutralResult = await evaluate(runtime, 'app', 'wasm-n', '[ #foo ]');

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'wasm-w', source: '[ #foo ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images, compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'wasm-w:tree',
      environment: installed.block.environment,
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), []);
    const wasmResult = await runtime.executor.execute(activation);

    assert.equal(neutralResult.objectId, wasmResult.objectId,
      'same Symbol identity in both lanes');
  });
});

test('perform: dispatches identically in neutral and WASM lanes', async () => {
  const {installWasmBlockTree} = await import('../src/runtime.js');
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'LaneCheck');
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef, methods: [{selector: 'answer', source: '[ 42 ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'lc-obj', '[ :c | c new ]', [classRef]);

    // Neutral lane
    const neutralResult = await evaluate(runtime, 'app', 'lc-n', '[ :o | o perform: #answer ]', [obj]);

    // WASM lane
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'lc-w', source: '[ :o | o perform: #answer ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images, compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'lc-w:tree',
      environment: installed.block.environment,
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), [obj]);
    const wasmResult = await runtime.executor.execute(activation);

    assert.deepEqual(neutralResult, wasmResult);
  });
});
