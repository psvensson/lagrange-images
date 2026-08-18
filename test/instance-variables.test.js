import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineClass,
  defineMethods,
  defineMethodsFromSource,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmBlockTree,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {compileSymmetricSmalltalkMethod} from '../src/language/smalltalk-instance-variables.js';
import {SYMMETRIC_SMALLTALK_ID} from '../src/language/symmetric-smalltalk.js';

// ADR 0050. Three concerns, and the tests are grouped by which one they hold:
//
//   binding      a name becomes a stable slot id, in the defining class
//   permission   a method may name only what its defining Behavior's visible layout declares
//   identity     the target must be this activation's own self, proved rather than trusted

const READ_PRIMITIVE = 'smalltalk/primitive/instance-slot-read';

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
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  const {installSmalltalkIndexedProtocol} = await import('../src/runtime.js');
  await installSmalltalkIndexedProtocol(options);
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  await defineMethods({...options, classRef: kernel.integerClass, methods: [PLUS]});
  return kernel;
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

const shapeWith = (runtime, imageId, id, slots) =>
  runtime.images.putShape(imageId, {id, slots}).then((shape) => objectRef(imageId, shape.id));

async function pointClass(runtime, imageId, {lane = 'neutral'} = {}) {
  const shape = await shapeWith(runtime, imageId, 'point-shape', [
    {id: 'point-x', name: 'x'}, {id: 'point-y', name: 'y'},
  ]);
  const point = await defineClass({images: runtime.images, imageId, name: 'Point', instanceShapeRef: shape});
  await defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId, lane, classRef: point.classRef,
    methods: [
      {selector: 'x', source: '[ x ]'},
      {selector: 'y', source: '[ y ]'},
      {selector: 'setX:', source: '[ :v | x := v ]'},
      {selector: 'bump', source: '[ x := x + 1 ]'},
    ],
  });
  return point;
}

const newInstance = (runtime, imageId, id, classRef) =>
  evaluate(runtime, imageId, id, '[ :c | c basicNew ]', [classRef]);

// --- binding -------------------------------------------------------------------------------------

test('a method carries the stable slot id, never the source name', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const compiled = await compileSymmetricSmalltalkMethod({
      images: runtime.images, imageId: 'app', classRef: point.classRef, selector: 'x', source: '[ x ]',
    });
    const encoded = JSON.stringify(compiled.program);
    assert.match(encoded, /point-x/, 'the stable slot id is in the semantic program');
    assert.doesNotMatch(encoded, /"value":"x"/, 'the source name is not');
    assert.deepEqual(compiled.instanceVariables, {x: 'point-x', y: 'point-y'});
  });
});

test('a Block still compiles with no class in sight', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // The class-independent entry point is untouched; a free name is still unbound.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'plain', '[ :a :b | a + b ]', [integerValue(1), integerValue(2)]),
      integerValue(3),
    );
    await assert.rejects(
      installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'app', id: 'free', source: '[ x ]'}),
      /unbound Symmetric Smalltalk name: x/,
    );
  });
});

test('a lexical binding shadows an instance variable, and keeps its write legality', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const options = {
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: point.classRef,
    };

    // A parameter named x shadows the instance variable for reads.
    await defineMethodsFromSource({...options, methods: [{selector: 'echo:', source: '[ :x | x ]'}]});
    const instance = await newInstance(runtime, 'app', 'shadow-instance', point.classRef);
    await evaluate(runtime, 'app', 'set', '[ :o | o setX: 1 ]', [instance]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'echo', '[ :o | o echo: 99 ]', [instance]),
      integerValue(99),
      'the parameter wins, not the slot',
    );

    // And for writes: assignment must stay illegal rather than falling through to the slot.
    await assert.rejects(
      defineMethodsFromSource({...options, methods: [{selector: 'bad:', source: '[ :x | x := 5 ]'}]}),
      /cannot assign to parameter x/,
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'unchanged', '[ :o | o x ]', [instance]),
      integerValue(1),
      'and nothing was written',
    );
  });
});

test('an unbound name is still an unbound name', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    await assert.rejects(
      defineMethodsFromSource({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: point.classRef,
        methods: [{selector: 'nope', source: '[ zzz ]'}],
      }),
      /unbound Symmetric Smalltalk name: zzz/,
    );
  });
});

