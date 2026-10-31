import {channel} from 'node:diagnostics_channel';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {mkdtemp, mkdir, writeFile, symlink, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseOptions, assertWorkerFacts, classifyOutcome, assertFixtureLocation, fixtureArguments, fingerprintSources} from '../scripts/m6-profile/contract.mjs';
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
  assert.throws(() => parseOptions(args.concat('--proof', 'kernel')), /Unknown/);
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

test('main-thread preload binds real Images module exports before the fixture body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'm6-preload-bindings-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'fixtures'));
  await symlink(fileURLToPath(new URL('../src/', import.meta.url)), join(root, 'src'), 'dir');
  await writeFile(join(root, 'package.json'), JSON.stringify({type: 'module'}));
  const fixture = join(root, 'fixtures/real-lagrange-m6-shared-server-process.js');
  await writeFile(fixture, [
    "import {ImageService} from '../src/image/graph-image-service.js';",
    "const rows = await ImageService.prototype.listCodeArtifacts.call({listRecords: async () => []}, 'unit-only');",
    "if (rows.length !== 0) throw new Error('Unexpected unit result');",
    "process.stdout.write('real module preload reached fixture body\\n');",
  ].join('\n'));
  const metricsFile = join(root, 'observation.json');
  const stdout = execFileSync(process.execPath, ['--import',
    new URL('../scripts/m6-profile/preload.mjs', import.meta.url).href, fixture], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    env: {...process.env, M6_PROFILE_CONFIG: JSON.stringify({
      imagesRoot: root, fixture, metricsFile, maxOperations: 1,
    })},
  });
  assert.equal(stdout, 'real module preload reached fixture body\n');
  const metrics = JSON.parse(await readFile(metricsFile, 'utf8'));
  assert.equal(metrics.uncaught, null);
  assert.equal(metrics.exitCode, 0);
  assert.equal(metrics.calls['images.listCodeArtifacts'].count, 1);
  assert.equal(metrics.topLevelCompleted, 0, 'no backend or application runtime was constructed');
  assert.equal(metrics.acceptance, false);
});


test('only allowlisted cold and literal warm argv are generated', () => {
  assert.deepEqual(fixtureArguments('/root/fixtures/real-lagrange-m6-shared-server-process.js', '/root', '/data'),
    ['/root/fixtures/real-lagrange-m6-shared-server-process.js', '/data']);
  assert.deepEqual(fixtureArguments('/root/fixtures/real-lagrange-backend-process.js', '/root', '/data'),
    ['/root/fixtures/real-lagrange-backend-process.js', '/data', 'warm']);
  assert.throws(() => fixtureArguments('/root/fixtures/other.js', '/root', '/data'), /canonical/);
});

test('pending stages and transaction phases are visible before settlement; costs use start stage', async () => {
  let now = 0;
  const saved = [];
  const observer = createObserver({maxOperations: 100, clock: () => now,
    persist(state) { saved.push(structuredClone(state)); }});
  let begin, work, commit;
  const before = new Promise((resolve) => { begin = resolve; });
  const during = new Promise((resolve) => { work = resolve; });
  const after = new Promise((resolve) => { commit = resolve; });
  const backend = {async transaction(callback) {
    await before; await callback({}); await after; return 'done';
  }};
  observer.patchTransaction(backend);
  observer.stage({stage: 'life.install-standard-image'});
  const pending = backend.transaction(() => during);
  assert.equal(saved.at(-1).pending[0].transactionPhase, 'beforeWork');
  assert.equal(observer.state.calls['backend.transaction'].count, 0);
  now = 10; begin(); await Promise.resolve();
  assert.equal(saved.at(-1).pending[0].transactionPhase, 'work');
  now = 20; work(); await Promise.resolve(); await Promise.resolve();
  assert.equal(saved.at(-1).pending[0].transactionPhase, 'afterWork');
  observer.stage({stage: 'life.import-native-package'});
  now = 30; observer.snapshot();
  assert.equal(observer.state.pending[0].elapsedMs, 30);
  assert.equal(observer.state.pending[0].phaseStartedMs, 20);
  assert.equal(observer.state.pending[0].phaseElapsedMs, 10);
  assert.equal(observer.state.pending[0].startStage, 'life.install-standard-image');
  assert.equal(observer.state.transactionPhases.count, 0);
  commit(); assert.equal(await pending, 'done');
  assert.deepEqual(observer.state.pending, []);
  assert.equal(observer.state.completedByStartStage['life.install-standard-image']['backend.transaction'].inclusiveMs, 30);
  assert.equal(observer.state.completedByStartStage['life.import-native-package'], undefined);
  assert.deepEqual(observer.state.transactionPhasesByStartStage['life.install-standard-image'],
    {count: 1, beforeWorkMs: 10, workMs: 10, afterWorkMs: 10});
});

