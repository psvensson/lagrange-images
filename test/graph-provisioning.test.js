// Object Environment provisioning handoff (GitHub #224, bead lagrange-images-6uyg): ONE public
// trusted provisioning operation that creates an object or Shape at a CALLER-CHOSEN stable id.
//
// The contract this file proves (from the Environment's handoff):
//   1. the caller names the id; the operation mints nothing;
//   2. idempotent replay is WRITE-FREE — a second identical run does not bump the record's
//      version (asserted through the object version token, which is byte-identical across runs);
//   3. a divergent occupant is refused, not overwritten, and the error names the PROVISIONING
//      concern rather than another subsystem's (never the Smalltalk kernel's conflict class);
//   4. a deliberate move is expressible — `seed: true` adopts an existing occupant AS-IS and the
//      caller applies its own domain check;
//   5. races converge rather than surfacing an uncaught version conflict;
//   6. Shapes are admitted on the same terms.
//
// The harness images are deliberately kernel-free: provisioning depends on no Smalltalk bootstrap
// state, which is exactly what the handoff refuses to give up. It reuses the deterministic race
// technique from the ea8 Shape-admission proof (test/shape-admission.test.js): a contended wrapper
// whose existence read is held by a gate, so both contenders observe "absent" before either insert.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime, objectRef, textValue} from '../src/runtime.js';
import {objectVersionToken} from '../src/object/version-token.js';
import {provisionObject, provisionShape, ProvisioningConflictError} from '../src/graph/provision.js';

const IMAGE = 'img';

const CATALOG_SHAPE = Object.freeze({id: 'environment/catalog-shape', slots: [{id: 'a', name: 'key'}, {id: 'b', name: 'value'}], indexed: 'none'});
const CATALOG_SLOTS = Object.freeze({a: textValue('theme-defaults'), b: textValue('theme/ships-with')});
const CATALOG_SLOTS_TEXT = Object.freeze({a: 'theme-defaults', b: 'theme/ships-with'});
const catalogObject = () => ({id: 'environment/theme-catalog', shape: objectRef(IMAGE, CATALOG_SHAPE.id), slots: CATALOG_SLOTS});

async function withFreshImage(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: IMAGE});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// The ordinary first install: the well-known Shape (readable object identity), then the
// well-known object that names it. Both are provisions, neither is anything else.
async function seedCatalog(runtime) {
  await provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE}});
  await provisionObject({images: runtime.images, imageId: IMAGE, object: catalogObject()});
}

async function recordAt(runtime, id) {
  return await runtime.images.getRecord(IMAGE, id);
}

// The race: both contenders complete their existence reads before either insert, so both truly
// observe "absent" and both attempt the insert-only create — the loser must converge.
function objectContender(runtime, {holdRead = null} = {}) {
  return {
    getRecord: async (imageId, id) => {
      const record = await runtime.images.getRecord(imageId, id);
      if (holdRead) await holdRead;
      return record;
    },
    getObject: async (imageId, id) => {
      const record = await runtime.images.getObject(imageId, id);
      if (holdRead) await holdRead;
      return record;
    },
    putObject: (imageId, input, options) => runtime.images.putObject(imageId, input, options),
  };
}

// 1 — the caller names the id, and only that id is written.
test('provisioning creates the object at exactly the caller-chosen id', async () => {
  await withFreshImage(async (runtime) => {
    await provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE}});
    const ref = await provisionObject({images: runtime.images, imageId: IMAGE, object: catalogObject()});
    assert.equal(ref.id, 'environment/theme-catalog', 'the durable record is the caller-chosen id');
    const stored = await recordAt(runtime, 'environment/theme-catalog');
    assert.ok(stored, 'the object is durable at the chosen id');
    assert.deepEqual(stored.slots, CATALOG_SLOTS);
  });
});

test('provisioning mints nothing: an idless record is refused before any write', async () => {
  await withFreshImage(async (runtime) => {
    const {id: _chosen, ...withoutId} = catalogObject();
    await assert.rejects(
      provisionObject({images: runtime.images, imageId: IMAGE, object: withoutId}),
      /caller.*chosen|provisioning: object id/,
      'the seam must demand an explicit caller-chosen id rather than minting one',
    );
    await assert.rejects(
      provisionObject({images: runtime.images, imageId: IMAGE, object: {...catalogObject(), id: ''}}),
      TypeError,
    );
  });
});

