import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {parseOptions, assertWorkerFacts, classifyOutcome, assertFixtureLocation} from '../scripts/m6-profile/contract.mjs';
import {createObserver, ProfilePrefixStop} from '../scripts/m6-profile/observation.mjs';
import {runOwnedChild} from '../scripts/m6-profile/lifecycle.mjs';

const options = {worker: 'worker', controllerBootId: 'controller'};
const facts = {platform: 'linux', hostname: 'worker', bootId: 'other', cpuLimit: 2,
  memoryLimit: 12 * 1024 ** 3, lockHeld: true, holderAncestor: true,
  holder: {project: 'lagrange-images', pid: 123, agent: 'agent', purpose: 'profile'}};

test('plan is default; fixture/root and finite caps are explicit', () => {
  const args = ['--images-root', '/candidate', '--fixture',
    '/candidate/fixtures/real-lagrange-m6-shared-server-process.js',
    '--data-dir', '/fresh/data', '--output-dir', '/fresh/out', '--worker', 'worker',
    '--controller-boot-id', 'controller', '--thermal-owner', '/core/thermal.js'];
  assert.equal(parseOptions(args).execute, false);
  assert.throws(() => parseOptions(args.concat('--max-ms', 'Infinity')), /finite|integer/);
  assert.throws(() => parseOptions(args.concat('--max-operations', '0')), /integer/);
  assert.throws(() => assertFixtureLocation('/other/fixture.js', '/candidate'), /canonical/);
  assert.throws(() => parseOptions(['--execute']), /Required option: imagesRoot/);
});

test('worker guard refuses controller, unlimited caps and unowned locks', () => {
  assert.doesNotThrow(() => assertWorkerFacts(facts, options));
  for (const patch of [{bootId: 'controller'}, {hostname: 'elsewhere'}, {cpuLimit: Infinity},
    {cpuLimit: 3}, {memoryLimit: Infinity}, {lockHeld: false}, {holderAncestor: false},
    {holder: {...facts.holder, project: 'other'}}]) {
    assert.throws(() => assertWorkerFacts({...facts, ...patch}, options));
  }
});

test('wrappers preserve this, arguments, sync results, thrown and rejected identities', async () => {
  const observer = createObserver({maxOperations: 100});
  const value = {};
  const error = new Error('same error');
  const target = {tag: value, sync(arg) { assert.equal(arg, value); return this.tag; },
    throws() { throw error; }, async rejects() { throw error; }};
  observer.patch(target, 'sync', 'backend.sync', true);
  observer.patch(target, 'throws', 'backend.throws', true);
  observer.patch(target, 'rejects', 'backend.rejects', true);
  assert.equal(target.sync(value), value);
  assert.throws(() => target.throws(), (caught) => caught === error);
  await assert.rejects(target.rejects(), (caught) => caught === error);
  assert.equal(observer.state.topLevelCompleted, 3);
});

test('prefix stops after completed outer transaction and preserves its scoped argument', async () => {
  const observer = createObserver({maxOperations: 1});
  const events = [];
  const scoped = Object.freeze({get() {}});
  const backend = {async transaction(work) {
    events.push('BEGIN'); const result = await work(scoped); events.push('COMMIT'); return result;
  }};
  observer.patchTransaction(backend);
  await assert.rejects(backend.transaction(async (candidate) => {
    assert.equal(candidate, scoped); events.push('work'); return {};
  }), (error) => error instanceof ProfilePrefixStop);
  assert.deepEqual(events, ['BEGIN', 'work', 'COMMIT']);
  assert.equal(observer.state.stopRequested, true);
  assert.equal(observer.state.transactionPhases.count, 1);
});

