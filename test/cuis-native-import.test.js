import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  CUIS_NATIVE_INTEGER_IDENTITY,
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  CUIS_SEMANTIC_EXPORT_V2,
  CuisNativeImportError,
  createRuntime,
  findSmalltalkKernel,
  importCuisNativePackage,
  installSmalltalkAllocationProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  methodBlockRef,
  objectRef,
  readBehavior,
  resolveGlobal,
  textValue,
} from '../src/runtime.js';

async function withKernel(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

function manifest({classes = null, methods = []} = {}) {
  return {
    format: CUIS_SEMANTIC_EXPORT_V2,
    packages: [{name: 'Fixture', requires: ['Cuis-Base']}],
    // Canonical identity order deliberately puts the child first. The adapter must resolve the
    // semantic superclass graph; array position is not construction authority.
    classes: classes ?? [
      {
        identity: 'cuis-class/Fixture/AChild',
        package: 'Fixture',
        name: 'AChild',
        superclassName: 'ZuluBase',
        superclass: 'cuis-class/Fixture/ZuluBase',
        instanceVariables: ['child'],
      },
      {
        identity: 'cuis-class/Fixture/ZuluBase',
        package: 'Fixture',
        name: 'ZuluBase',
        superclassName: 'Object',
        superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
        instanceVariables: ['base'],
      },
    ],
    methods,
  };
}

async function shapeOf(runtime, classRef) {
  const behavior = await readBehavior(runtime.images, classRef);
  return await runtime.images.getShape(behavior.instanceShape.imageId, behavior.instanceShape.objectId);
}

test('Cuis native class import resolves semantic inheritance through native owners and replays write-free', async () => {
  await withKernel(async (runtime) => {
    const first = await importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: manifest()});
    const byIdentity = new Map(first.classes.map((entry) => [entry.identity, entry]));
    const base = byIdentity.get('cuis-class/Fixture/ZuluBase');
    const child = byIdentity.get('cuis-class/Fixture/AChild');

    assert.deepEqual(base.classRef, objectRef('app', 'smalltalk/class/ZuluBase'));
    assert.deepEqual(child.classRef, objectRef('app', 'smalltalk/class/AChild'));
    assert.deepEqual((await readBehavior(runtime.images, base.classRef)).superclass, objectRef('app', 'smalltalk/class/Object'));
    assert.deepEqual((await readBehavior(runtime.images, child.classRef)).superclass, base.classRef);
    assert.deepEqual((await readBehavior(runtime.images, child.metaclassRef)).superclass, base.metaclassRef);

    const baseShape = await shapeOf(runtime, base.classRef);
    const childShape = await shapeOf(runtime, child.classRef);
    assert.deepEqual(baseShape.slots.map(({name}) => name), ['base']);
    assert.deepEqual(childShape.slots.map(({name}) => name), ['base', 'child']);
    assert.deepEqual(childShape.slots[0], baseShape.slots[0], 'the native class owner composes inherited identity');

    const frontierBeforeReplay = await runtime.images.frontier('app');
    const replayed = await importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: manifest()});
    assert.deepEqual(replayed, first);
    assert.equal(await runtime.images.frontier('app'), frontierBeforeReplay);
    assert.deepEqual(await shapeOf(runtime, child.classRef), childShape);
  });
});

test('an imported class allocates ordinary durable native object state', async () => {
  await withKernel(async (runtime) => {
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
    });
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const imported = await importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: manifest()});
    const child = imported.classes.find(({identity}) => identity === 'cuis-class/Fixture/AChild');
    const childBehavior = await readBehavior(runtime.images, child.classRef);
    const childShape = await runtime.images.getShape(
      childBehavior.instanceShape.imageId, childBehavior.instanceShape.objectId,
    );
    const allocationBlock = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'allocate-imported-unit', source: '[ :class | class basicNew ]',
    });
    const instance = await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('app', allocationBlock.block.id), [child.classRef],
    ));
    const allocated = await runtime.images.getObject('app', instance.objectId);
    assert.deepEqual(allocated.behavior, child.classRef);
    assert.deepEqual(Object.values(allocated.slots), [kernel.nil, kernel.nil]);

    const slotByName = new Map(childShape.slots.map(({id, name}) => [name, id]));
    await runtime.images.putObject('app', {
      id: allocated.id,
      shape: allocated.shape,
      behavior: allocated.behavior,
      slots: {
        ...allocated.slots,
        [slotByName.get('base')]: textValue('native'),
        [slotByName.get('child')]: integerValue(7),
      },
      metadata: allocated.metadata,
    }, {expectedVersion: allocated._version});
    const reread = await runtime.images.getObject('app', instance.objectId);
    assert.deepEqual(reread.slots[slotByName.get('base')], textValue('native'));
    assert.deepEqual(reread.slots[slotByName.get('child')], integerValue(7));
  });
});

test('the M1 root compatibility rule is exact semantic identity, never a shared Object name', async () => {
  await withKernel(async (runtime) => {
    const input = manifest();
    input.classes[1] = {
      ...input.classes[1],
      superclass: 'cuis-class/Some-Other-Package/Object',
    };
    const frontierBefore = await runtime.images.frontier('app');

    await assert.rejects(
      importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: input}),
      (error) => error instanceof CuisNativeImportError
        && /unsupported superclass semantic identity/.test(error.message),
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore, 'preflight failure publishes nothing');
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/ZuluBase'), null);
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/AChild'), null);
  });
});

