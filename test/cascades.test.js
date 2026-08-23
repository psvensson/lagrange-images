import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  compileSymmetricSmalltalkBlock,
  createRuntime,
  defineClass,
  defineMethods,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkConditionProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkGlobalNamespace,
  installSmalltalkIndexedProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkIntegerProtocol,
  installSmalltalkKernel,
  installSmalltalkLibrary,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  publishSmalltalkClassGlobals,
  textValue,
} from '../src/runtime.js';
import {parseSymmetricSmalltalk} from '../src/language/symmetric-smalltalk-parser.js';
import {defineMethodsFromSource} from '../src/language/smalltalk-instance-variables.js';

// Cascades. The last open row of the roadmap's library-gap table, and deliberately surface syntax:
// `receiver m1; m2; m3` sends every message to the *receiver of the first message* — not to the
// first message's answer — and the cascade answers the first message's value. The parser keeps the
// receiver and the messages apart, and the compiler lowers that to ordinary v1 temporaries and
// sends, so lagrange-code gains no op and no selector is recognized anywhere.

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
  await installSmalltalkControlFlow(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  return {kernel, options};
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// An accumulator whose `add:` answers the *added amount* rather than the collection, like
// Smalltalk's `add:` answering its argument. That answer is what makes a cascade observable:
// without it, "the whole cascade answers the first message's value" and "every message went to the
// collection" are indistinguishable from the same sends with no cascade.
async function defineCounter({options, kernel, lane = 'neutral'}) {
  const shapeRef = await ensureSmalltalkShape(
    options.images, options.imageId,
    {id: 'cascade-test/counter-shape', slots: [{id: 'cascade-test/total-slot', name: 'total'}]},
  );
  const {classRef} = await defineClass({
    images: options.images, imageId: options.imageId, name: 'CascadeCounter', instanceShapeRef: shapeRef,
  });
  await defineMethodsFromSource({
    images: options.images,
    compilation: options.compilation,
    imageId: options.imageId,
    lane,
    classRef,
    methods: [
      // `new` is basicNew + initialize (ADR 0046), and slots start nil — so the accumulator must
      // start its own total, exactly as OrderedCollection starts its own tally.
      {selector: 'initialize', source: '[ total := 0. self ]'},
      {selector: 'total', source: '[ total ]'},
      {selector: 'add:', source: '[ :n | total := total + n. n ]'},
      {selector: 'double', source: '[ self add: total ]'},
    ],
  });
  return classRef;
}

// --- parsing -----------------------------------------------------------------------------------

test('a cascade parses to the shared receiver and one selector+arguments per message', async () => {
  const syntax = parseSymmetricSmalltalk('[ :c | c add: 1; add: 2; double ]');
  assert.equal(syntax.kind, 'block');
  const cascade = syntax.body;
  assert.equal(cascade.kind, 'cascade');
  assert.deepEqual(cascade.receiver, {kind: 'name', name: 'c'});
  assert.deepEqual(
    cascade.messages.map(({selector, arguments: args}) => [selector, args.length]),
    [['add:', 1], ['add:', 1], ['double', 0]],
  );
  // The messages keep their own arguments: the second add: really does carry 2.
  assert.deepEqual(cascade.messages[1].arguments[0], {kind: 'integer', value: '2'});
});

test('a cascade does not swallow the statement separator, and a dangling one is a syntax error', async () => {
  const sequence = parseSymmetricSmalltalk('[ | x | x := 1 + 2; + 3. x ]');
  assert.equal(sequence.body.kind, 'sequence');
  assert.equal(sequence.body.statements.length, 2);
  assert.equal(sequence.body.statements[0].kind, 'assign');
  assert.equal(sequence.body.statements[0].value.kind, 'cascade');
  assert.throws(() => parseSymmetricSmalltalk('[ 1 + 2; ]'), /expected a message after ;/);
  assert.throws(() => parseSymmetricSmalltalk('[ 1 + 2; . 4 ]'), /expected a message after ;/);
});

// --- lowering ----------------------------------------------------------------------------------

test('a cascade lowers to hidden temporaries and ordinary sends; the IR gains no op', async () => {
  const {program, representation} = compileSymmetricSmalltalkBlock('[ 3 + 4; + 100 ]');
  assert.equal(representation, 'lagrange-code/v1', 'a cascade is mutable lexical state by construction');
  const text = JSON.stringify(program);
  assert.ok(!/"op"\s*:\s*"cascade"/.test(text), 'lagrange-code must gain no cascade op');
  // Exactly the lowering: receiver once into a hidden temporary, first answer kept, first
  // message's value answered.
  assert.equal(program.temporaries.length, 2);
  const [receiver, answer] = program.temporaries.map(({id}) => id);
  assert.deepEqual(program.body.statements.map(({op}) => op), [
    'binding-write', 'binding-write', 'send', 'binding',
  ]);
  assert.equal(program.body.statements[0].id, receiver);
  assert.equal(program.body.statements[1].id, answer);
  for (const send of [program.body.statements[1].value, program.body.statements[2]]) {
    assert.deepEqual(send.receiver, {op: 'binding', id: receiver});
  }
  assert.deepEqual(program.body.statements[3], {op: 'binding', id: answer});
});

// --- semantics, neutral lane -------------------------------------------------------------------

test('every message goes to the shared receiver, and the cascade answers the first value', async () => {
  await withRuntime(async (runtime) => {
    const {options, kernel} = await seed(runtime, 'app');
    const counter = await defineCounter({options, kernel});
    const made = await evaluate(runtime, 'app', 'make', '[ :c | c new add: 3; add: 4; double ]', [counter]);
    // add: 3 answers 3 — not the collection — so the whole cascade answers 3...
    assert.deepEqual(made, integerValue(3));
    // ...and holding the cascade's value in a temporary answers the same 3.
    const held = await evaluate(runtime, 'app', 'hold', '[ :c | | x | x := (c new add: 3; add: 4; double). x ]', [counter]);
    assert.deepEqual(held, integerValue(3));
  });
});

test('the cascade receiver is the first message receiver, not its answer', async () => {
  await withRuntime(async (runtime) => {
    const {options, kernel} = await seed(runtime, 'app');
    const counter = await defineCounter({options, kernel});
    // `c new add: 3; add: 4`: if the second add: went to the first message's answer (3), this
    // would be message-not-understood on Integer. Answering 3 proves it went to the collection.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'receiver', '[ :c | c new add: 3; add: 4 ]', [counter]),
      integerValue(3),
    );
  });
});

