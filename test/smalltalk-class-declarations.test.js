import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHAPE_INDEXED,
  SmalltalkKernelConflictError,
  createRuntime,
  defineClass,
  ensureClassFromDeclaration,
  ensureSmalltalkShape,
  installSmalltalkKernel,
  objectRef,
  readBehavior,
} from '../src/runtime.js';
import {subclassRegistryId} from '../src/language/smalltalk-subclasses.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function instanceShape(runtime, classRef) {
  const behavior = await readBehavior(runtime.images, classRef);
  return await runtime.images.getShape(behavior.instanceShape.imageId, behavior.instanceShape.objectId);
}

test('native class declarations own stable complete instance layouts and replay without writes', async () => {
  await withRuntime(async (runtime) => {
    const base = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeBase',
      instanceVariables: ['baseValue'],
    });
    const child = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeChild',
      superclassRef: base.classRef,
      instanceVariables: ['childFirst', 'childSecond'],
    });

    assert.deepEqual(base, {
      classRef: objectRef('app', 'smalltalk/class/NativeBase'),
      metaclassRef: objectRef('app', 'smalltalk/metaclass/NativeBase'),
    });
    assert.deepEqual(child, {
      classRef: objectRef('app', 'smalltalk/class/NativeChild'),
      metaclassRef: objectRef('app', 'smalltalk/metaclass/NativeChild'),
    });

    const baseShape = await instanceShape(runtime, base.classRef);
    const childShape = await instanceShape(runtime, child.classRef);
    assert.equal(baseShape.id, 'smalltalk/class/NativeBase/instance-shape');
    assert.equal(childShape.id, 'smalltalk/class/NativeChild/instance-shape');
    assert.deepEqual(baseShape.slots, [
      {id: 'smalltalk/class/NativeBase/instance-slot/YmFzZVZhbHVl', name: 'baseValue'},
    ]);
    assert.deepEqual(childShape.slots, [
      {id: 'smalltalk/class/NativeBase/instance-slot/YmFzZVZhbHVl', name: 'baseValue'},
      {id: 'smalltalk/class/NativeChild/instance-slot/Y2hpbGRGaXJzdA', name: 'childFirst'},
      {id: 'smalltalk/class/NativeChild/instance-slot/Y2hpbGRTZWNvbmQ', name: 'childSecond'},
    ]);
    assert.notEqual(childShape.slots[1].id, childShape.slots[1].name, 'slot identity is not its display name');

    const baseClassBefore = await runtime.images.getObject('app', base.classRef.objectId);
    const childClassBefore = await runtime.images.getObject('app', child.classRef.objectId);
    const frontierBefore = await runtime.images.frontier('app');

    const replayedBase = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeBase',
      instanceVariables: ['baseValue'],
    });
    const replayedChild = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeChild',
      superclassRef: replayedBase.classRef,
      instanceVariables: ['childFirst', 'childSecond'],
    });

    assert.deepEqual(replayedBase, base);
    assert.deepEqual(replayedChild, child);
    assert.equal(await runtime.images.frontier('app'), frontierBefore, 'exact replay must publish nothing');
    assert.equal((await runtime.images.getObject('app', base.classRef.objectId))._version, baseClassBefore._version);
    assert.equal((await runtime.images.getObject('app', child.classRef.objectId))._version, childClassBefore._version);
    assert.deepEqual(await instanceShape(runtime, child.classRef), childShape);
  });
});

test('a declaration with no local state reuses the inherited or kernel-empty Shape', async () => {
  await withRuntime(async (runtime) => {
    const empty = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeEmpty',
    });
    const base = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeStateful',
      instanceVariables: ['value'],
    });
    const leaf = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeLeaf',
      superclassRef: base.classRef,
    });

    assert.equal((await readBehavior(runtime.images, empty.classRef)).instanceShape.objectId, 'smalltalk/empty-shape/v1');
    assert.deepEqual(
      (await readBehavior(runtime.images, leaf.classRef)).instanceShape,
      (await readBehavior(runtime.images, base.classRef)).instanceShape,
    );
    assert.equal(
      await runtime.images.getShape('app', 'smalltalk/class/NativeLeaf/instance-shape'),
      null,
      'no local state must not mint a duplicate complete layout',
    );
  });
});

test('local declarations preserve an inherited indexed-values layout', async () => {
  await withRuntime(async (runtime) => {
    const parentShapeRef = await ensureSmalltalkShape(runtime.images, 'app', {
      id: 'indexed-parent-shape',
      slots: [{id: 'inherited-slot', name: 'inherited'}],
      indexed: SHAPE_INDEXED.VALUES,
    });
    const parent = await defineClass({
      images: runtime.images,
      imageId: 'app',
      name: 'IndexedParent',
      instanceShapeRef: parentShapeRef,
    });
    const child = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'IndexedChild',
      superclassRef: parent.classRef,
      instanceVariables: ['local'],
    });

    const shape = await instanceShape(runtime, child.classRef);
    assert.equal(shape.indexed, SHAPE_INDEXED.VALUES);
    assert.deepEqual(shape.slots, [
      {id: 'inherited-slot', name: 'inherited'},
      {id: 'smalltalk/class/IndexedChild/instance-slot/bG9jYWw', name: 'local'},
    ]);
  });
});