test('operation ancestry never consumes or suppresses backend-boundary budget', async () => {
  const observer = createObserver({maxOperations: 1});
  const backend = {get() { return 'record'; }};
  const compiler = {compile() { return backend.get(); }};
  observer.patch(backend, 'get', 'backend.get', true);
  observer.patch(compiler, 'compile', 'compilation.compileArtifact');
  assert.throws(() => compiler.compile(), (error) => error instanceof ProfilePrefixStop);
  assert.equal(observer.state.topLevelCompleted, 1);
  assert.equal(observer.state.calls['backend.get'].count, 1);
  assert.equal(observer.state.calls['compilation.compileArtifact'].count, 1);
});

test('telemetry stages, start and snapshots fail sticky without replacing subject errors; ledgers bounded', async () => {
  const original = new Error('subject');
  let called = 0;
  const observer = createObserver({maxOperations: 100, maxPending: 1, maxStages: 1,
    persist() { throw new Error('telemetry'); }});
  observer.stage({stage: 'life.create-image'});
  observer.stage({stage: 'life.install-managed-release'});
  observer.snapshot();
  let release;
  const target = {async wait() { await new Promise((resolve) => { release = resolve; }); },
    reject() { called++; throw original; }};
  observer.patch(target, 'wait', 'backend.wait', true);
  observer.patch(target, 'reject', 'backend.reject', true);
  const pending = target.wait();
  assert.throws(() => target.reject(), (error) => error === original);
  assert.equal(called, 1);
  assert.equal(observer.state.pending.length, 1);
  assert.equal(observer.state.stages.length, 1);
  assert.deepEqual(observer.state.overflow, {pending: 1, stages: 1});
  release(); await pending;
  assert.deepEqual(observer.state.pending, []);
  assert.equal(observer.state.telemetryFailure.name, 'Error');
});

test('Life helper emits owner stage before the same original first operation/error', async () => {
  const {installRecoveredLife} = await import('./support/life-m5-witness.js');
  const stages = channel('lagrange-images.m6-stage/1');
  const records = [];
  const receive = (record) => records.push(record);
  stages.subscribe(receive);
  const original = new Error('original createImage refusal');
  try {
    await assert.rejects(installRecoveredLife({imageId: 'life', fixture: {},
      runtime: {images: {createImage(input) { assert.deepEqual(input, {id: 'life'}); throw original; }}}}),
    (error) => error === original);
    assert.deepEqual(records, [{stage: 'life.create-image'}]);
  } finally { stages.unsubscribe(receive); }
});