// --- read and write ------------------------------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`instance variables read and write through the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const kernel = await seed(runtime, 'app', {lane});
      const point = await pointClass(runtime, 'app', {lane});
      const instance = await newInstance(runtime, 'app', `p-${lane}`, point.classRef);

      assert.deepEqual(await evaluate(runtime, 'app', `fresh-${lane}`, '[ :o | o x ]', [instance]), kernel.nil);
      assert.deepEqual(await evaluate(runtime, 'app', `set-${lane}`, '[ :o | o setX: 5 ]', [instance]), integerValue(5));
      assert.deepEqual(await evaluate(runtime, 'app', `read-${lane}`, '[ :o | o x ]', [instance]), integerValue(5));
      // read-modify-write through the slot
      await evaluate(runtime, 'app', `bump-${lane}`, '[ :o | o bump ]', [instance]);
      assert.deepEqual(await evaluate(runtime, 'app', `after-${lane}`, '[ :o | o x ]', [instance]), integerValue(6));
    });
  });
}

test('a write replaces one slot and preserves everything else', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'preserve', point.classRef);
    const before = await runtime.images.getObject('app', instance.objectId);

    await evaluate(runtime, 'app', 'write', '[ :o | o setX: 7 ]', [instance]);
    const after = await runtime.images.getObject('app', instance.objectId);

    assert.deepEqual(after.slots['point-x'], integerValue(7));
    assert.deepEqual(after.slots['point-y'], kernel.nil, 'the other slot survives');
    assert.deepEqual(after.shape, before.shape);
    assert.deepEqual(after.behavior, before.behavior);
    assert.deepEqual(after.metadata, before.metadata);
    assert.equal(after.id, before.id, 'identity is unchanged');
  });
});

// The indexed part is called out because ADR 0047's review found the mutation binding erasing one.
test('a write preserves an indexed part', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'boxed-shape', slots: [{id: 'label-slot', name: 'label'}], indexed: 'values',
    })).id);
    const boxed = await defineClass({images: runtime.images, imageId: 'app', name: 'Boxed', instanceShapeRef: shape});
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: boxed.classRef,
      methods: [{selector: 'label:', source: '[ :v | label := v ]'}],
    });
    const instance = await evaluate(runtime, 'app', 'boxed', '[ :c | c basicNew: 3 ]', [boxed.classRef]);
    const before = await runtime.images.getObject('app', instance.objectId);

    await evaluate(runtime, 'app', 'label', "[ :o | o label: 'hi' ]", [instance]);
    const after = await runtime.images.getObject('app', instance.objectId);
    assert.deepEqual(after.indexed, before.indexed, 'the indexed part must survive a named-slot write');
    assert.deepEqual(after.slots['label-slot'], textValue('hi'));
  });
});

// --- inheritance and renaming --------------------------------------------------------------------

async function parentChild(runtime, imageId) {
  const parentShape = await shapeWith(runtime, imageId, 'parent-shape', [{id: 'p-slot', name: 'p'}]);
  const childShape = await shapeWith(runtime, imageId, 'child-shape', [
    {id: 'p-slot', name: 'p'}, {id: 'secret-slot', name: 'secret'},
  ]);
  const parent = await defineClass({images: runtime.images, imageId, name: 'Parent', instanceShapeRef: parentShape});
  const child = await defineClass({
    images: runtime.images, imageId, name: 'Child', superclassRef: parent.classRef, instanceShapeRef: childShape,
  });
  const options = {images: runtime.images, compilation: runtime.compilation, imageId};
  await defineMethodsFromSource({
    ...options, classRef: parent.classRef,
    methods: [{selector: 'p', source: '[ p ]'}, {selector: 'setP:', source: '[ :v | p := v ]'}],
  });
  await defineMethodsFromSource({
    ...options, classRef: child.classRef,
    methods: [{selector: 'secret', source: '[ secret ]'}, {selector: 'setSecret:', source: '[ :v | secret := v ]'}],
  });
  return {parent, child};
}

test('a superclass method reads and writes an inherited slot of a subclass instance', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {child} = await parentChild(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'child', child.classRef);

    await evaluate(runtime, 'app', 'set-p', '[ :o | o setP: 3 ]', [instance]);
    assert.deepEqual(await evaluate(runtime, 'app', 'get-p', '[ :o | o p ]', [instance]), integerValue(3));
    // and the subclass reaches both its own and the inherited slot
    await evaluate(runtime, 'app', 'set-s', '[ :o | o setSecret: 9 ]', [instance]);
    assert.deepEqual(await evaluate(runtime, 'app', 'get-s', '[ :o | o secret ]', [instance]), integerValue(9));
    assert.deepEqual(await evaluate(runtime, 'app', 'still-p', '[ :o | o p ]', [instance]), integerValue(3));
  });
});

