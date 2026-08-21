import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
} from '../src/runtime.js';
import {defineMethodsFromSource} from '../src/language/smalltalk-instance-variables.js';
import {compileSymmetricSmalltalkSemanticBlock} from '../src/language/symmetric-smalltalk-semantic.js';
import {parseSymmetricSmalltalkBlock} from '../src/language/symmetric-smalltalk-parser.js';

// ADR 0056. The interesting asymmetry is that `true`/`false` are language-neutral Values while `nil`
// is a language-owned image object reached through an image-independent binding — so most of these
// tests are about `nil` staying out of the generic substrate.

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
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({
    ...options,
    classRef: kernel.integerClass,
    methods: [{
      selector: '+',
      program: {
        parameters: [{id: 'plus:arg', name: 'n'}],
        captures: [],
        body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
      },
    }],
  });
  return {kernel, options};
}

async function evaluate(runtime, imageId, id, source, args = [], installOptions = {}) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId, id, source, ...installOptions,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- true and false --------------------------------------------------------------------------------

test('true and false compile to canonical boolean literal Values', () => {
  for (const [source, value] of [['[ true ]', true], ['[ false ]', false]]) {
    const {program} = compileSymmetricSmalltalkSemanticBlock(source);
    assert.deepEqual(program.body, {op: 'literal', value: booleanValue(value)});
  }
  // And under v1, where the surrounding program needs mutable lexical state.
  const {program, representation} = compileSymmetricSmalltalkSemanticBlock('[ | t | t := true. t ]');
  assert.equal(representation, 'lagrange-code/v1');
  assert.match(JSON.stringify(program), /\{"kind":"boolean","value":true\}/);
});

for (const lane of ['neutral', 'wasm']) {
  test(`a boolean literal survives storing, passing and returning through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const {kernel, options} = await seed(runtime, 'app', {lane});
      const shape = objectRef('app', (await runtime.images.putShape('app', {
        id: 'flag-shape', slots: [{id: 'flag-slot', name: 'flag'}],
      })).id);
      const {defineClass} = await import('../src/runtime.js');
      const holder = await defineClass({images: runtime.images, imageId: 'app', name: 'Flag', instanceShapeRef: shape});
      await defineMethodsFromSource({
        ...options,
        classRef: holder.classRef,
        methods: [
          {selector: 'set', source: '[ flag := true. self ]'},
          {selector: 'flag', source: '[ flag ]'},
          {selector: 'pass:', source: '[ :b | b ]'},
        ],
      });

      const instance = await evaluate(runtime, 'app', `flag-${lane}`, '[ :c | (c new) set ]', [holder.classRef]);
      // Stored in a durable slot and read back: still the canonical Value, not a singleton ref.
      const record = await runtime.images.getObject('app', instance.objectId);
      assert.deepEqual(record.slots['flag-slot'], booleanValue(true), 'a slot must hold the Value');
      assert.deepEqual(
        await evaluate(runtime, 'app', `flag-read-${lane}`, '[ :o | o flag ]', [instance]),
        booleanValue(true),
      );
      assert.deepEqual(
        await evaluate(runtime, 'app', `flag-pass-${lane}`, '[ :o | o pass: true ]', [instance]),
        booleanValue(true),
      );
      void kernel;
    });
  });
}

test('sends to a boolean literal go through the ADR 0045 bridge', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // `class` reaches the singleton's class, while the Value itself is never replaced.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'lit-class', '[ true class ]'),
      objectRef('app', 'smalltalk/class/True'),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'lit-if', '[ false ifTrue: [ 1 ] ifFalse: [ 2 ] ]'),
      integerValue(2),
    );
    assert.deepEqual(await evaluate(runtime, 'app', 'lit-not', '[ true not ]'), booleanValue(false));
  });
});

test('no durable Boolean wrapper is created by using the literals', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'no-wrapper', source: '[ true ]',
    });
    const before = (await runtime.images.listRecords('app')).length;
    await runtime.executor.execute(
      await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), []),
    );
    assert.equal((await runtime.images.listRecords('app')).length, before,
      'evaluating a boolean literal must write nothing');
  });
});

// --- nil ---------------------------------------------------------------------------------------------

test('the semantic artifact for nil contains no image-specific ref', () => {
  const {program} = compileSymmetricSmalltalkSemanticBlock('[ nil ]', {
    intrinsics: {$nil: 'smalltalk/intrinsic/nil'},
  });
  assert.deepEqual(program.body, {op: 'binding', id: 'smalltalk/intrinsic/nil'});
  const json = JSON.stringify(program);
  assert.ok(!/"kind":"ref"/.test(json), 'the artifact must carry a binding id and no ref at all');
});

// The sharpest test of image-independence: one compiled artifact, two images whose nil objects are
// different records, each answering its own.
test('one compiled program answers each image its own nil', async () => {
  await withRuntime(async (runtime) => {
    for (const imageId of ['first', 'second']) await seed(runtime, imageId);
    // A second image whose nil is a *different* record, so answering the wrong one is visible.
    const answers = [];
    for (const imageId of ['first', 'second']) {
      answers.push(await evaluate(runtime, imageId, 'nil-here', '[ nil ]'));
    }
    assert.deepEqual(answers[0], objectRef('first', 'smalltalk/nil'));
    assert.deepEqual(answers[1], objectRef('second', 'smalltalk/nil'));
    assert.notDeepEqual(answers[0], answers[1], 'each image must answer its own nil');

    // And the two semantic artifacts are identical, which is what "image-independent" means.
    const artifacts = await Promise.all(['first', 'second'].map(async (imageId) =>
      (await runtime.images.getCodeArtifact(imageId, 'nil-here:semantic')).content.value));
    assert.equal(artifacts[0], artifacts[1]);
  });
});

for (const lane of ['neutral', 'wasm']) {
  test(`nil evaluates to the image kernel nil through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const {kernel} = await seed(runtime, 'app', {lane});
      assert.deepEqual(await evaluate(runtime, 'app', `nil-${lane}`, '[ nil ]'), kernel.nil);
      // And from inside a nested Block, where it arrives by the ordinary capture walk.
      assert.deepEqual(
        await evaluate(runtime, 'app', `nil-nested-${lane}`, '[ [ [ nil ] value ] value ]'),
        kernel.nil,
      );
    });
  });
}

