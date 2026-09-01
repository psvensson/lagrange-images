import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {createRuntime} from '../src/runtime.js';
import {LagrangeBackend} from '../src/backend/index.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {
  exportGraphBundle,
  importGraphBundle,
  GraphBundleImportError,
} from '../src/graph/bundle.js';
import {
  integerValue,
  objectRef,
  pinnedRef,
  textValue,
} from '../src/value/index.js';

// ADR 0074 second slice acceptance proofs: portable graph bundle -> fresh
// target-Image graph, IMPORT ONLY, published atomically through
// GraphImageService.createRecords (PR #165).

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

const recordsCreated = async (runtime, imageId) => await runtime.images.listRecords(imageId);
const eventsOf = async (runtime, imageId) =>
  (await runtime.images.history(imageId)).filter((e) => e.type !== 'image.created');

// A fully internal heterogeneous graph: Shape + Object(+child) + CodeArtifact
// (with a fresh dependency) + LexicalEnvironment + Block closure.
async function seedInternalGraph(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  await runtime.images.putShape(imageId, {id: 'shape', slots: [{id: 'v', name: 'v'}]});
  await runtime.images.putObject(imageId, {id: 'child', shape: objectRef(imageId, 'shape'), slots: {v: integerValue(42)}});
  await runtime.images.putObject(imageId, {id: 'obj', shape: objectRef(imageId, 'shape'), slots: {v: objectRef(imageId, 'child')}});
  await runtime.images.putCodeArtifact(imageId, {id: 'base', representation: 'neutral-expression/v0', content: textValue('1')});
  await runtime.images.putCodeArtifact(imageId, {
    id: 'code', representation: 'neutral-expression/v0', content: textValue('2'),
    dependencies: [{role: 'import', artifact: objectRef(imageId, 'base')}],
  });
  await runtime.images.putLexicalEnvironment(imageId, {id: 'env', bindings: {}});
  await runtime.images.putBlock(imageId, {
    id: 'block', code: objectRef(imageId, 'code'), environment: objectRef(imageId, 'env'),
  });
}

test('1. Object + Shape round-trip: fresh records, fresh ids, localIds never become target ids', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {v: integerValue(7)}});
    const {bundle, contentIdentity} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});

    await runtime.images.createImage({id: 'dst'});
    const result = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle});
    assert.equal(result.contentIdentity, contentIdentity);
    const targetObj = await runtime.images.getObject('dst', result.roots.root.objectId);
    assert.ok(targetObj, 'imported object exists');
    assert.notEqual(result.roots.root.objectId, 'obj', 'target id differs from source id');
    assert.notEqual(result.roots.root.objectId, 'r0', 'bundle localId did not become target id');
    const targetShape = await runtime.images.getShape('dst', targetObj.shape.objectId);
    assert.ok(targetShape, 'imported shape exists and object references it');
    assert.notEqual(targetShape.id, 'shape');
    assert.equal(targetObj.slots.v.value, '7');
  });
});

test('2. Shared child: both target parents point at the SAME fresh target child', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('src', {id: 'child', shape: objectRef('src', 'shape'), slots: {v: integerValue(1)}});
    await runtime.images.putObject('src', {id: 'p1', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'child')}});
    await runtime.images.putObject('src', {id: 'p2', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'child')}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images, roots: {a: objectRef('src', 'p1'), b: objectRef('src', 'p2')},
    });
    await runtime.images.createImage({id: 'dst'});
    const {roots} = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle});
    const pa = await runtime.images.getObject('dst', roots.a.objectId);
    const pb = await runtime.images.getObject('dst', roots.b.objectId);
    assert.equal(pa.slots.v.objectId, pb.slots.v.objectId, 'aliasing preserved: one shared fresh child');
    assert.equal((await recordsCreated(runtime, 'dst')).length, 4, 'no duplication: 2 parents + 1 child + 1 shape');
  });
});

test('3. Cycle: A -> B -> A survives import atomically (two-phase mint proof)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('src', {id: 'a', shape: objectRef('src', 'shape'), slots: {v: integerValue(0)}});
    await runtime.images.putObject('src', {id: 'b', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'a')}});
    await runtime.images.putObject('src', {id: 'a', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'b')}}, {expectedVersion: 1});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'a')}});
    await runtime.images.createImage({id: 'dst'});
    const {roots} = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle});
    const a = await runtime.images.getObject('dst', roots.root.objectId);
    const b = await runtime.images.getObject('dst', a.slots.v.objectId);
    assert.equal(b.slots.v.objectId, a.id, 'cycle preserved exactly through fresh ids');
  });
});

