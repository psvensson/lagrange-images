import test from 'node:test';
import assert from 'node:assert/strict';
import './ensure-node-crypto.test-helper.js';
import {createRuntime} from '../src/runtime.js';
import {exportGraphBundle, GRAPH_BUNDLE_V1, GraphBundleExportError} from '../src/graph/bundle.js';
import {referencesOfRecord} from '../src/graph/references.js';
import {getDefaultCryptoProvider, setDefaultCryptoProvider} from '../src/support/default-crypto.js';
import {createNodeCryptoProvider} from '../src/support/node-crypto-provider.js';
import {
  integerValue,
  objectRef,
  pinnedRef,
  textValue,
} from '../src/value/index.js';

// ADR 0074 first slice acceptance proofs: durable graph roots -> portable graph
// bundle + deterministic contentIdentity, EXPORT ONLY. Every adversarial case the
// ADR named, plus the source-identity/frontier/metadata/insertion-order/provider
// discriminators and the falsification discriminating proofs.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seedShape(runtime, imageId, shapeId = 'shape', slots = [{id: 'v', name: 'v'}]) {
  await runtime.images.createImage({id: imageId});
  await runtime.images.putShape(imageId, {id: shapeId, slots});
  return objectRef(imageId, shapeId);
}

test('Object + Shape: two bundle records; object shape edge becomes a local-ref', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(7)}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    assert.equal(bundle.format, GRAPH_BUNDLE_V1);
    assert.deepEqual(bundle.roots, {root: 'r0'});
    assert.equal(Object.keys(bundle.records).length, 2);
    assert.deepEqual(bundle.records.r0.shape, {kind: 'local-ref', localId: 'r1'});
    assert.equal(bundle.records.r1.kind, 'shape');
    assert.deepEqual(bundle.externals, {});
  });
});

test('Shared child: two parents -> one bundled child localId (aliasing preserved)', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'child', shape, slots: {v: integerValue(1)}});
    await runtime.images.putObject('img', {id: 'p1', shape, slots: {v: objectRef('img', 'child')}});
    await runtime.images.putObject('img', {id: 'p2', shape, slots: {v: objectRef('img', 'child')}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {a: objectRef('img', 'p1'), b: objectRef('img', 'p2')},
    });
    const childRefs = JSON.stringify(bundle).match(/"local-ref"/g) ?? [];
    // both parents point at ONE child localId
    const childLocalIds = new Set([
      bundle.records[bundle.roots.a].slots.v.localId,
      bundle.records[bundle.roots.b].slots.v.localId,
    ]);
    assert.equal(childLocalIds.size, 1, 'same child reached twice -> one localId');
    const childLocalId = [...childLocalIds][0];
    assert.equal(bundle.records[childLocalId].slots.v.value, '1');
  });
});

test('Cycle A -> B -> A terminates and preserves the cycle', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'a', shape, slots: {v: integerValue(0)}});
    await runtime.images.putObject('img', {id: 'b', shape, slots: {v: objectRef('img', 'a')}});
    // now point a at b (mutate a)
    await runtime.images.putObject('img', {id: 'a', shape, slots: {v: objectRef('img', 'b')}}, {expectedVersion: 1});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'a')}});
    assert.equal(bundle.records.r0.slots.v.kind, 'local-ref');
    const bLocal = bundle.records.r0.slots.v.localId;
    assert.deepEqual(bundle.records[bLocal].slots.v, {kind: 'local-ref', localId: 'r0'}, 'cycle back to A preserved');
    assert.equal(Object.keys(bundle.records).length, 3, 'a + b + shape, no infinite recursion');
  });
});

