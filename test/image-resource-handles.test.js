import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ComponentHostImportRegistry,
  OBJECT_READ_OPERATION,
  WASM_COMPONENT_V1,
  booleanValue,
  bytesValue,
  createAuthorityService,
  createJcoComponentRuntime,
  createPreboundImageResourceProvider,
  createRuntime,
  installCallableInterface,
  installCallableInterfaceV2,
  installImageProjectionBinding,
  installWasmComponentBindingV2,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  textValue,
  unpackCompositeValue,
} from '../src/runtime.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const RESOURCE_COMPONENT = join(FIXTURES, 'image-resource-component', 'image-resource.component.wasm');
const IMAGE_OBJECTS_INTERFACE = 'lagrange:proof/image-objects';

const ITEM_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'quantity', type: 's64'},
      {name: 'enabled', type: 'bool'},
    ],
  },
});
const ITEM_FIELDS = [
  {name: 'name', slot: 'slot-name'},
  {name: 'quantity', slot: 'slot-quantity'},
  {name: 'enabled', slot: 'slot-enabled'},
];

const readGrant = (objectId) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('demo', objectId)});

async function seed({grants = null, declare = [IMAGE_OBJECTS_INTERFACE], register = true} = {}) {
  const authority = createAuthorityService();
  const hostImports = new ComponentHostImportRegistry();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    componentRuntime: createJcoComponentRuntime(),
    componentHostImports: hostImports,
  });
  await runtime.images.createImage({id: 'demo'});
  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-quantity', name: 'quantity'},
      {id: 'slot-enabled', name: 'enabled'},
    ],
  });
  await runtime.images.putObject('demo', {
    id: 'counter',
    shape: objectRef('demo', shape.id),
    slots: {'slot-name': textValue('Widget'), 'slot-quantity': integerValue(7), 'slot-enabled': booleanValue(true)},
  });

  // The prebound resource reuses an ordinary image-projection-binding/v1, so snapshot() has
  // exactly the semantics ADR 0039 already proved.
  const projectionInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'read-item',
    functionName: 'read-item', parameters: ['string'], result: 'item', types: ITEM_TYPES,
  });
  const projection = await installImageProjectionBinding({
    images: runtime.images,
    callableInterface: objectRef('demo', projectionInterface.id),
    fields: ITEM_FIELDS, bindingId: 'projection', blockId: 'projection-block',
  });
  if (register) {
    hostImports.register(IMAGE_OBJECTS_INTERFACE, createPreboundImageResourceProvider({
      images: runtime.images,
      projection: objectRef('demo', projection.bindingArtifact.id),
      objectId: 'counter',
    }));
  }

  const component = await runtime.images.putCodeArtifact('demo', {
    id: 'component', representation: WASM_COMPONENT_V1,
    content: bytesValue(await readFile(RESOURCE_COMPONENT)), languageId: 'rust',
  });
  const blocks = {};
  for (const [id, functionName] of Object.entries({
    readOnce: 'read-once', readTwice: 'read-twice', twoHandles: 'two-handles',
    dropThenUseOther: 'drop-then-use-other', trapAfterRead: 'trap-after-read',
  })) {
    const callableInterface = await installCallableInterface({
      images: runtime.images, imageId: 'demo', interfaceId: `${id}-iface`,
      functionName, parameters: [], result: 'string',
    });
    const binding = await installWasmComponentBindingV2({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      hostImports: declare,
      bindingId: `${id}-binding`, blockId: `${id}-block`,
    });
    blocks[id] = objectRef('demo', binding.block.id);
  }

  const context = grants === null ? null : authority.issue({principal: 'alice', grants});
  const call = async (name) => {
    const activation = await runtime.invocations.invokeBlock(blocks[name], []);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  return {runtime, authority, context, call, projection, hostImports};
}

// Case 1
test('opening or using a handle is denied without authority', async () => {
  const {runtime, call} = await seed({grants: null});
  try {
    await assert.rejects(call('readOnce'), /no authority context was supplied/);
  } finally {
    await runtime.close();
  }

  const ungranted = await seed({grants: [readGrant('somewhere-else')]});
  try {
    await assert.rejects(ungranted.call('readOnce'), /not authorized: object\/read/);
  } finally {
    await ungranted.runtime.close();
  }
});