test('the adapter preflights malformed class and method graphs before any native publication', async () => {
  const cases = [
    {
      label: 'cycle',
      input: manifest({classes: [
        {
          identity: 'cuis-class/Fixture/CycleA', package: 'Fixture', name: 'CycleA',
          superclassName: 'CycleB', superclass: 'cuis-class/Fixture/CycleB', instanceVariables: [],
        },
        {
          identity: 'cuis-class/Fixture/CycleB', package: 'Fixture', name: 'CycleB',
          superclassName: 'CycleA', superclass: 'cuis-class/Fixture/CycleA', instanceVariables: [],
        },
      ]}),
      message: /cycle/,
    },
    {
      label: 'duplicate native name',
      input: manifest({classes: [
        {
          identity: 'cuis-class/Fixture/Duplicate', package: 'Fixture', name: 'Duplicate',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: [],
        },
        {
          identity: 'cuis-class/Other/Duplicate', package: 'Other', name: 'Duplicate',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: [],
        },
      ]}),
      message: /native class name Duplicate appears more than once/,
    },
    {
      label: 'foreign method target',
      input: manifest({methods: [{
        identity: 'cuis-method/Fixture/Foreign/instance/value',
        package: 'Fixture', class: 'cuis-class/Cuis-Base/Foreign', side: 'instance',
        selector: 'value', source: 'value\n\t^ 1',
      }]}),
      message: /outside the imported native class graph/,
    },
    {
      label: 'method identity',
      input: manifest({methods: [{
        identity: 'cuis-method/Fixture/AChild/instance/notValue',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'value', source: 'value\n\t^ 1',
      }]}),
      message: /does not match its canonical declaration/,
    },
    {
      label: 'source header',
      input: manifest({methods: [{
        identity: 'cuis-method/Fixture/AChild/instance/value',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'value', source: 'different\n\t^ 1',
      }]}),
      message: /source header declares different, not value/,
    },
    {
      label: 'missing compilation owner',
      input: manifest({methods: [{
        identity: 'cuis-method/Fixture/AChild/instance/value',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'value', source: 'value\n\t^ 1',
      }]}),
      message: /compilation must be a compilation service/,
    },
  ];

  for (const {label, input, message} of cases) {
    await withKernel(async (runtime) => {
      const frontierBefore = await runtime.images.frontier('app');
      await assert.rejects(
        importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: input}),
        (error) => error instanceof CuisNativeImportError && message.test(error.message),
        label,
      );
      assert.equal(await runtime.images.frontier('app'), frontierBefore, `${label} publishes nothing`);
    });
  }
});

test('native declaration legality stays with the class owner and a corrected retry converges', async () => {
  await withKernel(async (runtime) => {
    const invalid = manifest({classes: [
      {
        identity: 'cuis-class/Fixture/Base', package: 'Fixture', name: 'Base',
        superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: ['shared'],
      },
      {
        identity: 'cuis-class/Fixture/Child', package: 'Fixture', name: 'Child',
        superclassName: 'Base', superclass: 'cuis-class/Fixture/Base', instanceVariables: ['shared'],
      },
    ]});
    const frontierBefore = await runtime.images.frontier('app');
    await assert.rejects(
      importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: invalid}),
      /class Child duplicates inherited instance variable: shared/,
    );

    assert.notEqual(
      await runtime.images.frontier('app'),
      frontierBefore,
      'the valid immutable ancestor was admitted before the native owner rejected the child',
    );
    assert.ok(await runtime.images.getObject('app', 'smalltalk/class/Base'));
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/Child'), null);

    const corrected = {
      ...invalid,
      classes: [invalid.classes[0], {...invalid.classes[1], instanceVariables: ['child']}],
    };
    const imported = await importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: corrected});
    assert.equal(imported.classes.length, 2);
    assert.deepEqual(
      (await shapeOf(runtime, objectRef('app', 'smalltalk/class/Child'))).slots.map(({name}) => name),
      ['shared', 'child'],
    );
  });
});

test('valid Cuis source outside the native subset fails explicitly without fallback or publication', async () => {
  await withKernel(async (runtime) => {
    await importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: manifest()});
    const frontierBefore = await runtime.images.frontier('app');
    const unsupported = manifest({methods: [{
      identity: 'cuis-method/Fixture/AChild/instance/pair',
      package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
      selector: 'pair', source: 'pair\n\t^ #(1 2)',
    }]});

    await assert.rejects(
      importCuisNativePackage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: unsupported,
      }),
      /literal Array element syntax is not supported/,
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore);
    assert.equal(
      (await runtime.images.listRecords('app')).some((record) =>
        record.kind === 'block' && record.metadata?.smalltalk === 'method'
          && record.metadata.selector === 'pair'),
      false,
    );
  });
});