test('nested backend calls are inclusive; unrelated async calls retain separate roots', async () => {
  const observer = createObserver({maxOperations: 100});
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const backend = {async get() { await wait; return {}; },
    async put() { return this.get(); }, async scan() { return [{secret: 'never collected'}]; }};
  for (const name of ['get', 'put', 'scan']) observer.patch(backend, name, 'backend.' + name, true);
  const pending = backend.put();
  const unrelated = backend.get();
  release();
  await Promise.all([pending, unrelated]);
  await backend.scan();
  assert.equal(observer.state.topLevelCompleted, 3);
  assert.equal(observer.state.calls['backend.get'].count, 2);
  assert.equal(observer.state.calls['backend.scan'].returnedRows, 1);
  assert.equal(JSON.stringify(observer.state).includes('secret'), false);
});

test('partial, limits, cancellation and cleanup failure never become completed acceptance', () => {
  const normal = {schema: 'm6-profile-observation/1', stopRequested: false, exitCode: 0};
  const base = {code: 0, signal: null, metrics: normal, reaped: true, groupGone: true};
  assert.equal(classifyOutcome(base).status, 'diagnostic-completed');
  for (const reason of ['wall-limit', 'log-limit', 'cancelled', 'thermal-hold']) {
    const result = classifyOutcome({...base, reason});
    assert.notEqual(result.status, 'diagnostic-completed');
    assert.equal(result.acceptance, false);
  }
  const partial = {schema: normal.schema, stopRequested: true, uncaught: {ownedPrefixStop: true}};
  assert.equal(classifyOutcome({...base, code: 1, metrics: partial}).status, 'diagnostic-prefix');
  assert.equal(classifyOutcome({...base, metrics: partial}).status, 'child-failed');
  assert.equal(classifyOutcome({...base, code: 1, metrics: {...partial,
    uncaught: {ownedPrefixStop: false}}}).status, 'runtime-failed');
  assert.equal(classifyOutcome({...base, groupGone: false}).status, 'cleanup-failed');
  assert.equal(classifyOutcome({...base, metrics: null}).status, 'child-failed');
});