test('4. Heterogeneous Block closure imports in ONE createRecords call; relationships resolve fresh', async () => {
  await withRuntime(async (runtime) => {
    await seedInternalGraph(runtime, 'src');
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {block: objectRef('src', 'block')}});
    await runtime.images.createImage({id: 'dst'});
    const realCreate = runtime.images.createRecords.bind(runtime.images);
    let calls = 0;
    runtime.images.createRecords = async (imageId, inputs) => { calls += 1; return realCreate(imageId, inputs); };
    const {roots} = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle});
    assert.equal(calls, 1, 'exactly one createRecords publication');
    const block = await runtime.images.getBlock('dst', roots.block.objectId);
    assert.ok(await runtime.images.getCodeArtifact('dst', block.code.objectId), 'fresh code artifact');
    assert.ok(await runtime.images.getLexicalEnvironment('dst', block.environment.objectId), 'fresh lexical environment');
    const code = await runtime.images.getCodeArtifact('dst', block.code.objectId);
    assert.ok(await runtime.images.getCodeArtifact('dst', code.dependencies[0].artifact.objectId), 'fresh dependency artifact');
  });
});

test('5. CodeArtifact dependency graph: fresh deps remain fresh target CodeArtifact refs', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putCodeArtifact('src', {id: 'base', representation: 'neutral-expression/v0', content: textValue('1')});
    await runtime.images.putCodeArtifact('src', {
      id: 'top', representation: 'neutral-expression/v0', content: textValue('2'),
      dependencies: [{role: 'import', artifact: objectRef('src', 'base')}],
    });
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {top: objectRef('src', 'top')}});
    await runtime.images.createImage({id: 'dst'});
    const {roots} = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle});
    const top = await runtime.images.getCodeArtifact('dst', roots.top.objectId);
    const dep = top.dependencies[0].artifact;
    const depRecord = await runtime.images.getCodeArtifact('dst', dep.objectId);
    assert.ok(depRecord, 'dependency resolves to a fresh target code-artifact (createRecords kind validation passed)');
    assert.notEqual(dep.objectId, 'base');
  });
});

test('6. Multi-root alias: two root keys naming one bundled record return the SAME fresh ObjectRef', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({
      images: runtime.images, roots: {a: objectRef('src', 'obj'), b: objectRef('src', 'obj')},
    });
    await runtime.images.createImage({id: 'dst'});
    const {roots} = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle});
    assert.deepEqual(roots.a, roots.b);
  });
});

test('7. External unpinned binding: imported record points to the exact existing target ref; target NOT copied', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    // cross-Image ref is external under the default policy
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {v: objectRef('other', 'well-known')}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    assert.equal(Object.keys(bundle.externals).length, 1);

    await runtime.images.createImage({id: 'dst'});
    await runtime.images.putShape('dst', {id: 'shape', slots: []});
    await runtime.images.putObject('dst', {id: 'existing-target', shape: objectRef('dst', 'shape'), slots: {}});
    const before = (await recordsCreated(runtime, 'dst')).length;
    const {roots} = await importGraphBundle({
      images: runtime.images, targetImageId: 'dst', bundle,
      externalBindings: {e0: objectRef('dst', 'existing-target')},
    });
    const imported = await runtime.images.getObject('dst', roots.root.objectId);
    assert.deepEqual(imported.slots.v, objectRef('dst', 'existing-target'), 'exact bound ref preserved');
    assert.equal((await recordsCreated(runtime, 'dst')).length, before + 2, 'external target NOT copied; only obj+shape imported');
  });
});

test('8. Missing external binding: refuse before creation, zero records/history', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {v: objectRef('other', 'x')}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle}),
      (error) => error instanceof GraphBundleImportError && /missing external binding/.test(error.message),
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
    assert.deepEqual(await eventsOf(runtime, 'dst'), []);
  });
});

test('9. Extra external binding: refuse before creation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle, externalBindings: {e0: objectRef('dst', 'x')}}),
      /unknown external binding key/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
  });
});

test('10. Missing bound target: unpinned binding at a nonexistent record refuses before creation', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {v: objectRef('other', 'x')}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle, externalBindings: {e0: objectRef('dst', 'ghost')}}),
      /target does not exist/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
  });
});

test('11. Pinned external: requires a pinned binding; exact PinnedRef preserved; unpinned binding refused', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {v: pinnedRef('src', 'obj', '5')}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    await runtime.images.createImage({id: 'dst'});

    // unpinned binding for a pinned external -> refused
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle, externalBindings: {e0: objectRef('dst', 'x')}}),
      /must bind to a PinnedRef/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);

    // pinned binding preserved faithfully (NO historical read implemented)
    const {roots} = await importGraphBundle({
      images: runtime.images, targetImageId: 'dst', bundle,
      externalBindings: {e0: pinnedRef('other', 'thing', '9')},
    });
    const imported = await runtime.images.getObject('dst', roots.root.objectId);
    assert.deepEqual(imported.slots.v, pinnedRef('other', 'thing', '9'), 'exact provided PinnedRef preserved');
  });
});