test('Cuis method definitions become inherited native WASM behavior and replay write-free', async () => {
  await withKernel(async (runtime) => {
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
    });
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const input = manifest({methods: [
      {
        identity: 'cuis-method/Fixture/ZuluBase/instance/base',
        package: 'Fixture', class: 'cuis-class/Fixture/ZuluBase', side: 'instance',
        selector: 'base', source: 'base\n\t^ base',
      },
      {
        identity: 'cuis-method/Fixture/ZuluBase/instance/base:',
        package: 'Fixture', class: 'cuis-class/Fixture/ZuluBase', side: 'instance',
        selector: 'base:', source: 'base: aValue\n\tbase := aValue',
      },
      {
        identity: 'cuis-method/Fixture/AChild/instance/child',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'child', source: 'child\n\t^ child',
      },
      {
        identity: 'cuis-method/Fixture/AChild/instance/child:',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'child:', source: 'child: aValue\n\tchild := aValue',
      },
    ]});

    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: input,
    });
    const child = imported.classes.find(({identity}) => identity === 'cuis-class/Fixture/AChild');
    const allocation = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'allocate-m2-unit', source: '[ :class | class basicNew ]',
    });
    const instance = await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('app', allocation.block.id), [child.classRef],
    ));
    const exercise = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'app',
      id: 'exercise-m2-unit',
      source: '[ :object | object base: 41. object child: 42. object base ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('app', exercise.block.id), [instance],
      )),
      integerValue(41),
      'the child reaches the imported base setter/getter through native inheritance',
    );
    const readChild = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'read-child-m2-unit', source: '[ :object | object child ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('app', readChild.block.id), [instance],
      )),
      integerValue(42),
    );

    const methodBlocks = (await runtime.images.listRecords('app')).filter((record) =>
      record.kind === 'block' && record.metadata?.smalltalk === 'method'
        && ['base', 'base:', 'child', 'child:'].includes(record.metadata.selector));
    assert.equal(methodBlocks.length, 4);
    assert.ok(methodBlocks.every((record) => record.metadata.lane === 'wasm'));
    for (const block of methodBlocks) {
      const code = await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId);
      assert.equal(code.representation, 'wasm-function/v2');
    }

    const frontierBeforeReplay = await runtime.images.frontier('app');
    assert.deepEqual(await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: input,
    }), imported);
    assert.equal(await runtime.images.frontier('app'), frontierBeforeReplay);
  });
});

test('changed Cuis method semantics advance one native selector binding and replay write-free', async () => {
  await withKernel(async (runtime) => {
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
    });
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const method = (selector, answer) => ({
      identity: `cuis-method/Fixture/AChild/instance/${selector}`,
      package: 'Fixture',
      class: 'cuis-class/Fixture/AChild',
      side: 'instance',
      selector,
      source: `${selector}\n\t^ ${answer}`,
    });
    const a = manifest({methods: [method('stable', 9), method('value', 1)]});
    const b = manifest({methods: [method('stable', 9), method('value', 2)]});
    const execute = async (id, classRef, selector) => {
      const allocation = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: `${id}-allocation`, source: '[ :class | class basicNew ]',
      });
      const instance = await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('app', allocation.block.id), [classRef],
      ));
      const send = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id, source: `[ :object | object ${selector} ]`,
      });
      return await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('app', send.block.id), [instance],
      ));
    };

    const importedA = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: a,
    });
    const childA = importedA.classes.find(({identity}) => identity === 'cuis-class/Fixture/AChild');
    const valueA = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: childA.classRef, selector: 'value',
    });
    const stableA = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: childA.classRef, selector: 'stable',
    });
    assert.deepEqual(await execute('execute-a', childA.classRef, 'value'), integerValue(1));

    const dictionaryA = (await readBehavior(runtime.images, childA.classRef)).record.slots['behavior-methods'];
    const dictionaryRecordA = await runtime.images.getObject(dictionaryA.imageId, dictionaryA.objectId);
    const frontierA = await runtime.images.frontier('app');
    const replayA = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: a,
    });
    assert.deepEqual(replayA, importedA);
    assert.equal(await runtime.images.frontier('app'), frontierA);
    assert.deepEqual(await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: childA.classRef, selector: 'value',
    }), valueA);

    const importedB = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: b,
    });
    const childB = importedB.classes.find(({identity}) => identity === 'cuis-class/Fixture/AChild');
    const valueB = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: childB.classRef, selector: 'value',
    });
    const stableB = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: childB.classRef, selector: 'stable',
    });
    const dictionaryRecordB = await runtime.images.getObject(dictionaryA.imageId, dictionaryA.objectId);
    assert.deepEqual(childB.classRef, childA.classRef);
    assert.notDeepEqual(valueB, valueA);
    assert.deepEqual(stableB, stableA);
    assert.equal(dictionaryRecordB._version, dictionaryRecordA._version + 1);
    assert.deepEqual(await execute('execute-b', childB.classRef, 'value'), integerValue(2));
    assert.deepEqual(await execute('execute-stable', childB.classRef, 'stable'), integerValue(9));

    const frontierB = await runtime.images.frontier('app');
    const replayB = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: b,
    });
    assert.deepEqual(replayB, importedB);
    assert.equal(await runtime.images.frontier('app'), frontierB);
    assert.deepEqual(await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: childB.classRef, selector: 'value',
    }), valueB);
  });
});

