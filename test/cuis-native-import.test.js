import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  integerValue,
  objectRef,
  readBehavior,
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
