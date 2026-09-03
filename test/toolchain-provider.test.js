import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLCHAIN_PROVIDER_PROTOCOL_V0,
  ToolchainProviderNotFoundError,
  ToolchainProviderRegistrationError,
  ToolchainProviderRegistry,
  bytesValue,
  createRuntime,
  objectRef,
  referencesOfRecord,
  textValue,
} from '../src/runtime.js';

async function putArtifact(runtime, id, {
  representation = 'example/artifact-v1',
  content = textValue(id),
  dependencies = [],
  derivedFrom = [],
  languageId = null,
} = {}) {
  return await runtime.images.putCodeArtifact('demo', {
    id,
    languageId,
    representation,
    content,
    dependencies,
    derivedFrom,
  });
}

test('artifact dependencies point to existing artifacts and stay separate from provenance', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  try {
    const library = await putArtifact(runtime, 'library', {
      representation: 'java/jar-v1',
      content: bytesValue(new Uint8Array([1, 2, 3])),
    });
    const source = await putArtifact(runtime, 'source', {
      representation: 'rust/source-v1',
      content: textValue('fn main() {}'),
      dependencies: [{role: 'library', artifact: objectRef('demo', library.id)}],
    });
    assert.deepEqual(source.dependencies, [{role: 'library', artifact: objectRef('demo', library.id)}]);
    assert.deepEqual(source.derivedFrom, []);
    assert.deepEqual(referencesOfRecord(source), [objectRef('demo', library.id)]);

    await assert.rejects(
      runtime.images.putCodeArtifact('demo', {
        id: 'missing-dependency',
        representation: 'example/source-v1',
        content: textValue('x'),
        dependencies: [{role: 'library', artifact: objectRef('demo', 'does-not-exist')}],
      }),
      /must reference a code-artifact/,
    );
  } finally {
    await runtime.close();
  }
});

test('toolchain provider registry uses selection ids separate from stable provider identity', () => {
  const provider = Object.freeze({identity: 'example-toolchain/v1', async run() { return {outputs: []}; }});
  const registry = new ToolchainProviderRegistry();
  registry.register('example/default', provider);
  assert.equal(registry.get('example/default'), provider);
  assert.deepEqual(registry.list(), ['example/default']);
  assert.throws(() => registry.register('example/default', provider), ToolchainProviderRegistrationError);
  assert.throws(() => registry.get('missing'), ToolchainProviderNotFoundError);
});

test('toolchain service resolves dependency graph and persists provider outputs with explicit provenance', async () => {
  let observedRequest = null;
  let observedContext = null;
  const provider = Object.freeze({
    identity: 'example-external-toolchain/v7',
    async run(request, context) {
      observedRequest = request;
      observedContext = context;
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.roots), true);
      assert.equal(Object.isFrozen(request.artifacts), true);
      assert.equal(Object.isFrozen(request.artifacts[0].artifact), true);
      return {
        outputs: [
          {
            name: 'module',
            languageId: 'example-language',
            representation: 'example/executable-v1',
            content: textValue('compiled-module'),
            dependencies: [{role: 'runtime', artifact: objectRef('demo', 'library')}],
            metadata: {entry: 'main'},
          },
          {
            name: 'interface',
            representation: 'example/interface-v1',
            content: textValue('main(i32) -> i32'),
          },
        ],
        diagnostics: [{severity: 'note', message: 'compiled cleanly'}],
      };
    },
  });

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [['example/default', provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const historical = await putArtifact(runtime, 'historical-source', {
      representation: 'example/source-history-v1',
      content: textValue('previous source'),
    });
    const library = await putArtifact(runtime, 'library', {
      representation: 'java/jar-v1',
      content: bytesValue(new Uint8Array([0xca, 0xfe])),
    });
    const lock = await putArtifact(runtime, 'lock', {
      representation: 'example/lock-v1',
      content: textValue('locked=1'),
    });
    const manifest = await putArtifact(runtime, 'manifest', {
      representation: 'example/manifest-v1',
      content: textValue('package=demo'),
      dependencies: [
        {role: 'lock', artifact: objectRef('demo', lock.id)},
        {role: 'library', artifact: objectRef('demo', library.id)},
      ],
    });
    const source = await putArtifact(runtime, 'source', {
      representation: 'example/source-v1',
      content: textValue('main'),
      dependencies: [
        {role: 'manifest', artifact: objectRef('demo', manifest.id)},
        {role: 'library', artifact: objectRef('demo', library.id)},
      ],
      derivedFrom: [objectRef('demo', historical.id)],
    });

    const result = await runtime.toolchains.run({
      providerId: 'example/default',
      imageId: 'demo',
      roots: [objectRef('demo', source.id)],
      target: {representation: 'example/executable-v1', abi: 'example-abi/v1'},
      options: {optimize: true},
      outputIds: {module: 'compiled-module', interface: 'compiled-interface'},
    });

    assert.equal(observedRequest.protocol, TOOLCHAIN_PROVIDER_PROTOCOL_V0);
    assert.equal(observedRequest.providerId, 'example/default');
    assert.equal(observedRequest.toolchainIdentity, 'example-external-toolchain/v7');
    assert.deepEqual(observedRequest.target, {representation: 'example/executable-v1', abi: 'example-abi/v1'});
    assert.deepEqual(observedRequest.options, {optimize: true});
    assert.deepEqual(
      observedRequest.artifacts.map(({ref}) => ref.objectId),
      ['source', 'manifest', 'lock', 'library'],
    );
    assert.equal(observedRequest.artifacts.some(({ref}) => ref.objectId === historical.id), false);
    assert.deepEqual(observedRequest.roots.map(({ref}) => ref.objectId), ['source']);
    assert.deepEqual(Object.keys(observedContext), ['protocol']);
    assert.equal(observedContext.protocol, TOOLCHAIN_PROVIDER_PROTOCOL_V0);

    const sourceSnapshot = observedRequest.artifacts[0].artifact;
    assert.deepEqual(
      Object.keys(sourceSnapshot).sort(),
      ['kind', 'id', 'imageId', 'languageId', 'representation', 'content', 'logicalPath', 'dependencies', 'metadata'].sort(),
    );
    assert.equal(Object.hasOwn(sourceSnapshot, 'derivedFrom'), false);
    assert.equal(Object.hasOwn(sourceSnapshot, 'updatedAt'), false);
    assert.equal(Object.hasOwn(sourceSnapshot, '_version'), false);

    assert.deepEqual(result.inputs.map(({objectId}) => objectId), ['source', 'manifest', 'lock', 'library']);
    assert.deepEqual(result.diagnostics, [{severity: 'note', message: 'compiled cleanly'}]);
    assert.deepEqual(result.outputs.map(({name}) => name), ['module', 'interface']);

    const module = await runtime.images.getCodeArtifact('demo', 'compiled-module');
    const iface = await runtime.images.getCodeArtifact('demo', 'compiled-interface');
    const provenance = ['source', 'manifest', 'lock', 'library'].map((id) => objectRef('demo', id));
    assert.deepEqual(module.derivedFrom, provenance);
    assert.deepEqual(iface.derivedFrom, provenance);
    assert.equal(module.derivedFrom.some(({objectId}) => objectId === historical.id), false);
    assert.deepEqual(module.dependencies, [{role: 'runtime', artifact: objectRef('demo', 'library')}]);
    assert.deepEqual(iface.dependencies, []);
    assert.equal(module.metadata.entry, 'main');
    assert.equal(module.metadata.toolchainProviderId, 'example/default');
    assert.equal(module.metadata.toolchainIdentity, 'example-external-toolchain/v7');
    assert.equal(module.metadata.toolchainProtocol, TOOLCHAIN_PROVIDER_PROTOCOL_V0);
    assert.equal(JSON.stringify(module.metadata).includes('compiled cleanly'), false);
    assert.deepEqual(referencesOfRecord(module), [objectRef('demo', 'library'), ...provenance]);
  } finally {
    await runtime.close();
  }
});