test('the adapter translates headers and preserves Cuis implicit-self method returns', async () => {
  await withKernel(async (runtime) => {
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'neutral',
    });
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    const input = manifest({methods: [
      {
        identity: 'cuis-method/Fixture/AChild/class/constant',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'class',
        selector: 'constant', source: 'constant\n\t7',
      },
      {
        identity: 'cuis-method/Fixture/AChild/instance/@@',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: '@@', source: '@@ anObject\n\tanObject',
      },
      {
        identity: 'cuis-method/Fixture/AChild/instance/choose:or:',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'choose:or:', source: 'choose: first or: second\n\tsecond',
      },
      {
        identity: 'cuis-method/Fixture/AChild/instance/explicit',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'explicit', source: 'explicit\n\t^ 7',
      },
      {
        identity: 'cuis-method/Fixture/AChild/instance/store:',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'store:', source: 'store: aValue\n\tbase := aValue',
      },
    ]});
    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: input,
    });
    const child = imported.classes.find(({identity}) => identity === 'cuis-class/Fixture/AChild');
    const run = async (id, source, args) => {
      const block = await installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'app', id, source});
      return await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('app', block.block.id), args,
      ));
    };
    const instance = await run('allocate-header-unit', '[ :class | class basicNew ]', [child.classRef]);
    assert.deepEqual(await run('binary-header-unit', '[ :object | object @@ 8 ]', [instance]), instance);
    assert.deepEqual(
      await run('keyword-header-unit', '[ :object | object choose: 1 or: 9 ]', [instance]),
      instance,
    );
    assert.deepEqual(await run('class-header-unit', '[ :class | class constant ]', [child.classRef]), child.classRef);
    assert.deepEqual(await run('setter-return-unit', '[ :object | object store: 13 ]', [instance]), instance);
    const baseSlot = (await shapeOf(runtime, child.classRef)).slots.find(({name}) => name === 'base');
    assert.deepEqual((await runtime.images.getObject('app', instance.objectId)).slots[baseSlot.id], integerValue(13));
    assert.deepEqual(await run('explicit-return-unit', '[ :object | object explicit ]', [instance]), integerValue(7));
  });
});

// M3 import scope (bead lagrange-images-nv1.2). A real package is imported progressively, so the
// caller declares which canonical declarations one import covers. The manifest is never edited.
test('a scoped import covers exactly the named declarations and replays write-free', async () => {
  await withKernel(async (runtime) => {
    const scope = {classes: ['cuis-class/Fixture/ZuluBase'], methods: []};
    const imported = await importCuisNativePackage({
      images: runtime.images, imageId: 'app', manifest: manifest(), scope,
    });

    assert.deepEqual(imported.classes.map(({identity}) => identity), ['cuis-class/Fixture/ZuluBase']);
    assert.ok(await runtime.images.getObject('app', 'smalltalk/class/ZuluBase'));
    assert.equal(
      await runtime.images.getObject('app', 'smalltalk/class/AChild'),
      null,
      'a declaration the scope omits is not constructed',
    );
    assert.deepEqual((await shapeOf(runtime, imported.classes[0].classRef)).slots.map(({name}) => name), ['base']);

    const frontierBeforeReplay = await runtime.images.frontier('app');
    const replayed = await importCuisNativePackage({
      images: runtime.images, imageId: 'app', manifest: manifest(), scope,
    });
    assert.deepEqual(replayed, imported);
    assert.equal(
      await runtime.images.frontier('app'),
      frontierBeforeReplay,
      'exact replay of a scoped import is write-free at the native owners',
    );
  });
});

test('a scope omitting a required superclass is refused rather than widened', async () => {
  await withKernel(async (runtime) => {
    const frontierBefore = await runtime.images.frontier('app');
    await assert.rejects(
      importCuisNativePackage({
        images: runtime.images,
        imageId: 'app',
        manifest: manifest(),
        scope: {classes: ['cuis-class/Fixture/AChild'], methods: []},
      }),
      (error) => error instanceof CuisNativeImportError
        && /requires superclass cuis-class\/Fixture\/ZuluBase, which the requested import scope omits/.test(error.message)
        && error.semanticIdentity === 'cuis-class/Fixture/AChild',
    );
    assert.equal(await runtime.images.frontier('app'), frontierBefore, 'preflight failure publishes nothing');
  });
});

// The reason scope exists: a real package's manifest reaches semantics this image does not support,
// and an import that does not cover them must not be blocked by them. The falsifier is the pair —
// the same manifest still refuses when nothing is scoped out.
test('an unsupported declaration outside the scope does not block the import, and inside it still refuses', async () => {
  const withForeignExtension = manifest({methods: [{
    identity: 'cuis-method/Fixture/Foreign/instance/value',
    package: 'Fixture', class: 'cuis-class/Cuis-Base/Foreign', side: 'instance',
    selector: 'value', source: 'value\n\t^ 1',
  }]});

  await withKernel(async (runtime) => {
    const imported = await importCuisNativePackage({
      images: runtime.images,
      imageId: 'app',
      manifest: withForeignExtension,
      scope: {classes: ['cuis-class/Fixture/ZuluBase'], methods: []},
    });
    assert.deepEqual(imported.classes.map(({identity}) => identity), ['cuis-class/Fixture/ZuluBase']);
  });

  await withKernel(async (runtime) => {
    await assert.rejects(
      importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: withForeignExtension}),
      (error) => error instanceof CuisNativeImportError
        && /method target cuis-class\/Cuis-Base\/Foreign is outside the imported native class graph/.test(error.message),
      'the same manifest still refuses when the import covers the whole thing',
    );
  });

  await withKernel(async (runtime) => {
    await assert.rejects(
      importCuisNativePackage({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        manifest: withForeignExtension,
        scope: {
          classes: ['cuis-class/Fixture/ZuluBase'],
          methods: ['cuis-method/Fixture/Foreign/instance/value'],
        },
      }),
      (error) => error instanceof CuisNativeImportError
        && /method target cuis-class\/Cuis-Base\/Foreign is outside the imported native class graph/.test(error.message),
      'an unsupported semantic the scope DOES cover is still an explicit refusal',
    );
  });
});