// Case 2
test('repeated reads through one handle succeed', async () => {
  const {runtime, call} = await seed({grants: [readGrant('counter')]});
  try {
    assert.deepEqual(await call('readOnce'), textValue('Widget|7|true'));
    // Two snapshot() calls through the same handle, each independently authorized.
    assert.deepEqual(await call('readTwice'), textValue('Widget|7|true#Widget|7|true'));
  } finally {
    await runtime.close();
  }
});

// Case 3
test('revoking between two calls fails the second, not the first', async () => {
  const {runtime, authority, context, call} = await seed({grants: [readGrant('counter')]});
  try {
    assert.deepEqual(await call('readOnce'), textValue('Widget|7|true'));
    authority.revoke(context);
    // A handle is not a cached authorization: the next method re-runs require and is refused.
    await assert.rejects(call('readTwice'), /authority revoked/);
  } finally {
    await runtime.close();
  }
});

// Cases 4 and 5
test('two handles are distinct identities on the same object, and dropping one is local', async () => {
  const {runtime, call} = await seed({grants: [readGrant('counter')]});
  try {
    // Two handles, both observing the same underlying object.
    assert.deepEqual(await call('twoHandles'), textValue('Widget|7|true#Widget|7|true'));
    // One dropped, the other still usable: handle ownership is not object ownership.
    assert.deepEqual(await call('dropThenUseOther'), textValue('Widget|7|true'));

    // And nothing durable changed as a result of any drop.
    const object = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(object.slots['slot-name'], textValue('Widget'));
    assert.deepEqual(object.slots['slot-quantity'], integerValue(7));
  } finally {
    await runtime.close();
  }
});

// Case 6
test('a handle is not a Value and cannot leave the lane', async () => {
  const {runtime, call, hostImports} = await seed({grants: [readGrant('counter')]});
  try {
    // The Block result is an ordinary canonical Value; the handle never appears in it.
    const result = await call('readOnce');
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'value']);
    assert.equal(result.kind, 'text');

    // Reach the handle class directly and confirm an instance is not a canonical Value:
    // no kind, and it cannot be packed, stored or canonicalized.
    const seen = [];
    const implementation = await hostImports.create(IMAGE_OBJECTS_INTERFACE, {
      require: (demand) => { seen.push(demand); },
    });
    const handle = implementation.openItem();
    assert.equal(handle.kind, undefined, 'a handle must not look like a tagged Value');
    assert.throws(() => bytesValue(handle), /ArrayBuffer|typed-array/);
    await assert.rejects(
      runtime.images.putObject('demo', {
        id: 'holder', shape: objectRef('demo', 'item-shape'), slots: {'slot-name': handle},
      }),
      // The canonicalizer refuses it outright: a handle is not a Value kind at all.
      /unknown value kind/,
    );
    assert.deepEqual(seen, [{operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'counter')}]);
  } finally {
    await runtime.close();
  }
});

// Case 7 — the load-bearing one.
test('after the activation, a retained handle and a retained require are both dead', async () => {
  const {runtime, hostImports} = await seed({grants: [readGrant('counter')]});
  try {
    // Capture the executor context's require exactly as an executor would, then let the
    // activation finish.
    const captured = {};
    const probeRuntime = await createRuntime({
      backend: {mode: 'mock'},
      authority: createAuthorityService(),
      codeExecutors: {'capture/v0': {async execute(_i, context) {
        captured.require = context.require;
        return textValue('ok');
      }}},
    });
    try {
      await probeRuntime.images.createImage({id: 'demo'});
      const code = await probeRuntime.images.putCodeArtifact('demo', {
        id: 'c', representation: 'capture/v0', content: textValue('{}'),
      });
      await probeRuntime.images.putBlock('demo', {id: 'b', code: objectRef('demo', code.id), environment: null});
      const grant = {operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'counter')};
      const context = probeRuntime.authority.issue({principal: 'alice', grants: [grant]});
      const activation = await probeRuntime.invocations.invokeBlock(objectRef('demo', 'b'), []);
      await probeRuntime.executor.execute(activation, {authority: context});

      // A handle built over that same expired require is dead through the very same lifetime
      // record: one mechanism, not two.
      const implementation = await hostImports.create(IMAGE_OBJECTS_INTERFACE, {require: captured.require});
      assert.throws(() => implementation.openItem(), /does not outlive the activation/);
      assert.throws(() => captured.require(grant), /does not outlive the activation/);
    } finally {
      await probeRuntime.close();
    }
  } finally {
    await runtime.close();
  }
});