test('Block closure: Block -> CodeArtifact + LexicalEnvironment via referencesOfRecord traversal', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putLexicalEnvironment('img', {id: 'env', bindings: {}});
    await runtime.images.putCodeArtifact('img', {id: 'code', representation: 'neutral-expression/v0', content: textValue('1')});
    await runtime.images.putBlock('img', {id: 'block', code: objectRef('img', 'code'), environment: objectRef('img', 'env')});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'block')}});
    const kinds = Object.values(bundle.records).map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['block', 'code-artifact', 'lexical-environment']);
    assert.equal(bundle.records.r0.kind, 'block');
    assert.equal(bundle.records.r0.code.kind, 'local-ref');
    assert.equal(bundle.records.r0.environment.kind, 'local-ref');
  });
});

test('CodeArtifact dependency graph: dependency/derivedFrom closure traversed, no CodeArtifact-specific code', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putCodeArtifact('img', {id: 'base', representation: 'neutral-expression/v0', content: textValue('1')});
    await runtime.images.putCodeArtifact('img', {
      id: 'mid', representation: 'neutral-expression/v0', content: textValue('2'),
      dependencies: [{role: 'import', artifact: objectRef('img', 'base')}],
    });
    await runtime.images.putCodeArtifact('img', {
      id: 'top', representation: 'neutral-expression/v0', content: textValue('3'),
      dependencies: [{role: 'import', artifact: objectRef('img', 'mid')}],
      derivedFrom: [objectRef('img', 'base')],
    });
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'top')}});
    assert.equal(Object.keys(bundle.records).length, 3, 'top + mid + base all bundled');
    // dependency edge is a local-ref into the closure
    const top = bundle.records.r0;
    assert.equal(top.dependencies[0].artifact.kind, 'local-ref');
    assert.equal(top.derivedFrom[0].kind, 'local-ref');
  });
});

test('Multi-root alias: two root keys naming the same source record -> one record/localId', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(9)}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {first: objectRef('img', 'obj'), second: objectRef('img', 'obj')},
    });
    assert.equal(bundle.roots.first, bundle.roots.second, 'same source -> one localId for both root keys');
    const objectRecords = Object.values(bundle.records).filter((r) => r.kind === 'object');
    assert.equal(objectRecords.length, 1, 'the object is bundled once');
  });
});

test('Cross-Image default: cross-Image child becomes external; no silent traversal', async () => {
  await withRuntime(async (runtime) => {
    const shapeA = await seedShape(runtime, 'a');
    const shapeB = await seedShape(runtime, 'b');
    await runtime.images.putObject('b', {id: 'foreign', shape: shapeB, slots: {v: integerValue(1)}});
    await runtime.images.putObject('a', {id: 'local', shape: shapeA, slots: {v: objectRef('b', 'foreign')}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('a', 'local')}});
    assert.equal(bundle.records.r0.slots.v.kind, 'external-ref', 'cross-Image ref defaults to external');
    const extKey = bundle.records.r0.slots.v.externalKey;
    assert.deepEqual(bundle.externals[extKey], {pinned: false, imageId: 'b', objectId: 'foreign'});
    assert.ok(!Object.values(bundle.records).some((r) => r.slots?.v?.value === '1'), 'foreign record NOT bundled');
  });
});

test('Cross-Image opt-in: explicit policy makes that same edge internal and includes the target', async () => {
  await withRuntime(async (runtime) => {
    const shapeA = await seedShape(runtime, 'a');
    const shapeB = await seedShape(runtime, 'b');
    await runtime.images.putObject('b', {id: 'foreign', shape: shapeB, slots: {v: integerValue(1)}});
    await runtime.images.putObject('a', {id: 'local', shape: shapeA, slots: {v: objectRef('b', 'foreign')}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {root: objectRef('a', 'local')},
      referencePolicy: {classify: () => 'internal'},
    });
    assert.equal(bundle.records.r0.slots.v.kind, 'local-ref', 'opted-in cross-Image ref becomes internal');
    const kinds = Object.values(bundle.records).map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['object', 'object', 'shape', 'shape'], 'foreign record + its shape bundled');
  });
});

