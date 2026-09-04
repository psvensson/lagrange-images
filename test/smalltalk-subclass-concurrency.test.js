import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SmalltalkSubclassRegistryConflictError,
  createRuntime,
  defineClass,
  installSmalltalkKernel,
  objectRef,
} from '../src/runtime.js';
import {subclassRegistryId} from '../src/language/smalltalk-subclasses.js';

async function withKernel(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

function gateRegistryAppends(images, registryId, expectedArrivals = 2) {
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const wrapped = new Proxy(images, {
    get(target, property) {
      if (property === 'putObject') {
        return async (imageId, input, options) => {
          if (input?.id === registryId && options?.expectedVersion > 0) {
            arrivals += 1;
            if (arrivals === expectedArrivals) release();
            await gate;
          }
          return await target.putObject(imageId, input, options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {images: wrapped, arrivals: () => arrivals};
}

// Admit one stale contender, then deliberately replace its valid winner with a malformed
// duplicate-member record before the other contender attempts its already-stale CAS. This makes
// the lost-CAS reread — rather than the initial seed read — encounter malformed authoritative state.
function installMalformedRegistryWinner(images, registryId) {
  const contenders = [];
  let driven = false;
  const drive = async () => {
    const [winner, loser] = contenders;
    try {
      const saved = await images.putObject(...winner.arguments);
      await images.putObject(winner.arguments[0], {
        id: saved.id,
        shape: saved.shape,
        behavior: saved.behavior,
        slots: saved.slots,
        indexed: [saved.indexed[0], saved.indexed[0]],
        metadata: saved.metadata,
      }, {expectedVersion: saved._version});
      winner.resolve(saved);
    } catch (error) {
      winner.reject(error);
      loser.reject(error);
      return;
    }
    try {
      loser.resolve(await images.putObject(...loser.arguments));
    } catch (error) {
      loser.reject(error);
    }
  };
  return new Proxy(images, {
    get(target, property) {
      if (property === 'putObject') {
        return (...args) => {
          const [, input, options] = args;
          if (input?.id !== registryId || !(options?.expectedVersion > 0)) {
            return target.putObject(...args);
          }
          return new Promise((resolve, reject) => {
            contenders.push({arguments: args, resolve, reject});
            if (contenders.length === 2 && !driven) {
              driven = true;
              void drive();
            }
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('concurrent identical class definitions converge on one subclass membership', async () => {
  await withKernel(async (runtime) => {
    const registryId = subclassRegistryId('Object');
    const gated = gateRegistryAppends(runtime.images, registryId);

    const [left, right] = await Promise.all([
      defineClass({images: gated.images, imageId: 'app', name: 'ConcurrentSame'}),
      defineClass({images: gated.images, imageId: 'app', name: 'ConcurrentSame'}),
    ]);

    assert.deepEqual(left, right);
    assert.equal(gated.arrivals(), 2, 'both contenders reached the same authoritative CAS');
    const registry = await runtime.images.getObject('app', registryId);
    assert.deepEqual(registry.indexed, [objectRef('app', 'smalltalk/class/ConcurrentSame')]);

    const frontierBeforeReplay = await runtime.images.frontier('app');
    assert.deepEqual(
      await defineClass({images: runtime.images, imageId: 'app', name: 'ConcurrentSame'}),
      left,
    );
    assert.equal(await runtime.images.frontier('app'), frontierBeforeReplay, 'converged replay is write-free');
  });
});

test('a divergent subclass-registry CAS winner becomes a Smalltalk conflict without overwrite', async () => {
  await withKernel(async (runtime) => {
    const registryId = subclassRegistryId('Object');
    const gated = gateRegistryAppends(runtime.images, registryId);
    const results = await Promise.allSettled([
      defineClass({images: gated.images, imageId: 'app', name: 'ConcurrentLeft'}),
      defineClass({images: gated.images, imageId: 'app', name: 'ConcurrentRight'}),
    ]);

    const successes = results.filter(({status}) => status === 'fulfilled');
    const failures = results.filter(({status}) => status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].reason instanceof SmalltalkSubclassRegistryConflictError);
    assert.notEqual(failures[0].reason.name, 'VersionConflictError');
    assert.equal(failures[0].reason.cause, undefined, 'backend conflict is not exposed as a cause');
    assert.equal(gated.arrivals(), 2, 'the loser does not spin or attempt another write');

    const registryAfterLoss = await runtime.images.getObject('app', registryId);
    assert.equal(registryAfterLoss.indexed.length, 1, 'the loser did not overwrite the winner');
    const winningRef = registryAfterLoss.indexed[0];
    const losingName = winningRef.objectId.endsWith('ConcurrentLeft') ? 'ConcurrentRight' : 'ConcurrentLeft';

    await defineClass({images: runtime.images, imageId: 'app', name: losingName});
    const registryAfterRetry = await runtime.images.getObject('app', registryId);
    assert.deepEqual(
      registryAfterRetry.indexed.map(({objectId}) => objectId).sort(),
      ['smalltalk/class/ConcurrentLeft', 'smalltalk/class/ConcurrentRight'],
    );
  });
});

test('a malformed registry is a Smalltalk conflict and is never normalized by replay', async () => {
  await withKernel(async (runtime) => {
    const defined = await defineClass({images: runtime.images, imageId: 'app', name: 'Duplicated'});
    const registryId = subclassRegistryId('Object');
    const registry = await runtime.images.getObject('app', registryId);
    await runtime.images.putObject('app', {
      id: registry.id,
      shape: registry.shape,
      behavior: registry.behavior,
      slots: registry.slots,
      indexed: [defined.classRef, defined.classRef],
      metadata: registry.metadata,
    }, {expectedVersion: registry._version});
    const malformed = await runtime.images.getObject('app', registryId);
    const frontierBefore = await runtime.images.frontier('app');

    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'Duplicated'}),
      (error) => error instanceof SmalltalkSubclassRegistryConflictError
        && error.objectId === registryId
        && error.cause === undefined,
    );

    assert.equal(await runtime.images.frontier('app'), frontierBefore);
    assert.deepEqual(await runtime.images.getObject('app', registryId), malformed);
  });
});

test('a wrong-kind registry occupant becomes a Smalltalk conflict without replacement', async () => {
  await withKernel(async (runtime) => {
    const registryId = subclassRegistryId('Object');
    const squatter = await runtime.images.putShape('app', {id: registryId, slots: []});

    await assert.rejects(
      defineClass({images: runtime.images, imageId: 'app', name: 'ShapeSquatter'}),
      (error) => error instanceof SmalltalkSubclassRegistryConflictError
        && error.objectId === registryId
        && error.cause === undefined,
    );

    assert.deepEqual(await runtime.images.getShape('app', registryId), squatter);
    assert.equal(await runtime.images.getObject('app', registryId), null);
  });
});

test('a malformed lost-CAS winner becomes a Smalltalk conflict and remains authoritative', async () => {
  await withKernel(async (runtime) => {
    const registryId = subclassRegistryId('Object');
    const images = installMalformedRegistryWinner(runtime.images, registryId);
    const results = await Promise.allSettled([
      defineClass({images, imageId: 'app', name: 'MalformedWinner'}),
      defineClass({images, imageId: 'app', name: 'MalformedLoser'}),
    ]);

    const successes = results.filter(({status}) => status === 'fulfilled');
    const failures = results.filter(({status}) => status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].reason instanceof SmalltalkSubclassRegistryConflictError);
    assert.notEqual(failures[0].reason.name, 'VersionConflictError');
    assert.equal(failures[0].reason.cause, undefined);

    const malformed = await runtime.images.getObject('app', registryId);
    assert.equal(malformed.indexed.length, 2);
    assert.deepEqual(malformed.indexed[0], malformed.indexed[1]);
    assert.deepEqual(malformed.indexed[0], successes[0].value.classRef);

    const frontierAfterLoss = await runtime.images.frontier('app');
    assert.deepEqual(await runtime.images.getObject('app', registryId), malformed);
    assert.equal(await runtime.images.frontier('app'), frontierAfterLoss, 'the loser did not repair or overwrite the winner');
  });
});
