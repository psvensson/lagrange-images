import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverApplication, M4_LOCATOR, openRuntime, assertRuntimeClosed, assertFreshRuntimes} from './support/yaxo-m4-acceptance.js';

test('M4 F1: recovery refuses an old document ref before accessing any runtime', async () => {
  const unreadable = new Proxy({}, {get() {throw new Error('runtime was accessed');}});
  const oldDocument = {kind: 'ref', imageId: M4_LOCATOR.imageId, objectId: 'old-document'};
  for (const locator of [oldDocument, {...M4_LOCATOR, document: oldDocument}]) {
    await assert.rejects(recoverApplication(unreadable, locator), {code: 'ERR_ASSERTION'});
  }
});

function assertRecoveryStructure(source) {
  const recovery = source.slice(source.indexOf('export async function recoverApplication('), source.indexOf('export async function runM4Acceptance('));
  assert.match(recovery, /readProjectDescriptor\(/);
  assert.match(recovery, /inspectDocument\(runtime, member.target\)/);
  assert.match(recovery, /await mutate\(runtime, recovered.refs.root, 'se'\)/);
  assert.doesNotMatch(recovery, /importCuisNativePackage|installSymmetricSmalltalk|parseDocumentFrom:|M4_XML|prepareApplication|putObject|putCodeArtifact/);
  assert.doesNotMatch(source, /\.putObject\(|\.putShape\(|\.putBlock\(|\.setRoot\(|ProjectInstallation/);
  assert.equal((source.match(/await importCuisNativePackage\(/g) ?? []).length, 1);
  assert.match(source, /attributeAt:put:/);
  assert.match(source, /assert\.deepEqual\(await recoverApplication\(b.runtime, \{\.\.\.M4_LOCATOR\}\), expected\)/);
  const lifecycle = source.slice(source.indexOf('export async function runM4Acceptance('));
  assert.match(lifecycle, /await assertRuntimeClosed\(a\)/);
  assert.match(lifecycle, /assertFreshRuntimes\(a, b\)/);
  assert.ok(lifecycle.indexOf('await assertRuntimeClosed(a)') < lifecycle.indexOf('const b = await openRuntime(filename)'));
}

test('M4 recovery has no setup replay, host graph mutation, or alternative root locator', async () => {
  assertRecoveryStructure(await readFile(new URL('./support/yaxo-m4-acceptance.js', import.meta.url), 'utf8'));
});

test('M4 F3/F4: inserting re-import or host mutation makes the structural acceptance fail', async () => {
  const source = await readFile(new URL('./support/yaxo-m4-acceptance.js', import.meta.url), 'utf8');
  assertRecoveryStructure(source);
  const badImport = source.replace(
    'export async function recoverApplication(runtime, locator) {',
    'export async function recoverApplication(runtime, locator) {\n  await importCuisNativePackage({images: runtime.images});',
  );
  assert.notEqual(badImport, source);
  assert.throws(() => assertRecoveryStructure(badImport), {code: 'ERR_ASSERTION'});
  const badMutation = source.replace(
    "await send(runtime, root, 'attributeAt:put:', [textValue('lang'), textValue(value)]);",
    'await runtime.images.putObject(root.imageId, {id: root.objectId});',
  );
  assert.notEqual(badMutation, source);
  assert.throws(() => assertRecoveryStructure(badMutation), {code: 'ERR_ASSERTION'});
});

test('M4 F7: a live A, a reused runtime, and shared WASM machinery each fail the lifecycle guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm4-lifecycle-'));
  const filename = join(directory, 'application.sqlite');
  const a = await openRuntime(filename);
  let b;
  try {
    await assert.rejects(assertRuntimeClosed(a), {code: 'ERR_ASSERTION'});
    assert.throws(() => assertFreshRuntimes(a, a), /images must be fresh/);
    await a.runtime.close();
    await assertRuntimeClosed(a);
    b = await openRuntime(filename);
    assertFreshRuntimes(a, b);
    for (const field of ['database', 'wasmModuleCache', 'wasmInstancePool']) {
      assert.throws(() => assertFreshRuntimes(a, {...b, [field]: a[field]}), new RegExp(`${field} must be fresh`));
    }
    for (const field of ['images', 'backend', 'executor', 'compilation', 'codeExecutors', 'invocations', 'codeCompilers', 'groupCompilers', 'dispatchers', 'toolchainProviders', 'foreignRuntimeProviders', 'foreignRuntimeInstanceCache']) {
      assert.throws(() => assertFreshRuntimes(a, {...b, runtime: {...b.runtime, [field]: a.runtime[field]}}), new RegExp(`${field} must be fresh`));
    }
  } finally {
    await b?.runtime.close();
    await a.runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});
