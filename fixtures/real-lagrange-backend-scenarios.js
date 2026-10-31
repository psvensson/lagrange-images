import assert from 'node:assert/strict';
import {ImageService} from '../src/image/graph-image-service.js';
import {findSmalltalkKernel, installSmalltalkKernel} from '../src/language/smalltalk-kernel.js';
import {defineClass, ensureNamedClass} from '../src/language/smalltalk-class-builder.js';

export async function proveKernel(backend, mark = () => {}) {
  const images = new ImageService({backend});
  const createRecords = images.createRecords.bind(images);
  const batches = [];
  images.createRecords = async (imageId, inputs) => {
    const phase = batches.length + 1;
    mark('object-batch-starting', {phase, count: inputs.length});
    const stored = await createRecords(imageId, inputs);
    batches.push(stored.length);
    mark('object-batch-committed', {phase, count: stored.length});
    return stored;
  };
  await images.createImage({id: 'real-kernel'});
  mark('kernel-installing');
  await installSmalltalkKernel({images, imageId: 'real-kernel'});
  mark('kernel-installed');
  assert.deepEqual(batches, [22, 22]);
  const records = await images.listRecords('real-kernel');
  const events = await images.history('real-kernel');
  assert.equal(records.length, 52);
  assert.equal(events.length, 53, 'image.created plus 52 kernel record events');
  assert.ok(await findSmalltalkKernel({images, imageId: 'real-kernel'}));
  await installSmalltalkKernel({images, imageId: 'real-kernel'});
  assert.deepEqual(batches, [22, 22], 'reinstall publishes no batch');
  assert.deepEqual(await images.listRecords('real-kernel'), records);
  assert.deepEqual(await images.history('real-kernel'), events);
  mark('kernel-reused');
  mark('class-installing');
  const namedClass = await defineClass({images, imageId: 'real-kernel', name: 'RealPair'});
  assert.deepEqual(batches, [22, 22, 2, 2]);
  const classIds = [
    'smalltalk/metaclass/RealPair/methods', 'smalltalk/metaclass/RealPair',
    'smalltalk/class/RealPair/methods', 'smalltalk/class/RealPair',
  ];
  const classRecords = await images.listRecords('real-kernel');
  const classEvents = await images.history('real-kernel');
  assert.deepEqual(
    classEvents.filter((event) => classIds.includes(event.object?.id)).map((event) => event.object.id),
    classIds,
  );
  for (const id of classIds) assert.equal((await images.getObject('real-kernel', id))._version, 1);
  mark('class-installed');
  assert.deepEqual(
    await ensureNamedClass({images, imageId: 'real-kernel', name: 'RealPair'}), namedClass,
  );
  assert.deepEqual(batches, [22, 22, 2, 2], 'class rediscovery publishes no pair');
  assert.deepEqual(await images.listRecords('real-kernel'), classRecords);
  assert.deepEqual(await images.history('real-kernel'), classEvents);
  mark('class-reused');
}

export async function proveTransaction(backend) {
  await backend.transaction(async (transaction) => {
    const stored = await transaction.put(
      'things',
      'one',
      {value: 'committed'},
      {expectedVersion: 0},
    );
    await transaction.append('events', {
      type: 'thing.created',
      version: stored._version,
    });
  });
  await assertTransactionResult(backend);
}

export async function assertTransactionResult(backend) {
  assert.deepEqual(
    await backend.get('things', 'one'),
    {value: 'committed', _version: 1},
  );
  assert.deepEqual(
    await backend.readStream('events'),
    [{type: 'thing.created', version: 1, revision: 1}],
  );
}