// Case 8
test('a trapping Component leaves nothing usable behind', async () => {
  const {runtime, call} = await seed({grants: [readGrant('counter')]});
  try {
    // The guest reads successfully, then panics. jco does not dispose the guest's handles on a
    // trap, which is exactly why cleanup is the activation's job rather than the drop's.
    await assert.rejects(call('trapAfterRead'), /unreachable|RuntimeError|trap/i);
    // The activation still completed, so a subsequent one is unaffected.
    assert.deepEqual(await call('readOnce'), textValue('Widget|7|true'));
    // And nothing durable was disturbed.
    const object = await runtime.images.getObject('demo', 'counter');
    assert.deepEqual(object.slots['slot-quantity'], integerValue(7));
  } finally {
    await runtime.close();
  }
});

// Case 9
test('a handle carries identity only, never a principal, grant or context', async () => {
  const {runtime, hostImports} = await seed({grants: [readGrant('counter')]});
  try {
    const implementation = await hostImports.create(IMAGE_OBJECTS_INTERFACE, {require: () => {}});
    const handle = implementation.openItem();
    // Nothing enumerable at all: identity is host-private, and there is no authority on it.
    assert.deepEqual(Object.keys(handle), []);
    const serialised = JSON.stringify(handle);
    assert.equal(serialised, '{}');
    for (const leak of ['alice', 'principal', 'grant', 'authority', 'demo', 'counter']) {
      assert.ok(!JSON.stringify({...handle}).toLowerCase().includes(leak), `handle leaked ${leak}`);
    }
    // The interface's own surface is only the class and the opener.
    assert.deepEqual(Object.keys(implementation).sort(), ['Item', 'openItem']);
  } finally {
    await runtime.close();
  }
});

test('a dropped handle is unusable even while authority remains valid', async () => {
  const {runtime, hostImports} = await seed({grants: [readGrant('counter')]});
  try {
    const implementation = await hostImports.create(IMAGE_OBJECTS_INTERFACE, {require: () => {}});
    const handle = implementation.openItem();
    assert.deepEqual(handle.snapshot(), {name: 'Widget', quantity: 7n, enabled: true});
    // Dropped-ness is independent of authority: revocation and destruction stay distinct.
    handle[Symbol.dispose ?? Symbol.for('dispose')]();
    assert.throws(() => handle.snapshot(), /has been dropped/);
  } finally {
    await runtime.close();
  }
});

// Case 10
test('projection and ordinary Component paths are unaffected', async () => {
  const {runtime, projection} = await seed({grants: [readGrant('counter')]});
  try {
    // The same projection binding still works as an ordinary callable Block.
    const context = runtime.authority.issue({principal: 'alice', grants: [readGrant('counter')]});
    const activation = await runtime.invocations.invokeBlock(
      objectRef('demo', projection.block.id), [textValue('counter')],
    );
    const packed = await runtime.executor.execute(activation, {authority: context});
    assert.deepEqual(unpackCompositeValue(packed, 'item', ITEM_TYPES), {
      name: 'Widget', quantity: 7n, enabled: true,
    });
  } finally {
    await runtime.close();
  }
});

test('a component requiring the resource interface still needs it declared', async () => {
  const {runtime, call} = await seed({grants: [readGrant('counter')], declare: []});
  try {
    await assert.rejects(call('readOnce'), {name: 'UndeclaredHostImportError'});
  } finally {
    await runtime.close();
  }

  const unavailable = await seed({grants: [readGrant('counter')], register: false});
  try {
    await assert.rejects(unavailable.call('readOnce'), {name: 'HostImportUnavailableError'});
  } finally {
    await unavailable.runtime.close();
  }
});