test('a Block that does not use nil installs with no lexical environment', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const plain = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'plain-block', source: '[ 1 ]',
    });
    assert.equal(plain.block.environment, null, 'no nil means no extra record');
    assert.equal(await runtime.images.getLexicalEnvironment('app', 'plain-block:nil-environment'), null);
  });
});

// ADR 0056 decision 2a: the intrinsic environment parents the caller's rather than copying it.
test('nil composes with a caller-supplied environment by parenting it', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const callerEnvironment = await runtime.images.putLexicalEnvironment('app', {
      id: 'caller-env',
      bindings: {'caller:x': {name: 'x', value: integerValue(41)}},
    });

    const answer = await evaluate(runtime, 'app', 'nil-and-capture', '[ x ]', [], {
      captures: {x: 'caller:x'},
      environment: objectRef('app', 'caller-env'),
    });
    assert.deepEqual(answer, integerValue(41), 'the caller capture still resolves');

    // Now a Block that uses both.
    const both = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'both-block',
      source: '[ (x = 41) ifTrue: [ nil ] ifFalse: [ x ] ]',
      captures: {x: 'caller:x'},
      environment: objectRef('app', 'caller-env'),
    });
    assert.deepEqual(
      await runtime.executor.execute(
        await runtime.invocations.invokeBlock(objectRef('app', both.block.id), []),
      ),
      kernel.nil,
      'both the caller capture and nil must resolve',
    );

    // The intrinsic environment parents the caller's rather than copying its bindings.
    const intrinsic = await runtime.images.getLexicalEnvironment('app', 'both-block:nil-environment');
    assert.ok(intrinsic, 'the intrinsic environment must exist');
    assert.deepEqual(intrinsic.parent, objectRef('app', 'caller-env'));
    assert.deepEqual(Object.keys(intrinsic.bindings), ['smalltalk/intrinsic/nil'],
      'it must hold only the intrinsic, not a copy of the caller bindings');

    // And the caller's own record is untouched by the composition.
    const caller = await runtime.images.getLexicalEnvironment('app', 'caller-env');
    assert.deepEqual(caller.bindings, callerEnvironment.bindings);
    assert.equal(caller._version, callerEnvironment._version);
  });
});

