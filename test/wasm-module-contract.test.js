// The canonical module-contract accessor (Bead lagrange-images-ygi): one decoder for both the
// frozen wasm-module/v1 (contract in metadata) and the wasm-module/v2 (contract in identity-bearing
// content + a role:implementation bytes dependency). Executors read through this, never the schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import './ensure-node-crypto.test-helper.js';
import {bytesValue, createRuntime, objectRef, textValue} from '../src/runtime.js';
import {exportGraphBundle} from '../src/graph/bundle.js';
import {
  WASM_MODULE_V2,
  assertWasmModuleV2Artifact,
  canonicalJson,
  encodeModuleContractContent,
  readModuleContract,
} from '../src/wasm/module-contract.js';

const CONTRACT = {
  abi: 'wasm-resumable-value-handle-abi/v1',
  literals: [1, 'two'],
  functions: [{entry: 'run', memberIndex: 0, parameters: 1, captures: [], sendSiteIndices: [], closureSiteIndices: []}],
  sendSites: [],
  closureSites: [],
  effectSites: [],
};
const WASM_X = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1]);
const WASM_Y = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2]);

test('canonical JSON is key-order independent', () => {
  const a = canonicalJson({b: 1, a: {d: 2, c: 3}});
  const b = canonicalJson({a: {c: 3, d: 2}, b: 1});
  assert.equal(a, b);
  // encodeModuleContractContent is stable regardless of contract construction order.
  const reordered = {effectSites: [], sendSites: [], closureSites: [], functions: CONTRACT.functions, literals: CONTRACT.literals, abi: CONTRACT.abi};
  assert.equal(encodeModuleContractContent(CONTRACT), encodeModuleContractContent(reordered));
});

async function put(runtime, id, representation, content, extra = {}) {
  return await runtime.images.putCodeArtifact('img', {id, representation, content, ...extra});
}

test('accessor decodes a v2 descriptor by resolving its implementation bytes', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'img'});
  try {
    await put(runtime, 'bin', 'wasm-binary/v1', bytesValue(WASM_X));
    const desc = await put(runtime, 'mod', WASM_MODULE_V2, textValue(encodeModuleContractContent(CONTRACT)), {
      dependencies: [{role: 'implementation', artifact: objectRef('img', 'bin')}],
    });
    assertWasmModuleV2Artifact(desc);
    const resolveImplementation = (ref) => runtime.images.getCodeArtifact(ref.imageId, ref.objectId);
    const contract = await readModuleContract(desc, {resolveImplementation});
    assert.deepEqual([...contract.bytes], [...WASM_X]);
    assert.equal(contract.abi, CONTRACT.abi);
    assert.deepEqual(contract.functions[0].entry, 'run');
    // v2 needs the resolver: without it, reading the bytes must fail loudly, never silently.
    await assert.rejects(readModuleContract(desc, {}), /requires resolveImplementation/);
  } finally {
    await runtime.close();
  }
});

test('accessor decodes the frozen v1 form from metadata', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'img'});
  try {
    const v1 = await put(runtime, 'v1mod', 'wasm-module/v1', bytesValue(WASM_X), {
      metadata: {abi: CONTRACT.abi, literals: CONTRACT.literals, functions: CONTRACT.functions, sendSites: [], closureSites: [], effectSites: []},
    });
    const contract = await readModuleContract(v1, {});
    assert.deepEqual([...contract.bytes], [...WASM_X]);
    assert.equal(contract.abi, CONTRACT.abi);
    assert.deepEqual(contract.functions, CONTRACT.functions);
  } finally {
    await runtime.close();
  }
});

// The identity gate (user-required falsifier): module identity is bound to the exact implementation
// bytes through the dependency edge, with no change to generic contentIdentity.
test('module identity binds to the implementation bytes', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'img'});
  try {
    const content = textValue(encodeModuleContractContent(CONTRACT));
    await put(runtime, 'bin-x', 'wasm-binary/v1', bytesValue(WASM_X));
    await put(runtime, 'bin-y', 'wasm-binary/v1', bytesValue(WASM_Y));
    await put(runtime, 'desc-x', WASM_MODULE_V2, content, {dependencies: [{role: 'implementation', artifact: objectRef('img', 'bin-x')}]});
    await put(runtime, 'desc-y', WASM_MODULE_V2, content, {dependencies: [{role: 'implementation', artifact: objectRef('img', 'bin-y')}]});
    const idX = (await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'desc-x')}})).contentIdentity;
    const idY = (await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'desc-y')}})).contentIdentity;
    assert.notEqual(idX, idY, 'same contract + different implementation bytes must differ in identity');

    // Same contract + same bytes (different image/id) collide: identity is contract+bytes, not artifact id.
    await runtime.images.createImage({id: 'img2'});
    await runtime.images.putCodeArtifact('img2', {id: 'bin-z', representation: 'wasm-binary/v1', content: bytesValue(WASM_X)});
    await runtime.images.putCodeArtifact('img2', {id: 'desc-z', representation: WASM_MODULE_V2, content, dependencies: [{role: 'implementation', artifact: objectRef('img2', 'bin-z')}]});
    const idZ = (await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img2', 'desc-z')}})).contentIdentity;
    assert.equal(idX, idZ, 'same contract + same implementation bytes must share identity');
  } finally {
    await runtime.close();
  }
});
