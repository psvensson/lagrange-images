import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLCHAIN_PROVIDER_PROTOCOL_V0,
  createRuntime,
  createToolchainDerivationDescriptor,
  objectRef,
  resolveArtifactGraph,
  textValue,
} from '../src/runtime.js';

test('incomplete persisted toolchain result sets are ignored', async () => {
  let runs = 0;
  const provider = Object.freeze({
    identity: 'partial-cache-provider/v1',
    cacheKey() { return {contract: 'partial-cache/v1'}; },
    async run() {
      runs += 1;
      return {
        outputs: [
          {name: 'module', representation: 'example/module-v1', content: textValue('fresh-module')},
          {name: 'interface', representation: 'example/interface-v1', content: textValue('fresh-interface')},
        ],
      };
    },
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [['partial/default', provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const source = await runtime.images.putCodeArtifact('demo', {
      id: 'source',
      representation: 'example/source-v1',
      content: textValue('source'),
    });
    const rootRef = objectRef('demo', source.id);
    const graph = await resolveArtifactGraph(runtime.images, [rootRef]);
    const target = Object.freeze({representation: 'example/module-v1'});
    const options = Object.freeze({});
    const request = Object.freeze({
      protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0,
      providerId: 'partial/default',
      toolchainIdentity: provider.identity,
      roots: graph.roots,
      artifacts: graph.artifacts,
      target,
      options,
    });
    const context = Object.freeze({protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0});
    const descriptor = await createToolchainDerivationDescriptor(provider, request, context);

    await runtime.images.putCodeArtifact('demo', {
      id: 'partial-module',
      representation: 'example/module-v1',
      content: textValue('stale-partial'),
      derivedFrom: [rootRef],
      metadata: {
        toolchainProviderId: 'partial/default',
        toolchainIdentity: provider.identity,
        toolchainProtocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0,
        toolchainDerivationKey: descriptor.derivationKey,
        toolchainResultId: 'partial-result',
        toolchainOutputName: 'module',
        toolchainOutputIndex: 0,
        toolchainOutputCount: 2,
      },
    });

    const result = await runtime.toolchains.run({
      providerId: 'partial/default',
      imageId: 'demo',
      roots: [rootRef],
      target,
      options,
      outputIds: {module: 'module-new', interface: 'interface-new'},
    });

    assert.equal(runs, 1);
    assert.equal(result.reused, false);
    assert.deepEqual(result.outputs.map(({artifact}) => artifact.id), ['module-new', 'interface-new']);
    assert.equal((await runtime.images.getCodeArtifact('demo', 'partial-module')).content.value, 'stale-partial');
  } finally {
    await runtime.close();
  }
});
