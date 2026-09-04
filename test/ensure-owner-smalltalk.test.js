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
  methodBlockRef,
  objectRef,
  SHAPE_INDEXED,
  SmalltalkMethodRedefinitionError,
  textValue,
} from '../src/runtime.js';
import {RecordConflictError, ensureCodeArtifacts, ensureLexicalEnvironment, ensureObject, ensureShape} from '../src/graph/ensure-records.js';
import {
  buildMethodBuckets,
  methodDictionaryRecordFields,
} from '../src/language/smalltalk-method-dictionary.js';

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

test('CLASS BUILDER: concurrent identical method definitions converge at the dictionary swap with no raw version conflict', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const methods = [
      PLUS,
      {
        selector: 'fortyTwo',
        program: {parameters: [], captures: [], body: {op: 'literal', value: integerValue(42)}},
      },
    ];
    const define = () => defineMethods({
      images: runtime.images, compilation: runtime.compilation, imageId: 'boot', classRef: kernel.integerClass,
      methods,
    });
    let competingResult = null;
    const putObject = runtime.images.putObject.bind(runtime.images);
    runtime.images.putObject = async (imageId, input, writeOptions) => {
      if (competingResult === null
        && input.id === `${kernel.integerClass.objectId}/methods`
        && writeOptions?.expectedVersion !== undefined) {
        runtime.images.putObject = putObject;
        competingResult = await define();
      }
      return await putObject(imageId, input, writeOptions);
    };
    const result = await define();
    runtime.images.putObject = putObject;
    assert.ok(competingResult, 'the identical contender committed before the stale conditional write');
    assert.deepEqual(result, competingResult, 'the loser adopted the complete semantic winner');
    // Admission of the method's environment, Block and compiled artifact converged: every such
    // record exists exactly once at version 1 whichever contender won.
    const records = await runtime.images.listRecords('boot');
    for (const r of records.filter((x) => ['lexical-environment', 'block', 'code-artifact'].includes(x.kind))) {
      assert.equal(r._version, 1, `${r.kind} ${r.id} inserted exactly once`);
    }
    // This is the boundary falsifier for fb1: deleting the class-builder translation makes the
    // stale outer write reject with raw VersionConflictError before these assertions.
    const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'boot', id: 'probe', source: '[ 40 + 2 ]'});
    const activation = await runtime.invocations.invokeBlock(objectRef('boot', installed.block.id), []);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(42));
    const beforeReplay = await runtime.images.getObject('boot', `${kernel.integerClass.objectId}/methods`);
    await define();
    const afterReplay = await runtime.images.getObject('boot', `${kernel.integerClass.objectId}/methods`);
    assert.equal(afterReplay._version, beforeReplay._version, 'retry against the converged state is idempotent');
  });
});

test('CLASS BUILDER: a same-selector divergent dictionary-swap winner is a redefinition conflict and is not overwritten', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const options = {
      images: runtime.images, compilation: runtime.compilation, imageId: 'boot', classRef: kernel.integerClass,
    };
    const requested = {
      selector: 'alpha',
      program: {parameters: [], captures: [], body: {op: 'literal', value: textValue('requested')}},
    };
    const impostor = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'boot', id: 'divergent-winner', source: '[ 99 ]',
    });

    // Force a structurally valid dictionary to bind alpha to a different Block after the request
    // has read the dictionary but before its conditional write. This reaches the specific
    // same-selector semantic classification branch; an ordinary competing defineMethods would
    // conflict earlier at the selector's deterministic semantic-artifact id.
    let injected = false;
    const putObject = runtime.images.putObject.bind(runtime.images);
    runtime.images.putObject = async (imageId, input, writeOptions) => {
      if (!injected && input.id === `${kernel.integerClass.objectId}/methods` && writeOptions?.expectedVersion !== undefined) {
        injected = true;
        runtime.images.putObject = putObject;
        const current = await runtime.images.getObject('boot', input.id);
        const {buckets} = buildMethodBuckets([
          [textValue('alpha'), objectRef('boot', impostor.block.id)],
        ]);
        await putObject('boot', {
          id: current.id,
          ...methodDictionaryRecordFields({
            buckets,
            shapeRef: current.shape,
            nilRef: kernel.nil,
            metadata: current.metadata,
          }),
        }, {expectedVersion: current._version});
      }
      return await putObject(imageId, input, writeOptions);
    };

    const error = await defineMethods({...options, methods: [requested]}).then(() => null, (cause) => cause);
    runtime.images.putObject = putObject;
    assert.ok(injected, 'the competing definition won the dictionary CAS');
    assert.ok(error instanceof SmalltalkMethodRedefinitionError);
    assert.notEqual(error?.name, 'VersionConflictError');
    assert.equal(error.cause, undefined, 'the backend conflict is not retained as a cause');
    assert.deepEqual(
      await methodBlockRef({
        images: runtime.images, imageId: 'boot', classRef: kernel.integerClass, selector: 'alpha',
      }),
      objectRef('boot', impostor.block.id),
      'the divergent CAS winner remains authoritative',
    );
    assert.equal(
      (await runtime.images.getObject('boot', `${kernel.integerClass.objectId}/methods`))._version,
      2,
      'the losing write did not overwrite the winner',
    );
  });
});