test('12. Unknown local-ref: portable record references an absent localId -> refuse before createRecords', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    bundle.records.r0.shape = {kind: 'local-ref', localId: 'r99'};
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle}),
      /unknown localId/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
  });
});

test('13. Unknown external-ref: portable record references an absent externalKey -> refuse', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    bundle.records.r0.shape = {kind: 'external-ref', externalKey: 'e99'};
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle}),
      /unknown externalKey/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
  });
});

test('14. Unreachable record: hidden extra material refuses rather than importing', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    bundle.records.r2 = {kind: 'shape', slots: []}; // contiguous key, but unreachable
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle}),
      /unreachable record/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
  });
});

test('15. Unused external: an unreferenced external descriptor refuses (closure exactness)', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    bundle.externals.e0 = {pinned: false, imageId: 'other', objectId: 'x'};
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle}),
      /unused external descriptor/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
  });
});

test('16. Raw source ObjectRef smuggling: a raw ref Value in portable material refuses', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    // replace the shape edge token with a raw durable ObjectRef — source identity
    // must not be able to bypass the bundle-local identity contract
    bundle.records.r0.shape = objectRef('src', 'shape');
    await runtime.images.createImage({id: 'dst'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle}),
      /raw source ref smuggled/,
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst'), []);
  });
});

test('17. Expected content identity: correct -> success; wrong -> zero durable effect', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'src'});
    await runtime.images.putShape('src', {id: 'shape', slots: []});
    await runtime.images.putObject('src', {id: 'obj', shape: objectRef('src', 'shape'), slots: {}});
    const {bundle, contentIdentity} = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('src', 'obj')}});
    await runtime.images.createImage({id: 'dst'});
    const ok = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle, expectedContentIdentity: contentIdentity});
    assert.equal(ok.contentIdentity, contentIdentity);
    assert.equal((await recordsCreated(runtime, 'dst')).length, 2);

    await runtime.images.createImage({id: 'dst2'});
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst2', bundle, expectedContentIdentity: 'sha256:wrong'}),
      (error) => error instanceof GraphBundleImportError && /content identity mismatch/.test(error.message),
    );
    assert.deepEqual(await recordsCreated(runtime, 'dst2'), [], 'zero records on identity mismatch');
    assert.deepEqual(await eventsOf(runtime, 'dst2'), [], 'zero history on identity mismatch');
  });
});

test('18. Export -> import -> export: same canonical bundle + contentIdentity despite new target identity', async () => {
  await withRuntime(async (runtime) => {
    await seedInternalGraph(runtime, 'src');
    const first = await exportGraphBundle({images: runtime.images, roots: {block: objectRef('src', 'block')}});
    await runtime.images.createImage({id: 'dst'});
    const imported = await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle: first.bundle});
    const second = await exportGraphBundle({images: runtime.images, roots: {block: imported.roots.block}});
    assert.deepEqual(second.bundle, first.bundle, 'canonical bundle identical across a full round-trip');
    assert.equal(second.contentIdentity, first.contentIdentity, 'contentIdentity portable across images/ids/versions');
  });
});

test('19. Import twice: durable ids differ, re-exported bundle/contentIdentity identical (fresh-copy semantics)', async () => {
  await withRuntime(async (runtime) => {
    await seedInternalGraph(runtime, 'src');
    const first = await exportGraphBundle({images: runtime.images, roots: {block: objectRef('src', 'block')}});
    await runtime.images.createImage({id: 'dst1'});
    await runtime.images.createImage({id: 'dst2'});
    const one = await importGraphBundle({images: runtime.images, targetImageId: 'dst1', bundle: first.bundle});
    const two = await importGraphBundle({images: runtime.images, targetImageId: 'dst2', bundle: first.bundle});
    assert.notEqual(one.roots.block.objectId, two.roots.block.objectId, 'each import mints fresh ids');
    const reOne = await exportGraphBundle({images: runtime.images, roots: {block: one.roots.block}});
    const reTwo = await exportGraphBundle({images: runtime.images, roots: {block: two.roots.block}});
    assert.equal(reOne.contentIdentity, first.contentIdentity);
    assert.equal(reTwo.contentIdentity, first.contentIdentity);
  });
});