test('the adapter refuses a malformed or unsatisfiable import scope before any native publication', async () => {
  const cases = [
    {
      label: 'unknown class',
      scope: {classes: ['cuis-class/Fixture/Missing'], methods: []},
      message: /import scope names class cuis-class\/Fixture\/Missing, which this manifest does not declare/,
    },
    {
      label: 'unknown method',
      scope: {classes: ['cuis-class/Fixture/ZuluBase'], methods: ['cuis-method/Fixture/ZuluBase/instance/missing']},
      message: /import scope names method cuis-method\/Fixture\/ZuluBase\/instance\/missing, which this manifest does not declare/,
    },
    {
      label: 'no class',
      scope: {classes: [], methods: []},
      message: /import scope must name at least one class/,
    },
    {
      label: 'duplicate entry',
      scope: {classes: ['cuis-class/Fixture/ZuluBase', 'cuis-class/Fixture/ZuluBase'], methods: []},
      message: /import scope classes must not contain duplicates/,
    },
    {
      label: 'unknown field',
      scope: {classes: ['cuis-class/Fixture/ZuluBase'], methods: [], packages: []},
      message: /import scope must have exactly fields classes, methods/,
    },
  ];

  for (const {label, scope, message} of cases) {
    await withKernel(async (runtime) => {
      const frontierBefore = await runtime.images.frontier('app');
      await assert.rejects(
        importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: manifest(), scope}),
        (error) => error instanceof CuisNativeImportError && message.test(error.message),
        label,
      );
      assert.equal(await runtime.images.frontier('app'), frontierBefore, `${label} publishes nothing`);
    });
  }
});

test('a covered method whose target class the scope omits is refused', async () => {
  await withKernel(async (runtime) => {
    const input = manifest({methods: [{
      identity: 'cuis-method/Fixture/AChild/instance/value',
      package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
      selector: 'value', source: 'value\n\t^ 1',
    }]});
    const frontierBefore = await runtime.images.frontier('app');
    await assert.rejects(
      importCuisNativePackage({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        manifest: input,
        scope: {
          classes: ['cuis-class/Fixture/ZuluBase'],
          methods: ['cuis-method/Fixture/AChild/instance/value'],
        },
      }),
      (error) => error instanceof CuisNativeImportError
        && /method target cuis-class\/Fixture\/AChild is outside the requested import scope/.test(error.message),
    );
    assert.equal(await runtime.images.frontier('app'), frontierBefore);
  });
});

// Manifest well-formedness is never scoped away. The canonical export is one artifact: if any of
// its declarations is malformed or duplicated, the input is untrustworthy whether or not this
// invocation asks for that declaration. Scope answers "what does this invocation ask to make
// native", not "which declarations must be valid".
test('a declaration outside the scope cannot smuggle a malformed or duplicated canonical identity', async () => {
  const scope = {classes: ['cuis-class/Fixture/ZuluBase'], methods: []};
  const cases = [
    {
      label: 'non-canonical class identity outside scope',
      input: manifest({classes: [
        {
          identity: 'cuis-class/Fixture/ZuluBase', package: 'Fixture', name: 'ZuluBase',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: ['base'],
        },
        {
          identity: 'cuis-class/Fixture/Mislabelled', package: 'Fixture', name: 'Other',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: [],
        },
      ]}),
      message: /class semantic identity cuis-class\/Fixture\/Mislabelled does not match its canonical package\/name/,
    },
    {
      label: 'incomplete class declaration outside scope',
      input: manifest({classes: [
        {
          identity: 'cuis-class/Fixture/ZuluBase', package: 'Fixture', name: 'ZuluBase',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: ['base'],
        },
        {
          identity: 'cuis-class/Fixture/Partial', package: 'Fixture', name: 'Partial',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
        },
      ]}),
      message: /class declaration must have exactly fields/,
    },
    {
      label: 'duplicate class identity, both outside scope',
      input: manifest({classes: [
        {
          identity: 'cuis-class/Fixture/ZuluBase', package: 'Fixture', name: 'ZuluBase',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: ['base'],
        },
        {
          identity: 'cuis-class/Fixture/Twin', package: 'Fixture', name: 'Twin',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: [],
        },
        {
          identity: 'cuis-class/Fixture/Twin', package: 'Fixture', name: 'Twin',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: [],
        },
      ]}),
      message: /class semantic identity cuis-class\/Fixture\/Twin appears more than once/,
    },
    {
      label: 'non-canonical method identity outside scope',
      input: manifest({methods: [{
        identity: 'cuis-method/Fixture/AChild/instance/wrong',
        package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
        selector: 'value', source: 'value\n\t^ 1',
      }]}),
      message: /does not match its canonical declaration/,
    },
    {
      label: 'duplicate method identity, both outside scope',
      input: manifest({methods: [
        {
          identity: 'cuis-method/Fixture/AChild/instance/value',
          package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
          selector: 'value', source: 'value\n\t^ 1',
        },
        {
          identity: 'cuis-method/Fixture/AChild/instance/value',
          package: 'Fixture', class: 'cuis-class/Fixture/AChild', side: 'instance',
          selector: 'value', source: 'value\n\t^ 2',
        },
      ]}),
      message: /method semantic identity cuis-method\/Fixture\/AChild\/instance\/value appears more than once/,
    },
    {
      label: 'duplicate native class name, both outside scope',
      input: manifest({classes: [
        {
          identity: 'cuis-class/Fixture/ZuluBase', package: 'Fixture', name: 'ZuluBase',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: ['base'],
        },
        {
          identity: 'cuis-class/Fixture/Clash', package: 'Fixture', name: 'Clash',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: [],
        },
        {
          identity: 'cuis-class/Other/Clash', package: 'Other', name: 'Clash',
          superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY, instanceVariables: [],
        },
      ]}),
      message: /native class name Clash appears more than once/,
    },
  ];

  for (const {label, input, message} of cases) {
    await withKernel(async (runtime) => {
      const frontierBefore = await runtime.images.frontier('app');
      await assert.rejects(
        importCuisNativePackage({images: runtime.images, imageId: 'app', manifest: input, scope}),
        (error) => error instanceof CuisNativeImportError && message.test(error.message),
        label,
      );
      assert.equal(await runtime.images.frontier('app'), frontierBefore, `${label} publishes nothing`);
    });
  }
});