// 2 — identical replay writes nothing: the version token is byte-identical across two runs.
test('identical replay is write-free: the version token survives both provisioning runs byte-identical', async () => {
  await withFreshImage(async (runtime) => {
    await seedCatalog(runtime);
    const first = await recordAt(runtime, 'environment/theme-catalog');
    assert.equal(first._version, 1);
    const token = objectVersionToken(IMAGE, first.id, first._version);

    const replayed = await provisionObject({images: runtime.images, imageId: IMAGE, object: catalogObject()});
    const second = await recordAt(runtime, 'environment/theme-catalog');
    assert.equal(second._version, 1, 'replay did not bump the version');
    assert.equal(objectVersionToken(IMAGE, second.id, second._version), token, 'byte-identical token after replay');
    assert.deepEqual(replayed, first);
  });
});

// 3 — a divergent occupant is refused, never overwritten, with a PROVISIONING-owned error.
test('a divergent occupant is refused with a provisioning conflict and nothing is overwritten', async () => {
  await withFreshImage(async (runtime) => {
    await seedCatalog(runtime);
    const before = await recordAt(runtime, 'environment/theme-catalog');

    await assert.rejects(
      provisionObject({
        images: runtime.images, imageId: IMAGE,
        object: {...catalogObject(), slots: {a: textValue('theme-defaults'), b: textValue('theme/OTHER')}},
      }),
      (error) => {
        assert.ok(error instanceof ProvisioningConflictError, "the conflict is the provisioning seam's, not a kernel or raw backend one");
        assert.equal(error.name, 'ProvisioningConflictError');
        assert.equal(error.objectId, 'environment/theme-catalog');
        assert.match(error.message, /provisioning conflict/);
        return true;
      },
    );
    const after = await recordAt(runtime, 'environment/theme-catalog');
    assert.equal(after._version, before._version, 'no write happened');
    assert.deepEqual(after.slots, before.slots, 'the occupant was not replaced');
  });
});

test('the provisioning conflict is NOT the Smalltalk kernel\'s conflict class', async () => {
  await withFreshImage(async (runtime) => {
    const {SmalltalkKernelConflictError} = await import('../src/language/smalltalk-kernel.js');
    await seedCatalog(runtime);
    await assert.rejects(
      provisionObject({
        images: runtime.images, imageId: IMAGE,
        object: {...catalogObject(), slots: {a: textValue('x'), b: textValue('y')}},
      }),
      (error) => {
        assert.ok(!(error instanceof SmalltalkKernelConflictError), 'Environment provisioning must not surface as a Smalltalk KERNEL error');
        assert.equal(error.name, 'ProvisioningConflictError');
        return true;
      },
    );
  });
});

// 4 — a deliberate move is expressible: seed adopts the existing occupant as-is.
test('seed mode adopts an existing occupant as-is: a moved default is not a hard conflict', async () => {
  await withFreshImage(async (runtime) => {
    await seedCatalog(runtime);
    const before = await recordAt(runtime, 'environment/theme-catalog');

    const adopted = await provisionObject({
      images: runtime.images, imageId: IMAGE,
      object: {...catalogObject(), slots: {a: textValue('theme-defaults'), b: textValue('theme/NEW-RELEASE-DEFAULT')}},
      seed: true,
    });
    assert.equal(adopted.id, 'environment/theme-catalog');
    assert.deepEqual(adopted.slots, before.slots, 'the new DEFAULT is not silently installed: the caller gets the existing occupant back and applies its own domain check');
    const after = await recordAt(runtime, 'environment/theme-catalog');
    assert.equal(after._version, before._version, 'seed adoption wrote nothing');
    assert.deepEqual(after.slots, before.slots, 'nothing was overwritten');
  });
});

test('seed mode creates when the id is absent', async () => {
  await withFreshImage(async (runtime) => {
    await provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE}});
    const ref = await provisionObject({
      images: runtime.images, imageId: IMAGE, object: catalogObject(), seed: true,
    });
    assert.equal((await recordAt(runtime, ref.id)).id, ref.id);
  });
});

// 5 — races converge; a divergent winner is a conflict, never an adoption or an uncaught CAS leak.
test('contended identical provisioning converges on one record created exactly once', async () => {
  await withFreshImage(async (runtime) => {
    await provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE}});
    const [x, y] = await Promise.all([
      provisionObject({images: objectContender(runtime), imageId: IMAGE, object: catalogObject()}),
      provisionObject({images: objectContender(runtime), imageId: IMAGE, object: catalogObject()}),
    ]);
    assert.equal(x.id, y.id);
    const stored = await recordAt(runtime, 'environment/theme-catalog');
    assert.equal(stored._version, 1, 'inserted exactly once');
    assert.deepEqual(x, y);
  });
});

