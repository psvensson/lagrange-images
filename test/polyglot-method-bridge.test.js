import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  OBJECT_READ_OPERATION,
  SYMMETRIC_SMALLTALK_ID,
  WASM_COMPONENT_V1,
  booleanValue,
  bytesValue,
  createAuthorityService,
  createJcoComponentRuntime,
  createRuntime,
  defineClass,
  definePolyglotMethodBridge,
  installCallableInterfaceV2,
  installImageProjectionBinding,
  installImageVersionedProjectionBinding,
  installSmalltalkAllocationProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installWasmComponentBinding,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  polyglotMethodBridgeDescriptor,
  textValue,
  unpackCompositeValue,
} from '../src/runtime.js';

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'normalize-component', 'normalize.component.wasm',
);

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

test('definePolyglotMethodBridge attaches a WASM Component callable to a native Smalltalk class in both lanes without violating assertBlockApplicationReceiver', async (t) => {
  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    componentRuntime: createJcoComponentRuntime(),
  });
  t.after(async () => runtime.close());

  await runtime.images.createImage({id: 'app'});
  await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
  await installSmalltalkAllocationProtocol({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    lane: 'neutral',
  });

  const shape = await runtime.images.putShape('app', {
    id: 'item-shape',
    slots: [
      {id: 'slot-name', name: 'name'},
      {id: 'slot-quantity', name: 'quantity'},
      {id: 'slot-enabled', name: 'enabled'},
    ],
  });
  const itemClass = await defineClass({
    images: runtime.images,
    imageId: 'app',
    name: 'InventoryItem',
    instanceShapeRef: objectRef('app', shape.id),
  });

  const component = await runtime.images.putCodeArtifact('app', {
    id: 'normalize-component',
    representation: WASM_COMPONENT_V1,
    content: bytesValue(await readFile(COMPONENT_PATH)),
    languageId: 'rust',
  });
  const relabelInterface = await installCallableInterfaceV2({
    images: runtime.images,
    imageId: 'app',
    interfaceId: 'relabel',
    functionName: 'relabel',
    parameters: ['item'],
    result: 'item',
    types: ITEM_TYPES,
  });
  const componentBinding = await installWasmComponentBinding({
    images: runtime.images,
    callableInterface: objectRef('app', relabelInterface.id),
    component: objectRef('app', component.id),
    bindingId: 'relabel-binding',
    blockId: 'relabel-block',
  });

  // Install polyglot bridge methods in both neutral and WASM lanes.
  await definePolyglotMethodBridge({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    classRef: itemClass.classRef,
    selector: 'relabelComposite:',
    callableBlockRef: objectRef('app', componentBinding.block.id),
    lane: 'neutral',
  });
  await definePolyglotMethodBridge({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    classRef: itemClass.classRef,
    selector: 'relabelCompositeWasm:',
    callableBlockRef: objectRef('app', componentBinding.block.id),
    lane: 'wasm',
  });

  // Replay is idempotent.
  await definePolyglotMethodBridge({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    classRef: itemClass.classRef,
    selector: 'relabelComposite:',
    callableBlockRef: objectRef('app', componentBinding.block.id),
    lane: 'neutral',
  });

  await runtime.images.putObject('app', {
    id: 'item-1',
    shape: objectRef('app', shape.id),
    behavior: itemClass.classRef,
    slots: {
      'slot-name': textValue('  Polyglot  Widget  '),
      'slot-quantity': integerValue(12),
      'slot-enabled': booleanValue(true),
    },
  });

  const readInterface = await installCallableInterfaceV2({
    images: runtime.images,
    imageId: 'app',
    interfaceId: 'read-item',
    functionName: 'read-item',
    parameters: ['string'],
    result: 'item',
    types: ITEM_TYPES,
  });
  await installImageProjectionBinding({
    images: runtime.images,
    callableInterface: objectRef('app', readInterface.id),
    fields: [
      {name: 'name', slot: 'slot-name'},
      {name: 'quantity', slot: 'slot-quantity'},
      {name: 'enabled', slot: 'slot-enabled'},
    ],
    bindingId: 'read-item-binding',
    blockId: 'read-item-block',
  });

  const context = authority.issue({
    principal: 'alice',
    grants: [{operation: OBJECT_READ_OPERATION, resource: objectResource('app', 'item-1')}],
  });
  const projected = await runtime.executor.execute(
    await runtime.invocations.invokeBlock(objectRef('app', 'read-item-block'), [textValue('item-1')]),
    {authority: context},
  );

  // Send ordinary Smalltalk message `relabelComposite:` and `relabelCompositeWasm:` to `item-1`.
  for (const selector of ['relabelComposite:', 'relabelCompositeWasm:']) {
    const caller = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'app',
      id: `call-${selector}`,
      source: `[ :receiver :payload | receiver ${selector} payload ]`,
    });
    const result = await runtime.executor.execute(
      await runtime.invocations.invokeBlock(
        objectRef('app', caller.block.id),
        [objectRef('app', 'item-1'), projected],
      ),
    );
    assert.deepEqual(unpackCompositeValue(result, 'item', ITEM_TYPES), {
      name: 'polyglot widget',
      quantity: 12n,
      enabled: false,
    });
  }

  // Validation: invalid selector or non-ref target is rejected before any write.
  assert.throws(
    () => polyglotMethodBridgeDescriptor({
      selector: 'bad:selector',
      callableBlockRef: objectRef('app', componentBinding.block.id),
    }),
    /invalid Smalltalk selector/,
  );
});

