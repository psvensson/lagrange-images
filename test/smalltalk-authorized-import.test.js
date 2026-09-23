import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CUIS_NATIVE_INTEGER_IDENTITY,
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  authorizedImportCuisPackage,
  importCuisNativePackage,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  objectResource,
  planCuisNativeImport,
  smalltalkClassObjectId,
  textValue,
} from '../src/runtime.js';
import {importDemandsFor} from '../src/language/smalltalk-authorized-import.js';
import {OBJECT_WRITE_OPERATION} from '../src/authority/object-resource.js';
import {OBJECT_CREATE_OPERATION} from '../src/callable/image-creation-binding.js';
import {NAMESPACE_OBJECT_ID} from '../src/language/smalltalk-globals.js';
import {CUIS_SEMANTIC_EXPORT_V2} from '../src/toolchain/opensmalltalk-cuis-toolchain-provider.js';
import {forkableRuntime} from './support/recovery-harness.js';

// The authorized Cuis native import seam (ADR 0094, Object Environment E4).
//
// What these proofs pin, and the wrong implementation each one kills:
//   * the demand SET, as data, computed from the caller's manifest alone — a seam that demanded
//     fewer, more, or the right demands only after reading the image;
//   * authority strictly BEFORE any graph read — a seam that let a denied caller learn whether the
//     image has a kernel, a namespace, or the named classes;
//   * the partial-result contract — an import that hid what it had admitted, rolled it back, or
//     re-imported it on retry;
//   * cancellation between declarations, never inside an owner's write;
//   * the owner's own refusal reaching the caller as `cause`, with the declaration named.

const IMAGE = 'app';

function manifest({methods = [], childMethodSource = 'child\n\t^ child'} = {}) {
  return {
    format: CUIS_SEMANTIC_EXPORT_V2,
    packages: [{name: 'Fixture', requires: ['Cuis-Base']}],
    classes: [
      {
        identity: 'cuis-class/Fixture/AChild', package: 'Fixture', name: 'AChild',
        superclassName: 'ZuluBase', superclass: 'cuis-class/Fixture/ZuluBase',
        instanceVariables: ['child'], classVariables: [],
      },
      {
        identity: 'cuis-class/Fixture/ZuluBase', package: 'Fixture', name: 'ZuluBase',
        superclassName: 'Object', superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
        instanceVariables: ['base'], classVariables: [],
      },
    ],
    methods: [
      {
        identity: 'cuis-method/Fixture/ZuluBase/instance/base', package: 'Fixture',
        class: 'cuis-class/Fixture/ZuluBase', side: 'instance', selector: 'base', source: 'base\n\t^ base',
      },
      {
        identity: 'cuis-method/Fixture/ZuluBase/instance/base:', package: 'Fixture',
        class: 'cuis-class/Fixture/ZuluBase', side: 'instance', selector: 'base:', source: 'base: aValue\n\tbase := aValue',
      },
      {
        identity: 'cuis-method/Fixture/AChild/instance/child', package: 'Fixture',
        class: 'cuis-class/Fixture/AChild', side: 'instance', selector: 'child', source: childMethodSource,
      },
      {
        identity: 'cuis-method/Fixture/Integer/instance/fixtureDoubled', package: 'Fixture',
        class: CUIS_NATIVE_INTEGER_IDENTITY, side: 'instance', selector: 'fixtureDoubled',
        source: 'fixtureDoubled\n\t^ self + self',
      },
      ...methods,
    ],
  };
}

const createDemand = (objectId) => ({operation: OBJECT_CREATE_OPERATION, resource: objectResource(IMAGE, objectId)});
const writeDemand = (objectId) => ({operation: OBJECT_WRITE_OPERATION, resource: objectResource(IMAGE, objectId)});

// The complete demand set a full import of the fixture needs, as the seam must compute it.
const FULL_DEMANDS = Object.freeze([
  createDemand(smalltalkClassObjectId('AChild')),
  createDemand(smalltalkClassObjectId('ZuluBase')),
  writeDemand(smalltalkClassObjectId('Integer')),
  writeDemand(smalltalkClassObjectId('Object')),
  writeDemand(NAMESPACE_OBJECT_ID),
].sort((a, b) => (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0)));

function requireFor(runtime, grants) {
  const context = runtime.authority.issue({principal: 'alice', grants});
  const demands = [];
  const require = (demand) => {
    demands.push(demand);
    return runtime.authority.require(context, demand);
  };
  require.demands = demands;
  return require;
}

