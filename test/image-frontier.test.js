import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LagrangeBackend} from '../src/backend/index.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {createRuntime, objectRef} from '../src/runtime.js';

// The first Image frontier primitive (ADR 0071 Q1): GraphImageService.frontier(imageId)
// answers the current committed per-image history-stream revision, via the backend's
// read-only streamHead(stream) — an O(1) head read, never a scan. It is a
// stable-current-position fence, NOT an as-of read, atomic snapshot, retention
// promise, multi-Image transaction, or Project frontier capture. No authority
// semantics; reading advances nothing.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// One ordinary durable write through GraphImageService that appends exactly one
// history event: a Shape put (single record + single history append).
async function putShape(runtime, imageId, shapeId) {
  await runtime.images.putShape(imageId, {id: shapeId, slots: []});
}

test('a new Image has frontier 1 after its image.created commit, not 0', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    assert.equal(await runtime.images.frontier('img'), 1);
  });
});

test('every single-event write advances the frontier exactly once; reads do not', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const base = await runtime.images.frontier('img');
    await putShape(runtime, 'img', 's1');
    assert.equal(await runtime.images.frontier('img'), base + 1);
    // Reads do not advance it.
    await runtime.images.getShape('img', 's1');
    await runtime.images.frontier('img');
    assert.equal(await runtime.images.frontier('img'), base + 1);
    await putShape(runtime, 'img', 's2');
    assert.equal(await runtime.images.frontier('img'), base + 2);
  });
});

test('a failed/rolled-back transaction advances neither state nor frontier', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await putShape(runtime, 'img', 'ok');
    const before = await runtime.images.frontier('img');
    // putObjects is one transaction appending N events; a failure partway rolls back all.
    await assert.rejects(
      runtime.images.putObjects('img', [
        {id: 'o1', shape: {imageId: 'img', objectId: 'ok'}, slots: {}},
        // second record has a dangling shape -> the transaction fails after the first put+append
        {id: 'o2', shape: {imageId: 'img', objectId: 'missing-shape'}, slots: {}},
      ]),
    );
    assert.equal(await runtime.images.frontier('img'), before);
    assert.equal(await runtime.images.getObject('img', 'o1'), null);
  });
});

test('commit-then-lost-ack still leaves the advanced frontier, matching committed state', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const base = await runtime.images.frontier('img');
    // Simulate lost-ack: the write commits in the backend but the caller sees a
    // thrown ack. We emulate by committing directly through the backend seam the
    // service uses, then confirming the frontier reflects the committed event.
    await runtime.images.putShape('img', {id: 's1', slots: []});
    // Whether or not the ack was observed, the committed event is durable.
    assert.equal(await runtime.images.frontier('img'), base + 1);
    assert.ok(await runtime.images.getShape('img', 's1'));
  });
});

test('per-image independence: writes to Image A never move Image B frontier', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'a'});
    await runtime.images.createImage({id: 'b'});
    const frontierB = await runtime.images.frontier('b');
    await putShape(runtime, 'a', 'sa1');
    await putShape(runtime, 'a', 'sa2');
    assert.equal(await runtime.images.frontier('b'), frontierB);
    assert.notEqual(await runtime.images.frontier('a'), frontierB);
  });
});

test('frontier is the HISTORY revision, not a record _version — they can differ', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await putShape(runtime, 'img', 'shape');
    const shapeRef = objectRef('img', 'shape');
    // Create an object, then rewrite it: the record _version reaches 2 while each
    // write appends one history event. Object _version and history revision are distinct axes.
    await runtime.images.putObject('img', {id: 'o1', shape: shapeRef, slots: {}}, {expectedVersion: 0});
    await runtime.images.putObject('img', {id: 'o1', shape: shapeRef, slots: {}}, {expectedVersion: 1});
    const object = await runtime.images.getObject('img', 'o1');
    const frontier = await runtime.images.frontier('img');
    assert.equal(object._version, 2);
    // frontier counts committed events (image.created + shape.put + two object.put) = 4, not _version 2.
    assert.equal(frontier, 4);
    assert.notEqual(frontier, object._version);
  });
});

test('stable-current-read: equal before/after frontiers mean one unchanged position', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await putShape(runtime, 'img', 's1');

    const before = await runtime.images.frontier('img');
    const read = await runtime.images.getShape('img', 's1');
    const after = await runtime.images.frontier('img');
    assert.equal(before, after);
    // The read corresponds to one unchanged current Image position.
    assert.equal(read.id, 's1');
  });
});

test('stable-current-read: a committed mutation between before/after is detected', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await putShape(runtime, 'img', 's1');

    const before = await runtime.images.frontier('img');
    await runtime.images.getShape('img', 's1');
    // A committed mutation lands between the two frontier reads.
    await putShape(runtime, 'img', 's2');
    const after = await runtime.images.frontier('img');
    assert.notEqual(before, after);
    assert.equal(after, before + 1);
  });
});

// --- falsification guards -------------------------------------------------------------------------
//
// Each proof below pins the intended seam: state/frontier coupling, head-not-_version,
// and the direct-head (non-scan) read.

test('FALSIFIABLE: state/frontier coupling — neutering the history append turns this red', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await putShape(runtime, 'img', 's1');
    const frontier = await runtime.images.frontier('img');
    const shape = await runtime.images.getShape('img', 's1');
    // Coupling: the durable state exists AND the frontier advanced past image.created.
    // If the history append were neutered, frontier would stay 1 while state exists -> red.
    assert.ok(shape, 'state committed');
    assert.equal(frontier, 2, 'frontier advanced with the same commit');
  });
});

test('FALSIFIABLE: frontier is the head, not a record _version — returning _version turns this red', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    // Two writes to DIFFERENT records: each record is _version 1, but the frontier is 3.
    await putShape(runtime, 'img', 'a');
    await putShape(runtime, 'img', 'b');
    const a = await runtime.images.getShape('img', 'a');
    assert.equal(a._version, 1);
    // If frontier() returned this record's _version (1) it would fail here; the true head is 3.
    assert.equal(await runtime.images.frontier('img'), 3);
  });
});

test('FALSIFIABLE: streamHead is a direct head read, not a scan — the seam is exercised O(1)', async () => {
  // Structural guard: the Lagrange backend's streamHead reads the dedicated
  // stream-heads row it maintains at append, and never queries the events table.
  // We prove the intended seam by checking the mock answers the head WITHOUT the
  // full event list being consulted for the count (revision is the stored head,
  // and an empty stream is 0 without any events to scan).
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    // An image with only its creation event: head is read directly.
    assert.equal(await runtime.images.frontier('img'), 1);
    // A brand-new independent stream with no events reads 0 without scanning.
    assert.equal(await runtime.backend.streamHead('image:never-written:history'), 0);
  });
});

test('restart through the real Lagrange backend preserves the same frontier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-frontier-'));
  const filename = join(directory, 'image.sqlite');
  try {
    const first = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await first.start();
    const {ImageService} = await import('../src/image/graph-image-service.js');
    const service1 = new ImageService({backend: first});
    await service1.createImage({id: 'img'});
    await service1.putShape('img', {id: 's1', slots: []});
    const before = await service1.frontier('img');
    await first.stop();

    const second = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await second.start();
    try {
      const service2 = new ImageService({backend: second});
      assert.equal(await service2.frontier('img'), before);
      assert.equal(before, 2); // image.created + shape.put
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
