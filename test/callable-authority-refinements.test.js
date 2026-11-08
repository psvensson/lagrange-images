import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  AuthorityError,
  ComponentHostImportRegistry,
  ComponentInstanceResetContractError,
  DroppedResourceHandleError,
  ExpiredForeignRuntimeCallAuthorityError,
  FOREIGN_RUNTIME_CALL_OPERATION,
  FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0,
  OBJECT_READ_OPERATION,
  UndeclaredAsyncHostEffectError,
  WASM_COMPONENT_INSTANCE_REUSE_NONE,
  WASM_COMPONENT_INSTANCE_REUSE_RESET_V1,
  WASM_COMPONENT_V1,
  booleanValue,
  bytesValue,
  createAuthorityService,
  createJcoComponentRuntime,
  createPreboundImageResourceProvider,
  createRuntime,
  foreignRuntimeCallResource,
  installCallableInterface,
  installCallableInterfaceV2,
  installForeignRuntimeBinding,
  installForeignRuntimeCallable,
  installImageProjectionBinding,
  installWasmComponentBindingV2,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  parseForeignRuntimeCallResource,
  textValue,
} from '../src/runtime.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const HOST_READER = join(FIXTURES, 'host-values-component', 'host-values.component.wasm');

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

test('per-call resource reads: snapshotAsync, refresh, and perCallRead observe live object mutations under per-call authority', async () => {
  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
  });
  try {
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
      slots: {
        'slot-name': textValue('Widget'),
        'slot-quantity': integerValue(7),
        'slot-enabled': booleanValue(true),
      },
    });

    const projectionInterface = await installCallableInterfaceV2({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'read-item',
      functionName: 'read-item',
      parameters: ['string'],
      result: 'item',
      types: ITEM_TYPES,
    });
    const projection = await installImageProjectionBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', projectionInterface.id),
      fields: ITEM_FIELDS,
      bindingId: 'projection',
      blockId: 'projection-block',
    });

    const grant = {operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'counter')};
    const context = authority.issue({principal: 'alice', grants: [grant]});

    const provider = createPreboundImageResourceProvider({
      images: runtime.images,
      projection: objectRef('demo', projection.bindingArtifact.id),
      objectId: 'counter',
    });
    const impl = await provider({require: (demand) => authority.require(context, demand)});
    assert.deepEqual(Object.keys(impl).sort(), ['Item', 'openItem']);

    const handle = impl.openItem();
    assert.deepEqual(Object.keys(handle), []);
    assert.deepEqual(handle.snapshot(), {name: 'Widget', quantity: 7n, enabled: true});

    // Mutate the underlying image object after the handle is already open.
    await runtime.images.putObject('demo', {
      id: 'counter',
      shape: objectRef('demo', shape.id),
      slots: {
        'slot-name': textValue('Widget-v2'),
        'slot-quantity': integerValue(42),
        'slot-enabled': booleanValue(false),
      },
    });

    // Synchronous snapshot still sees the cached wiring snapshot until refreshed, whereas
    // snapshotAsync performs a fresh per-call read and updates the handle's view.
    assert.deepEqual(handle.snapshot(), {name: 'Widget', quantity: 7n, enabled: true});
    assert.deepEqual(await handle.snapshotAsync(), {name: 'Widget-v2', quantity: 42n, enabled: false});
    assert.deepEqual(handle.snapshot(), {name: 'Widget-v2', quantity: 42n, enabled: false});

    // Mutate again and verify refresh() updates synchronous snapshot().
    await runtime.images.putObject('demo', {
      id: 'counter',
      shape: objectRef('demo', shape.id),
      slots: {
        'slot-name': textValue('Widget-v3'),
        'slot-quantity': integerValue(99),
        'slot-enabled': booleanValue(true),
      },
    });
    await handle.refresh();
    assert.deepEqual(handle.snapshot(), {name: 'Widget-v3', quantity: 99n, enabled: true});

    // perCallRead: true makes snapshot() itself return a per-call async read without pre-fetching.
    const asyncProvider = createPreboundImageResourceProvider({
      images: runtime.images,
      projection: objectRef('demo', projection.bindingArtifact.id),
      objectId: 'counter',
      perCallRead: true,
    });
    const asyncImpl = await asyncProvider({require: (demand) => authority.require(context, demand)});
    const asyncHandle = asyncImpl.openItem();
    assert.deepEqual(await asyncHandle.snapshot(), {name: 'Widget-v3', quantity: 99n, enabled: true});

    // Revoking authority denies subsequent per-call snapshotAsync() and refresh() calls.
    authority.revoke(context);
    await assert.rejects(handle.snapshotAsync(), /authority revoked/);
    await assert.rejects(handle.refresh(), /authority revoked/);
    await assert.rejects(asyncHandle.snapshot(), /authority revoked/);

    // Dropping the handle surfaces DroppedResourceHandleError before authority checks.
    handle[Symbol.dispose ?? Symbol.for('dispose')]();
    await assert.rejects(handle.snapshotAsync(), DroppedResourceHandleError);
    await assert.rejects(handle.refresh(), DroppedResourceHandleError);
  } finally {
    await runtime.close();
  }
});

