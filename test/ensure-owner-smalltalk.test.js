// Bead lagrange-images-ehz: the Smalltalk kernel and class builder request the durable objects
// they need but do NOT implement fresh-image race handling themselves — admission is
// graph/ensure-records.js (ea8). These falsifiers exercise the two paths that used to carry their
// own copy of the rule: the kernel's object installs and the class builder's method environments.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  KERNEL_SHAPE_ID,
  SMALLTALK_KERNEL_OBJECT_ID,
  SmalltalkKernelConflictError,
  createRuntime,
  defineMethods,
  findSmalltalkKernel,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  SHAPE_INDEXED,
} from '../src/runtime.js';
import {RecordConflictError, ensureLexicalEnvironment, ensureObject, ensureShape} from '../src/graph/ensure-records.js';

const PLUS = {
  selector: '+',
  program: {
    parameters: [{id: 'plus:arg', name: 'n'}],
    captures: [],
    body: {op: 'integer-add', left: {op: 'receiver'}, right: {op: 'argument', index: 0}},
  },
};

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'boot'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

test('KERNEL: two concurrent first installs on a fresh image converge on one kernel with no raw version conflict', async () => {
  await withRuntime(async (runtime) => {
    const results = await Promise.allSettled([
      installSmalltalkKernel({images: runtime.images, imageId: 'boot'}),
      installSmalltalkKernel({images: runtime.images, imageId: 'boot'}),
    ]);
    for (const r of results) {
      assert.equal(r.status, 'fulfilled', `a contender failed: ${r.reason?.name}: ${r.reason?.message}`);
    }
    const [a, b] = results.map((r) => r.value);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    assert.ok(kernel);
    const objects = await runtime.images.listObjects('boot');
    assert.ok(objects.length > 0);
    for (const object of objects) assert.equal(object._version, 1, `${object.id} was inserted exactly once`);
    for (const shape of await runtime.images.listShapes('boot')) assert.equal(shape._version, 1, `${shape.id} inserted exactly once`);
  });
});

test('KERNEL: retry after a successful install is idempotent; existing valid state is never overwritten', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const before = (await runtime.images.listRecords('boot')).map((r) => [r.id, r._version]).sort();
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const after = (await runtime.images.listRecords('boot')).map((r) => [r.id, r._version]).sort();
    assert.deepEqual(after, before, 'no record changed version: nothing was written');
  });
});

test('KERNEL: losing a race to a DIVERGENT winner of a kernel OBJECT conflicts with the Smalltalk conflict class, never a raw storage error, never adoption', async () => {
  await withRuntime(async (runtime) => {
    // A reference kernel in another image supplies a structurally valid but divergent record for
    // the competitor to plant at the kernel object's id in 'boot' the moment the installer reads it absent.
    await runtime.images.createImage({id: 'ref'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'ref'});
    const reference = await runtime.images.getObject('ref', SMALLTALK_KERNEL_OBJECT_ID);
    const realGetObject = runtime.images.getObject.bind(runtime.images);
    let fired = false;
    const images = new Proxy(runtime.images, {
      get(target, property) {
        if (property === 'getObject') {
          return async (imageId, id) => {
            const record = await realGetObject(imageId, id);
            if (!fired && imageId === 'boot' && id === SMALLTALK_KERNEL_OBJECT_ID && !record) {
              fired = true;
              await target.putObject('boot', {
                id: SMALLTALK_KERNEL_OBJECT_ID, shape: objectRef('boot', KERNEL_SHAPE_ID), behavior: reference.behavior,
                slots: reference.slots, metadata: {intruder: true},
              }, {expectedVersion: 0});
            }
            return record;
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const error = await installSmalltalkKernel({images, imageId: 'boot'}).then(() => null, (e) => e);
    assert.ok(fired, 'the competitor raced the kernel object');
    assert.ok(error instanceof SmalltalkKernelConflictError, `expected SmalltalkKernelConflictError, got ${error?.name}: ${error?.message}`);
    assert.notEqual(error?.name, 'VersionConflictError');
    const winner = await runtime.images.getObject('boot', SMALLTALK_KERNEL_OBJECT_ID);
    assert.deepEqual(winner.metadata, {intruder: true}, 'the divergent winner is untouched (never overwritten, never adopted)');
    assert.equal(winner._version, 1);
  });
});

test('CLASS BUILDER: concurrent definitions of the same method never overwrite an environment, Block or artifact; the only possible loss is the dictionary swap', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const define = () => defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'boot', classRef: kernel.integerClass,
      methods: [PLUS],
    });
    const results = await Promise.allSettled([define(), define()]);
    assert.ok(results.some((r) => r.status === 'fulfilled'), 'at least one definition committed');
    // Admission of the method's environment, Block and compiled artifact converged: every such
    // record exists exactly once at version 1 whichever contender won.
    const records = await runtime.images.listRecords('boot');
    for (const r of records.filter((x) => ['lexical-environment', 'block', 'code-artifact'].includes(x.kind))) {
      assert.equal(r._version, 1, `${r.kind} ${r.id} inserted exactly once`);
    }
    // A contender that lost did so at the class builder's own dictionary swap (a CAS-guarded
    // MUTATION of the method dictionary, the class builder's concern — bead discovered from ehz),
    // never at admission: the failure names the dictionary, not an environment, Block or artifact.
    for (const r of results.filter((x) => x.status === 'rejected')) {
      assert.match(String(r.reason?.message), /\/methods/, `lost at the dictionary swap, not at admission: ${r.reason?.message}`);
    }
    const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'boot', id: 'probe', source: '[ 40 + 2 ]'});
    const activation = await runtime.invocations.invokeBlock(objectRef('boot', installed.block.id), []);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(42));
  });
});

