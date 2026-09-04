import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  CUIS_SEMANTIC_EXPORT_V2,
  CuisNativeImportError,
  createRuntime,
  findSmalltalkKernel,
  importCuisNativeClasses,
  installSmalltalkAllocationProtocol,
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
    const first = await importCuisNativeClasses({images: runtime.images, imageId: 'app', manifest: manifest()});
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
    const replayed = await importCuisNativeClasses({images: runtime.images, imageId: 'app', manifest: manifest()});
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
    const imported = await importCuisNativeClasses({images: runtime.images, imageId: 'app', manifest: manifest()});
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
      importCuisNativeClasses({images: runtime.images, imageId: 'app', manifest: input}),
      (error) => error instanceof CuisNativeImportError
        && /unsupported superclass semantic identity/.test(error.message),
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore, 'preflight failure publishes nothing');
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/ZuluBase'), null);
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/AChild'), null);
  });
});

test('M1 preflights malformed graphs and method breadth before any native publication', async () => {
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
      label: 'M2 methods',
      input: manifest({methods: [{identity: 'cuis-method/Fixture/AChild/instance/value'}]}),
      message: /does not import methods/,
    },
  ];

  for (const {label, input, message} of cases) {
    await withKernel(async (runtime) => {
      const frontierBefore = await runtime.images.frontier('app');
      await assert.rejects(
        importCuisNativeClasses({images: runtime.images, imageId: 'app', manifest: input}),
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
      importCuisNativeClasses({images: runtime.images, imageId: 'app', manifest: invalid}),
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
    const imported = await importCuisNativeClasses({images: runtime.images, imageId: 'app', manifest: corrected});
    assert.equal(imported.classes.length, 2);
    assert.deepEqual(
      (await shapeOf(runtime, objectRef('app', 'smalltalk/class/Child'))).slots.map(({name}) => name),
      ['shared', 'child'],
    );
  });
});