function countingImages(images) {
  const counts = {reads: 0};
  const delegate = Object.create(images);
  for (const name of ['getObject', 'getBlock', 'getShape', 'getCodeArtifact', 'getRecord', 'getImage', 'listRecords', 'listCodeArtifacts', 'frontier']) {
    if (typeof images[name] !== 'function') continue;
    delegate[name] = async (...args) => {
      counts.reads += 1;
      return await images[name](...args);
    };
  }
  return {images: delegate, counts};
}

async function evaluate(runtime, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId: IMAGE, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(IMAGE, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

const failure = async (promise) => {
  try { await promise; } catch (error) { return error; }
  return null;
};

let base = null;
test.before(async () => {
  base = await forkableRuntime(async (runtime) => {
    await runtime.images.createImage({id: IMAGE});
    await installSymmetricSmalltalkStandardImage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, lane: 'wasm',
    });
    return null;
  });
});
test.after(async () => { await base?.close(); });

test('the demand set is a pure function of the manifest: creates for declared classes, writes for mapped superclasses, mapped extension targets and the namespace', () => {
  const plan = planCuisNativeImport(manifest(), null);
  assert.deepEqual(importDemandsFor({imageId: IMAGE, plan}), FULL_DEMANDS);
  // A scope covering one class and no method narrows the set to exactly what that import does.
  const scoped = planCuisNativeImport(manifest(), {classes: ['cuis-class/Fixture/ZuluBase'], methods: []});
  assert.deepEqual(importDemandsFor({imageId: IMAGE, plan: scoped}), [
    createDemand(smalltalkClassObjectId('ZuluBase')),
    writeDemand(smalltalkClassObjectId('Object')),
    writeDemand(NAMESPACE_OBJECT_ID),
  ].sort((a, b) => (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0)));
});

test('caller-owned input is refused before any demand: no require call, no read', async () => {
  await base.withFork(async (runtime) => {
    const require = requireFor(runtime, FULL_DEMANDS);
    const {images, counts} = countingImages(runtime.images);
    for (const [label, options] of [
      ['no manifest', {}],
      ['a bad signal', {manifest: manifest(), signal: {}}],
      ['a bad progress callback', {manifest: manifest(), onProgress: 'yes'}],
      ['no image id', {manifest: manifest(), imageId: ''}],
    ]) {
      const error = await failure(authorizedImportCuisPackage({
        images, compilation: runtime.compilation, imageId: IMAGE, require, ...options,
      }));
      assert.equal(error?.name, 'SmalltalkImportInputError', `${label}: ${error}`);
    }
    // An adapter-owned manifest refusal is caller input too: refused before authority, reads nothing.
    const bad = await failure(authorizedImportCuisPackage({
      images, compilation: runtime.compilation, imageId: IMAGE, require, manifest: {...manifest(), format: 'wrong'},
    }));
    assert.equal(bad?.name, 'CuisNativeImportError');
    assert.deepEqual(require.demands, [], 'nothing was demanded');
    assert.equal(counts.reads, 0, 'nothing was read');
  });
});

test('the operation demands exactly the set, in canonical order, before any read, then reads', async () => {
  await base.withFork(async (runtime) => {
    const {images, counts} = countingImages(runtime.images);
    let readsAtFirstDemand = null;
    const context = runtime.authority.issue({principal: 'alice', grants: FULL_DEMANDS});
    const demands = [];
    const require = (demand) => {
      if (readsAtFirstDemand === null) readsAtFirstDemand = counts.reads;
      demands.push(demand);
      return runtime.authority.require(context, demand);
    };
    const result = await authorizedImportCuisPackage({
      images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(), require,
    });
    assert.deepEqual(demands, FULL_DEMANDS, 'exactly the computed set, in canonical order');
    assert.equal(readsAtFirstDemand, 0, 'the first demand preceded every read');
    assert.ok(counts.reads > 0, 'and the import really read afterwards');
    assert.deepEqual(result.admitted.classes, ['cuis-class/Fixture/ZuluBase', 'cuis-class/Fixture/AChild']);
    assert.deepEqual([...result.admitted.methods].sort(), [
      'cuis-method/Fixture/AChild/instance/child',
      'cuis-method/Fixture/Integer/instance/fixtureDoubled',
      'cuis-method/Fixture/ZuluBase/instance/base',
      'cuis-method/Fixture/ZuluBase/instance/base:',
    ]);
    assert.deepEqual(result.imported.classes.map(({identity}) => identity).sort(),
      ['cuis-class/Fixture/AChild', 'cuis-class/Fixture/ZuluBase']);
    // The imported code executes: an instance through the published global, the extension on Integer.
    const instance = await evaluate(runtime, 'allocate', '[ AChild new ]');
    assert.deepEqual(await evaluate(runtime, 'exercise', '[ :o | o base: 20. o base ]', [instance]), integerValue(20));
    assert.deepEqual(await evaluate(runtime, 'extension', '[ 21 fixtureDoubled ]'), integerValue(42));
  });
});