test('delegated/attenuated host import authority and explicit async foreign callback contracts', async () => {
  const HOST_VALUES_INTERFACE = 'lagrange:proof/host-values';
  const READ = 'host-value/read';
  const WRITE = 'host-value/write';
  const STORE = {'public-message': 'hello', 'private-message': 'secret'};
  const seenProviderArgs = [];

  const authority = createAuthorityService();
  const hostImports = new ComponentHostImportRegistry();
  // Attenuate this host import at registration so even if the caller holds private-message or
  // write authority, this import specifier is only delegated READ on public-message.
  hostImports.register(
    HOST_VALUES_INTERFACE,
    ({require, ...rest}) => {
      seenProviderArgs.push(['require', ...Object.keys(rest)].sort());
      return {
        readValue(name) {
          require({operation: READ, resource: name});
          return STORE[name] ?? '';
        },
        writeValue(name, val) {
          require({operation: WRITE, resource: name});
          STORE[name] = val;
        },
      };
    },
    {
      allowedOperations: [READ],
      allowedResources: ['public-message'],
    },
  );

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    componentRuntime: createJcoComponentRuntime(),
    componentHostImports: hostImports,
  });
  try {
    await runtime.images.createImage({id: 'demo'});
    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(await readFile(HOST_READER)),
      languageId: 'rust',
    });
    const callableInterface = await installCallableInterface({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'iface',
      functionName: 'read-host-value',
      parameters: ['string'],
      result: 'string',
    });
    await installWasmComponentBindingV2({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      hostImports: [HOST_VALUES_INTERFACE],
      bindingId: 'binding',
      blockId: 'block',
    });

    // Caller holds broad grants (both public-message and private-message, plus WRITE).
    const broadContext = authority.issue({
      principal: 'alice',
      grants: [
        {operation: READ, resource: 'public-message'},
        {operation: READ, resource: 'private-message'},
        {operation: WRITE, resource: 'public-message'},
      ],
    });

    const pubAct = await runtime.invocations.invokeBlock(objectRef('demo', 'block'), [textValue('public-message')]);
    assert.deepEqual(await runtime.executor.execute(pubAct, {authority: broadContext}), textValue('hello'));
    assert.deepEqual(seenProviderArgs, [['require']]);

    // Calling private-message through the same import is denied by import attenuation even though
    // the caller's context holds private-message.
    const privAct = await runtime.invocations.invokeBlock(objectRef('demo', 'block'), [textValue('private-message')]);
    await assert.rejects(
      runtime.executor.execute(privAct, {authority: broadContext}),
      (err) => err instanceof AuthorityError && /not delegated resource/.test(err.message),
    );

    // Direct registry check for operation attenuation and async effect contracts:
    const directImpl = await hostImports.create(HOST_VALUES_INTERFACE, {
      require: (demand) => authority.require(broadContext, demand),
    });
    assert.throws(
      () => directImpl.writeValue('public-message', 'tampered'),
      (err) => err instanceof AuthorityError && /not delegated operation/.test(err.message),
    );

    // Async foreign callback contract: undeclared async effect is rejected when asyncEffects: false.
    hostImports.register(
      'lagrange:proof/async-effects',
      ({require}) => ({
        async fetchAsync(resource) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          require({operation: READ, resource});
          return STORE[resource] ?? '';
        },
      }),
      {asyncEffects: false, allowedOperations: [READ]},
    );
    const syncOnlyImpl = await hostImports.create('lagrange:proof/async-effects', {
      require: (demand) => authority.require(broadContext, demand),
    });
    assert.throws(
      () => syncOnlyImpl.fetchAsync('public-message'),
      UndeclaredAsyncHostEffectError,
    );

    // When asyncEffects: true is explicitly contracted, async callbacks work and enforce live
    // authority across await boundaries.
    const asyncImpl = await hostImports.create('lagrange:proof/async-effects', {
      require: (demand) => authority.require(broadContext, demand),
      asyncEffects: true,
      allowedResources: ['public-message'],
    });
    assert.equal(await asyncImpl.fetchAsync('public-message'), 'hello');
    await assert.rejects(
      asyncImpl.fetchAsync('private-message'),
      (err) => err instanceof AuthorityError && /not delegated resource/.test(err.message),
    );
  } finally {
    await runtime.close();
  }
});

