import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LagrangeBackend} from '../src/backend/index.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

test('Lagrange SQL mapping survives a runtime restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-restart-'));
  const filename = join(directory, 'image.sqlite');
  try {
    const first = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await first.start();
    await first.transaction(async (transaction) => {
      const record = await transaction.put('things', 'one', {value: 1}, {expectedVersion: 0});
      await transaction.append('events', {type: 'thing.created', version: record._version});
    });
    await first.stop();

    const second = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    await second.start();
    try {
      assert.deepEqual(await second.get('things', 'one'), {value: 1, _version: 1});
      assert.deepEqual(
        await second.readStream('events'),
        [{type: 'thing.created', version: 1, revision: 1}],
      );
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