test('20. Atomic failure: injected backend failure through createRecords -> no partial graph/history', async () => {
  await withRuntime(async (runtime) => {
    await seedInternalGraph(runtime, 'src');
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {block: objectRef('src', 'block')}});
    await runtime.images.createImage({id: 'dst'});
    const realTransaction = runtime.images.backend.transaction.bind(runtime.images.backend);
    let injected = false;
    runtime.images.backend.transaction = async (work) => await realTransaction(async (candidate) => {
      let appends = 0;
      const wrapped = {
        ...candidate,
        put: candidate.put.bind(candidate),
        append: async (stream, event) => {
          appends += 1;
          if (appends === 3 && !injected) { injected = true; throw new Error('injected mid-import failure'); }
          return candidate.append(stream, event);
        },
      };
      return work(wrapped);
    });
    const realCreate = runtime.images.createRecords.bind(runtime.images);
    let createCalls = 0;
    runtime.images.createRecords = async (imageId, inputs) => { createCalls += 1; return realCreate(imageId, inputs); };
    await assert.rejects(
      importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle}),
      (error) => error instanceof GraphBundleImportError && /publication failed/.test(error.message),
    );
    assert.equal(createCalls, 1, 'exactly one atomic publication attempt — no sequential per-record puts');
    assert.ok(injected, 'the failure fired INSIDE the one atomic transaction (sequential puts would fail earlier, at validation)');
    assert.deepEqual(await recordsCreated(runtime, 'dst'), [], 'zero partial target graph');
    assert.deepEqual(await eventsOf(runtime, 'dst'), [], 'zero partial history');
  });
});

test('21. Frontier: importing N records advances target frontier exactly N revisions (createRecords owns history)', async () => {
  await withRuntime(async (runtime) => {
    await seedInternalGraph(runtime, 'src');
    const {bundle} = await exportGraphBundle({images: runtime.images, roots: {block: objectRef('src', 'block')}});
    const n = Object.keys(bundle.records).length;
    await runtime.images.createImage({id: 'dst'});
    const before = await runtime.images.frontier('dst');
    await importGraphBundle({images: runtime.images, targetImageId: 'dst', bundle});
    const after = await runtime.images.frontier('dst');
    assert.equal(Number(after) - Number(before), n);
  });
});

test('22. Restart: heterogeneous bundle imported into the real Lagrange backend survives a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-bundle-import-'));
  const filename = join(directory, 'image.sqlite');
  try {
    const firstBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await firstBackend.start();
    const first = new ImageService({backend: firstBackend, clock: () => new Date('2026-09-01T00:00:00.000Z')});
    await first.createImage({id: 'src'});
    await first.putShape('src', {id: 'shape', slots: [{id: 'v', name: 'v'}]});
    await first.putObject('src', {id: 'a', shape: objectRef('src', 'shape'), slots: {v: integerValue(0)}});
    await first.putObject('src', {id: 'b', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'a')}});
    await first.putObject('src', {id: 'a', shape: objectRef('src', 'shape'), slots: {v: objectRef('src', 'b')}}, {expectedVersion: 1});
    await first.putCodeArtifact('src', {id: 'code', representation: 'neutral-expression/v0', content: textValue('1')});
    await first.putLexicalEnvironment('src', {id: 'env', bindings: {}});
    await first.putBlock('src', {id: 'block', code: objectRef('src', 'code'), environment: objectRef('src', 'env')});
    const {bundle} = await exportGraphBundle({images: first, roots: {cycle: objectRef('src', 'a'), block: objectRef('src', 'block')}});
    await first.createImage({id: 'dst'});
    const imported = await importGraphBundle({images: first, targetImageId: 'dst', bundle});
    await firstBackend.stop();

    const secondBackend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await secondBackend.start();
    try {
      const second = new ImageService({backend: secondBackend});
      const a = await second.getObject('dst', imported.roots.cycle.objectId);
      const b = await second.getObject('dst', a.slots.v.objectId);
      assert.equal(b.slots.v.objectId, a.id, 'cycle readable after restart');
      const block = await second.getBlock('dst', imported.roots.block.objectId);
      assert.ok(await second.getCodeArtifact('dst', block.code.objectId));
      assert.ok(await second.getLexicalEnvironment('dst', block.environment.objectId));
      const reexported = await exportGraphBundle({images: second, roots: {cycle: imported.roots.cycle, block: imported.roots.block}});
      assert.equal(reexported.contentIdentity, imported.contentIdentity, 'round-trip identity survives restart');
    } finally {
      await secondBackend.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('23. Portable closure: src/graph/bundle.js static import closure remains node:*-free', () => {
  const seen = new Set();
  const bad = new Set();
  const walk = (file) => {
    const resolved = resolve(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    let source;
    try { source = readFileSync(resolved, 'utf8'); } catch { return; }
    for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      if (specifier.startsWith('node:')) { bad.add(specifier); continue; }
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(resolved), specifier);
        for (const candidate of [base, `${base}.js`, `${base}/index.js`]) {
          try { readFileSync(candidate); walk(candidate); break; } catch { /* try next */ }
        }
      }
    }
  };
  walk(new URL('../src/graph/bundle.js', import.meta.url).pathname);
  assert.deepEqual([...bad], [], 'bundle.js (with importer) must stay portable-closure clean');
});