// ADR 0050 decision 5 as corrected: a nil layout declares nothing of its own and cancels nothing
// above it, because its methods are still inherited by concrete descendants.
test('an abstract intermediate class may name an ancestor-declared slot', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const baseShape = await shapeWith(runtime, 'app', 'base-shape', [{id: 'a-slot', name: 'a'}]);
    const base = await defineClass({images: runtime.images, imageId: 'app', name: 'Base', instanceShapeRef: baseShape});
    // Middle declares no layout of its own.
    const middle = await defineClass({images: runtime.images, imageId: 'app', name: 'Middle', superclassRef: base.classRef});
    const leafShape = await shapeWith(runtime, 'app', 'leaf-shape', [
      {id: 'a-slot', name: 'a'}, {id: 'c-slot', name: 'c'},
    ]);
    const leaf = await defineClass({
      images: runtime.images, imageId: 'app', name: 'Leaf', superclassRef: middle.classRef, instanceShapeRef: leafShape,
    });
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app'};

    await defineMethodsFromSource({
      ...options, classRef: middle.classRef, methods: [{selector: 'setA:', source: '[ :v | a := v ]'}],
    });
    await defineMethodsFromSource({
      ...options, classRef: leaf.classRef, methods: [{selector: 'a', source: '[ a ]'}],
    });

    const instance = await newInstance(runtime, 'app', 'leaf', leaf.classRef);
    await evaluate(runtime, 'app', 'set-a', '[ :o | o setA: 4 ]', [instance]);
    assert.deepEqual(await evaluate(runtime, 'app', 'get-a', '[ :o | o a ]', [instance]), integerValue(4));

    // But the abstract class still cannot name a descendant-private slot.
    await assert.rejects(
      defineMethodsFromSource({...options, classRef: middle.classRef, methods: [{selector: 'peek', source: '[ c ]'}]}),
      /unbound Symmetric Smalltalk name: c/,
    );
  });
});

test('a class with no layout and no ancestor layout can name nothing', async () => {
  await withRuntime(async (runtime) => {
    const kernel = await seed(runtime, 'app');
    await assert.rejects(
      defineMethodsFromSource({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: kernel.objectClass, methods: [{selector: 'nope', source: '[ anything ]'}],
      }),
      /unbound Symmetric Smalltalk name: anything/,
    );
  });
});

// Binding to the id rather than the name is what makes this work.
test('renaming a slot while preserving its id keeps compiled methods working', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'renamed', point.classRef);
    await evaluate(runtime, 'app', 'set', '[ :o | o setX: 11 ]', [instance]);

    // Same slot id, new source name. Shapes are immutable, so this is a new Shape identity.
    const renamed = await shapeWith(runtime, 'app', 'point-shape-v2', [
      {id: 'point-x', name: 'abscissa'}, {id: 'point-y', name: 'y'},
    ]);
    const classRecord = await runtime.images.getObject('app', point.classRef.objectId);
    await runtime.images.putObject('app', {
      id: classRecord.id,
      shape: classRecord.shape,
      behavior: classRecord.behavior,
      slots: {...classRecord.slots, 'behavior-instance-shape': renamed},
      metadata: classRecord.metadata,
    }, {expectedVersion: classRecord._version});
    const record = await runtime.images.getObject('app', instance.objectId);
    await runtime.images.putObject('app', {
      id: record.id, shape: renamed, behavior: record.behavior, slots: record.slots, metadata: record.metadata,
    }, {expectedVersion: record._version});

    assert.deepEqual(
      await evaluate(runtime, 'app', 'after-rename', '[ :o | o x ]', [instance]),
      integerValue(11),
      'the compiled method still reaches the same state',
    );
    // New source resolves against the new name.
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: point.classRef,
      methods: [{selector: 'abscissa', source: '[ abscissa ]'}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'new-name', '[ :o | o abscissa ]', [instance]),
      integerValue(11),
    );
  });
});

