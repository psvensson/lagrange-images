import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0,
  ForeignRuntimeInstanceNotActiveError,
  ForeignRuntimeInstanceNotFoundError,
  ForeignRuntimeProviderNotFoundError,
  ForeignRuntimeProviderRegistrationError,
  ForeignRuntimeProviderRegistry,
  ForeignRuntimeService,
  createRuntime,
  integerValue,
} from '../src/runtime.js';

function fakeProvider({onCall = null} = {}) {
  const observed = {starts: [], calls: [], stops: []};
  const provider = Object.freeze({
    identity: 'fake-foreign-runtime/v1',
    async start(request, context) {
      observed.starts.push({request, context});
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.spec), true);
      assert.deepEqual(Object.keys(context), ['protocol']);
      return {
        handle: {started: true, calls: 0},
        metadata: {engine: 'fake', version: 1},
      };
    },
    async call(handle, request, context) {
      observed.calls.push({handle, request, context});
      handle.calls += 1;
      if (onCall) return await onCall(handle, request, context);
      const total = request.arguments.reduce((sum, value) => sum + BigInt(value.value), 0n);
      return integerValue(total);
    },
    async stop(handle, request, context) {
      observed.stops.push({handle, request, context});
      handle.stopped = true;
    },
  });
  return {provider, observed};
}

test('foreign runtime registry separates provider selection from stable provider identity', () => {
  const {provider} = fakeProvider();
  const registry = new ForeignRuntimeProviderRegistry();
  registry.register('smalltalk/default', provider);
  assert.equal(registry.get('smalltalk/default'), provider);
  assert.deepEqual(registry.list(), ['smalltalk/default']);
  assert.throws(() => registry.register('smalltalk/default', provider), ForeignRuntimeProviderRegistrationError);
  assert.throws(() => registry.get('missing'), ForeignRuntimeProviderNotFoundError);
});

test('foreign runtime service keeps provider handles private and returns canonical Values', async () => {
  const {provider, observed} = fakeProvider();
  const service = new ForeignRuntimeService({
    providers: new ForeignRuntimeProviderRegistry([['smalltalk/default', provider]]),
  });

  const instance = await service.start({
    providerId: 'smalltalk/default',
    spec: {runtime: 'cuis', imageArtifact: {kind: 'ref', imageId: 'demo', objectId: 'cuis-image'}},
  });
  assert.equal(instance.kind, 'foreign-runtime-instance');
  assert.equal(instance.providerId, 'smalltalk/default');
  assert.equal(instance.providerIdentity, 'fake-foreign-runtime/v1');
  assert.equal(instance.status, 'active');
  assert.deepEqual(instance.metadata, {engine: 'fake', version: 1});
  assert.equal(Object.hasOwn(instance, 'handle'), false);
  assert.equal(Object.hasOwn(instance, 'imageId'), false);
  assert.equal(Object.hasOwn(instance, 'objectId'), false);
  assert.equal(observed.starts[0].request.protocol, FOREIGN_RUNTIME_PROVIDER_PROTOCOL_V0);
  assert.equal(observed.starts[0].request.providerIdentity, provider.identity);

  const result = await service.call({
    runtimeId: instance.runtimeId,
    interface: {service: 'math', operation: 'add'},
    arguments: [integerValue(12), integerValue(30)],
  });
  assert.deepEqual(result, integerValue(42));
  assert.equal(observed.calls.length, 1);
  assert.equal(observed.calls[0].request.runtimeId, instance.runtimeId);
  assert.deepEqual(observed.calls[0].request.interface, {service: 'math', operation: 'add'});
  assert.equal(Object.isFrozen(observed.calls[0].request.interface), true);
  assert.equal(Object.isFrozen(observed.calls[0].request.arguments), true);
  assert.equal(observed.calls[0].request.providerIdentity, provider.identity);

  const privateHandle = observed.calls[0].handle;
  assert.equal(privateHandle.started, true);
  assert.equal(privateHandle.calls, 1);
  await service.stop(instance.runtimeId);
  assert.equal(observed.stops.length, 1);
  assert.equal(observed.stops[0].handle, privateHandle);
  assert.equal(privateHandle.stopped, true);
  assert.deepEqual(service.list(), []);
  assert.throws(() => service.get(instance.runtimeId), ForeignRuntimeInstanceNotFoundError);
});