test('owned lifecycle cancels only its PGID, waits close, and retains actual zero exit as partial', async () => {
  const child = new EventEmitter(); child.pid = 4321;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const controller = new AbortController();
  let live = true;
  const signals = [];
  const pending = runOwnedChild({argv: ['fixture'], cwd: '/', env: {},
    maxMs: 1000, maxLogBytes: 20, graceMs: 5, signal: controller.signal,
    spawnChild() { setImmediate(() => controller.abort()); return child; },
    killGroup(pid, signal) {
      assert.equal(pid, 4321); signals.push(signal);
      if (signal === 'SIGTERM') setImmediate(() => {
        live = false; child.emit('close', 0, null);
      });
    }, groupAlive: () => live, onChunk() {}});
  const result = await pending;
  assert.equal(result.pid, 4321);
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.reaped, true);
  assert.equal(result.groupGone, true);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('log cap preserves a bounded prefix and zero child exit remains interrupted', async () => {
  const child = new EventEmitter(); child.pid = 5432;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let live = true; const kept = [];
  const result = await runOwnedChild({argv: [], cwd: '/', env: {}, maxMs: 1000,
    maxLogBytes: 4, graceMs: 5, spawnChild() {
      setImmediate(() => child.stdout.emit('data', Buffer.from('123456'))); return child;
    }, killGroup() { setImmediate(() => { live = false; child.emit('close', 0, null); }); },
    groupAlive: () => live, onChunk: (chunk) => kept.push(chunk)});
  assert.equal(result.reason, 'log-limit');
  assert.equal(Buffer.concat(kept).toString(), '1234');
  assert.equal(result.observedLogBytes, 6);
  assert.equal(result.keptLogBytes, 4);
  assert.equal(result.reaped, true);
});

test('wall bound escalates ignored TERM to owned-group KILL and waits close', async () => {
  const child = new EventEmitter(); child.pid = 6543;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let live = true; const actions = [];
  const result = await runOwnedChild({argv: [], cwd: '/', env: {}, maxMs: 5,
    maxLogBytes: 100, graceMs: 5, spawnChild: () => child,
    groupAlive: () => live, killGroup(pid, signal) {
      assert.equal(pid, 6543); actions.push(signal);
      if (signal === 'SIGKILL') setImmediate(() => { live = false; child.emit('close', null, 'SIGKILL'); });
    }});
  assert.deepEqual(actions, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.reason, 'wall-limit');
  assert.equal(result.reaped, true);
  assert.equal(result.groupGone, true);
});

test('startup registration failure still terminates and reaps the owned child', async () => {
  const child = new EventEmitter(); child.pid = 7654;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let live = true;
  const result = await runOwnedChild({argv: [], cwd: '/', env: {}, maxMs: 100,
    maxLogBytes: 100, graceMs: 5, spawnChild: () => child,
    onStarted() { throw new Error('ledger unavailable'); },
    groupAlive: () => live, killGroup() {
      setImmediate(() => { live = false; child.emit('close', 1, null); });
    }});
  assert.equal(result.reason, 'start-ledger-failed');
  assert.equal(result.reaped, true);
});

test('worker-thread preload neither parses profiler config nor patches target modules', async (t) => {
  const worker = new Worker("require('node:worker_threads').parentPort.postMessage('unobserved worker')",
    {eval: true, execArgv: ['--import', new URL('../scripts/m6-profile/preload.mjs', import.meta.url).href],
      env: {...process.env, M6_PROFILE_CONFIG: 'invalid JSON must remain unread in workers'}});
  t.after(() => worker.terminate());
  const exited = once(worker, 'exit');
  assert.deepEqual(await once(worker, 'message'), ['unobserved worker']);
  assert.deepEqual(await exited, [0]);
});

test('telemetry write failure never replaces an original fixture error', async () => {
  const error = new Error('original fixture failure');
  const observer = createObserver({maxOperations: 100, persist() { throw new Error('ENOSPC'); }});
  const target = {sync() { throw error; }, async asynchronous() { throw error; }};
  observer.patch(target, 'sync', 'backend.sync', true);
  observer.patch(target, 'asynchronous', 'backend.asynchronous', true);
  assert.throws(() => target.sync(), (caught) => caught === error);
  await assert.rejects(target.asynchronous(), (caught) => caught === error);
  assert.equal(observer.state.telemetryFailure.name, 'Error');
});

test('every stop has a close fallback; no-close cancellation is never falsely reaped', {timeout: 500}, async () => {
  const child = new EventEmitter(); child.pid = 8765;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const controller = new AbortController(); let live = true;
  const actions = [];
  const result = await runOwnedChild({argv: [], cwd: '/', env: {}, maxMs: 10000,
    maxLogBytes: 100, graceMs: 2, reapMs: 2, signal: controller.signal,
    spawnChild() { setImmediate(() => controller.abort()); return child; },
    groupAlive: () => live, killGroup(pid, signal) {
      assert.equal(pid, 8765); actions.push(signal); if (signal === 'SIGKILL') live = false;
    }});
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.reaped, false);
  assert.equal(result.groupGone, true);
  assert.ok(actions.includes('SIGTERM') && actions.includes('SIGKILL'));
});

test('handled fixture failure and recovered telemetry cannot report zero-exit completion', () => {
  const original = new Error('handled fixture failure');
  let failing = true;
  const observer = createObserver({maxOperations: 100, persist() {
    if (failing) throw Object.assign(new Error('telemetry unavailable'), {code: 'EIO'});
  }});
  const target = {fail() { throw original; }, recover() { return {}; }};
  observer.patch(target, 'fail', 'backend.fail', true);
  observer.patch(target, 'recover', 'backend.recover', true);
  assert.throws(() => target.fail(), (error) => error === original);
  failing = false;
  target.recover();
  observer.state.exitCode = 0;
  const result = classifyOutcome({code: 0, signal: null, metrics: observer.state,
    reaped: true, groupGone: true});
  assert.equal(result.status, 'telemetry-failed');
  assert.equal(result.acceptance, false);
});
