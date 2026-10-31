import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {ImageService} from '../src/image/graph-image-service.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {assertKernelResult, assertTransactionResult, proveKernel, proveTransaction} from '../fixtures/real-lagrange-backend-scenarios.js';
import {
  REAL_LAGRANGE_REPORT_PREFIX,
  readRealLagrangeReport,
  runRealLagrangeSuite,
} from '../fixtures/real-lagrange-suite.js';

const executeFile = promisify(execFile);
const suiteURL = new URL('../fixtures/real-lagrange-suite.js', import.meta.url).href;
const scenario = (name, run) => ({name, run, timeoutMs: 1000});

test('warm fixture acquires one resource, sequences all three cases and awaits one cleanup', async () => {
  const resource = {};
  const calls = [];
  const report = await runRealLagrangeSuite({
    start: async () => { calls.push('start'); return resource; },
    stop: async (actual) => { assert.equal(actual, resource); calls.push('stop'); },
    scenarios: ['transaction', 'kernel', 'life'].map((name) => scenario(name, async (actual) => {
      assert.equal(actual, resource);
      calls.push(name);
    })),
  });
  assert.deepEqual(calls, ['start', 'transaction', 'kernel', 'life', 'stop']);
  assert.deepEqual(readRealLagrangeReport(REAL_LAGRANGE_REPORT_PREFIX + JSON.stringify(report),
    ['transaction', 'kernel', 'life']), report);
});

test('a failed case prevents later cases and preserves failure after cleanup', async () => {
  const primary = new Error('native admission refused');
  const calls = [];
  await assert.rejects(runRealLagrangeSuite({
    start: async () => ({}),
    stop: async () => { calls.push('stop'); },
    scenarios: [scenario('transaction', async () => { throw primary; }),
      scenario('kernel', async () => { calls.push('unexpected'); })],
  }), (error) => error === primary);
  assert.deepEqual(calls, ['stop']);
});

test('scenario and cleanup failures retain both original errors', async () => {
  const primary = new Error('scenario');
  const cleanup = new Error('cleanup');
  await assert.rejects(runRealLagrangeSuite({
    start: async () => ({}),
    stop: async () => { throw cleanup; },
    scenarios: [scenario('transaction', async () => { throw primary; })],
  }), (error) => {
    assert.deepEqual(error.errors, [primary, cleanup]);
    return error instanceof AggregateError;
  });
});

test('failed setup owns its cleanup and never admits a scenario', async () => {
  const primary = new Error('startup');
  const records = [];
  await assert.rejects(runRealLagrangeSuite({
    start: async () => { throw primary; },
    stop: async () => assert.fail('no successful acquisition to release'),
    scenarios: [scenario('transaction', async () => assert.fail('not admitted'))],
    observe: (record) => records.push(record),
  }), (error) => error === primary);
  assert.deepEqual(records.map(({phase, state}) => [phase, state]), [['setup', 'started'], ['setup', 'failed']]);
});

test('live diagnostic failure cannot strand an acquired resource', async () => {
  let stops = 0;
  const report = await runRealLagrangeSuite({
    start: async () => ({}),
    stop: async () => { stops++; },
    scenarios: [scenario('transaction', async () => {})],
    observe: () => { throw new Error('diagnostic sink closed'); },
  });
  assert.equal(stops, 1);
  assert.equal(report.phases.length, 3);
});

test('completion report refuses absent, duplicate, omitted and unordered cases or cleanup', () => {
  const report = {schema: 'images-real-lagrange/v1', phases:
    ['setup', 'transaction', 'kernel', 'life', 'cleanup'].map((phase) => ({phase, state: 'passed', elapsedMs: 1}))};
  const encode = (value) => REAL_LAGRANGE_REPORT_PREFIX + JSON.stringify(value);
  const read = (stdout) => readRealLagrangeReport(stdout, ['transaction', 'kernel', 'life']);
  assert.throws(() => read(''));
  assert.throws(() => read(`${encode(report)}\n${encode(report)}`));
  for (const phases of [report.phases.slice(0, -1), report.phases.slice(1),
    [report.phases[0], report.phases[2], report.phases[1], report.phases[3]],
    report.phases.map((row, i) => i === 4 ? {...row, state: 'failed'} : row),
    report.phases.map((row, i) => i === 1 ? {...row, elapsedMs: -1} : row)]) {
    assert.throws(() => read(encode({...report, phases})));
  }
});

