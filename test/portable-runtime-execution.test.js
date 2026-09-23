import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setDefaultCryptoProvider, resetDefaultCryptoProvider} from '../src/support/default-crypto.js';
import {createNodeCryptoProvider} from '../src/support/node-crypto-provider.js';
import * as portable from '../src/portable-runtime.js';
import {CUIS_NATIVE_ROOT_OBJECT_IDENTITY} from '../src/language/cuis-native-import.js';
// The manifest format tag is owned by the (Node-only) Cuis toolchain provider; the test imports it
// for fixture data only, the way test/cuis-native-import.test.js does.
import {CUIS_SEMANTIC_EXPORT_V2} from '../src/toolchain/opensmalltalk-cuis-toolchain-provider.js';
import {installSymmetricSmalltalkBlock} from '../src/language/index.js';
import {WASM_FUNCTION_V2} from '../src/code/wasm-artifacts.js';

// The portable execution surface (bead lagrange-images-hygu).
//
// THE CLAIM: a host that composes Images through `createPortableRuntime` ALONE — no
// `src/runtime.js`, no foreign-runtime or toolchain provider, nothing but the host's own
// WebAssembly API and an installed crypto provider — can bring an application into an image and
// run it: install the standard image in the WASM lane, define native methods from source, import
// a Cuis package whose methods are (as every imported method is) WASM-lane, execute them, and
// install and recover a managed Project release. Before this surface existed a portable host could
// browse an imported application but never execute one, and the exported method-replacement seam
// could not succeed for want of the compilation service (Object Environment Beads dcx, aov).
//
// Everything below reaches the runtime through the portable root's own exports; the test harness
// imports owners directly only to build fixtures and to read the durable lane fact back.

const {
  createPortableRuntime,
  installSymmetricSmalltalkStandardImage,
  defineMethodsFromSource,
  importCuisNativePackage,
  installManagedProjectRelease,
  readManagedProjectInstallation,
  resolveGlobal,
  objectRef,
  integerValue,
} = {...portable, integerValue: (await import('../src/value/index.js')).integerValue};

const IMAGE = 'portable-execution';

function fixtureManifest() {
  return {
    format: CUIS_SEMANTIC_EXPORT_V2,
    packages: [{name: 'Fixture', requires: ['Cuis-Base']}],
    classes: [
      {
        identity: 'cuis-class/Fixture/Counter', package: 'Fixture', name: 'Counter',
        superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
        instanceVariables: ['count'], classVariables: [],
      },
    ],
    methods: [
      {
        identity: 'cuis-method/Fixture/Counter/instance/count', package: 'Fixture',
        class: 'cuis-class/Fixture/Counter', side: 'instance', selector: 'count', source: 'count\n\t^ count',
      },
      {
        identity: 'cuis-method/Fixture/Counter/instance/count:', package: 'Fixture',
        class: 'cuis-class/Fixture/Counter', side: 'instance', selector: 'count:', source: 'count: aValue\n\tcount := aValue',
      },
      {
        identity: 'cuis-method/Fixture/Counter/instance/increment', package: 'Fixture',
        class: 'cuis-class/Fixture/Counter', side: 'instance', selector: 'increment',
        source: 'increment\n\tcount := count + 1.\n\t^ count',
      },
    ],
  };
}