test('invalid provider start results clean up an already-created opaque runtime handle', async () => {
  const handle = {started: true};
  let stopped = false;
  const provider = Object.freeze({
    identity: 'invalid-start/v1',
    async start() {
      return {
        handle,
        metadata: {bad: new Date()},
      };
    },
    async call() { return integerValue(0); },
    async stop(observedHandle) {
      assert.equal(observedHandle, handle);
      observedHandle.stopped = true;
      stopped = true;
    },
  });
  const service = new ForeignRuntimeService({
    providers: new ForeignRuntimeProviderRegistry([['invalid/default', provider]]),
  });
  await assert.rejects(
    service.start({providerId: 'invalid/default'}),
    /foreign runtime start metadata\.bad objects must be plain records/,
  );
  assert.equal(stopped, true);
  assert.equal(handle.stopped, true);
  assert.deepEqual(service.list(), []);
});

test('stop closes the call gate and waits for in-flight calls before provider shutdown', async () => {
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let providerStopped = false;
  const {provider} = fakeProvider({
    async onCall() {
      enteredResolve();
      await release;
      return integerValue(7);
    },
  });
  const wrapped = Object.freeze({
    ...provider,
    async stop(handle, request, context) {
      providerStopped = true;
      return await provider.stop(handle, request, context);
    },
  });
  const service = new ForeignRuntimeService({
    providers: new ForeignRuntimeProviderRegistry([['fake/default', wrapped]]),
  });
  const instance = await service.start({providerId: 'fake/default'});

  const callPromise = service.call({
    runtimeId: instance.runtimeId,
    interface: {operation: 'slow'},
    arguments: [],
  });
  await entered;
  const stopPromise = service.stop(instance.runtimeId);
  assert.equal(service.get(instance.runtimeId).status, 'stopping');
  assert.equal(providerStopped, false);
  await assert.rejects(
    service.call({runtimeId: instance.runtimeId, interface: {operation: 'late'}}),
    ForeignRuntimeInstanceNotActiveError,
  );

  releaseResolve();
  assert.deepEqual(await callPromise, integerValue(7));
  await stopPromise;
  assert.equal(providerStopped, true);
});

test('foreign runtime call results must be canonical Values', async () => {
  const provider = Object.freeze({
    identity: 'bad-result/v1',
    async start() { return {handle: {}}; },
    async call() { return 42; },
    async stop() {},
  });
  const service = new ForeignRuntimeService({
    providers: new ForeignRuntimeProviderRegistry([['bad/default', provider]]),
  });
  const instance = await service.start({providerId: 'bad/default'});
  await assert.rejects(
    service.call({runtimeId: instance.runtimeId, interface: {operation: 'bad'}}),
    TypeError,
  );
  await service.stop(instance.runtimeId);
});

test('createRuntime owns and closes active foreign runtimes before backend shutdown', async () => {
  const {provider, observed} = fakeProvider();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [['fake/default', provider]],
  });
  const first = await runtime.foreignRuntimes.start({providerId: 'fake/default', spec: {name: 'first'}});
  const second = await runtime.foreignRuntimes.start({providerId: 'fake/default', spec: {name: 'second'}});
  assert.equal(runtime.foreignRuntimeProviders.get('fake/default'), provider);
  assert.deepEqual(
    runtime.foreignRuntimes.list().map(({runtimeId}) => runtimeId).sort(),
    [first.runtimeId, second.runtimeId].sort(),
  );
  await runtime.close();
  assert.equal(observed.stops.length, 2);
});