test('a divergent native declaration conflicts without overwriting its existing layout or class', async () => {
  await withRuntime(async (runtime) => {
    const original = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeConflict',
      instanceVariables: ['original'],
    });
    const shapeBefore = await instanceShape(runtime, original.classRef);
    const classBefore = await runtime.images.getObject('app', original.classRef.objectId);
    const frontierBefore = await runtime.images.frontier('app');

    await assert.rejects(
      ensureClassFromDeclaration({
        images: runtime.images,
        imageId: 'app',
        name: 'NativeConflict',
        instanceVariables: ['replacement'],
      }),
      (error) => error instanceof SmalltalkKernelConflictError
        && error.objectId === 'smalltalk/class/NativeConflict/instance-shape',
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore);
    assert.deepEqual(await instanceShape(runtime, original.classRef), shapeBefore);
    assert.deepEqual(await runtime.images.getObject('app', original.classRef.objectId), classBefore);
  });
});

test('a matching declaration Shape does not disguise a divergent existing Class', async () => {
  await withRuntime(async (runtime) => {
    const otherBase = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'OtherBase',
    });
    const original = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeClassConflict',
      superclassRef: otherBase.classRef,
      instanceVariables: ['value'],
    });
    const shapeBefore = await instanceShape(runtime, original.classRef);
    const classBefore = await runtime.images.getObject('app', original.classRef.objectId);
    const frontierBefore = await runtime.images.frontier('app');

    await assert.rejects(
      ensureClassFromDeclaration({
        images: runtime.images,
        imageId: 'app',
        name: 'NativeClassConflict',
        instanceVariables: ['value'],
      }),
      (error) => error instanceof SmalltalkKernelConflictError
        && error.objectId === 'smalltalk/class/NativeClassConflict',
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore);
    assert.deepEqual(await instanceShape(runtime, original.classRef), shapeBefore);
    assert.deepEqual(await runtime.images.getObject('app', original.classRef.objectId), classBefore);
  });
});

test('a local declaration cannot shadow inherited state and fails before publication', async () => {
  await withRuntime(async (runtime) => {
    const base = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'NativeParent',
      instanceVariables: ['shared'],
    });
    const frontierBefore = await runtime.images.frontier('app');

    await assert.rejects(
      ensureClassFromDeclaration({
        images: runtime.images,
        imageId: 'app',
        name: 'NativeShadow',
        superclassRef: base.classRef,
        instanceVariables: ['shared'],
      }),
      /duplicates inherited instance variable: shared/,
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore);
    assert.equal(await runtime.images.getShape('app', 'smalltalk/class/NativeShadow/instance-shape'), null);
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/NativeShadow'), null);
  });
});

test('a malformed inherited layout is refused before a child Shape is admitted', async () => {
  await withRuntime(async (runtime) => {
    const base = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'MalformedParent',
      instanceVariables: ['original'],
    });
    const malformed = await runtime.images.putShape('app', {
      id: 'malformed-inherited-shape',
      slots: [{id: 'one', name: 'duplicate'}, {id: 'two', name: 'duplicate'}],
    });
    const baseRecord = await runtime.images.getObject('app', base.classRef.objectId);
    await runtime.images.putObject('app', {
      id: baseRecord.id,
      shape: baseRecord.shape,
      behavior: baseRecord.behavior,
      slots: {
        ...baseRecord.slots,
        'behavior-instance-shape': objectRef('app', malformed.id),
      },
      metadata: baseRecord.metadata,
    }, {expectedVersion: baseRecord._version});
    const frontierBefore = await runtime.images.frontier('app');

    await assert.rejects(
      ensureClassFromDeclaration({
        images: runtime.images,
        imageId: 'app',
        name: 'MalformedChild',
        superclassRef: base.classRef,
        instanceVariables: ['local'],
      }),
      /inherited instance shape declares duplicate slot name: duplicate/,
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore);
    assert.equal(await runtime.images.getShape('app', 'smalltalk/class/MalformedChild/instance-shape'), null);
    assert.equal(await runtime.images.getObject('app', 'smalltalk/class/MalformedChild'), null);
  });
});

test('exhaustive-recovery: every write publishing a native class declaration converges on identical retry', async () => {
  const base = await forkableRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
  });
  try {
    const declaration = {
      imageId: 'app',
      name: 'NativeRecovered',
      instanceVariables: ['value'],
    };
    const total = await base.withFork(async (runtime) => {
      const {images, writeCount} = faultingImages(runtime.images);
      await ensureClassFromDeclaration({...declaration, images});
      return writeCount();
    });
    assert.ok(total > 3, `expected a multi-record class definition, saw ${total} writes`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await base.withFork(async (runtime) => {
          const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});
          await assert.rejects(
            ensureClassFromDeclaration({...declaration, images}),
            /injected/,
            `write ${failAt} (commitThenThrow=${commitThenThrow}) should fail`,
          );

          const recovered = await ensureClassFromDeclaration({...declaration, images: runtime.images});
          const shape = await instanceShape(runtime, recovered.classRef);
          assert.deepEqual(shape.slots, [
            {id: 'smalltalk/class/NativeRecovered/instance-slot/dmFsdWU', name: 'value'},
          ]);
          const ownRegistry = await runtime.images.getObject('app', subclassRegistryId('NativeRecovered'));
          assert.deepEqual(ownRegistry.indexed, []);
          const objectRegistry = await runtime.images.getObject('app', subclassRegistryId('Object'));
          assert.deepEqual(objectRegistry.indexed, [recovered.classRef]);
        });
      }
    }
  } finally {
    await base.close();
  }
});