test('a slot id absent from the current shape fails structurally', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'stale', point.classRef);

    // The instance is migrated to a layout that no longer declares point-x.
    const narrowed = await shapeWith(runtime, 'app', 'narrow-shape', [{id: 'point-y', name: 'y'}]);
    const record = await runtime.images.getObject('app', instance.objectId);
    await runtime.images.putObject('app', {
      id: record.id,
      shape: narrowed,
      behavior: record.behavior,
      slots: {'point-y': record.slots['point-y']},
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    await assert.rejects(
      evaluate(runtime, 'app', 'gone', '[ :o | o x ]', [instance]),
      (error) => error.name === 'SmalltalkSlotAccessError' && /absent from the current shape/.test(error.message),
      'never nil, never message-not-understood, never a new slot',
    );
  });
});

// --- permission and identity, adversarially --------------------------------------------------------

// A method is ordinary durable data, so the compiler's output is not the only input the runtime sees.
async function forgedMethod({runtime, imageId, classRef, selector, target, slotId}) {
  const read = objectRef(imageId, READ_PRIMITIVE);
  await defineMethods({
    images: runtime.images, compilation: runtime.compilation, imageId, classRef,
    methods: [{
      selector,
      program: {
        parameters: target === 'argument' ? [{id: `${selector}:0`, name: 'other'}] : [],
        captures: [{id: READ_PRIMITIVE, name: 'prim'}],
        body: {
          op: 'send',
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: {op: 'binding', id: READ_PRIMITIVE},
          message: textValue('value:value:'),
          arguments: [
            target === 'argument' ? {op: 'argument', index: 0} : {op: 'receiver'},
            {op: 'literal', value: textValue(slotId)},
          ],
        },
      },
      captures: [{id: READ_PRIMITIVE, name: 'prim', value: read}],
    }],
  });
}

test('a forged method cannot read a slot from another object of the same class', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {parent, child} = await parentChild(runtime, 'app');
    await forgedMethod({runtime, imageId: 'app', classRef: parent.classRef, selector: 'spy:', target: 'argument', slotId: 'p-slot'});

    const mine = await newInstance(runtime, 'app', 'mine', child.classRef);
    const theirs = await newInstance(runtime, 'app', 'theirs', child.classRef);
    await evaluate(runtime, 'app', 'seed-theirs', '[ :o | o setP: 77 ]', [theirs]);

    await assert.rejects(
      evaluate(runtime, 'app', 'spy', '[ :o :x | o spy: x ]', [mine, theirs]),
      (error) => error.name === 'SmalltalkSlotAccessError' && /own self/.test(error.message),
      'same class, real slot, genuinely present — and still refused',
    );
  });
});

// Self-only is necessary and not sufficient: this passes both the receiver and the layout check.
test('a Parent method cannot name a Child-private slot even on a Child instance', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {parent, child} = await parentChild(runtime, 'app');
    await forgedMethod({runtime, imageId: 'app', classRef: parent.classRef, selector: 'peek', target: 'self', slotId: 'secret-slot'});

    const instance = await newInstance(runtime, 'app', 'child', child.classRef);
    await evaluate(runtime, 'app', 'seed-secret', '[ :o | o setSecret: 5 ]', [instance]);

    await assert.rejects(
      evaluate(runtime, 'app', 'peek', '[ :o | o peek ]', [instance]),
      (error) => error.name === 'SmalltalkSlotAccessError' && /not declared by/.test(error.message),
    );
    // The same method reading a Parent-declared slot is fine, which is what makes this a scope check
    // rather than a blanket refusal.
    assert.deepEqual(await evaluate(runtime, 'app', 'p-ok', '[ :o | o p ]', [instance]), integerValue(5) && await evaluate(runtime, 'app', 'p-ok2', '[ :o | o p ]', [instance]));
  });
});

test('a forged write is refused on the same terms as a forged read', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {parent, child} = await parentChild(runtime, 'app');
    const write = objectRef('app', 'smalltalk/primitive/instance-slot-write');
    await defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: parent.classRef,
      methods: [{
        selector: 'poke:',
        program: {
          parameters: [{id: 'poke:0', name: 'other'}],
          captures: [{id: write.objectId, name: 'prim'}],
          body: {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: {op: 'binding', id: write.objectId},
            message: textValue('value:value:value:'),
            arguments: [
              {op: 'argument', index: 0},
              {op: 'literal', value: textValue('p-slot')},
              {op: 'literal', value: integerValue(666)},
            ],
          },
        },
        captures: [{id: write.objectId, name: 'prim', value: write}],
      }],
    });

    const mine = await newInstance(runtime, 'app', 'mine', child.classRef);
    const theirs = await newInstance(runtime, 'app', 'theirs', child.classRef);
    await assert.rejects(
      evaluate(runtime, 'app', 'poke', '[ :o :x | o poke: x ]', [mine, theirs]),
      (error) => error.name === 'SmalltalkSlotAccessError' && /own self/.test(error.message),
    );
    const record = await runtime.images.getObject('app', theirs.objectId);
    assert.notDeepEqual(record.slots['p-slot'], integerValue(666), 'and nothing was written');
  });
});