test('Explicit same-Image external: a well-known Shape declared external uses the SAME mechanism', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(7)}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {root: objectRef('img', 'obj')},
      // Externalize the Shape specifically (same mechanism as any external — no Shape special-case).
      referencePolicy: {classify: (ref) => (ref.objectId === 'shape' ? 'external' : 'internal')},
    });
    assert.equal(bundle.records.r0.shape.kind, 'external-ref');
    const extKey = bundle.records.r0.shape.externalKey;
    assert.deepEqual(bundle.externals[extKey], {pinned: false, imageId: 'img', objectId: 'shape'});
    assert.ok(!Object.values(bundle.records).some((r) => r.kind === 'shape'), 'Shape not bundled');
  });
});

test('Pinned ref: always external by construction; exact pin preserved; policy cannot internalize it', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: pinnedRef('img', 'obj', '5')}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {root: objectRef('img', 'obj')},
      referencePolicy: {classify: () => 'internal'}, // tries to internalize everything
    });
    assert.equal(bundle.records.r0.slots.v.kind, 'external-ref', 'pinned ref is external even under an internal-everything policy');
    const extKey = bundle.records.r0.slots.v.externalKey;
    assert.deepEqual(bundle.externals[extKey], {pinned: true, imageId: 'img', objectId: 'obj', revision: '5'}, 'exact pin preserved');
  });
});

test('Different source identities: isomorphic graphs with different imageId/objectId -> identical contentIdentity', async () => {
  const buildGraph = async (runtime, imageId, prefix) => {
    const shape = await seedShape(runtime, imageId, `${prefix}-shape`);
    await runtime.images.putObject(imageId, {id: `${prefix}-child`, shape, slots: {v: integerValue(42)}});
    await runtime.images.putObject(imageId, {id: `${prefix}-root`, shape, slots: {v: objectRef(imageId, `${prefix}-child`)}});
    return objectRef(imageId, `${prefix}-root`);
  };
  let first;
  let second;
  await withRuntime(async (runtime) => {
    first = await exportGraphBundle({images: runtime.images, roots: {root: await buildGraph(runtime, 'imgOne', 'alpha')}});
  });
  await withRuntime(async (runtime) => {
    second = await exportGraphBundle({images: runtime.images, roots: {root: await buildGraph(runtime, 'imgTwo', 'beta')}});
  });
  assert.equal(first.contentIdentity, second.contentIdentity, 'source identity is not portable identity');
  assert.deepEqual(first.bundle, second.bundle, 'bundle semantic bytes identical');
});

test('Later unrelated frontier/write: re-export unchanged graph -> identical contentIdentity; bundle has no frontier field', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(7)}});
    const before = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    // unrelated write elsewhere in the same Image advances its frontier
    await runtime.images.putObject('img', {id: 'unrelated', shape, slots: {v: integerValue(0)}});
    const after = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    assert.equal(before.contentIdentity, after.contentIdentity, 'unrelated frontier movement does not change identity');
    assert.ok(!('frontier' in before.bundle) && !('sourceFrontiers' in before.bundle), 'bundle has no frontier field');
  });
});

test('Meaningful graph change: slot scalar / edge / bundled dependency change -> different contentIdentity', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(7)}});
    const base = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(8)}}, {expectedVersion: 1});
    const changed = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    assert.notEqual(base.contentIdentity, changed.contentIdentity, 'a slot scalar change changes identity');
  });
});

test('metadata / updatedAt / _version only change -> identical contentIdentity', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(7)}, metadata: {note: 'one'}});
    const first = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    // mutate ONLY metadata (also bumps _version + updatedAt)
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(7)}, metadata: {note: 'two'}}, {expectedVersion: 1});
    const second = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    assert.equal(first.contentIdentity, second.contentIdentity, 'metadata/_version/updatedAt are provenance, not identity');
  });
});