test('authorization precedes existence: a denied caller gets AuthorityError, reads nothing, and the image is untouched — whether or not the image exists', async () => {
  await base.withFork(async (runtime) => {
    const before = await runtime.images.frontier(IMAGE);
    for (const [label, missing] of [
      ['everything but the namespace write', writeDemand(NAMESPACE_OBJECT_ID)],
      ['everything but the Object write', writeDemand(smalltalkClassObjectId('Object'))],
      ['everything but the Integer write', writeDemand(smalltalkClassObjectId('Integer'))],
      ['everything but one create', createDemand(smalltalkClassObjectId('AChild'))],
    ]) {
      const require = requireFor(runtime, FULL_DEMANDS.filter((demand) => JSON.stringify(demand) !== JSON.stringify(missing)));
      const {images, counts} = countingImages(runtime.images);
      const error = await failure(authorizedImportCuisPackage({
        images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(), require,
      }));
      assert.equal(error?.name, 'AuthorityError', `${label}: ${error}`);
      assert.equal(counts.reads, 0, `${label}: a denied caller caused no graph read`);
    }
    assert.equal(await runtime.images.frontier(IMAGE), before, 'nothing was written');
    // An image that does not exist is indistinguishable to a denied caller.
    const require = requireFor(runtime, []);
    const {images, counts} = countingImages(runtime.images);
    const error = await failure(authorizedImportCuisPackage({
      images, compilation: runtime.compilation, imageId: 'no-such-image', manifest: manifest(), require,
    }));
    assert.equal(error?.name, 'AuthorityError');
    assert.equal(counts.reads, 0);
  });
});

test('exact replay through the seam is write-free and reports the same admissions', async () => {
  await base.withFork(async (runtime) => {
    const run = () => authorizedImportCuisPackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(),
      require: requireFor(runtime, FULL_DEMANDS),
    });
    const first = await run();
    const frontier = await runtime.images.frontier(IMAGE);
    const second = await run();
    assert.equal(await runtime.images.frontier(IMAGE), frontier, 'the replay wrote nothing');
    assert.deepEqual(second.admitted, first.admitted);
  });
});

test('progress reports each declaration as it begins and is admitted, in the adapter\'s order', async () => {
  await base.withFork(async (runtime) => {
    const events = [];
    await authorizedImportCuisPackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(),
      require: requireFor(runtime, FULL_DEMANDS), onProgress: (event) => events.push(`${event.event}:${event.phase}:${event.identity ?? '-'}`),
    });
    assert.deepEqual(events.slice(0, 6), [
      'begin:class:cuis-class/Fixture/ZuluBase', 'admitted:class:cuis-class/Fixture/ZuluBase',
      'begin:class:cuis-class/Fixture/AChild', 'admitted:class:cuis-class/Fixture/AChild',
      'begin:globals:-', 'admitted:globals:-',
    ]);
    const methodEvents = events.slice(6);
    assert.equal(methodEvents.length, 6, 'three method groups (ZuluBase, AChild, Integer), each begun and admitted');
    for (let index = 0; index < methodEvents.length; index += 2) {
      assert.match(methodEvents[index], /^begin:methods:/);
      assert.equal(methodEvents[index + 1], methodEvents[index].replace('begin', 'admitted'));
    }
  });
});

