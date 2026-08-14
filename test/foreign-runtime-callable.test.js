import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
  FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE,
  FOREIGN_RUNTIME_VALUE_CALL_V0,
  ForeignRuntimeDefinitionBindingNotFoundError,
  booleanValue,
  createRuntime,
  installForeignRuntimeCallable,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

class RecordingProvider {
  constructor({startDelayMs = 0} = {}) {
    this.identity = 'recording-runtime/v0';
    this.startDelayMs = startDelayMs;
    this.starts = [];
    this.calls = [];
    this.stops = [];
  }

  async start(request) {
    this.starts.push(request);
    if (this.startDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    }
    return {
      handle: {runtimeId: request.runtimeId},
      metadata: {definition: request.spec.runtimeDefinition.root.ref},
    };
  }

  async call(handle, request) {
    this.calls.push({handle, request});
    if (request.interface.service === 'math' && request.interface.operation === 'add') {
      return integerValue(BigInt(request.arguments[0].value) + BigInt(request.arguments[1].value));
    }
    if (request.interface.service === 'proof' && request.interface.operation === 'true') {
      return booleanValue(true);
    }
    throw new TypeError('unsupported recording provider interface');
  }

  async stop(handle) {
    this.stops.push(handle);
  }
}

async function putDefinition(runtime, id = 'definition') {
  return await runtime.images.putCodeArtifact('runtime-image', {
    id,
    representation: 'example/runtime-definition-v1',
    content: textValue('definition/v0'),
  });
}

test('foreign runtime callable installs an ordinary Block and lazily reuses one runtime instance', async () => {
  const provider = new RecordingProvider({startDelayMs: 5});
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [['test/recording', provider]],
    foreignRuntimeDefinitionBindings: [['example/runtime-definition-v1', 'test/recording']],
  });
  let closed = false;
  try {
    await runtime.images.createImage({id: 'runtime-image'});
    const definition = await putDefinition(runtime);
    const {interfaceArtifact, block} = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('runtime-image', definition.id),
      interface: {service: 'math', operation: 'add'},
      argumentCount: 2,
      interfaceId: 'math-add-interface',
      blockId: 'math-add-block',
    });

    assert.equal(interfaceArtifact.representation, FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1);
    assert.deepEqual(interfaceArtifact.dependencies, [{
      role: FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE,
      artifact: objectRef('runtime-image', definition.id),
    }]);
    assert.deepEqual(JSON.parse(interfaceArtifact.content.value), {
      abi: FOREIGN_RUNTIME_VALUE_CALL_V0,
      argumentCount: 2,
      interface: {operation: 'add', service: 'math'},
    });
    assert.equal(interfaceArtifact.content.value.includes('test/recording'), false);
    assert.deepEqual(block.code, objectRef('runtime-image', interfaceArtifact.id));
    assert.equal(block.environment, null);
    assert.equal(provider.starts.length, 0);

    const blockRef = objectRef('runtime-image', block.id);
    const activations = await Promise.all([
      runtime.invocations.invokeBlock(blockRef, [integerValue(12), integerValue(30)]),
      runtime.invocations.invokeBlock(blockRef, [integerValue(1), integerValue(2)]),
    ]);
    const [first, second] = await Promise.all(activations.map((activation) => runtime.executor.execute(activation)));
    assert.deepEqual(first, integerValue(42));
    assert.deepEqual(second, integerValue(3));
    assert.equal(provider.starts.length, 1);
    assert.equal(provider.calls.length, 2);
    assert.equal(runtime.foreignRuntimes.list().length, 1);

    const thirdActivation = await runtime.invocations.invokeBlock(blockRef, [integerValue(20), integerValue(22)]);
    assert.deepEqual(await runtime.executor.execute(thirdActivation), integerValue(42));
    assert.equal(provider.starts.length, 1);
    assert.equal(provider.calls.length, 3);

    await runtime.close();
    closed = true;
    assert.equal(provider.stops.length, 1);
    assert.equal(runtime.foreignRuntimeInstanceCache.entries.size, 0);
  } finally {
    if (!closed) await runtime.close();
  }
});

test('foreign runtime callable validates arity before starting a runtime', async () => {
  const provider = new RecordingProvider();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [['test/recording', provider]],
    foreignRuntimeDefinitionBindings: [['example/runtime-definition-v1', 'test/recording']],
  });
  try {
    await runtime.images.createImage({id: 'runtime-image'});
    const definition = await putDefinition(runtime);
    const {block} = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('runtime-image', definition.id),
      interface: {service: 'math', operation: 'add'},
      argumentCount: 2,
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('runtime-image', block.id), [integerValue(1)]);
    await assert.rejects(runtime.executor.execute(activation), /expected 2 arguments, got 1/);
    assert.equal(provider.starts.length, 0);
  } finally {
    await runtime.close();
  }
});

test('foreign runtime provider binding is runtime-local rather than durable callable data', async () => {
  const provider = new RecordingProvider();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [['test/recording', provider]],
  });
  try {
    await runtime.images.createImage({id: 'runtime-image'});
    const definition = await putDefinition(runtime);
    const {interfaceArtifact, block} = await installForeignRuntimeCallable({
      images: runtime.images,
      runtimeDefinition: objectRef('runtime-image', definition.id),
      interface: {service: 'proof', operation: 'true'},
      argumentCount: 0,
    });
    assert.equal(JSON.stringify(interfaceArtifact).includes('test/recording'), false);

    const activation = await runtime.invocations.invokeBlock(objectRef('runtime-image', block.id), []);
    await assert.rejects(
      runtime.executor.execute(activation),
      ForeignRuntimeDefinitionBindingNotFoundError,
    );
    assert.equal(provider.starts.length, 0);

    runtime.foreignRuntimeDefinitionBindings.register('example/runtime-definition-v1', 'test/recording');
    assert.deepEqual(await runtime.executor.execute(activation), booleanValue(true));
    assert.equal(provider.starts.length, 1);
  } finally {
    await runtime.close();
  }
});

test('foreign-runtime-value-call/v0 interface data is frozen JSON-compatible plain data', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'runtime-image'});
    const definition = await putDefinition(runtime);
    await assert.rejects(
      installForeignRuntimeCallable({
        images: runtime.images,
        runtimeDefinition: objectRef('runtime-image', definition.id),
        interface: {service: 'bad', version: 1n},
        argumentCount: 0,
      }),
      /JSON-compatible/,
    );
  } finally {
    await runtime.close();
  }
});