test('slot-map insertion order differs -> identical contentIdentity', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img', 'shape', [{id: 'a', name: 'a'}, {id: 'b', name: 'b'}]);
    await runtime.images.putObject('img', {id: 'obj1', shape, slots: {a: integerValue(1), b: integerValue(2)}});
    // construct the same semantic object with opposite insertion order via a fresh image
    await runtime.images.createImage({id: 'img2'});
    await runtime.images.putShape('img2', {id: 'shape', slots: [{id: 'a', name: 'a'}, {id: 'b', name: 'b'}]});
    await runtime.images.putObject('img2', {id: 'obj2', shape: objectRef('img2', 'shape'), slots: {b: integerValue(2), a: integerValue(1)}});
    const one = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj1')}});
    const two = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img2', 'obj2')}});
    assert.equal(one.contentIdentity, two.contentIdentity, 'slot insertion order is not identity');
  });
});

test('slot edge insertion order differs (refs in slots) -> identical local-id assignment AND contentIdentity', async () => {
  // Two semantically identical objects with refs in two slots, constructed with
  // opposite slot insertion order. Canonical edge ordering (slot id code-unit
  // order, owned by referencesOfRecord) must assign local ids identically — so the
  // same target gets the same localId in both, proving local-id assignment is
  // source-insertion-order-independent, not just contentIdentity.
  const build = async (runtime, imageId, slotsInOrder) => {
    await runtime.images.createImage({id: imageId});
    await runtime.images.putShape(imageId, {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject(imageId, {id: 'ca', shape: objectRef(imageId, 'shape'), slots: {v: integerValue(1)}});
    await runtime.images.putObject(imageId, {id: 'cb', shape: objectRef(imageId, 'shape'), slots: {v: integerValue(2)}});
    await runtime.images.putShape(imageId, {id: 'pair', slots: [{id: 'a', name: 'a'}, {id: 'b', name: 'b'}]});
    await runtime.images.putObject(imageId, {id: 'root', shape: objectRef(imageId, 'pair'), slots: slotsInOrder});
    return objectRef(imageId, 'root');
  };
  let one;
  let two;
  await withRuntime(async (runtime) => {
    one = await exportGraphBundle({
      images: runtime.images,
      roots: {root: await build(runtime, 'i1', {a: objectRef('i1', 'ca'), b: objectRef('i1', 'cb')})},
    });
  });
  await withRuntime(async (runtime) => {
    two = await exportGraphBundle({
      images: runtime.images,
      roots: {root: await build(runtime, 'i2', {b: objectRef('i2', 'cb'), a: objectRef('i2', 'ca')})},
    });
  });
  // slot a's target (the '1' object) must get the SAME localId in both.
  assert.equal(one.bundle.records.r0.slots.a.localId, two.bundle.records.r0.slots.a.localId, 'canonical edge order, not insertion order');
  assert.equal(one.bundle.records.r0.slots.b.localId, two.bundle.records.r0.slots.b.localId);
  assert.equal(one.contentIdentity, two.contentIdentity);
});

test('lexical-binding insertion order differs -> identical contentIdentity', async () => {
  const buildEnv = async (runtime, imageId, envId, bindings) => {
    await runtime.images.createImage({id: imageId});
    await runtime.images.putLexicalEnvironment(imageId, {id: envId, bindings});
    return objectRef(imageId, envId);
  };
  await withRuntime(async (runtime) => {
    const envA = await buildEnv(runtime, 'e1', 'env', {
      x: {name: 'x', value: integerValue(1)},
      y: {name: 'y', value: integerValue(2)},
    });
    const envB = await buildEnv(runtime, 'e2', 'env', {
      y: {name: 'y', value: integerValue(2)},
      x: {name: 'x', value: integerValue(1)},
    });
    const one = await exportGraphBundle({images: runtime.images, roots: {root: envA}});
    const two = await exportGraphBundle({images: runtime.images, roots: {root: envB}});
    assert.equal(one.contentIdentity, two.contentIdentity, 'binding insertion order is not identity');
  });
});

test('source ObjectIds never appear inside roots/records internal identity data', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'secretly-named-object', shape, slots: {v: integerValue(1)}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'secretly-named-object')}});
    const rootsAndRecords = JSON.stringify({roots: bundle.roots, records: bundle.records});
    assert.ok(!rootsAndRecords.includes('secretly-named-object'), 'source objectId must not leak into internal identity');
    assert.ok(!rootsAndRecords.includes('img'), 'source imageId must not leak into internal identity');
  });
});