test('phase watchdog terminates a hanging child without admitting another case', async () => {
  const script = `import {runRealLagrangeSuite} from ${JSON.stringify(suiteURL)};
    await runRealLagrangeSuite({start: async () => ({}), stop: async () => console.log('cleanup'),
      scenarios: [{name: 'blocked', timeoutMs: 20, run: () => new Promise(() => {})},
        {name: 'later', timeoutMs: 20, run: async () => console.log('later')} ]});
    console.log('accepted');`;
  await assert.rejects(executeFile(process.execPath, ['--input-type=module', '--eval', script],
    {timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024}), (error) => {
    assert.equal(error.code, 124);
    assert.equal(error.stdout, '');
    const record = JSON.parse(error.stderr.trim());
    assert.equal(record.type, 'IMAGES_REAL_LAGRANGE_PHASE_TIMEOUT');
    assert.equal(record.phase, 'blocked');
    assert.equal(record.disposition, 'inconclusive');
    return true;
  });
});

test('completed phase watchdogs cannot abort the process afterwards', async () => {
  const script = `import {runRealLagrangeSuite} from ${JSON.stringify(suiteURL)};
    import {setTimeout as sleep} from 'node:timers/promises';
    await runRealLagrangeSuite({start: async () => ({}), stop: async () => {},
      setupTimeoutMs: 20, cleanupTimeoutMs: 20,
      scenarios: [{name: 'case', timeoutMs: 20, run: async () => {}}]});
    await sleep(40); console.log('still alive');`;
  const {stdout} = await executeFile(process.execPath, ['--input-type=module', '--eval', script],
    {timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024});
  assert.equal(stdout, 'still alive\n');
});

test('watchdog still exits when its diagnostic descriptor is closed', async () => {
  const script = `import {runRealLagrangeSuite} from ${JSON.stringify(suiteURL)};
    import {closeSync} from 'node:fs';
    closeSync(2);
    process.on('uncaughtException', () => console.log('diagnostic vetoed exit'));
    await runRealLagrangeSuite({start: async () => ({}), stop: async () => {},
      scenarios: [{name: 'blocked', timeoutMs: 20, run: () => new Promise(() => {})}]});`;
  await assert.rejects(executeFile(process.execPath, ['--input-type=module', '--eval', script],
    {timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024}), (error) => {
    assert.equal(error.code, 124);
    assert.equal(error.stdout, '');
    return true;
  });
});

test('synchronous work cannot clear an overdue watchdog and publish success', async () => {
  const script = `import {runRealLagrangeSuite} from ${JSON.stringify(suiteURL)};
    await runRealLagrangeSuite({start: async () => ({}), stop: async () => {},
      scenarios: [{name: 'blocked', timeoutMs: 10, run: () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      }}]}); console.log('accepted');`;
  await assert.rejects(executeFile(process.execPath, ['--input-type=module', '--eval', script],
    {timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024}), (error) => {
    assert.equal(error.code, 124);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr.trim()).phase, 'blocked');
    return true;
  });
});

test('existing scenario assertions coexist in one SQL compatibility session', async () => {
  // This checks fixture data separation, not native Lagrange semantics.
  const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime()});
  await backend.start();
  try {
    await proveTransaction(backend);
    const kernel = await proveKernel(backend);
    await assertTransactionResult(backend);
    await assertKernelResult(backend, kernel);
  } finally {
    await backend.stop();
  }
});

test('attached Life image sessions neither isolate by namespace nor own the warm server', async () => {
  // SQL compatibility proves fixture isolation/lifetime only, not native semantics.
  const server = createSqliteApplicationRuntime();
  const start = server.start.bind(server);
  const stop = server.stop.bind(server);
  let starts = 0;
  let stops = 0;
  server.start = async () => { starts++; await start(); };
  server.stop = async () => { stops++; await stop(); };
  const owner = new LagrangeBackend({runtime: server});
  const sessionA = new LagrangeBackend({runtime: server, ownsRuntime: false, namespace: 'm6-a'});
  const sessionB = new LagrangeBackend({runtime: server, ownsRuntime: false, namespace: 'm6-b'});
  await owner.start();
  try {
    await proveTransaction(owner);
    const kernel = await proveKernel(owner);
    await sessionA.start();
    await sessionB.start();
    const imagesA = new ImageService({backend: sessionA});
    const imagesB = new ImageService({backend: sessionB});
    const life = await imagesB.createImage({id: 'life-native-m6'});
    assert.deepEqual(await imagesA.getImage(life.id), life);
    await sessionA.stop();
    assert.deepEqual(await imagesB.getImage(life.id), life);
    assert.equal(starts, 1);
    assert.equal(stops, 0);
    await assertTransactionResult(owner);
    await assertKernelResult(owner, kernel);
  } finally {
    await sessionA.stop();
    await sessionB.stop();
    await owner.stop();
  }
  assert.equal(stops, 1);
});