// Target resolution is by complete semantic identity against the adapter's mapping table, and the
// table is a set of POSITIONS, not a set of names. The standard image is installed here on purpose:
// every `Cuis-Base` identity below names a class this image really does have, so a refusal cannot
// be explained away as "there was nothing to resolve to". `Cuis-Base/Object` is among them — it is
// mapped, but only as a SUPERCLASS, and installing a package's selector on the root of the whole
// native image is a claim no consumer has made.
test('a covered method target outside the manifest is refused however native its name looks', async () => {
  const targets = [
    // Classes this image really has, none of which is a mapped METHOD TARGET.
    'cuis-class/Cuis-Base/Object',
    'cuis-class/Cuis-Base/Dictionary',
    'cuis-class/Cuis-Base/Text',
    'cuis-class/Cuis-Base/Array',
    'cuis-class/Cuis-Base/Association',
    'cuis-class/Cuis-Base/Collection',
    'cuis-class/Cuis-Base/Float',
    'cuis-class/Cuis-Base/Error',
    // The mapped identity's own spelling from another package is not the mapped identity.
    'cuis-class/Other/Integer',
    'cuis-class/Other/ZuluBase',
  ];
  await withStandardImage(async (runtime) => {
    for (const target of targets) {
      const className = target.slice(target.lastIndexOf('/') + 1);
      // The premise of this test: the image really does have a class of that name to be tempted by.
      if (target.startsWith('cuis-class/Cuis-Base/')) {
        assert.ok(
          await runtime.images.getObject('app', `smalltalk/class/${className}`),
          `${className} must exist natively for this refusal to mean anything`,
        );
      }
      const selector = 'value';
      const identity = `cuis-method/Fixture/${className}/instance/${selector}`;
      const input = manifest({methods: [{
        identity, package: 'Fixture', class: target, side: 'instance', selector, source: 'value\n\t^ 1',
      }]});
      const frontierBefore = await runtime.images.frontier('app');
      await assert.rejects(
        importCuisNativePackage({
          images: runtime.images,
          compilation: runtime.compilation,
          imageId: 'app',
          manifest: input,
          scope: {classes: ['cuis-class/Fixture/ZuluBase'], methods: [identity]},
        }),
        (error) => error instanceof CuisNativeImportError
          && new RegExp(`method target ${target.replace(/\//g, '\\/')} is outside the imported native class graph`).test(error.message),
        target,
      );
      assert.equal(await runtime.images.frontier('app'), frontierBefore, target);
    }
  });
});

// The other half of the position rule. `Cuis-Base/Integer` is a mapped METHOD TARGET, not a mapped
// superclass: native integers are Values whose dispatch class is fixed by their kind, so a class
// declaring Integer as its parent would be an inert class no integer ever reaches. Nothing has
// asked for it, so the adapter refuses instead of quietly constructing one.
test('a mapped method-target identity is not thereby a legal superclass', async () => {
  await withStandardImage(async (runtime) => {
    const input = manifest({classes: [{
      identity: 'cuis-class/Fixture/ZuluBase',
      package: 'Fixture',
      name: 'ZuluBase',
      superclassName: 'Integer',
      superclass: CUIS_NATIVE_INTEGER_IDENTITY,
      instanceVariables: ['base'],
    }]});
    const frontierBefore = await runtime.images.frontier('app');
    await assert.rejects(
      importCuisNativePackage({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        manifest: input,
        scope: {classes: ['cuis-class/Fixture/ZuluBase'], methods: []},
      }),
      (error) => error instanceof CuisNativeImportError
        && /unsupported superclass semantic identity cuis-class\/Cuis-Base\/Integer/.test(error.message)
        // The refusal names the superclass position specifically, not the whole table.
        && /only these map to a native superclass: cuis-class\/Cuis-Base\/Object$/.test(error.message)
        && error.semanticIdentity === 'cuis-class/Fixture/ZuluBase',
    );
    assert.equal(await runtime.images.frontier('app'), frontierBefore);
  });
});

// One authority per semantic identity. A mapped identity already denotes an existing native class,
// so a manifest that also DECLARES it would make the same identity mean two different classes
// depending on where it is read. Refused at preflight rather than resolved by precedence.
test('a manifest may not declare a class whose identity the mapping already owns', async () => {
  for (const identity of [CUIS_NATIVE_ROOT_OBJECT_IDENTITY, CUIS_NATIVE_INTEGER_IDENTITY]) {
    await withStandardImage(async (runtime) => {
      const name = identity.slice(identity.lastIndexOf('/') + 1);
      const input = {
        format: CUIS_SEMANTIC_EXPORT_V2,
        packages: [{name: 'Cuis-Base', requires: []}],
        classes: [{
          identity,
          package: 'Cuis-Base',
          name,
          superclassName: 'Object',
          superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
          instanceVariables: [],
        }],
        methods: [],
      };
      const frontierBefore = await runtime.images.frontier('app');
      await assert.rejects(
        importCuisNativePackage({
          images: runtime.images,
          compilation: runtime.compilation,
          imageId: 'app',
          manifest: input,
          scope: {classes: [identity], methods: []},
        }),
        (error) => error instanceof CuisNativeImportError
          && /is already mapped to an existing native class; a manifest may not also declare it/.test(error.message)
          && error.semanticIdentity === identity,
        identity,
      );
      assert.equal(await runtime.images.frontier('app'), frontierBefore, identity);
    });
  }
});

