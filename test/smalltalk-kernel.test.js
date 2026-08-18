import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MockBackend,
  createRuntime,
  installSymmetricSmalltalkBlock,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {TupleSet} from '../src/support/tuple-map.js';
import {
  BEHAVIOR_SHAPE_ID,
  SMALLTALK_KERNEL_OBJECT_ID,
  SMALLTALK_KERNEL_PROTOCOL_V1,
  findSmalltalkKernel,
  installSmalltalkKernel,
  isBehaviorObject,
  methodDictionarySlots,
  readBehavior,
} from '../src/language/smalltalk-kernel.js';

// ADR 0044's first landing: identity only. Nothing here dispatches — execution starts depending on
// the kernel once dispatch-image context exists.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'boot'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

const behaviorOf = async (images, ref) => (await images.getObject(ref.imageId, ref.objectId)).behavior;
const nameOf = async (images, ref) => (await readBehavior(images, ref)).name.value;

async function superclassChain(images, ref) {
  const names = [];
  let current = ref;
  // A TupleSet, not a joined string: image and object ids are arbitrary non-empty text, so this is
  // the same non-injectivity PR #61 removed everywhere else.
  const seen = new TupleSet(2);
  while (names.length < 16) {
    const key = [current.imageId, current.objectId];
    if (seen.has(key)) throw new Error('superclass cycle');
    seen.add(key);
    const behavior = await readBehavior(images, current);
    names.push(behavior.name.value);
    if (behavior.superclass.objectId === 'smalltalk/nil') return [...names, 'nil'];
    current = behavior.superclass;
  }
  throw new Error('superclass chain did not terminate');
}

// The point of a *durable* kernel. Returning refs from the installer is not enough: those die with
// the process while the image survives, so this rediscovers through a second ImageService built
// over the same backend, holding nothing from the first.
test('the kernel is rediscovered from an image id alone, with no retained refs', async () => {
  const backend = new MockBackend({integration: {selectedBy: 'explicit'}});
  await backend.start();
  try {
    const installer = new ImageService({backend});
    await installer.createImage({id: 'boot'});
    await installSmalltalkKernel({images: installer, imageId: 'boot'});

    const rediscovered = new ImageService({backend});
    const kernel = await findSmalltalkKernel({images: rediscovered, imageId: 'boot'});
    assert.equal(kernel.protocol, SMALLTALK_KERNEL_PROTOCOL_V1);
    for (const name of ['nil', 'true', 'false', 'objectClass', 'integerClass', 'booleanClass',
      'floatClass', 'textClass', 'byteArrayClass', 'classClass', 'metaclassClass']) {
      assert.equal(kernel[name].kind, 'ref', `${name} must be reachable from the kernel`);
    }
    // The knot still resolves through the second service, so it is graph data rather than
    // process state.
    const metaclassMeta = await behaviorOf(rediscovered, kernel.metaclassClass);
    assert.equal(
      (await behaviorOf(rediscovered, metaclassMeta)).objectId,
      kernel.metaclassClass.objectId,
    );
  } finally {
    await backend.stop();
  }
});

test('an uninstalled image has no kernel rather than a broken one', async () => {
  await withRuntime(async (runtime) => {
    assert.equal(await findSmalltalkKernel({images: runtime.images, imageId: 'boot'}), null);
  });
});

test('an object squatting the kernel id without the protocol is rejected', async () => {
  await withRuntime(async (runtime) => {
    const shape = await runtime.images.putShape('boot', {id: 'imposter-shape', slots: []});
    await runtime.images.putObject('boot', {
      id: SMALLTALK_KERNEL_OBJECT_ID,
      shape: objectRef('boot', shape.id),
      slots: {},
    });
    await assert.rejects(
      findSmalltalkKernel({images: runtime.images, imageId: 'boot'}),
      /does not declare smalltalk-kernel\/v1/,
    );
  });
});

// The knot is what distinguishes a real Smalltalk from a prototype table, and it is a genuine graph
// cycle: putObject validates the shape but neither `behavior` nor ref-valued slots, so the
// bootstrap can create these in any order and close the loop.
test('the metaclass knot installs and resolves', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const images = runtime.images;

    const integerMeta = await behaviorOf(images, kernel.integerClass);
    assert.equal(await nameOf(images, integerMeta), 'Integer class');
    assert.equal(await nameOf(images, await behaviorOf(images, integerMeta)), 'Metaclass');

    const metaclassMeta = await behaviorOf(images, kernel.metaclassClass);
    assert.equal(await nameOf(images, metaclassMeta), 'Metaclass class');
    assert.equal(
      (await behaviorOf(images, metaclassMeta)).objectId,
      kernel.metaclassClass.objectId,
      'behavior(Metaclass class) must be Metaclass — the knot',
    );
  });
});

