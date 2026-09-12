import assert from 'node:assert/strict';
import {
  LagrangeBackend, WasmModuleCache, WasmInstancePool,
  createRuntime, createProject, addProjectMember, readProjectDescriptor,
  importCuisNativePackage, installSymmetricSmalltalkStandardImage,
  textValue, integerValue,
} from '../../src/runtime.js';
import {createSqliteApplicationRuntime} from './sqlite-application-runtime.js';

export const M4_XML = '<note lang="en"><to>Tove</to></note>';
export const M4_LOCATOR = Object.freeze({imageId: 'yaxo-m4', projectId: 'yaxo-application', memberKey: 'application/root'});

// All sends, including both mutations, enter ordinary native dispatch. There is no host XML
// parser, object constructor, attribute storage writer, or recovery installer in this proof.
export async function send(runtime, receiver, selector, args = []) {
  return runtime.executor.execute(await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk', receiver, message: textValue(selector), arguments: args,
  }, {dispatchImage: M4_LOCATOR.imageId}));
}

export async function openRuntime(filename) {
  const database = createSqliteApplicationRuntime(filename);
  const wasmModuleCache = new WasmModuleCache();
  const wasmInstancePool = new WasmInstancePool();
  const runtime = await createRuntime({
    backend: {instance: new LagrangeBackend({runtime: database})},
    wasmModuleCache, wasmInstancePool,
  });
  assert.deepEqual(runtime.toolchainProviders.list(), []);
  assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
  return {runtime, database, wasmModuleCache, wasmInstancePool};
}

async function assertClass(runtime, ref, expected) {
  assert.deepEqual(await send(runtime, await send(runtime, ref, 'class'), 'name'), textValue(expected));
}

export async function inspectDocument(runtime, document) {
  await assertClass(runtime, document, 'XMLDocument');
  const roots = await send(runtime, document, 'elements');
  assert.deepEqual(await send(runtime, roots, 'size'), integerValue(1));
  const root = await send(runtime, roots, 'first');
  await assertClass(runtime, root, 'XMLElement');
  const children = await send(runtime, root, 'elements');
  assert.deepEqual(await send(runtime, children, 'size'), integerValue(1));
  const child = await send(runtime, children, 'first');
  await assertClass(runtime, child, 'XMLElement');
  const contents = await send(runtime, child, 'contents');
  assert.deepEqual(await send(runtime, contents, 'size'), integerValue(1));
  const text = await send(runtime, contents, 'first');
  await assertClass(runtime, text, 'XMLStringNode');
  assert.deepEqual(await send(runtime, text, 'string'), textValue('Tove'));
  const attributes = await send(runtime, root, 'attributes');
  assert.deepEqual(await send(runtime, attributes, 'size'), integerValue(1));
  const lang = await send(runtime, root, 'attributeAt:', [textValue('lang')]);
  return {refs: {document, root, child, text}, lang};
}

export async function mutate(runtime, root, value) {
  await send(runtime, root, 'attributeAt:put:', [textValue('lang'), textValue(value)]);
}

export async function prepareApplication(runtime, manifest, scope) {
  const {imageId, projectId, memberKey} = M4_LOCATOR;
  await runtime.images.createImage({id: imageId});
  await installSymmetricSmalltalkStandardImage({images: runtime.images, compilation: runtime.compilation, imageId, lane: 'wasm'});
  // One import into A. Initializer values are created by the unchanged package method, never
  // carried across from Cuis. The scope is extended only after this acceptance names a miss.
  const imported = await importCuisNativePackage({images: runtime.images, compilation: runtime.compilation, imageId, manifest, scope});
  const classRef = (name) => imported.classes.find(({identity}) => identity === `cuis-class/YAXO/${name}`).classRef;
  await send(runtime, classRef('XMLTokenizer'), 'initialize');
  const stream = await send(runtime, textValue(M4_XML), 'readStream');
  const document = await send(runtime, classRef('XMLDOMParser'), 'parseDocumentFrom:', [stream]);
  const original = await inspectDocument(runtime, document);
  assert.deepEqual(original.lang, textValue('en'));
  await createProject({images: runtime.images, imageId, projectId, name: 'YAXO application'});
  await addProjectMember({images: runtime.images, imageId, projectId, key: memberKey, role: 'application-root', target: document});
  await mutate(runtime, original.refs.root, 'sv');
  const mutated = await inspectDocument(runtime, document);
  assert.deepEqual(mutated.refs, original.refs, 'mutation preserves all application identities');
  assert.deepEqual(mutated.lang, textValue('sv'));
  return mutated.refs;
}

// B receives exactly the durable locator. An old root ref is not an alternative recovery API.
export async function recoverApplication(runtime, locator) {
  assert.deepEqual(Object.keys(locator).sort(), ['imageId', 'memberKey', 'projectId']);
  for (const value of Object.values(locator)) assert.equal(typeof value, 'string');
  const descriptor = await readProjectDescriptor({images: runtime.images, imageId: locator.imageId, projectId: locator.projectId});
  assert.equal(descriptor.members.length, 1);
  const member = descriptor.members.find(({key}) => key === locator.memberKey);
  assert.ok(member, 'application root is found only through the Project descriptor');
  assert.equal(member.role, 'application-root');
  const recovered = await inspectDocument(runtime, member.target);
  assert.deepEqual(recovered.lang, textValue('sv'));
  await mutate(runtime, recovered.refs.root, 'se');
  const resumed = await inspectDocument(runtime, member.target);
  assert.deepEqual(resumed.refs, recovered.refs, 'resumed behavior preserves graph identities');
  assert.deepEqual(resumed.lang, textValue('se'));
  return resumed.refs;
}

export async function runM4Acceptance(filename, manifest, scope) {
  let a = await openRuntime(filename);
  let expected;
  try {
    expected = await prepareApplication(a.runtime, manifest, scope);
  } finally {
    await a.runtime.close();
  }
  assert.throws(() => a.database.listTables(), /runtime is not started/, 'A database has closed');
  await assert.rejects(() => a.runtime.images.getObject(M4_LOCATOR.imageId, 'anything'), undefined, 'A cannot read after close');
  const b = await openRuntime(filename);
  try {
    for (const name of ['images', 'executor', 'compilation', 'codeExecutors', 'invocations', 'codeCompilers', 'groupCompilers', 'dispatchers', 'toolchainProviders', 'foreignRuntimeProviders', 'foreignRuntimeInstanceCache']) {
      assert.notEqual(a.runtime[name], b.runtime[name], `${name} must be fresh`);
    }
    for (const name of ['database', 'wasmModuleCache', 'wasmInstancePool']) assert.notEqual(a[name], b[name]);
    a = null;
    // Expected refs are used only by this comparison, never as input to B's root discovery.
    assert.deepEqual(await recoverApplication(b.runtime, {...M4_LOCATOR}), expected);
  } finally {
    await b.runtime.close();
  }
}