// M3 blocker 2 (bead lagrange-images-nv1.3). A Cuis package routinely owns a method declaration on
// a class it does not define. That is ordinary Smalltalk extension-method behavior, and the native
// result must be ordinary too: the explicit identity mapping resolves the target, and the EXISTING
// native class's EXISTING MethodDictionary owner installs the selector. No proxy subclass, no
// second Integer, no importer-owned extension store, no behavior attached to a package object.
async function withStandardImage(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSymmetricSmalltalkStandardImage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', lane: 'wasm',
    });
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

const extensionManifest = (body) => manifest({methods: [{
  identity: 'cuis-method/Fixture/Integer/instance/fixtureDoubled',
  package: 'Fixture',
  class: CUIS_NATIVE_INTEGER_IDENTITY,
  side: 'instance',
  selector: 'fixtureDoubled',
  source: `fixtureDoubled\n\t^ ${body}`,
}]});

const EXTENSION_SCOPE = Object.freeze({
  // `Cuis-Base/Integer` is deliberately absent from the class scope: it is not a declaration this
  // import makes native, it is an existing native class the covered METHOD extends.
  classes: ['cuis-class/Fixture/ZuluBase'],
  methods: ['cuis-method/Fixture/Integer/instance/fixtureDoubled'],
});

test('an imported extension method installs on the existing native class the mapping names', async () => {
  await withStandardImage(async (runtime) => {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const integerClassBefore = await runtime.images.getObject('app', 'smalltalk/class/Integer');
    const behaviorBefore = await readBehavior(runtime.images, kernel.integerClass);
    const boundBefore = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'fixtureDoubled',
    });

    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      manifest: extensionManifest('self + self'),
      scope: EXTENSION_SCOPE,
    });

    // The mapped class is not part of the import result: it was resolved, not made native here.
    assert.deepEqual(imported.classes.map(({identity}) => identity), ['cuis-class/Fixture/ZuluBase']);

    // The mapping answered the ACTUAL kernel Integer ref, and that class was neither recreated nor
    // rewritten: the Class record does not move when a method dictionary gains a selector.
    const integerClassAfter = await runtime.images.getObject('app', 'smalltalk/class/Integer');
    assert.deepEqual(integerClassAfter.behavior, integerClassBefore.behavior);
    assert.equal(integerClassAfter._version, integerClassBefore._version, 'the mapped Class record does not move');
    const behaviorAfter = await readBehavior(runtime.images, kernel.integerClass);
    assert.deepEqual(behaviorAfter.superclass, behaviorBefore.superclass);
    assert.deepEqual(behaviorAfter.instanceShape, behaviorBefore.instanceShape);
    assert.deepEqual(
      behaviorAfter.methods,
      behaviorBefore.methods,
      'the same MethodDictionary owns the binding; no second dictionary was introduced',
    );

    // The selector is bound in the existing kernel Integer method dictionary, and was not before.
    assert.equal(boundBefore, null, 'the selector is the package\'s, not something the image already had');
    const bound = await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'fixtureDoubled',
    });
    assert.ok(bound, 'the imported extension selector is bound on the mapped native class');

    // The behavioral proof of the mapping: an ORDINARY native integer reaches the imported method.
    // A doesNotUnderstand here would mean the mapping named some other class.
    const send = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'send-fixture-doubled', source: '[ :n | n fixtureDoubled ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('app', send.block.id), [integerValue(21)],
      )),
      integerValue(42),
    );

    const frontierBeforeReplay = await runtime.images.frontier('app');
    const replayed = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      manifest: extensionManifest('self + self'),
      scope: EXTENSION_SCOPE,
    });
    assert.deepEqual(replayed, imported);
    assert.equal(
      await runtime.images.frontier('app'),
      frontierBeforeReplay,
      'exact replay of a mapped-target extension import is write-free',
    );
  });
});

test('a changed extension method on a mapped native class reconciles through the existing dictionary owner', async () => {
  await withStandardImage(async (runtime) => {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const options = {
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', scope: EXTENSION_SCOPE,
    };
    const bindingOf = async () => await methodBlockRef({
      images: runtime.images, imageId: 'app', classRef: kernel.integerClass, selector: 'fixtureDoubled',
    });
    await importCuisNativePackage({...options, manifest: extensionManifest('self + self')});
    const a = await readBehavior(runtime.images, kernel.integerClass);
    const dictionaryA = await runtime.images.getObject(a.methods.imageId, a.methods.objectId);
    const bindingA = await bindingOf();

    await importCuisNativePackage({...options, manifest: extensionManifest('self + self + self')});
    const b = await readBehavior(runtime.images, kernel.integerClass);
    const dictionaryB = await runtime.images.getObject(b.methods.imageId, b.methods.objectId);
    const bindingB = await bindingOf();

    assert.deepEqual(b.methods, a.methods, 'the same MethodDictionary record is the position');
    assert.equal(dictionaryB._version, dictionaryA._version + 1, 'exactly one authoritative advance');
    assert.notDeepEqual(bindingB, bindingA, 'changed semantics get a new Block identity');

    const send = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'send-fixture-doubled-b', source: '[ :n | n fixtureDoubled ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('app', send.block.id), [integerValue(7)],
      )),
      integerValue(21),
    );

    const frontierBeforeReplay = await runtime.images.frontier('app');
    await importCuisNativePackage({...options, manifest: extensionManifest('self + self + self')});
    assert.equal(await runtime.images.frontier('app'), frontierBeforeReplay, 'exact B replay is write-free');
  });
});

