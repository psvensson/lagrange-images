import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService, createDefaultCodeCompilerRegistry, createDefaultCompilationGroupCompilerRegistry,
  installSmalltalkStringEqualityProtocol, booleanValue, textValue,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime, WRITE_METHODS} from './support/recovery-harness.js';
import {seedStringEquality, stringEqualitySender} from './support/string-equality-fixture.js';

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing native ${lane} string equality and hash recovers`, async () => {
    const imageId = 'string-equality-recovery';
    const forks = await forkableRuntime(runtime => seedStringEquality(runtime, imageId, lane));
    // Compilation can publish a binary/descriptor pair in one atomic createRecords write.
    const writes = [...WRITE_METHODS, 'createRecords'];
    const install = images => installSmalltalkStringEqualityProtocol({
      images, imageId, lane,
      compilation: new CompilationService({
        images, compilers: createDefaultCodeCompilerRegistry(), groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
      }),
    });
    try {
      let total;
      await forks.withFork(async runtime => {
        const counting = faultingImages(runtime.images, {writeMethods: writes});
        await install(counting.images);
        total = counting.writeCount();
      });
      assert.ok(total > 0);
      for (const commitThenThrow of [false, true]) {
        for (let failAt = 1; failAt <= total; failAt++) {
          await forks.withFork(async runtime => {
            const fault = faultingImages(runtime.images, {failAt, commitThenThrow, writeMethods: writes});
            await assert.rejects(install(fault.images), /injected (post-commit )?failure at write/);
            await install(runtime.images);
            const frontier = await runtime.images.frontier(imageId);
            await install(runtime.images);
            assert.equal(await runtime.images.frontier(imageId), frontier, `${lane} write ${failAt} replay`);
            const send = stringEqualitySender(runtime, imageId);
            const text = textValue('to');
            const symbol = await send(text, 'asSymbol');
            assert.deepEqual(await send(symbol, '=', [text]), booleanValue(true));
            assert.deepEqual(await send(text, '=', [symbol]), booleanValue(true));
            assert.deepEqual(await send(symbol, 'hash'), await send(text, 'hash'));
            assert.deepEqual(await send(symbol, '==', [text]), booleanValue(false));
          });
        }
      }
    } finally { await forks.close(); }
  });
}