test('cancellation stops between declarations, reports exactly what landed, and a retry converges on what an uninterrupted import produces', async () => {
  const straight = await base.withFork(async (runtime) => {
    await authorizedImportCuisPackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(),
      require: requireFor(runtime, FULL_DEMANDS),
    });
    return {
      frontier: await runtime.images.frontier(IMAGE),
      records: (await runtime.images.listRecords(IMAGE)).map(({id}) => id).sort(),
    };
  });
  await base.withFork(async (runtime) => {
    const signal = {aborted: false, reason: null};
    const error = await failure(authorizedImportCuisPackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(),
      require: requireFor(runtime, FULL_DEMANDS), signal,
      onProgress: (event) => {
        // Cancel as soon as the first class is admitted: the check runs before the next declaration.
        if (event.event === 'admitted' && event.phase === 'class') { signal.aborted = true; signal.reason = 'user cancelled'; }
      },
    }));
    assert.equal(error?.name, 'CuisNativeImportAbortedError', String(error));
    assert.deepEqual(error.admitted, {classes: ['cuis-class/Fixture/ZuluBase'], methods: []});
    assert.equal(error.reason, 'user cancelled');
    const partial = await runtime.images.frontier(IMAGE);
    assert.ok(partial < straight.frontier, 'the interrupted import wrote less than a complete one');
    // The retry, with a fresh signal, converges: identical records and frontier to the straight run.
    const retried = await authorizedImportCuisPackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(),
      require: requireFor(runtime, FULL_DEMANDS), signal: {aborted: false},
    });
    assert.deepEqual(retried.admitted.classes, ['cuis-class/Fixture/ZuluBase', 'cuis-class/Fixture/AChild'],
      'a retry re-admits the already-landed class write-free and reports it as admitted');
    assert.equal(await runtime.images.frontier(IMAGE), straight.frontier);
    assert.deepEqual((await runtime.images.listRecords(IMAGE)).map(({id}) => id).sort(), straight.records);
  });
});

test('a native owner\'s refusal after earlier admissions names the declaration, what landed and the owner\'s own cause; a corrected retry converges', async () => {
  await base.withFork(async (runtime) => {
    const broken = manifest({childMethodSource: 'child\n\t^ [ :x | ] value: ]'});
    const error = await failure(authorizedImportCuisPackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: broken,
      require: requireFor(runtime, FULL_DEMANDS),
    }));
    assert.equal(error?.name, 'SmalltalkImportRefusedError', String(error));
    assert.equal(error.phase, 'methods');
    assert.equal(error.identity, 'cuis-class/Fixture/AChild', 'the group being admitted is named');
    assert.equal(error.cause?.name, 'SymmetricSmalltalkSyntaxError', 'the compiler owner\'s own refusal is the cause');
    assert.deepEqual(error.admitted.classes, ['cuis-class/Fixture/ZuluBase', 'cuis-class/Fixture/AChild']);
    assert.deepEqual(error.admitted.methods, ['cuis-method/Fixture/ZuluBase/instance/base', 'cuis-method/Fixture/ZuluBase/instance/base:'],
      'the groups admitted before the refusal are reported truthfully');
    // The classes and ZuluBase's methods are ordinary image state now; the corrected package converges.
    const corrected = await authorizedImportCuisPackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(),
      require: requireFor(runtime, FULL_DEMANDS),
    });
    assert.deepEqual(corrected.admitted.classes, ['cuis-class/Fixture/ZuluBase', 'cuis-class/Fixture/AChild']);
    const instance = await evaluate(runtime, 'allocate-after', '[ AChild new ]');
    assert.deepEqual(await evaluate(runtime, 'child-after', '[ :o | o child ]', [instance]).then((value) => value.kind), 'ref',
      'the corrected child accessor executes (answers the nil ref of an unset slot)');
  });
});

test('the adapter without a signal or progress callback is unchanged, and its own cancellation unit is the declaration', async () => {
  await base.withFork(async (runtime) => {
    const plain = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(),
    });
    assert.deepEqual(plain.classes.map(({identity}) => identity).sort(), ['cuis-class/Fixture/AChild', 'cuis-class/Fixture/ZuluBase']);
    const error = await failure(importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: manifest(), signal: {aborted: true},
    }));
    assert.equal(error?.name, 'CuisNativeImportAbortedError');
    assert.deepEqual(error.admitted, {classes: [], methods: []}, 'aborted before the first declaration: nothing admitted');
  });
});

test('the seam is published by name from the Node root and stays out of the language barrel', async () => {
  const runtime = await import('../src/runtime.js');
  const owner = await import('../src/language/smalltalk-authorized-import.js');
  assert.equal(runtime.authorizedImportCuisPackage, owner.authorizedImportCuisPackage, 'the owner\'s own function, never a wrapper');
  const barrel = await readFile(new URL('../src/language/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(barrel, /smalltalk-authorized-import/, 'the export * barrel would publish the seam\'s internal error classes');
  assert.equal(typeof runtime.SmalltalkImportRefusedError, 'undefined', 'error classes stay internal; consumers discriminate by error.name');
});