test('OWNER: two concurrent ensures of the same missing lexical environment converge; a divergent winner conflicts; nothing is overwritten', async () => {
  await withRuntime(async (runtime) => {
    const desired = {id: 'env/x', parent: null, bindings: {'b:1': {name: 'b', value: integerValue(1)}}, metadata: {}};
    const [a, b] = await Promise.all([
      ensureLexicalEnvironment(runtime.images, 'boot', desired),
      ensureLexicalEnvironment(runtime.images, 'boot', desired),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a._version, 1);
    await assert.rejects(ensureLexicalEnvironment(runtime.images, 'boot', {...desired, metadata: {other: true}}), RecordConflictError);
    assert.equal((await runtime.images.getLexicalEnvironment('boot', 'env/x'))._version, 1, 'never overwritten');
  });
});

test('OWNER seed mode: a present or concurrently created MUTABLE record is adopted as it is, never overwritten and never identity-compared', async () => {
  await withRuntime(async (runtime) => {
    await ensureShape(runtime.images, 'boot', {id: 'reg-shape', slots: [], indexed: SHAPE_INDEXED.VALUES});
    const seed = {id: 'registry', shape: objectRef('boot', 'reg-shape'), behavior: null, slots: {}, indexed: [], metadata: {m: 1}};
    const created = await ensureObject(runtime.images, 'boot', seed, {seed: true});
    // The registry mutates afterwards under its own CAS.
    await runtime.images.putObject('boot', {...seed, indexed: [objectRef('boot', 'registry')]}, {expectedVersion: created._version});
    const adopted = await ensureObject(runtime.images, 'boot', seed, {seed: true});
    assert.equal(adopted._version, 2, 'the mutated record is adopted as it is');
    assert.equal(adopted.indexed.length, 1, 'and its appended content survives a late creator');
    // Exact mode would have refused it: the two modes are one rule with one difference.
    await assert.rejects(ensureObject(runtime.images, 'boot', seed), RecordConflictError);
    // A concurrent first creation in seed mode still inserts exactly once.
    const seed2 = {...seed, id: 'registry-2'};
    const [x, y] = await Promise.all([ensureObject(runtime.images, 'boot', seed2, {seed: true}), ensureObject(runtime.images, 'boot', seed2, {seed: true})]);
    assert.deepEqual(x, y);
    assert.equal(x._version, 1);
  });
});

test('STRUCTURAL: the Smalltalk layer contains no second implementation of the generic admission rule', async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'language');
  const offenders = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(join(dir, file), 'utf8');
    // The rule's signature: a local function that reads a record by id and then writes it with
    // an existence-dependent put. Delegating wrappers that call ensure-records.js are allowed.
    const bodies = source.match(/async function ensure[A-Za-z]*\([^)]*\) \{[\s\S]*?\n\}/g) ?? [];
    for (const body of bodies) {
      const readsThenPuts = /\.get(Object|Shape|Block|LexicalEnvironment|CodeArtifact|Record)\(/.test(body)
        && /\.put(Object|Shape|Block|LexicalEnvironment|CodeArtifact)\(/.test(body);
      if (readsThenPuts) offenders.push(`${file}: ${body.split('\n')[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'read-then-put ensure implementations outside graph/ensure-records.js');
});