test('reusable WASM Component instance/reset contract rebinds per-activation authority and evicts on missing reset or trap', async () => {
  const HOST_VALUES_INTERFACE = 'lagrange:proof/host-values';
  const READ = 'host-value/read';
  const STORE = {'public-message': 'hello', 'private-message': 'secret'};

  // First prove that the real jco runtime rejects stateless-reset-v1 on a Component that does
  // not export lagrange-reset / reset, and records the eviction in poolStats.
  const jcoRuntime = createJcoComponentRuntime();
  const authority = createAuthorityService();
  const hostImports = new ComponentHostImportRegistry([
    [HOST_VALUES_INTERFACE, ({require}) => ({
      readValue(name) {
        require({operation: READ, resource: name});
        return STORE[name] ?? '';
      },
    })],
  ]);
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    componentRuntime: jcoRuntime,
    componentHostImports: hostImports,
  });
  try {
    await runtime.images.createImage({id: 'demo'});
    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(await readFile(HOST_READER)),
      languageId: 'rust',
    });
    const callableInterface = await installCallableInterface({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'iface',
      functionName: 'read-host-value',
      parameters: ['string'],
      result: 'string',
    });
    // Default binding (fresh-per-activation):
    await installWasmComponentBindingV2({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      hostImports: [HOST_VALUES_INTERFACE],
      bindingId: 'fresh-binding',
      blockId: 'fresh-block',
    });
    // Opt-in reusable binding on a component without reset export -> fails closed:
    await installWasmComponentBindingV2({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      hostImports: [HOST_VALUES_INTERFACE],
      bindingId: 'reuse-no-reset-binding',
      blockId: 'reuse-no-reset-block',
      bindingMetadata: {instanceReuse: WASM_COMPONENT_INSTANCE_REUSE_RESET_V1},
    });

    const ctx = authority.issue({
      principal: 'alice',
      grants: [{operation: READ, resource: 'public-message'}],
    });
    const act1 = await runtime.invocations.invokeBlock(objectRef('demo', 'fresh-block'), [textValue('public-message')]);
    const act2 = await runtime.invocations.invokeBlock(objectRef('demo', 'fresh-block'), [textValue('public-message')]);
    assert.deepEqual(await runtime.executor.execute(act1, {authority: ctx}), textValue('hello'));
    assert.deepEqual(await runtime.executor.execute(act2, {authority: ctx}), textValue('hello'));
    assert.deepEqual(jcoRuntime.poolStats(component), {
      instantiations: 2,
      reuses: 0,
      resets: 0,
      evictions: 0,
      idleCount: 0,
    });

    const actNoReset = await runtime.invocations.invokeBlock(
      objectRef('demo', 'reuse-no-reset-block'),
      [textValue('public-message')],
    );
    await assert.rejects(
      runtime.executor.execute(actNoReset, {authority: ctx}),
      ComponentInstanceResetContractError,
    );
    assert.equal(jcoRuntime.poolStats(component).evictions, 1);
    assert.equal(jcoRuntime.poolStats(component).idleCount, 0);
  } finally {
    await runtime.close();
  }

  // Now prove a Component with an explicit lagrangeReset / reset export reuses the instance,
  // clears guest state on every reset, rebinds host imports per activation without leaking
  // authority across activations, and evicts on trap.
  let instantiations = 0;
  let resets = 0;
  let reuses = 0;
  let evictions = 0;
  const idlePool = [];
  let leakedImportRef = null;

  const resettableComponentRuntime = {
    async requiredImports() {
      return [HOST_VALUES_INTERFACE];
    },
    async invoke(_component, functionName, args, imports, options = {}) {
      const mode = options.instanceReuse ?? WASM_COMPONENT_INSTANCE_REUSE_NONE;
      let entry = mode === WASM_COMPONENT_INSTANCE_REUSE_RESET_V1 ? (idlePool.pop() ?? null) : null;
      if (entry) {
        reuses += 1;
      } else {
        instantiations += 1;
        const holder = {currentImports: null};
        const guestState = {dirtyScratch: 0};
        const instance = {
          readHostValue(name) {
            if (name === 'trap') throw new Error('guest wasm trap');
            if (name === 'stash-import') {
              leakedImportRef = () => {
                const current = holder.currentImports?.[HOST_VALUES_INTERFACE];
                if (!current) throw new TypeError('host import accessed outside an active invocation');
                return current.readValue('public-message');
              };
            }
            guestState.dirtyScratch += 1;
            const current = holder.currentImports?.[HOST_VALUES_INTERFACE];
            if (!current) throw new TypeError('host import accessed outside an active invocation');
            return `${current.readValue(name)}#${guestState.dirtyScratch}`;
          },
          lagrangeReset() {
            guestState.dirtyScratch = 0;
          },
        };
        entry = {instance, holder, guestState};
      }
      entry.holder.currentImports = imports;
      let ok = false;
      try {
        const fn = entry.instance[functionName === 'read-host-value' ? 'readHostValue' : functionName];
        const out = await fn(...args);
        if (mode === WASM_COMPONENT_INSTANCE_REUSE_RESET_V1) {
          entry.instance.lagrangeReset();
          resets += 1;
        }
        ok = true;
        return out;
      } finally {
        entry.holder.currentImports = null;
        if (mode === WASM_COMPONENT_INSTANCE_REUSE_RESET_V1) {
          if (ok) idlePool.push(entry);
          else evictions += 1;
        }
      }
    },
  };

  const r2Authority = createAuthorityService();
  const r2Imports = new ComponentHostImportRegistry([
    [HOST_VALUES_INTERFACE, ({require}) => ({
      readValue(name) {
        require({operation: READ, resource: name});
        return STORE[name] ?? '';
      },
    })],
  ]);
  const r2 = await createRuntime({
    backend: {mode: 'mock'},
    authority: r2Authority,
    componentRuntime: resettableComponentRuntime,
    componentHostImports: r2Imports,
  });
  try {
    await r2.images.createImage({id: 'demo'});
    const component = await r2.images.putCodeArtifact('demo', {
      id: 'component',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(await readFile(HOST_READER)),
      languageId: 'rust',
    });
    const callableInterface = await installCallableInterface({
      images: r2.images,
      imageId: 'demo',
      interfaceId: 'iface',
      functionName: 'read-host-value',
      parameters: ['string'],
      result: 'string',
    });
    await installWasmComponentBindingV2({
      images: r2.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      hostImports: [HOST_VALUES_INTERFACE],
      bindingId: 'reuse-binding',
      blockId: 'reuse-block',
      bindingMetadata: {instanceReuse: WASM_COMPONENT_INSTANCE_REUSE_RESET_V1},
    });

    const aliceCtx = r2Authority.issue({
      principal: 'alice',
      grants: [{operation: READ, resource: 'public-message'}, {operation: READ, resource: 'stash-import'}],
    });
    const bobCtx = r2Authority.issue({
      principal: 'bob',
      grants: [],
    });

    // Activation 1 (alice): instantiates once, resets scratch to 0 after returning.
    const a1 = await r2.invocations.invokeBlock(objectRef('demo', 'reuse-block'), [textValue('public-message')]);
    assert.deepEqual(await r2.executor.execute(a1, {authority: aliceCtx}), textValue('hello#1'));
    assert.equal(instantiations, 1);
    assert.equal(reuses, 0);
    assert.equal(resets, 1);

    // Activation 2 (alice): reuses the same instance, sees dirtyScratch reset to 0 (#1, not #2),
    // and stashes a closure trying to reach holder.currentImports after return.
    const a2 = await r2.invocations.invokeBlock(objectRef('demo', 'reuse-block'), [textValue('stash-import')]);
    assert.deepEqual(await r2.executor.execute(a2, {authority: aliceCtx}), textValue('#1'));
    assert.equal(instantiations, 1);
    assert.equal(reuses, 1);
    assert.equal(resets, 2);
    assert.throws(() => leakedImportRef(), /outside an active invocation/);

    // Activation 3 (bob, no grants): reuses the same instance, but host imports are rebound to
    // bob's authority — alice's prior grant never carries over!
    const a3 = await r2.invocations.invokeBlock(objectRef('demo', 'reuse-block'), [textValue('public-message')]);
    await assert.rejects(
      r2.executor.execute(a3, {authority: bobCtx}),
      (err) => err instanceof AuthorityError && /not authorized/.test(err.message),
    );
    assert.equal(evictions, 1);
    assert.equal(idlePool.length, 0);
  } finally {
    await r2.close();
  }
});