test('CLASS BUILDER: concurrent divergent definitions of one selector yield one winner and one Smalltalk-domain conflict', async () => {
  await withRuntime(async (runtime) => {
    await installSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'boot'});
    const define = (answer) => defineMethods({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'boot',
      classRef: kernel.integerClass,
      methods: [{
        selector: 'contended',
        program: {parameters: [], captures: [], body: {op: 'literal', value: textValue(answer)}},
      }],
    });

    const results = await Promise.allSettled([define('left'), define('right')]);
    assert.equal(results.filter(({status}) => status === 'fulfilled').length, 1);
    const [rejected] = results.filter(({status}) => status === 'rejected');
    assert.ok(
      rejected.reason instanceof SmalltalkMethodRedefinitionError
        || rejected.reason instanceof SmalltalkKernelConflictError,
      `expected a Smalltalk conflict, got ${rejected.reason?.name}: ${rejected.reason?.message}`,
    );
    assert.notEqual(rejected.reason?.name, 'VersionConflictError');

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'boot', id: 'contended-probe', source: '[ :a | a contended ]',
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('boot', installed.block.id), [integerValue(1)]);
    const answer = await runtime.executor.execute(activation);
    assert.ok(['left', 'right'].includes(answer.value), 'exactly one complete semantic definition is visible');
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

test('OWNER: a code-artifact graph ensure that loses the batch insert to an identical concurrent creator converges; a divergent one conflicts', async () => {
  await withRuntime(async (runtime) => {
    const pair = [
      {id: 'g', representation: 'x/v1', content: textValue('main'), dependencies: [{role: 'aux', artifact: objectRef('boot', 'g:aux')}]},
      {id: 'g:aux', representation: 'x/v1', content: textValue('aux')},
    ];
    const [a, b] = await Promise.all([ensureCodeArtifacts(runtime.images, 'boot', pair), ensureCodeArtifacts(runtime.images, 'boot', pair)]);
    assert.deepEqual(a.map((r) => [r.id, r._version]), b.map((r) => [r.id, r._version]));
    assert.ok(a.every((r) => r._version === 1));
    const divergent = [pair[0], {...pair[1], content: textValue('other')}];
    await assert.rejects(ensureCodeArtifacts(runtime.images, 'boot', divergent), RecordConflictError);
    assert.equal((await runtime.images.getCodeArtifact('boot', 'g:aux')).content.value, 'aux', 'never overwritten');
  });
});

test('STRUCTURAL: the Smalltalk layer contains no admission implementation of its own', async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'language');
  const offenders = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(join(dir, file), 'utf8');
    // (1) No ensure-style function that reads a record by id and then writes it itself.
    const bodies = source.match(/async function ensure[A-Za-z]*\([^)]*\) \{[\s\S]*?\n\}/g) ?? [];
    for (const body of bodies) {
      const readsThenPuts = /\.get(Object|Shape|Block|LexicalEnvironment|CodeArtifact|Record)\(/.test(body)
        && /\.put(Object|Shape|Block|LexicalEnvironment|CodeArtifact)\(/.test(body);
      if (readsThenPuts) offenders.push(`${file}: ${body.split('\n')[0]}`);
    }
    // (2) Every insert-only write (expectedVersion: 0) outside the ensure owner is an ALLOCATION at
    //     a freshly minted id inside ADR 0046's identity-retry loop — never admission at a derived
    //     id. Admission at a derived id must be an ensure-owner call.
    let match;
    const insertOnly = /expectedVersion: 0\}/g;
    while ((match = insertOnly.exec(source)) !== null) {
      const before = source.slice(Math.max(0, match.index - 900), match.index);
      const allocation = /for \(let attempt = 0; attempt < maxIdentityAttempts/.test(before) && /newObjectId\(\)/.test(before);
      if (!allocation) offenders.push(`${file}: insert-only write outside an identity-retry allocation at offset ${match.index}`);
    }
  }
  assert.deepEqual(offenders, [], 'admission implementations outside graph/ensure-records.js');
});