// Decision 4. Without this the instance side inherits and the class side silently does not.
test('the metaclass chain parallels the class chain and terminates at Class', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const images = runtime.images;

    assert.deepEqual(await superclassChain(images, kernel.integerClass), ['Integer', 'Object', 'nil']);
    assert.deepEqual(
      await superclassChain(images, await behaviorOf(images, kernel.integerClass)),
      ['Integer class', 'Object class', 'Class', 'Object', 'nil'],
    );
    // The root case: Object superclass is nil, but Object class superclass is Class, not nil.
    assert.deepEqual(
      await superclassChain(images, await behaviorOf(images, kernel.objectClass)),
      ['Object class', 'Class', 'Object', 'nil'],
    );
    // A deeper instance-side chain carries through to the class side unchanged in shape.
    const trueClass = (await runtime.images.getObject('boot', 'smalltalk/true')).behavior;
    assert.deepEqual(await superclassChain(images, trueClass), ['True', 'Boolean', 'Object', 'nil']);
    assert.deepEqual(
      await superclassChain(images, await behaviorOf(images, trueClass)),
      ['True class', 'Boolean class', 'Object class', 'Class', 'Object', 'nil'],
    );
  });
});

// Decision 2. Generic Shapes reject duplicate slot *ids* and say nothing about names, so this is a
// MethodDictionary invariant and not a Shape one.
test('a method dictionary rejects duplicate selectors instead of letting one win', () => {
  const slots = methodDictionarySlots(['+', 'value:']);
  assert.deepEqual(slots.map(({name}) => name), ['+', 'value:']);
  assert.equal(new Set(slots.map(({id}) => id)).size, 2, 'slot ids must be distinct too');
  assert.throws(() => methodDictionarySlots(['+', '+']), /duplicate selector/);
  assert.throws(() => methodDictionarySlots(['']), /must be non-empty text/);
});

test('generic shapes still permit duplicate slot names, which is why the rule lives here', async () => {
  await withRuntime(async (runtime) => {
    // Not a defect in Shape — other users have slot names that are not selectors.
    const shape = await runtime.images.putShape('boot', {
      id: 'ambiguous',
      slots: [{id: 'a', name: 'dup'}, {id: 'b', name: 'dup'}],
    });
    assert.equal(shape.slots.length, 2);
  });
});

test('a fixed-shape Behavior is distinguishable from a legacy behavior record', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const behavior = await runtime.images.getObject('boot', kernel.integerClass.objectId);
    assert.equal(isBehaviorObject(behavior), true);
    assert.equal(behavior.shape.objectId, BEHAVIOR_SHAPE_ID);

    const legacyShape = await runtime.images.putShape('boot', {
      id: 'legacy-behavior-shape',
      slots: [{id: 'method-echo', name: 'echo:'}],
    });
    await runtime.images.putObject('boot', {
      id: 'LegacyBehavior',
      shape: objectRef('boot', legacyShape.id),
      slots: {'method-echo': objectRef('boot', 'anything')},
    });
    const legacy = await runtime.images.getObject('boot', 'LegacyBehavior');
    assert.equal(isBehaviorObject(legacy), false);
  });
});

// ADR 0044 decision 10, and the reason this PR has this shape. The legacy convention is durable
// graph data: installing the kernel must not change what an already-stored object means.
test('installing the kernel leaves legacy behavior dispatch unchanged', async () => {
  await withRuntime(async (runtime) => {
    await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'boot', id: 'echo-method', source: '[ :value | value ]',
    });
    const behaviorShape = await runtime.images.putShape('boot', {
      id: 'echo-behavior-shape', slots: [{id: 'method-echo', name: 'echo:'}],
    });
    await runtime.images.putObject('boot', {
      id: 'EchoBehavior',
      shape: objectRef('boot', behaviorShape.id),
      slots: {'method-echo': objectRef('boot', 'echo-method')},
    });
    const receiverShape = await runtime.images.putShape('boot', {id: 'receiver-shape', slots: []});
    await runtime.images.putObject('boot', {
      id: 'receiver', shape: objectRef('boot', receiverShape.id),
      behavior: objectRef('boot', 'EchoBehavior'), slots: {},
    });
    const caller = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'boot', id: 'caller',
      source: "[ :target | target echo: 'hello' ]",
    });

    const send = async () => {
      const activation = await runtime.invocations.invokeBlock(
        objectRef('boot', caller.block.id), [objectRef('boot', 'receiver')],
      );
      return await runtime.executor.execute(activation);
    };

    const before = await send();
    assert.deepEqual(before, textValue('hello'));

    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});

    const after = await send();
    assert.deepEqual(after, before, 'the kernel must not reinterpret an existing behavior record');
    // And the record itself is untouched, so nothing migrated by side effect.
    const stored = await runtime.images.getObject('boot', 'EchoBehavior');
    assert.equal(stored.shape.objectId, 'echo-behavior-shape');
    assert.equal(stored._version, 1);
  });
});