test('installing a standalone Block twice converges, including its nil environment', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const options = {images: runtime.images, imageId: 'app', id: 'twice', source: '[ nil ]'};
    await installSymmetricSmalltalkBlock(options);
    const before = (await runtime.images.listRecords('app')).length;
    await installSymmetricSmalltalkBlock(options);
    assert.equal((await runtime.images.listRecords('app')).length, before, 'a repeat must write nothing new');
  });
});

test('a method using nil binds it through the ordinary capture machinery', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await defineMethodsFromSource({
      ...options,
      classRef: kernel.integerClass,
      methods: [{selector: 'nothing', source: '[ nil ]'}],
    });
    assert.deepEqual(await evaluate(runtime, 'app', 'method-nil', '[ 0 nothing ]'), kernel.nil);
  });
});

// --- reserved names ------------------------------------------------------------------------------

test('true, false and nil cannot be declared, assigned or captured', () => {
  const refusals = [
    ['[ :true | 1 ]', /cannot declare a block parameter named true/],
    ['[ :false | 1 ]', /cannot declare a block parameter named false/],
    ['[ :nil | 1 ]', /cannot declare a block parameter named nil/],
    ['[ :self | 1 ]', /cannot declare a block parameter named self/],
    ['[ | true | 1 ]', /cannot declare a temporary named true/],
    ['[ | nil | 1 ]', /cannot declare a temporary named nil/],
    ['[ | self | 1 ]', /cannot declare a temporary named self/],
    ['[ | x | true := 1 ]', /cannot assign to true/],
    ['[ | x | nil := 1 ]', /cannot assign to nil/],
    ['[ | x | self := 1 ]', /cannot assign to self/],
  ];
  for (const [source, message] of refusals) {
    assert.throws(() => parseSymmetricSmalltalkBlock(source), message, source);
  }

  // The fourth site, which source cannot reach: captures are supplied programmatically.
  for (const name of ['true', 'false', 'nil', 'self']) {
    assert.throws(
      () => compileSymmetricSmalltalkSemanticBlock('[ 1 ]', {captures: {[name]: 'some/binding'}}),
      /is a reserved word/,
      `capture named ${name}`,
    );
  }
});

test('a reserved word is a pseudo-literal, not a name, in the syntax tree', () => {
  assert.equal(parseSymmetricSmalltalkBlock('[ true ]').body.kind, 'true');
  assert.equal(parseSymmetricSmalltalkBlock('[ false ]').body.kind, 'false');
  assert.equal(parseSymmetricSmalltalkBlock('[ nil ]').body.kind, 'nil');
  assert.equal(parseSymmetricSmalltalkBlock('[ self ]').body.kind, 'self');
  // An ordinary identifier still is one, so the rule is narrow.
  assert.equal(parseSymmetricSmalltalkBlock('[ :x | x ]').body.kind, 'name');
});

test('no new lagrange-code operation or Value kind was introduced', async () => {
  const {readFileSync} = await import('node:fs');
  const ir = readFileSync(new URL('../src/execution/neutral-expression-v0.js', import.meta.url), 'utf8');
  for (const op of ["'nil'", "'true'", "'false'", "'not'", "'and'", "'or'"]) {
    assert.ok(!new RegExp(`case ${op}`).test(ir), `lagrange-code/v0 must gain no ${op} op`);
  }
  const kinds = readFileSync(new URL('../src/value/kinds.js', import.meta.url), 'utf8');
  assert.ok(!/nil/i.test(kinds), 'the Value model must gain no nil kind');
});