// --- frame transport and lifetime ------------------------------------------------------------------

test('a directly invoked Block has no frame and cannot use the slot primitives', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'direct', point.classRef);

    // invokeBlock produces no envelope, so a direct send to the primitive has no frame at all.
    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: objectRef('app', READ_PRIMITIVE),
        message: textValue('value:value:'),
        arguments: [instance, textValue('point-x')],
      })),
      (error) => error.name === 'SmalltalkSlotFrameMissingError',
    );
  });
});

// Decision 5a rule 4: a method must not lend its identity to a Block it merely invoked.
test('an ordinary Block invoked by a method does not borrow the method self', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'lend', point.classRef);

    // A Block that calls the slot primitive directly, passed into a method and invoked there.
    const sneaky = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'sneaky',
      source: '[ :prim :target | prim value: target value: 1 ]',
    });
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: point.classRef,
      methods: [{selector: 'run:with:', source: '[ :b :p | b value: p value: 2 ]'}],
    });
    void sneaky;

    // The Block runs with no frame of its own, so the primitive refuses regardless of what the
    // enclosing method's self happens to be.
    await assert.rejects(
      evaluate(runtime, 'app', 'lend-run', '[ :o :b :p | o run: b with: p ]', [
        instance, objectRef('app', 'sneaky'), objectRef('app', READ_PRIMITIVE),
      ]),
      (error) => error.name === 'SmalltalkSlotFrameMissingError' || error.name === 'SmalltalkSlotAccessError',
    );
  });
});

// ADR 0050 decision 10, staged: refused at definition time, which is stronger than failing at
// execution — the method never exists, so no path can read the Block as the target.
test('a method containing a Block literal is refused rather than partly supported', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    await assert.rejects(
      defineMethodsFromSource({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app', classRef: point.classRef,
        methods: [{selector: 'inBlock', source: '[ [ x := 1 ] value ]'}],
      }),
      (error) => error.name === 'SmalltalkMethodBlockLiteralError',
    );
  });
});

// --- boundaries -------------------------------------------------------------------------------------

test('a slot write needs no authority context at all', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const point = await pointClass(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'no-auth', point.classRef);
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'no-auth-block', source: '[ :o | o setX: 3 ]',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), [instance]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(3));
  });
});

test('a foreign primitive Block cannot reach a local instance slot', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await seed(runtime, 'other');
    const point = await pointClass(runtime, 'app');
    const instance = await newInstance(runtime, 'app', 'foreign', point.classRef);
    await assert.rejects(
      runtime.executor.execute(await runtime.invocations.sendMessage({
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: objectRef('other', READ_PRIMITIVE),
        message: textValue('value:value:'),
        arguments: [instance, textValue('point-x')],
      })),
      (error) => error.name === 'SmalltalkSlotFrameMissingError' || error.name === 'SmalltalkPrimitiveLocalityError',
    );
  });
});

test('no accessors are generated by declaring a layout', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = await shapeWith(runtime, 'app', 'bare-shape', [{id: 'v-slot', name: 'v'}]);
    const bare = await defineClass({images: runtime.images, imageId: 'app', name: 'Bare', instanceShapeRef: shape});
    const instance = await newInstance(runtime, 'app', 'bare', bare.classRef);
    await assert.rejects(
      evaluate(runtime, 'app', 'no-accessor', '[ :o | o v ]', [instance]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError',
      'declaring a slot must not create protocol',
    );
  });
});

// --- both lanes ---------------------------------------------------------------------------------------

test('a slot write whose result feeds another send resumes correctly in WASM', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app', {lane: 'wasm'});
    const point = await pointClass(runtime, 'app', {lane: 'wasm'});
    const instance = await newInstance(runtime, 'app', 'wasm-nontail', point.classRef);

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'nontail', source: '[ :o | (o setX: 4) + 1 ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'nontail-tree',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), [instance]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(5));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'wrote-once', '[ :o | o x ]', [instance]),
      integerValue(4),
      'and the write happened exactly once across suspension and resumption',
    );
  });
});
