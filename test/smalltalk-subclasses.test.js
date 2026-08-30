import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue,
  createRuntime,
  defineClass,
  findSmalltalkKernel,
  installSmalltalkSubclassProtocol,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  installWasmBlockTree,
  integerValue,
  objectRef,
} from '../src/runtime.js';
import {subclassRegistryId} from '../src/language/smalltalk-subclasses.js';

// Class-hierarchy introspection: `subclasses` / `allSubclasses` on every class.
//
// The required proofs map to the bead's RED list: a leaf answers empty, `Integer allSubclasses`
// answers empty (the actual upstream MessagePack requirement — Integer has no subclasses here),
// direct and transitive sets are exact by identity, the registry is durable across executor
// re-entry, the lanes agree, and replaying defineClass never duplicates a subclass entry.
//
// The registry itself is ordinary durable image state at `smalltalk/subclasses/<ClassName>`,
// maintained by `defineClass`; kernel classes maintain none (the kernel installer writes its
// class graph directly), so a missing registry reads as empty.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  return await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId, lane,
  });
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// A base class with two direct subclasses and one grandchild, returning the refs.
async function buildHierarchy(runtime, imageId, prefix) {
  const base = await defineClass({images: runtime.images, imageId, name: `${prefix}Base`});
  const a = await defineClass({
    images: runtime.images, imageId, name: `${prefix}A`, superclassRef: base.classRef,
  });
  const b = await defineClass({
    images: runtime.images, imageId, name: `${prefix}B`, superclassRef: base.classRef,
  });
  const leaf = await defineClass({
    images: runtime.images, imageId, name: `${prefix}Leaf`, superclassRef: a.classRef,
  });
  return {base, a, b, leaf};
}

const refName = (ref) => ref.objectId.replace('smalltalk/class/', '');

// Evaluate `source` naming the classes by global-style capture is unavailable in a bare Block, so
// the class refs arrive as arguments and the source names them positionally.
async function subclassesOf(runtime, imageId, id, classRef) {
  return await evaluate(runtime, imageId, id, '[ :c | c subclasses ]', [classRef]);
}
async function allSubclassesOf(runtime, imageId, id, classRef) {
  return await evaluate(runtime, imageId, id, '[ :c | c allSubclasses ]', [classRef]);
}
async function sizeOf(runtime, imageId, id, collectionSource, args) {
  return await evaluate(runtime, imageId, id, `[ ${collectionSource} ] size`, args);
}

// --- leaf / empty ------------------------------------------------------------------------------

test('a leaf class answers an empty subclasses and allSubclasses', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {leaf} = await buildHierarchy(runtime, 'app', 'L');

    assert.deepEqual(
      await evaluate(runtime, 'app', 'leaf-sub-empty', '[ :c | c subclasses isEmpty ]', [leaf.classRef]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'leaf-all-empty', '[ :c | c allSubclasses isEmpty ]', [leaf.classRef]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'leaf-sub-size', '[ :c | c subclasses size ]', [leaf.classRef]),
      integerValue(0),
    );
  });
});

test('Integer allSubclasses is empty — the upstream MessagePack requirement', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    // The exact upstream shape: `Integer allSubclasses do: [...]` must iterate zero times. Kernel
    // classes maintain no registries, so absence reads as empty rather than failing.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'int-all', '[ :i | i allSubclasses ]', [kernel.integerClass])
        .then((coll) => evaluate(runtime, 'app', 'int-all-size', '[ :c | c size ]', [coll])),
      integerValue(0),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'int-sub-empty', '[ :i | i subclasses isEmpty ]', [kernel.integerClass]),
      booleanValue(true),
    );
    // The literal upstream iteration runs to completion with zero side effects.
    assert.deepEqual(
      await evaluate(
        runtime, 'app', 'int-do', '[ :i | | n | n := 0. i allSubclasses do: [ :each | n := n + 1 ]. n ]',
        [kernel.integerClass],
      ),
      integerValue(0),
    );
  });
});

// --- direct subclasses -------------------------------------------------------------------------

test('subclasses answers exactly the direct subclasses, by identity', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {base, a, b} = await buildHierarchy(runtime, 'app', 'D');

    const coll = await subclassesOf(runtime, 'app', 'd-sub', base.classRef);
    assert.deepEqual(await evaluate(runtime, 'app', 'd-size', '[ :c | c size ]', [coll]), integerValue(2));
    // includes: uses `=`, which for refs is identity — so this is membership by identity.
    assert.deepEqual(
      await evaluate(runtime, 'app', 'd-has-a', '[ :c :x | c includes: x ]', [coll, a.classRef]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'd-has-b', '[ :c :x | c includes: x ]', [coll, b.classRef]),
      booleanValue(true),
    );
    // The grandchild is NOT a direct subclass.
    const grandchild = objectRef('app', 'smalltalk/class/DLeaf');
    assert.deepEqual(
      await evaluate(runtime, 'app', 'd-no-leaf', '[ :c :x | c includes: x ]', [coll, grandchild]),
      booleanValue(false),
    );
  });
});

// --- transitive subclasses ---------------------------------------------------------------------

