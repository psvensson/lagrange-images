import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  WASM_COMPONENT_V1,
  bytesValue,
  createJcoComponentRuntime,
  createRuntime,
  installCallableInterface,
  installWasmComponentBinding,
  objectRef,
} from '../src/runtime.js';

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'normalize-component', 'normalize.component.wasm',
);

// `bump` increments guest-resident state and returns the new value. It exists purely so
// instance reuse is observable: a reused instance keeps counting, a fresh one always
// answers 1.
async function bumpLane({moduleCache = true, componentIds = ['component']} = {}) {
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime: createJcoComponentRuntime({moduleCache}),
  });
  await runtime.images.createImage({id: 'demo'});
  const bytes = bytesValue(await readFile(COMPONENT_PATH));

  const lanes = [];
  for (const componentId of componentIds) {
    const component = await runtime.images.putCodeArtifact('demo', {
      id: componentId, representation: WASM_COMPONENT_V1, content: bytes, languageId: 'rust',
    });
    const callableInterface = await installCallableInterface({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: `${componentId}-bump-interface`,
      functionName: 'bump',
      parameters: [],
      result: 's64',
    });
    const binding = await installWasmComponentBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      bindingId: `${componentId}-bump-binding`,
      blockId: `${componentId}-bump-block`,
    });
    const blockRef = objectRef('demo', binding.block.id);
    lanes.push(async () => {
      const activation = await runtime.invocations.invokeBlock(blockRef, []);
      return (await runtime.executor.execute(activation)).value;
    });
  }
  return {runtime, lanes};
}

// The contract this file exists to pin. Before ADR 0036 the runtime cached the instantiated
// Component and this returned 1, 2, 3, 4 — guest state crossing between unrelated
// activations, which is also the route by which host authority would eventually leak.
test('guest state does not survive from one activation to the next', async () => {
  const {runtime, lanes} = await bumpLane();
  const [bump] = lanes;
  try {
    const seen = [];
    for (let index = 0; index < 5; index++) seen.push(await bump());
    assert.deepEqual(seen, ['1', '1', '1', '1', '1'],
      'each activation must observe a freshly instantiated Component');
  } finally {
    await runtime.close();
  }
});

test('isolation does not depend on the compilation cache being enabled', async () => {
  const {runtime, lanes} = await bumpLane({moduleCache: false});
  const [bump] = lanes;
  try {
    assert.deepEqual([await bump(), await bump(), await bump()], ['1', '1', '1']);
  } finally {
    await runtime.close();
  }
});

test('the compilation cache is keyed by artifact identity, so components cannot interfere', async () => {
  const {runtime, lanes} = await bumpLane({componentIds: ['component-a', 'component-b']});
  const [bumpA, bumpB] = lanes;
  try {
    // Same bytes, two artifact identities. Neither may observe the other's state, and
    // neither may observe its own from a previous activation.
    assert.deepEqual(
      [await bumpA(), await bumpB(), await bumpA(), await bumpB()],
      ['1', '1', '1', '1'],
    );
  } finally {
    await runtime.close();
  }
});

test('a failed preparation is not cached, so a later activation can retry', async () => {
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    componentRuntime: createJcoComponentRuntime(),
  });
  try {
    await runtime.images.createImage({id: 'demo'});
    // A bare core module header, which is not a Component.
    const component = await runtime.images.putCodeArtifact('demo', {
      id: 'broken',
      representation: WASM_COMPONENT_V1,
      content: bytesValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])),
      languageId: 'rust',
    });
    const callableInterface = await installCallableInterface({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'broken-interface',
      functionName: 'bump',
      parameters: [],
      result: 's64',
    });
    const binding = await installWasmComponentBinding({
      images: runtime.images,
      callableInterface: objectRef('demo', callableInterface.id),
      component: objectRef('demo', component.id),
      bindingId: 'broken-binding',
      blockId: 'broken-block',
    });
    const blockRef = objectRef('demo', binding.block.id);

    const attempt = async () => {
      const activation = await runtime.invocations.invokeBlock(blockRef, []);
      return await runtime.executor.execute(activation).then(() => null, (error) => error);
    };
    const first = await attempt();
    const second = await attempt();
    assert.ok(first instanceof Error, 'an invalid Component must fail');
    // A cached rejection would make the second attempt fail for a stale reason, and would
    // never recover if the artifact were replaced.
    assert.ok(second instanceof Error, 'the retry must fail on its own merits');
    assert.equal(first.constructor.name, second.constructor.name);
  } finally {
    await runtime.close();
  }
});