test('per-call authority transport for long-lived foreign runtimes enforces call-scoped authority without leaking across calls', async () => {
  // Verify injective foreignRuntimeCallResource round-trip with tricky delimiters.
  const rA = foreignRuntimeCallResource('img.a/b', 'def.c', {service: 's.1', operation: 'op/2'});
  const rB = foreignRuntimeCallResource('img.a', 'b/def.c', {service: 's.1', operation: 'op/2'});
  assert.notEqual(rA, rB);
  assert.deepEqual(parseForeignRuntimeCallResource(rA), {
    imageId: 'img.a/b',
    definitionId: 'def.c',
    target: {operation: 'op/2', service: 's.1'},
  });

  const observedStarts = [];
  const observedCalls = [];
  const observedStops = [];
  let stashedRequireFromCall1 = null;

  const provider = Object.freeze({
    identity: 'long-lived-foreign/v1',
    async start(request, context) {
      observedStarts.push({request, contextKeys: Object.keys(context).sort()});
      return {
        handle: {runtimeId: request.runtimeId},
        metadata: {longLived: true},
      };
    },
    async call(handle, request, context) {
      observedCalls.push({handle, request, contextKeys: Object.keys(context).sort()});
      if (typeof context.require === 'function') {
        if (!stashedRequireFromCall1) stashedRequireFromCall1 = context.require;
        // Provider performs an additional fine-grained per-call object/read check using the
        // call-scoped require callback transported for this individual call.
        context.require({
          operation: OBJECT_READ_OPERATION,
          resource: objectResource('demo', `doc-${request.arguments[0].value}`),
        });
      }
      return integerValue(BigInt(request.arguments[0].value) * 10n);
    },
    async stop(handle, request, context) {
      observedStops.push({handle, request, contextKeys: Object.keys(context).sort()});
    },
  });

  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    foreignRuntimeProviders: [['test/long-lived', provider]],
    foreignRuntimeDefinitionBindings: [['example/runtime-definition-v1', 'test/long-lived']],
  });
  try {
    await runtime.images.createImage({id: 'demo'});
    const definition = await runtime.images.putCodeArtifact('demo', {
      id: 'foreign-def',
      representation: 'example/runtime-definition-v1',
      content: textValue('definition/v0'),
    });
    const callableInterface = await installCallableInterface({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'compute-iface',
      functionName: 'compute',
      parameters: ['s64'],
      result: 's64',
    });
    const target = {service: 'vault', operation: 'compute'};
    const binding = await installForeignRuntimeBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      runtimeDefinition: objectRef('demo', definition.id),
      target,
      bindingId: 'vault-binding',
      blockId: 'vault-block',
      bindingMetadata: {requireCallAuthority: true},
    });

    // Also install a v1 callable artifact with requireCallAuthority to prove both executors.
    const legacyCallable = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('demo', definition.id),
      interface: target,
      argumentCount: 1,
      interfaceId: 'legacy-vault-iface',
      blockId: 'legacy-vault-block',
      interfaceMetadata: {requireCallAuthority: true},
    });

    const callGrant = {
      operation: FOREIGN_RUNTIME_CALL_OPERATION,
      resource: foreignRuntimeCallResource('demo', definition.id, target),
    };
    const doc1Grant = {operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'doc-1')};
    const doc2Grant = {operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'doc-2')};

    // 1. Without authority context, the call is rejected BEFORE starting the foreign runtime.
    const unauthAct = await runtime.invocations.invokeBlock(
      objectRef('demo', binding.block.id),
      [integerValue(1)],
    );
    await assert.rejects(runtime.executor.execute(unauthAct), /no authority context was supplied/);
    assert.equal(observedStarts.length, 0);

    // 2. Caller 1 (alice) has callGrant + doc-1, but not doc-2.
    const aliceCtx = authority.issue({principal: 'alice', grants: [callGrant, doc1Grant]});
    const aliceAct1 = await runtime.invocations.invokeBlock(
      objectRef('demo', binding.block.id),
      [integerValue(1)],
    );
    assert.deepEqual(await runtime.executor.execute(aliceAct1, {authority: aliceCtx}), integerValue(10));
    assert.equal(observedStarts.length, 1);
    assert.deepEqual(observedStarts[0].contextKeys, ['protocol']);
    assert.deepEqual(observedCalls[0].contextKeys, ['protocol', 'require']);

    // Stashed require from Call 1 is already expired as soon as Call 1 completed!
    assert.equal(typeof stashedRequireFromCall1, 'function');
    assert.throws(() => stashedRequireFromCall1(doc1Grant), ExpiredForeignRuntimeCallAuthorityError);

    // Alice trying to access doc-2 on the same long-lived runtime fails the provider's per-call check.
    const aliceAct2 = await runtime.invocations.invokeBlock(
      objectRef('demo', binding.block.id),
      [integerValue(2)],
    );
    await assert.rejects(
      runtime.executor.execute(aliceAct2, {authority: aliceCtx}),
      (err) => err instanceof AuthorityError && /not authorized: object\/read/.test(err.message),
    );
    // Still the single long-lived foreign runtime instance!
    assert.equal(observedStarts.length, 1);

    // 3. Caller 2 (bob) has callGrant + doc-2, and succeeds on the SAME long-lived runtime instance
    // through the legacy foreign-runtime-callable-interface/v1 executor as well.
    const bobCtx = authority.issue({principal: 'bob', grants: [callGrant, doc2Grant]});
    const bobAct = await runtime.invocations.invokeBlock(
      objectRef('demo', legacyCallable.block.id),
      [integerValue(2)],
    );
    assert.deepEqual(await runtime.executor.execute(bobAct, {authority: bobCtx}), integerValue(20));
    assert.equal(observedStarts.length, 1);

    // 4. Revoking bob's authority immediately denies the next call on that same runtime instance.
    authority.revoke(bobCtx);
    const bobRevokedAct = await runtime.invocations.invokeBlock(
      objectRef('demo', legacyCallable.block.id),
      [integerValue(2)],
    );
    await assert.rejects(
      runtime.executor.execute(bobRevokedAct, {authority: bobCtx}),
      (err) => err instanceof AuthorityError && /authority revoked/.test(err.message),
    );
  } finally {
    await runtime.close();
  }
  // And stop() receives only ['protocol'], never authority.
  assert.equal(observedStops.length, 1);
  assert.deepEqual(observedStops[0].contextKeys, ['protocol']);
  assert.equal(observedStops[0].request.protocol, FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0);
});