test('allSubclasses answers the full transitive set', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {base, a, b, leaf} = await buildHierarchy(runtime, 'app', 'T');

    const coll = await allSubclassesOf(runtime, 'app', 't-all', base.classRef);
    // base -> {a, b}; a -> {leaf}. So allSubclasses = {a, b, leaf}.
    assert.deepEqual(await evaluate(runtime, 'app', 't-size', '[ :c | c size ]', [coll]), integerValue(3));
    for (const [id, ref] of [['a', a.classRef], ['b', b.classRef], ['leaf', leaf.classRef]]) {
      assert.deepEqual(
        await evaluate(runtime, 'app', `t-has-${id}`, '[ :c :x | c includes: x ]', [coll, ref]),
        booleanValue(true),
        `allSubclasses includes ${refName(ref)}`,
      );
    }
    // The receiver itself is not its own subclass.
    assert.deepEqual(
      await evaluate(runtime, 'app', 't-no-self', '[ :c :x | c includes: x ]', [coll, base.classRef]),
      booleanValue(false),
    );
    // And the intermediate class's own transitive set excludes its sibling.
    const fromA = await allSubclassesOf(runtime, 'app', 't-all-a', a.classRef);
    assert.deepEqual(await evaluate(runtime, 'app', 't-a-size', '[ :c | c size ]', [fromA]), integerValue(1));
    assert.deepEqual(
      await evaluate(runtime, 'app', 't-a-no-b', '[ :c :x | c includes: x ]', [fromA, b.classRef]),
      booleanValue(false),
    );
  });
});

// --- durability across executor re-entry --------------------------------------------------------

test('the registry is durable: introspection works after re-entering the executor', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {base, a, b} = await buildHierarchy(runtime, 'app', 'R');

    // The registry is an ordinary durable object in the image record — a fresh read (not a
    // cached in-process value) shows both subclass refs.
    const registry = await runtime.images.getObject('app', subclassRegistryId('RBase'));
    assert.ok(registry, 'registry durable');
    const names = registry.indexed.map((ref) => refName(ref)).sort();
    assert.deepEqual(names, ['RA', 'RB']);

    // Re-discover the kernel from nothing but the image id and introspect again.
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    assert.ok(kernel, 'kernel rediscovered');
    const coll = await subclassesOf(runtime, 'app', 'r-sub', base.classRef);
    assert.deepEqual(await evaluate(runtime, 'app', 'r-size', '[ :c | c size ]', [coll]), integerValue(2));
    assert.deepEqual(
      await evaluate(runtime, 'app', 'r-has-a', '[ :c :x | c includes: x ]', [coll, a.classRef]),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'r-has-b', '[ :c :x | c includes: x ]', [coll, b.classRef]),
      booleanValue(true),
    );
  });
});

// --- replay -------------------------------------------------------------------------------------

test('re-running defineClass for an existing class does not duplicate the subclass entry', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const base = await defineClass({images: runtime.images, imageId: 'app', name: 'PBase'});
    await defineClass({images: runtime.images, imageId: 'app', name: 'PA', superclassRef: base.classRef});

    // Replay the identical definitions — defineClass is ensure-exact-or-create, and the registry
    // append is membership-guarded, so neither duplicates.
    await defineClass({images: runtime.images, imageId: 'app', name: 'PBase'});
    await defineClass({images: runtime.images, imageId: 'app', name: 'PA', superclassRef: base.classRef});

    const registry = await runtime.images.getObject('app', subclassRegistryId('PBase'));
    assert.deepEqual(registry.indexed.length, 1, 'replayed defineClass added no duplicate');
    assert.deepEqual(registry.indexed[0], objectRef('app', 'smalltalk/class/PA'));

    const coll = await subclassesOf(runtime, 'app', 'p-sub', base.classRef);
    assert.deepEqual(await evaluate(runtime, 'app', 'p-size', '[ :c | c size ]', [coll]), integerValue(1));
  });
});

// --- lane agreement ------------------------------------------------------------------------------

test('subclasses and allSubclasses agree across neutral and WASM lanes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app-w', {lane: 'wasm'});
    const {base, a} = await buildHierarchy(runtime, 'app-w', 'W');

    const run = async (id, source, args) => {
      const installed = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app-w', id, source,
      });
      const tree = await installWasmBlockTree({
        images: runtime.images, compilation: runtime.compilation,
        semanticRef: objectRef('app-w', installed.semanticArtifact.id),
        id: `${id}:tree`, environment: installed.block.environment,
      });
      const activation = await runtime.invocations.invokeBlock(objectRef('app-w', tree.block.id), args);
      return await runtime.executor.execute(activation);
    };

    // Both lanes compute the direct-subclass count and the transitive membership by identity.
    const wasmSubSize = await run('w-sub-size', '[ :c | c subclasses size ]', [base.classRef]);
    const wasmAllHasLeaf = await run(
      'w-all-leaf', '[ :c :x | c allSubclasses includes: x ]', [base.classRef, a.classRef],
    );
    const wasmAllSize = await run('w-all-size', '[ :c | c allSubclasses size ]', [base.classRef]);

    const neutralSubSize = await evaluate(runtime, 'app-w', 'n-sub-size', '[ :c | c subclasses size ]', [base.classRef]);
    const neutralAllSize = await evaluate(runtime, 'app-w', 'n-all-size', '[ :c | c allSubclasses size ]', [base.classRef]);

    assert.deepEqual(wasmSubSize, integerValue(2));
    assert.deepEqual(wasmAllHasLeaf, booleanValue(true));
    assert.deepEqual(wasmAllSize, integerValue(3));
    assert.deepEqual(wasmSubSize, neutralSubSize);
    assert.deepEqual(wasmAllSize, neutralAllSize);
  });
});

// --- guards ---------------------------------------------------------------------------------------

test('subclasses is class protocol: an instance does not understand it', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // `subclasses` lives on Class, so an Integer instance — which is not a class — gets the
    // ordinary message-not-understood rather than reaching the primitive. The primitive's own
    // receiver guard is defence in depth behind the dispatch walk.
    await assert.rejects(
      evaluate(runtime, 'app', 'g-refuse', '[ 5 subclasses ]'),
      /message not understood: subclasses/i,
    );
  });
});