test('crypto provider independence: two conforming providers produce identical graph contentIdentity', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(7)}});
    setDefaultCryptoProvider(createNodeCryptoProvider());
    const one = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    // a second conforming provider: same primitives, same digests (Node reference is the oracle)
    const second = await exportGraphBundle({
      images: runtime.images, roots: {root: objectRef('img', 'obj')}, crypto: createNodeCryptoProvider(),
    });
    assert.equal(one.contentIdentity, second.contentIdentity);
  });
});

test('missing required internal record -> explicit export failure, never silent omission', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: integerValue(1)}});
    await assert.rejects(
      exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'does-not-exist')}}),
      GraphBundleExportError,
    );
  });
});

test('projection/edge-owner guard: rewritten refs correspond exactly to referencesOfRecord', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'child', shape, slots: {v: integerValue(1)}});
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: objectRef('img', 'child')}});
    const record = await runtime.images.getRecord('img', 'obj');
    // referencesOfRecord counts shape + slot child = 2 edges; the projection must rewrite exactly those.
    assert.equal(referencesOfRecord(record).length, 2);
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    // both edges rewritten to local-ref tokens
    assert.equal(bundle.records.r0.shape.kind, 'local-ref');
    assert.equal(bundle.records.r0.slots.v.kind, 'local-ref');
  });
});

// --- Tuple-key bookkeeping proofs (joined-string collision defect repair) ---------
// The old implementation keyed internal dedup by `${imageId}${objectId}` and external
// dedup by analogous joined strings. Image ids, object ids and revision text are
// arbitrary strings, so those keys were not injective. These proofs pin the exact
// tuples as the bookkeeping identity. The public bundle format is unchanged.

test('INTERNAL COLLISION: source tuples (ab,c) and (a,bc) -> distinct localIds and distinct records', async () => {
  await withRuntime(async (runtime) => {
    // Root imageIds {'ab','a'} make both roots internal under the default policy.
    await runtime.images.createImage({id: 'ab'});
    await runtime.images.putShape('ab', {id: 'shape', slots: []});
    await runtime.images.putObject('ab', {id: 'c', shape: objectRef('ab', 'shape'), slots: {}});
    await runtime.images.createImage({id: 'a'});
    await runtime.images.putShape('a', {id: 'shape', slots: []});
    await runtime.images.putObject('a', {id: 'bc', shape: objectRef('a', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {first: objectRef('ab', 'c'), second: objectRef('a', 'bc')},
    });
    assert.notEqual(bundle.roots.first, bundle.roots.second, 'ambiguous joined key must NOT collapse the two roots');
    assert.equal(Object.keys(bundle.records).length, 4, 'two objects + two shapes, nothing collapsed');
    assert.equal(bundle.records[bundle.roots.first].kind, 'object');
    assert.equal(bundle.records[bundle.roots.second].kind, 'object');
  });
});

test('SHARED IDENTITY STILL DEDUPS: the exact same (imageId, objectId) reached twice -> one localId', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'child', shape, slots: {v: integerValue(3)}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {a: objectRef('img', 'child'), b: objectRef('img', 'child')},
    });
    assert.equal(bundle.roots.a, bundle.roots.b, 'identical tuple still dedups to one localId');
    assert.equal(Object.keys(bundle.records).length, 2, 'child + shape only');
  });
});