test('invalid output image fails before the provider runs', async () => {
  let calls = 0;
  const provider = Object.freeze({
    identity: 'image-preflight-provider/v1',
    async run() {
      calls += 1;
      return {outputs: [{name: 'out', representation: 'example/output-v1', content: textValue('out')}]};
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [['preflight/default', provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await putArtifact(runtime, 'source');
    await assert.rejects(
      runtime.toolchains.run({
        providerId: 'preflight/default',
        imageId: 'missing-image',
        roots: [objectRef('demo', source.id)],
      }),
      /image not found/,
    );
    assert.equal(calls, 0);
  } finally {
    await runtime.close();
  }
});

test('toolchain output dependency validation happens before output writes', async () => {
  const provider = Object.freeze({
    identity: 'bad-output-provider/v1',
    async run() {
      return {
        outputs: [{
          name: 'bad',
          representation: 'example/output-v1',
          content: textValue('bad'),
          dependencies: [{role: 'runtime', artifact: objectRef('demo', 'missing-runtime')}],
        }],
      };
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [['bad/default', provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await putArtifact(runtime, 'source');
    const before = (await runtime.images.listCodeArtifacts('demo')).length;
    await assert.rejects(
      runtime.toolchains.run({
        providerId: 'bad/default',
        imageId: 'demo',
        roots: [objectRef('demo', source.id)],
        outputIds: {bad: 'bad-output'},
      }),
      /toolchain output dependency not found/,
    );
    assert.equal((await runtime.images.listCodeArtifacts('demo')).length, before);
    assert.equal(await runtime.images.getCodeArtifact('demo', 'bad-output'), null);
  } finally {
    await runtime.close();
  }
});

test('toolchain output id collisions are preflighted before any output write', async () => {
  const provider = Object.freeze({
    identity: 'collision-provider/v1',
    async run() {
      return {
        outputs: [
          {name: 'first', representation: 'example/output-v1', content: textValue('first')},
          {name: 'second', representation: 'example/output-v1', content: textValue('second')},
        ],
      };
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [['collision/default', provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await putArtifact(runtime, 'source');
    const existing = await putArtifact(runtime, 'existing-output', {content: textValue('keep-me')});
    await assert.rejects(
      runtime.toolchains.run({
        providerId: 'collision/default',
        imageId: 'demo',
        roots: [objectRef('demo', source.id)],
        outputIds: {first: 'would-be-first', second: existing.id},
      }),
      /toolchain output already exists/,
    );
    assert.equal(await runtime.images.getCodeArtifact('demo', 'would-be-first'), null);
    assert.deepEqual((await runtime.images.getCodeArtifact('demo', existing.id)).content, textValue('keep-me'));
  } finally {
    await runtime.close();
  }
});