test('the receiver expression is evaluated once', async () => {
  await withRuntime(async (runtime) => {
    const {options, kernel} = await seed(runtime, 'app');
    const counter = await defineCounter({options, kernel});
    // The receiver `c new` is a send. If the lowering replayed it per message, each add: would go
    // to a *fresh* counter totalling 10 and 100 — and `self total` afterwards would answer 0.
    // Evaluating the receiver once makes every message land on the one collection, total 110.
    assert.deepEqual(
      await evaluate(
        runtime, 'app', 'once',
        '[ :c | | x | x := (c new add: 10; add: 100). (c new add: 10; add: 100) ]', [counter],
      ),
      integerValue(10),
      'each cascade still answers its first message value',
    );
    // The discriminating read: the receiver-creating send ran once, so the probe accumulated both.
    assert.deepEqual(
      await evaluate(
        runtime, 'app', 'once-total',
        '[ :c | | probe | probe := c new. probe add: 10; add: 100. probe total ]', [counter],
      ),
      integerValue(110),
      'replaying `c new` per message would leave the probe at 0',
    );
  });
});

test('a cascade assigns its first value through :=, and unary/binary/keyword messages mix', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    await installSmalltalkIntegerProtocol(options);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'assign', '[ | x | x := 10 + 1; + 2; - 3. x ]'),
      integerValue(11),
      'x receives the first message answer (10 + 1), not the last or the receiver',
    );
  });
});

test('a cascade works inside a method and reads self', async () => {
  await withRuntime(async (runtime) => {
    const {options, kernel} = await seed(runtime, 'app');
    const counter = await defineCounter({options, kernel});
    await defineMethodsFromSource({
      images: options.images,
      compilation: options.compilation,
      imageId: options.imageId,
      classRef: counter,
      methods: [{selector: 'bump', source: '[ self add: 1; add: 2. total ]'}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'bump', '[ :c | (c new) bump ]', [counter]),
      integerValue(3),
    );
  });
});

// --- the library idiom --------------------------------------------------------------------------

test('the OrderedCollection construction idiom no longer needs a temporary', async () => {
  await withRuntime(async (runtime) => {
    const {options} = await seed(runtime, 'app');
    await installSmalltalkIndexedProtocol(options);
    await installSmalltalkIntegerProtocol(options);
    await installSmalltalkConditionProtocol(options);
    await installSmalltalkGlobalNamespace(options);
    await publishSmalltalkClassGlobals({
      images: runtime.images, imageId: 'app', names: ['Array', 'IndexOutOfRange', 'EmptyCollection'],
    });
    const library = await installSmalltalkLibrary(options);
    // Building a collection used to need `| c | c := OrderedCollection new. c add: ... c add: ...`
    // — the exact pattern `;` exists for. Every add: goes to the one collection, so the built
    // collection holds all three...
    assert.deepEqual(
      await evaluate(
        runtime, 'app', 'build',
        "[ :oc | | c | c := oc new. c add: 'a'; add: 'b'; add: 'c'. c size ]",
        [library.orderedCollection],
      ),
      integerValue(3),
    );
    // ...and the cascade itself answers the first message's value — the added element, like
    // Smalltalk's add: answering its argument — which is why `size` above is sent to `c`, never
    // cascaded: a trailing `; size` would still answer 'a'.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'first-answer', "[ :oc | oc new add: 'a'; add: 'b' ]", [library.orderedCollection]),
      textValue('a'),
    );
  });
});

// --- WASM lane -----------------------------------------------------------------------------------

test('a cascade works in the WASM lane, including across a suspension', async () => {
  await withRuntime(async (runtime) => {
    const {options, kernel} = await seed(runtime, 'app-wasm', {lane: 'wasm'});
    const counter = await defineCounter({options, kernel, lane: 'wasm'});
    assert.deepEqual(
      await evaluate(runtime, 'app-wasm', 'wasm-cascade', '[ :c | c new add: 3; add: 4; double ]', [counter]),
      integerValue(3),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app-wasm', 'wasm-mixed', '[ | x | x := 10 + 1; + 2. x ]'),
      integerValue(11),
    );
  });
});

// --- guards --------------------------------------------------------------------------------------

test('the compiler recognizes no selector', async () => {
  for (const path of ['symmetric-smalltalk-semantic.js', 'symmetric-smalltalk-parser.js']) {
    const source = readFileSync(new URL(`../src/language/${path}`, import.meta.url), 'utf8');
    assert.ok(!/'add:'|'double'|whileTrue|ifTrue/.test(source), `${path} must recognize no selector`);
  }
});