test('warm binding changes when any suite scenario or support input changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'm6-warm-bindings-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const paths = ['fixtures/real-lagrange-backend-process.js', 'fixtures/real-lagrange-suite.js',
    'fixtures/real-lagrange-backend-scenarios.js', 'fixtures/real-lagrange-m6-scenario.js',
    'fixtures/real-lagrange-m6-shared-server-process.js', 'src/runtime.js',
    'src/backend/lagrange-backend.js', 'src/backend/lagrange-schema.js',
    'src/image/graph-image-service.js', 'src/compilation/compilation-service.js',
    'test/support/life-m5-witness.js', 'test/fixtures/life-m5-release.json',
    'test/support/sqlite-application-runtime.js', 'package.json', 'package-lock.json', 'thermal.mjs'];
  for (const name of paths) {
    await mkdir(join(root, name, '..'), {recursive: true}); await writeFile(join(root, name), 'before');
  }
  const options = {imagesRoot: root, fixture: join(root, paths[0]), thermalOwner: join(root, 'thermal.mjs')};
  const before = fingerprintSources(options);
  assert.equal(before.files.length, paths.length);
  for (const name of paths) {
    await writeFile(join(root, name), 'after');
    assert.notDeepEqual(fingerprintSources(options), before, name);
    await writeFile(join(root, name), 'before');
  }
  const coldOptions = {...options, fixture: join(root, 'fixtures/real-lagrange-m6-shared-server-process.js')};
  const coldBefore = fingerprintSources(coldOptions);
  await writeFile(join(root, 'fixtures/real-lagrange-m6-scenario.js'), 'changed cold body');
  assert.notDeepEqual(fingerprintSources(coldOptions), coldBefore, 'cold entry binds its delegated Life module too');
  await rm(join(root, 'fixtures/real-lagrange-m6-scenario.js'));
  assert.throws(() => fingerprintSources(coldOptions), /frozen original monolithic/);
});


test('warm main-thread bridge observes source stage and literal argv then exits without a live heartbeat', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'm6-warm-preload-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'fixtures'));
  await symlink(fileURLToPath(new URL('../src/', import.meta.url)), join(root, 'src'), 'dir');
  await writeFile(join(root, 'package.json'), JSON.stringify({type: 'module'}));
  const fixture = join(root, 'fixtures/real-lagrange-backend-process.js');
  await writeFile(fixture, [
    "import {channel} from 'node:diagnostics_channel';",
    "import {ImageService} from '../src/image/graph-image-service.js';",
    "if (process.argv[3] !== 'warm') throw new Error('Not warm');",
    "channel('lagrange-images.m6-stage/1').publish({stage: 'life.install-standard-image'});",
    "await ImageService.prototype.listCodeArtifacts.call({listRecords: async () => []}, 'unit-only');",
    "channel('lagrange-images.m6-stage/1').publish({stage: 'life.install-standard-image', state: 'passed'});",
  ].join('\n'));
  const metricsFile = join(root, 'observation.json');
  const argv = fixtureArguments(fixture, root, '/fresh-data');
  const env = {...process.env, M6_PROFILE_CONFIG: JSON.stringify({
    imagesRoot: root, fixture, fixtureArgv: argv, metricsFile, maxOperations: 100,
  })};
  execFileSync(process.execPath, ['--import', new URL('../scripts/m6-profile/preload.mjs', import.meta.url).href,
    ...argv], {env, timeout: 5000, maxBuffer: 65536});
  const metrics = JSON.parse(await readFile(metricsFile, 'utf8'));
  assert.equal(metrics.currentStage, 'life', 'completed import stage is not left active for later model work');
  assert.equal(metrics.completedByStartStage['life.install-standard-image']['images.listCodeArtifacts'].count, 1);
  assert.deepEqual(metrics.pending, []);
  assert.equal(metrics.exitCode, 0);
  assert.throws(() => execFileSync(process.execPath, ['--import',
    new URL('../scripts/m6-profile/preload.mjs', import.meta.url).href, fixture, '/fresh-data', 'kernel'],
  {env, timeout: 5000, maxBuffer: 65536, stdio: 'pipe'}), /argv mismatch/);
});

test('overflow or outstanding observations cannot become a completed diagnostic', () => {
  const metrics = {schema: 'm6-profile-observation/1', stopRequested: false, exitCode: 0};
  for (const extra of [{overflow: {pending: 1, stages: 0}}, {overflow: {pending: 0, stages: 1}},
    {pending: [{id: 1}]}]) {
    const result = classifyOutcome({code: 0, signal: null, metrics: {...metrics, ...extra}, reaped: true, groupGone: true});
    assert.notEqual(result.status, 'diagnostic-completed');
    assert.equal(result.acceptance, false);
  }
});