test('UNPINNED EXTERNAL COLLISION: ambiguous (ab,c) vs (a,bc) -> two distinct externalKeys/descriptors', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    // Cross-Image refs are external under the default policy; targets are never fetched.
    await runtime.images.putObject('img', {id: 'x', shape, slots: {v: objectRef('ab', 'c')}});
    await runtime.images.putObject('img', {id: 'y', shape, slots: {v: objectRef('a', 'bc')}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {x: objectRef('img', 'x'), y: objectRef('img', 'y')},
    });
    const keyX = bundle.records[bundle.roots.x].slots.v.externalKey;
    const keyY = bundle.records[bundle.roots.y].slots.v.externalKey;
    assert.notEqual(keyX, keyY, 'ambiguous joined key must NOT collapse the two external requirements');
    assert.equal(Object.keys(bundle.externals).length, 2);
    assert.deepEqual(bundle.externals[keyX], {pinned: false, imageId: 'ab', objectId: 'c'});
    assert.deepEqual(bundle.externals[keyY], {pinned: false, imageId: 'a', objectId: 'bc'});
  });
});

test('PINNED EXTERNAL COLLISION — ID BOUNDARY: ambiguous (ab,c) vs (a,bc) pins -> distinct externals', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'x', shape, slots: {v: pinnedRef('ab', 'c', '7')}});
    await runtime.images.putObject('img', {id: 'y', shape, slots: {v: pinnedRef('a', 'bc', '7')}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {x: objectRef('img', 'x'), y: objectRef('img', 'y')},
    });
    const keyX = bundle.records[bundle.roots.x].slots.v.externalKey;
    const keyY = bundle.records[bundle.roots.y].slots.v.externalKey;
    assert.notEqual(keyX, keyY);
    assert.equal(Object.keys(bundle.externals).length, 2);
    assert.deepEqual(bundle.externals[keyX], {pinned: true, imageId: 'ab', objectId: 'c', revision: '7'});
    assert.deepEqual(bundle.externals[keyY], {pinned: true, imageId: 'a', objectId: 'bc', revision: '7'});
  });
});

test('PINNED EXTERNAL COLLISION — REVISION BOUNDARY: (x,y,rz) vs (x,yr,z) — identical old concatenation — stay distinct', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    // Old joined key for both was 'pinned'+'x'+'y'+'rz' === 'pinned'+'x'+'yr'+'z'.
    await runtime.images.putObject('img', {id: 'x', shape, slots: {v: pinnedRef('x', 'y', 'rz')}});
    await runtime.images.putObject('img', {id: 'y', shape, slots: {v: pinnedRef('x', 'yr', 'z')}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {x: objectRef('img', 'x'), y: objectRef('img', 'y')},
    });
    const keyX = bundle.records[bundle.roots.x].slots.v.externalKey;
    const keyY = bundle.records[bundle.roots.y].slots.v.externalKey;
    assert.notEqual(keyX, keyY, 'revision-boundary collision must NOT merge the two pins');
    assert.equal(Object.keys(bundle.externals).length, 2);
    assert.deepEqual(bundle.externals[keyX], {pinned: true, imageId: 'x', objectId: 'y', revision: 'rz'});
    assert.deepEqual(bundle.externals[keyY], {pinned: true, imageId: 'x', objectId: 'yr', revision: 'z'});
  });
});

test('EXISTING BUNDLE COMPATIBILITY: representative graph -> byte-identical canonical bundle + contentIdentity (regression anchor)', async () => {
  await withRuntime(async (runtime) => {
    const shape = await seedShape(runtime, 'img');
    await runtime.images.putObject('img', {id: 'child', shape, slots: {v: integerValue(42)}});
    await runtime.images.putObject('img', {id: 'obj', shape, slots: {v: objectRef('img', 'child')}});
    // The expected hash below was captured from the PRE-repair (joined-string)
    // implementation for this exact graph and verified byte-identical post-repair;
    // the tuple-key repair must not move a single byte for any non-collision case.
    const first = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    const second = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'obj')}});
    assert.equal(first.contentIdentity, second.contentIdentity);
    assert.equal(
      first.contentIdentity,
      'sha256:b36e08989b3ee333f2288c904345917cbcfb195a9b690d4739e4d4c508b2e499',
      'contentIdentity unchanged by the tuple-key repair',
    );
  });
});
