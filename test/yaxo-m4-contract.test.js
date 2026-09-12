import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {recoverApplication, M4_LOCATOR} from './support/yaxo-m4-acceptance.js';

test('M4 F1: recovery refuses an old document ref before accessing any runtime', async () => {
  const unreadable = new Proxy({}, {get() {throw new Error('runtime was accessed');}});
  const oldDocument = {kind: 'ref', imageId: M4_LOCATOR.imageId, objectId: 'old-document'};
  for (const locator of [oldDocument, {...M4_LOCATOR, document: oldDocument}]) {
    await assert.rejects(recoverApplication(unreadable, locator), {code: 'ERR_ASSERTION'});
  }
});

test('M4 recovery has no setup replay, host graph mutation, or alternative root locator', async () => {
  const source = await readFile(new URL('./support/yaxo-m4-acceptance.js', import.meta.url), 'utf8');
  const recovery = source.slice(source.indexOf('export async function recoverApplication('), source.indexOf('export async function runM4Acceptance('));
  assert.match(recovery, /readProjectDescriptor\(/);
  assert.match(recovery, /inspectDocument\(runtime, member.target\)/);
  assert.match(recovery, /await mutate\(runtime, recovered.refs.root, 'se'\)/);
  assert.doesNotMatch(recovery, /importCuisNativePackage|installSymmetricSmalltalk|parseDocumentFrom:|M4_XML|prepareApplication|putObject|putCodeArtifact/);
  assert.doesNotMatch(source, /\.putObject\(|\.putShape\(|\.putBlock\(|\.setRoot\(|ProjectInstallation/);
  assert.equal((source.match(/await importCuisNativePackage\(/g) ?? []).length, 1);
  assert.match(source, /attributeAt:put:/);
  assert.match(source, /assert\.deepEqual\(await recoverApplication\(b.runtime, \{\.\.\.M4_LOCATOR\}\), expected\)/);
});