test('image-versioned-projection-binding/v1 projects indexed: true list<leaf> fields alongside the version token', async (t) => {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  t.after(async () => runtime.close());

  await runtime.images.createImage({id: 'app'});
  const shape = await runtime.images.putShape('app', {
    id: 'series-shape',
    slots: [{id: 'slot-label', name: 'label'}],
    indexed: 'values',
  });
  await runtime.images.putObject('app', {
    id: 'series-1',
    shape: objectRef('app', shape.id),
    slots: {'slot-label': textValue('temps')},
    indexed: [integerValue(21), integerValue(22)],
  });

  const versionedTypes = normalizeTypeDeclarations({
    series: {
      kind: 'record',
      fields: [
        {name: 'label', type: 'string'},
        {name: 'samples', type: {kind: 'list', element: 's64'}},
      ],
    },
    'versioned-series': {
      kind: 'record',
      fields: [
        {name: 'version-token', type: 'string'},
        {name: 'value', type: 'series'},
      ],
    },
  });
  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images,
    imageId: 'app',
    interfaceId: 'read-versioned-series',
    functionName: 'read-versioned-series',
    parameters: ['string'],
    result: 'versioned-series',
    types: versionedTypes,
  });
  await installImageVersionedProjectionBinding({
    images: runtime.images,
    callableInterface: objectRef('app', callableInterface.id),
    fields: [
      {name: 'label', slot: 'slot-label'},
      {name: 'samples', indexed: true},
    ],
    bindingId: 'read-versioned-series-binding',
    blockId: 'read-versioned-series-block',
  });

  const context = authority.issue({
    principal: 'alice',
    grants: [{operation: OBJECT_READ_OPERATION, resource: objectResource('app', 'series-1')}],
  });
  const packed = await runtime.executor.execute(
    await runtime.invocations.invokeBlock(
      objectRef('app', 'read-versioned-series-block'),
      [textValue('series-1')],
    ),
    {authority: context},
  );
  const unpacked = unpackCompositeValue(packed, 'versioned-series', versionedTypes);
  assert.equal(typeof unpacked['version-token'], 'string');
  assert.ok(unpacked['version-token'].length > 0);
  assert.deepEqual(unpacked.value, {
    label: 'temps',
    samples: [21n, 22n],
  });
});