test('a divergent race is a refusal on the loser, never an adoption of a foreign layout', async () => {
  await withFreshImage(async (runtime) => {
    await provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE}});
    const slow = provisionObject({
      images: objectContender(runtime, {holdRead: new Promise((resolve) => setTimeout(resolve, 20))}),
      imageId: IMAGE, object: {...catalogObject(), slots: {a: textValue('late'), b: textValue('arrival')}},
    });
    await provisionObject({images: runtime.images, imageId: IMAGE, object: catalogObject()});
    await assert.rejects(slow, (error) => {
      assert.ok(error instanceof ProvisioningConflictError, 'the losing contender must not adopt a divergent winner');
      return true;
    });
    const stored = await recordAt(runtime, 'environment/theme-catalog');
    assert.deepEqual({a: stored.slots.a.value, b: stored.slots.b.value}, CATALOG_SLOTS_TEXT);
  });
});

// 6 — Shapes on the same terms.
test('Shapes are provisioned at a caller-chosen id, replay write-free and divergent-refused', async () => {
  await withFreshImage(async (runtime) => {
    await provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE}});
    const first = await recordAt(runtime, CATALOG_SHAPE.id);
    assert.equal(first._version, 1);
    assert.equal(first.kind, 'shape');
    const token = objectVersionToken(IMAGE, first.id, first._version);

    await provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE, metadata: {later: 'note'}}});
    const replayed = await recordAt(runtime, CATALOG_SHAPE.id);
    assert.equal(replayed._version, 1, 'Shape replay wrote nothing; a Shape is its layout, not metadata');
    assert.equal(objectVersionToken(IMAGE, replayed.id, replayed._version), token);

    await assert.rejects(
      provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE, slots: [{id: 'a', name: 'key'}]}}),
      (error) => {
        assert.ok(error instanceof ProvisioningConflictError);
        assert.match(error.message, /provisioning conflict: shape/);
        return true;
      },
    );
    assert.equal((await recordAt(runtime, CATALOG_SHAPE.id))._version, 1);
  });
});

test('a non-Shape occupant of the id is a conflict, never normalized into Shape success', async () => {
  await withFreshImage(async (runtime) => {
    await seedCatalog(runtime);
    await assert.rejects(
      provisionShape({images: runtime.images, imageId: IMAGE, shape: {...CATALOG_SHAPE, id: 'environment/theme-catalog'}}),
      ProvisioningConflictError,
      'the shape-lane occupancy check must detect a kind mismatch',
    );
    assert.equal((await recordAt(runtime, 'environment/theme-catalog')).kind, 'object', 'still the object; nothing was overwritten');
  });
});

// Provisioning works on a kernel-free image; later reads stay ordinary graph reads.
test('provisioning depends on no Smalltalk kernel and its objects read through ordinary graph reads', async () => {
  await withFreshImage(async (runtime) => {
    assert.ok(!(await recordAt(runtime, 'smalltalk/kernel')), 'no Smalltalk kernel was installed in this image');
    await seedCatalog(runtime);
    const read = await runtime.images.getObject(IMAGE, 'environment/theme-catalog');
    assert.deepEqual({a: read.slots.a.value, b: read.slots.b.value}, CATALOG_SLOTS_TEXT, 'the well-known object is reachable and ordinary');
  });
});

// Structural ownership: the seam adds a boundary, not a second admission implementation, and
// durable-state provisioning must not be gated on (or typed by) the Smalltalk personality.
test('STRUCTURAL: the provisioning seam wraps the ensure owner and imports no Smalltalk', async () => {
  const {readFile} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const source = await readFile(join(process.cwd(), 'src', 'graph', 'provision.js'), 'utf8');
  assert.ok(/from '\.\/ensure-records\.js'/.test(source), 'admission stays with the one ensure owner');
  assert.ok(!/from '\.\.\/language\//.test(source), 'provisioning must not import the Smalltalk personality');
  assert.ok(!/import .*smalltalk-kernel/.test(source), 'the seam must not route through the kernel wrappers');

  const barrel = await readFile(join(process.cwd(), 'src', 'graph', 'index.js'), 'utf8');
  assert.ok(/provision\.js/.test(barrel), 'the seam is public through the ./graph root');

  const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./graph'], './src/graph/index.js', 'the reviewable public root is the package ./graph subpath');
});