async function evaluate(runtime, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId: IMAGE, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(IMAGE, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

test('the portable root composes image-native compilation and the WASM function lane', async () => {
  resetDefaultCryptoProvider();
  setDefaultCryptoProvider(createNodeCryptoProvider());
  const runtime = await createPortableRuntime({backend: {mode: 'mock'}});
  try {
    assert.equal(typeof runtime.compilation?.compileArtifact, 'function', 'the compilation service is composed');
    assert.equal(typeof runtime.compilation?.compileGroup, 'function');
    assert.ok(runtime.codeExecutors.has(WASM_FUNCTION_V2), 'the WASM function lane is registered');
    assert.equal(runtime.toolchainProviders, undefined, 'no toolchain service: nothing to fall back to');
    assert.equal(runtime.foreignRuntimes, undefined, 'no foreign-runtime service: nothing to fall back to');
  } finally {
    await runtime.close();
  }
});

test('through the portable root alone: standard image, native methods from source and an imported Cuis package execute in the WASM lane', async () => {
  resetDefaultCryptoProvider();
  setDefaultCryptoProvider(createNodeCryptoProvider());
  const runtime = await createPortableRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: IMAGE});
    const image = await installSymmetricSmalltalkStandardImage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, lane: 'wasm',
    });
    assert.equal(image.lane, 'wasm');

    // A native method defined from source in the WASM lane, on a standard-image class.
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, lane: 'wasm',
      classRef: image.kernel.objectClass, methods: [{selector: 'portableAnswer', source: '[ ^ 42 ]'}],
    });
    assert.deepEqual(await evaluate(runtime, 'native-answer', '[ 1 portableAnswer ]'), integerValue(42));

    // An imported Cuis package: classes through the class owner, methods through the WASM lane.
    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: fixtureManifest(),
    });
    const counter = imported.classes.find(({identity}) => identity === 'cuis-class/Fixture/Counter');
    assert.ok(counter, 'the imported class is answered');
    const binding = await resolveGlobal({images: runtime.images, imageId: IMAGE, name: 'Counter'});
    assert.ok(binding, 'the imported class is nameable through the native namespace');

    const instance = await evaluate(runtime, 'allocate', '[ Counter new ]');
    assert.deepEqual(
      await evaluate(runtime, 'exercise', '[ :c | c count: 41. c increment ]', [instance]),
      integerValue(42),
      'the imported methods executed on a native instance',
    );
    assert.deepEqual(await evaluate(runtime, 'read', '[ :c | c count ]', [instance]), integerValue(42));

    // The lane is a durable fact this owner published: every imported method Block is WASM-lane.
    const methodBlocks = (await runtime.images.listRecords(IMAGE)).filter((record) =>
      record.kind === 'block' && record.metadata?.smalltalk === 'method' && ['count', 'count:', 'increment'].includes(record.metadata?.selector));
    assert.equal(methodBlocks.length, 3);
    assert.ok(methodBlocks.every((record) => record.metadata.lane === 'wasm'));
    for (const block of methodBlocks) {
      const code = await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId);
      assert.equal(code.representation, WASM_FUNCTION_V2, `${block.metadata.selector} runs as ${WASM_FUNCTION_V2}`);
    }
  } finally {
    await runtime.close();
  }
});

test('through the portable root alone: the committed Life release installs as a managed installation and is recoverable', async () => {
  resetDefaultCryptoProvider();
  setDefaultCryptoProvider(createNodeCryptoProvider());
  const fixture = JSON.parse(await readFile(new URL('./fixtures/life-m5-release.json', import.meta.url), 'utf8'));
  const runtime = await createPortableRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: IMAGE});
    const installed = await installManagedProjectRelease({
      images: runtime.images, targetImageId: IMAGE, release: fixture.release, material: fixture.material,
    });
    const recovered = await readManagedProjectInstallation({
      images: runtime.images, targetImageId: IMAGE, projectId: fixture.release.projectId,
    });
    assert.ok(recovered, 'the managed installation is recoverable from the deterministic head');
    assert.equal(recovered.releaseId, installed.releaseId);
    assert.deepEqual(recovered.members.map(({key}) => key), ['life/export', 'life/package']);
    // A same-release retry is the documented write-free outcome (ADR 0076).
    const frontier = await runtime.images.frontier(IMAGE);
    const again = await installManagedProjectRelease({
      images: runtime.images, targetImageId: IMAGE, release: fixture.release, material: fixture.material,
    });
    assert.equal(again.releaseId, installed.releaseId);
    assert.equal(await runtime.images.frontier(IMAGE), frontier, 'the retry wrote nothing');
  } finally {
    await runtime.close();
  }
});