test('class-side extension of a mapped native class is refused rather than guessed', async () => {
  await withStandardImage(async (runtime) => {
    const identity = 'cuis-method/Fixture/Integer/class/fixtureMake';
    const input = manifest({methods: [{
      identity,
      package: 'Fixture',
      class: CUIS_NATIVE_INTEGER_IDENTITY,
      side: 'class',
      selector: 'fixtureMake',
      source: 'fixtureMake\n\t^ 1',
    }]});
    const frontierBefore = await runtime.images.frontier('app');
    await assert.rejects(
      importCuisNativePackage({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        manifest: input,
        scope: {classes: ['cuis-class/Fixture/ZuluBase'], methods: [identity]},
      }),
      (error) => error instanceof CuisNativeImportError
        && /only instance-side extension of a mapped native class is proven/.test(error.message)
        && error.semanticIdentity === identity,
    );
    assert.equal(await runtime.images.frontier('app'), frontierBefore);
  });
});

// M3 blocker 4 (bead lagrange-images-nv1.5). ONE Cuis dialect idiom is translated at the boundary
// that already owns dialect translation. It is NOT a `String` mapping: no `String` global is
// published, no Cuis String identity is mapped to a native class, and native Text is untouched.
//
// The claim is only about the role `String new` plays, measured against the pinned Cuis VM and
// recorded on the bead: it is an EMPTY textual seed that the path never mutates (being empty, the
// first write grows the stream onto a new collection and the original still reads ''), never
// compares, and never keeps — its only contribution is the species of the eventual result, and
// swapping it for an empty UnicodeString changes that species while leaving the textual value
// identical. So an empty native Text value is the exact native counterpart for this expression.
const seedMethod = (source) => manifest({methods: [{
  identity: 'cuis-method/Fixture/ZuluBase/instance/seed',
  package: 'Fixture',
  class: 'cuis-class/Fixture/ZuluBase',
  side: 'instance',
  selector: 'seed',
  source,
}]});

const SEED_SCOPE = Object.freeze({
  classes: ['cuis-class/Fixture/ZuluBase'],
  methods: ['cuis-method/Fixture/ZuluBase/instance/seed'],
});

async function importSeed(runtime, source) {
  return await importCuisNativePackage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    manifest: seedMethod(source),
    scope: SEED_SCOPE,
  });
}

// Ordinary Smalltalk throughout: allocate through the class the import produced, then send the
// imported selector to the instance. Nothing here reaches past the language to inspect the
// compiled body — the adaptation is judged by what the method ANSWERS.
let counter = 0;

async function seedAnswer(runtime, source) {
  const imported = await importSeed(runtime, source);
  const {block} = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: 'app', id: `seed-send-${counter += 1}`, source: '[ :class | class basicNew seed ]',
  });
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(
    objectRef('app', block.id), [imported.classes[0].classRef],
  ));
}

test('the Cuis `String new` seed idiom imports as an empty native Text value', async () => {
  await withStandardImage(async (runtime) => {
    assert.deepEqual(await seedAnswer(runtime, 'seed\n\t^ String new'), textValue(''));
    // Nothing published a `String` global: the name is gone from the source, not bound in the image.
    assert.equal(await resolveGlobal({images: runtime.images, imageId: 'app', name: 'String'}), null);
  });
});

// The idiom is matched on the TOKEN stream, so text that merely spells it is untouched.
test('the seed idiom is matched as tokens, not as text', async () => {
  await withStandardImage(async (runtime) => {
    // Inside a string literal the words are data and must survive verbatim.
    assert.deepEqual(await seedAnswer(runtime, "seed\n\t^ 'String new'"), textValue('String new'));
  });
});

test('a comment spelling the idiom is not rewritten', async () => {
  await withStandardImage(async (runtime) => {
    assert.deepEqual(await seedAnswer(runtime, 'seed\n\t"String new is the idiom"\n\t^ 7'), integerValue(7));
  });
});

// EVERY other use of the name stays exactly as unsupported as it was. These are the falsification
// cases: if any of them started resolving, the narrow idiom would have become a `String` mapping.
test('only the exact unary `String new` idiom is adapted; every other use of the name stays unbound', async () => {
  await withStandardImage(async (runtime) => {
    const unsupported = [
      // A SIZED buffer is a different expression the oracle does not cover.
      'seed\n\t^ String new: 16',
      // The class itself, as a value.
      'seed\n\t^ String',
      // Any other message to it.
      'seed\n\t^ String name',
      // `new` sent to something else is not this idiom either.
      'seed\n\t^ Strings new',
    ];
    for (const source of unsupported) {
      await assert.rejects(
        importSeed(runtime, source),
        (error) => /unbound Symmetric Smalltalk name: Strings?/.test(error.message),
        source,
      );
    }
  });
});

test('two occurrences of the idiom in one body are both adapted', async () => {
  await withStandardImage(async (runtime) => {
    assert.deepEqual(
      await seedAnswer(runtime, 'seed\n\t| a b |\n\ta := String new.\n\tb := String new.\n\t^ a = b'),
      booleanValue(true),
    );
  });
});