// Bootstrap must be safe on a populated image and restartable after a partial failure, because
// putObject and putShape are upserts: a plain write would silently replace an existing
// `smalltalk/nil` or `Integer`.
test('installing twice is a no-op rather than an overwrite', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const first = await runtime.images.getObject('boot', 'smalltalk/nil');
    const firstKernel = await runtime.images.getObject('boot', SMALLTALK_KERNEL_OBJECT_ID);

    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const second = await runtime.images.getObject('boot', 'smalltalk/nil');
    const secondKernel = await runtime.images.getObject('boot', SMALLTALK_KERNEL_OBJECT_ID);

    assert.equal(second._version, first._version, 'a reinstall must not rewrite existing records');
    assert.equal(secondKernel._version, firstKernel._version);
  });
});

test('installation resumes after a partial failure', async () => {
  await withRuntime(async (runtime) => {
    // Stop the installer once the shapes and singletons exist but no classes do.
    const failing = {
      ...runtime.images,
      putShape: (...args) => runtime.images.putShape(...args),
      getShape: (...args) => runtime.images.getShape(...args),
      getObject: (...args) => runtime.images.getObject(...args),
      putObject: async (imageId, input, options) => {
        if (String(input.id).startsWith('smalltalk/metaclass/')) throw new Error('backend went away');
        return await runtime.images.putObject(imageId, input, options);
      },
    };
    await assert.rejects(
      installSmalltalkKernel({images: failing, imageId: 'boot'}),
      /backend went away/,
    );
    assert.notEqual(await runtime.images.getObject('boot', 'smalltalk/nil'), null);
    assert.equal(await runtime.images.getObject('boot', SMALLTALK_KERNEL_OBJECT_ID), null);

    // A plain retry now succeeds, reusing what is already there.
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    assert.equal(kernel.protocol, SMALLTALK_KERNEL_PROTOCOL_V1);
  });
});

test('a conflicting object at a kernel id is refused, not overwritten', async () => {
  await withRuntime(async (runtime) => {
    const shape = await runtime.images.putShape('boot', {id: 'squatter-shape', slots: []});
    await runtime.images.putObject('boot', {
      id: 'smalltalk/nil',
      shape: objectRef('boot', shape.id),
      slots: {},
      metadata: {mine: 'not the kernel'},
    });
    await assert.rejects(
      installSmalltalkKernel({images: runtime.images, imageId: 'boot'}),
      (error) => error.name === 'SmalltalkKernelConflictError' && /refusing to overwrite/.test(error.message),
    );
    const survived = await runtime.images.getObject('boot', 'smalltalk/nil');
    assert.equal(survived.metadata.mine, 'not the kernel');
  });
});

// Cross-image shape refs are legal, so an object id alone is not identity.
test('a foreign behavior shape does not make a record a Behavior', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'other'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'other'});
    const shapeOfOther = objectRef('other', BEHAVIOR_SHAPE_ID);
    await runtime.images.putObject('boot', {
      id: 'foreign-shaped',
      shape: shapeOfOther,
      slots: {
        'behavior-name': textValue('Impostor'),
        'behavior-superclass': objectRef('other', 'smalltalk/nil'),
        'behavior-methods': objectRef('other', 'smalltalk/nil'),
        'behavior-instance-shape': objectRef('other', 'smalltalk/nil'),
      },
    });
    const record = await runtime.images.getObject('boot', 'foreign-shaped');
    assert.equal(record.shape.objectId, BEHAVIOR_SHAPE_ID);
    assert.equal(isBehaviorObject(record), false, 'the shape must be local to count');
  });
});

test('a kernel object without the kernel shape is refused', async () => {
  await withRuntime(async (runtime) => {
    const shape = await runtime.images.putShape('boot', {id: 'wrong-kernel-shape', slots: []});
    await runtime.images.putObject('boot', {
      id: SMALLTALK_KERNEL_OBJECT_ID,
      shape: objectRef('boot', shape.id),
      slots: {},
      metadata: {protocol: SMALLTALK_KERNEL_PROTOCOL_V1},
    });
    await assert.rejects(
      findSmalltalkKernel({images: runtime.images, imageId: 'boot'}),
      /does not have shape smalltalk\/kernel-shape\/v1/,
    );
  });
});

test('readBehavior rejects a malformed fixed-shape record before dispatch relies on it', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    await runtime.images.putObject('boot', {
      id: 'bent-behavior',
      shape: objectRef('boot', BEHAVIOR_SHAPE_ID),
      slots: {
        'behavior-name': objectRef('boot', 'smalltalk/nil'),
        'behavior-superclass': objectRef('boot', 'smalltalk/nil'),
        'behavior-methods': objectRef('boot', 'smalltalk/nil'),
        'behavior-instance-shape': objectRef('boot', 'smalltalk/nil'),
      },
    });
    await assert.rejects(
      readBehavior(runtime.images, objectRef('boot', 'bent-behavior')),
      /name must be a text Value/,
    );
  });
});
