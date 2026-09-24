import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {
  LANES,
  LabScheduler,
  aggregate,
  buildJobs,
  costJobs,
  isDefaultTestFile,
  learnSpeeds,
  parseLabLine,
  recordTimings,
  renderRemoteScript,
  selectWorkers,
  simulateSchedule,
  updateLearning,
} from '../scripts/lab-suite.mjs';
import labSuiteReporter from '../scripts/lab-suite-reporter.mjs';
import {LANE_FLAGS, createFrameReader, parseCommand} from '../scripts/lab-suite-worker.mjs';

// The lab fan-out (scripts/lab-suite.mjs). These proofs cover its pure parts: which files node
// would run, which workers qualify, how files are shared out, the program a worker runs, how the
// workers' reports are folded into one verdict, and the reporter's output. The effects (ssh, git
// archive) are proved by running it; its receipts are recorded on the Bead.

test('the default test-file set matches node:test, including the name trap the script avoids', () => {
  for (const path of ['test/a.test.js', 'test/support/helper.js', 'test/x.mjs', 'lib/a.test.mjs', 'src/foo-test.js',
    'src/foo_test.cjs', 'src/test-foo.js', 'src/test.js', 'scripts/lab-test.mjs']) {
    assert.equal(isDefaultTestFile(path), true, path);
  }
  for (const path of ['src/a.js', 'test/fixtures/data.json', 'node_modules/x/test/a.js', 'scripts/lab-suite.mjs', 'src/latest.js', 'src/contest.js']) {
    assert.equal(isDefaultTestFile(path), false, path);
  }
});

test('no script in scripts/ is picked up by node --test as a test file', async () => {
  // `npm test` runs node's default file set; a script matching it would be EXECUTED as a test in
  // every lane. scripts/lab-suite.mjs was first written as lab-test.mjs, which matches `*-test.*`.
  const names = await readdir(new URL('../scripts/', import.meta.url));
  assert.deepEqual(names.filter((name) => isDefaultTestFile(`scripts/${name}`)), []);
});

const INVENTORY = Object.freeze({
  controller: {testCapability: {bootId: 'boot-controller', cpuSampleMs: 100}},
  nodes: {
    fast: {name: 'fast', ssh: 'peter@10.0.0.1', os: 'linux', roles: ['runner'], testCapability: {bootId: 'b1', cores: 12, cpuSampleMs: 150, nodePath: '/home/peter/.nvm/versions/node/v22/bin/node'}},
    slow: {name: 'slow', ssh: 'peter@10.0.0.2', os: 'linux', roles: ['runner', 'harness'], testCapability: {bootId: 'b2', cores: 4, cpuSampleMs: 300}},
    self: {name: 'self', ssh: 'peter@10.0.0.3', os: 'linux', roles: ['runner'], testCapability: {bootId: 'boot-controller', cores: 20}},
    mac: {name: 'mac', ssh: 'peter@mac', os: 'macos', roles: ['runner'], testCapability: {bootId: 'b4'}},
    harnessOnly: {name: 'harnessOnly', ssh: 'peter@10.0.0.5', os: 'linux', roles: ['harness'], testCapability: {bootId: 'b5'}},
    gone: {name: 'gone', ssh: 'peter@10.0.0.6', os: 'linux', roles: ['runner'], testCapability: {bootId: 'b6'}},
    hostile: {name: 'hostile', ssh: 'peter@x; rm -rf ~', os: 'linux', roles: ['runner'], testCapability: {bootId: 'b7'}},
  },
});

test('workers are reachable linux runners other than the controller, with this repository\'s own settings', () => {
  const probes = {fast: {reachable: true, cores: 12}, slow: {reachable: true, cores: 4}, gone: {reachable: false, reason: 'No route to host'}};
  const config = {defaultDir: '~/lab/lagrange-images', nodes: {slow: {dir: '/mnt/old/lab/lagrange-images', slots: 2}}};
  const {workers, skipped} = selectWorkers(INVENTORY, config, probes);
  assert.deepEqual(workers.map(({name}) => name), ['fast', 'slow']);
  const [fast, slow] = workers;
  assert.equal(fast.slots, 4, 'about a third of the logical cores by default');
  assert.equal(fast.speed, 1.5, 'relative to the controller\'s probe sample');
  assert.equal(fast.nodeBinDir, '/home/peter/.nvm/versions/node/v22/bin');
  assert.equal(fast.dir, '~/lab/lagrange-images');
  assert.equal(fast.singleThread, 1.5, 'single-core speed comes from the probe sample');
  assert.equal(slow.slots, 2, 'a configured slot count wins');
  assert.equal(slow.dir, '/mnt/old/lab/lagrange-images');
  const reasons = Object.fromEntries(skipped.map(({name, reason}) => [name, reason]));
  assert.equal(reasons.self, 'same machine as the controller');
  assert.match(reasons.mac, /not linux/);
  assert.equal(reasons.harnessOnly, 'no runner role');
  assert.match(reasons.gone, /unreachable: No route to host/);
  assert.equal(selectWorkers(INVENTORY, {}, {}).workers.length, 0, 'a node nobody probed this run is not used on the strength of its inventory entry');
  assert.equal(reasons.hostile, 'unusable name or ssh target');
});

test('--nodes and --exclude narrow the set, and an unknown node name is reported', () => {
  const probes = {fast: {reachable: true, cores: 12}, slow: {reachable: true, cores: 4}};
  const only = selectWorkers(INVENTORY, {}, probes, {only: ['slow', 'nosuch']});
  assert.deepEqual(only.workers.map(({name}) => name), ['slow']);
  assert.deepEqual(only.skipped, [{name: 'nosuch', reason: 'not in the Lagrange lab inventory'}]);
  const excluded = selectWorkers(INVENTORY, {nodes: {fast: {exclude: true}}}, probes);
  assert.deepEqual(excluded.workers.map(({name}) => name), ['slow']);
});

test('the recovery lane gets only files that name a sweep; the ordinary lane gets every file', () => {
  const jobs = buildJobs({files: ['test/a.test.js', 'test/b.test.js'], lanes: ['fast', 'recovery'], sweepFiles: ['test/b.test.js']});
  assert.deepEqual(jobs, [
    {lane: 'fast', file: 'test/a.test.js'}, {lane: 'fast', file: 'test/b.test.js'}, {lane: 'recovery', file: 'test/b.test.js'},
  ]);
  assert.throws(() => buildJobs({files: [], lanes: ['nightly'], sweepFiles: []}), /unknown lane/);
});

const worker = (name, slots, speed = 1) => ({name, slots, speed, dir: '~/lab/lagrange-images', nodeBinDir: null});
const job = (id, cost, lane = 'fast') => ({id, lane, file: `test/f${String(id).padStart(3, '0')}.test.js`, cost});

test('jobs are costed from their lane\'s recorded timings, and an unknown file costs the lane median', () => {
  const costed = costJobs([{lane: 'fast', file: 'test/a.test.js'}, {lane: 'fast', file: 'test/new.test.js'}, {lane: 'recovery', file: 'test/r.test.js'}],
    {fast: {'test/a.test.js': 4000, 'test/b.test.js': 6000, 'test/c.test.js': 8000}});
  assert.deepEqual(costed.map(({id, cost}) => [id, cost]), [[0, 4000], [1, 6000], [2, 2000]], 'no recovery timings at all: the default');
});

test('the first wave deals the longest files one per worker, fastest single core first, before any worker gets a second', () => {
  // `fast-few` has the better single core; `slow-many` has the better learned factor (the one that
  // comes from running few files at a time). Placement of the longest files follows the core.
  const scheduler = new LabScheduler([job(0, 90_000), job(1, 80_000), job(2, 70_000), job(3, 5000), job(4, 4000), job(5, 3000)],
    [{...worker('slow-many', 3, 0.9), singleThread: 2}, {...worker('fast-few', 3, 1.2), singleThread: 1}]);
  scheduler.markReady('slow-many');
  scheduler.markReady('fast-few');
  const first = scheduler.start();
  assert.deepEqual(first.get('fast-few').map(({id}) => id), [0, 2, 4], 'the fastest worker gets the longest file, then every other round');
  assert.deepEqual(first.get('slow-many').map(({id}) => id), [1, 3, 5]);
});

test('after the first wave a worker is topped up as its files finish, never beyond its slots, longest remaining first', () => {
  const jobs = Array.from({length: 10}, (_, id) => job(id, 10_000 - id * 100));
  const scheduler = new LabScheduler(jobs, [worker('a', 2), worker('b', 1, 1.5)]);
  assert.deepEqual(scheduler.markReady('a'), [], 'nothing is dispatched before start');
  scheduler.markReady('b');
  const first = scheduler.start();
  assert.equal(first.get('a').length, 2);
  assert.equal(first.get('b').length, 1);
  const next = scheduler.complete('a', first.get('a')[0].id);
  assert.deepEqual(next.map(({id}) => id), [3], 'exactly one slot freed, filled with the longest remaining job');
  assert.deepEqual(scheduler.complete('a', 999), [], 'an unknown job id frees nothing');
  assert.equal(scheduler.remaining, 6);
});

test('a worker that joins after the start is filled on arrival, and a dropped worker\'s files are re-run once elsewhere', () => {
  const scheduler = new LabScheduler([job(0, 9000), job(1, 8000), job(2, 7000), job(3, 6000)], [worker('early', 1), worker('late', 2)]);
  scheduler.markReady('early');
  const first = scheduler.start();
  assert.deepEqual([...first.keys()], ['early']);
  assert.deepEqual(scheduler.markReady('late').map(({id}) => id), [1, 2]);
  assert.equal(scheduler.inFlight, 3);
  const lost = scheduler.drop('late');
  assert.deepEqual(lost.map(({id}) => id), [1, 2], 'the files it held are returned');
  assert.deepEqual(scheduler.markReady('late'), [], 'a dropped worker gets nothing more');
  const {requeued, abandoned} = scheduler.requeue(lost);
  assert.deepEqual(requeued.map(({id, attempt}) => [id, attempt]), [[1, 2], [2, 2]], 'back on the queue, marked as a second attempt');
  assert.deepEqual(abandoned, []);
  assert.deepEqual(scheduler.complete('early', 0).map(({id}) => id), [1], 'the longest job, a requeued one, goes first');
  // Lost a second time: abandoned, never a third attempt.
  const again = scheduler.drop('early');
  const second = scheduler.requeue(again);
  assert.deepEqual(second.requeued, []);
  assert.deepEqual(second.abandoned.map(({id}) => id), [1]);
});

test('work that reappears is dealt to every ready worker with a free slot', () => {
  const scheduler = new LabScheduler([job(0, 9000)], [worker('a', 2), worker('b', 2)]);
  scheduler.markReady('a');
  scheduler.markReady('b');
  scheduler.start();
  scheduler.complete('a', 0);
  scheduler.requeue([job(5, 4000), job(6, 3000), job(7, 2000)]);
  const dealt = scheduler.fillAll();
  assert.equal([...dealt.values()].flat().length, 3);
  assert.equal(scheduler.remaining, 0);
});

test('the simulation replays the dispatch rules: every job runs once, and finish times follow speed', () => {
  const jobs = Array.from({length: 30}, (_, id) => job(id, id < 2 ? 60_000 : 3000));
  const prediction = simulateSchedule(jobs, [worker('fast', 4, 1), worker('slow', 4, 2)]);
  assert.equal(prediction.workers.fast.jobs + prediction.workers.slow.jobs, 30);
  assert.equal(prediction.makespanMs, Math.max(prediction.workers.fast.finishMs, prediction.workers.slow.finishMs));
  assert.ok(prediction.workers.fast.jobs > prediction.workers.slow.jobs, 'the faster worker drains more of the queue');
  assert.ok(prediction.makespanMs >= 60_000, 'a file cannot be split: the longest bounds the run');
  assert.throws(() => simulateSchedule(jobs, []), /no usable lab workers/);
});

test('the worker program is valid bash, locks the worker, guards the directory and installs the driver', () => {
  const script = renderRemoteScript({
    dir: '~/lab/lagrange-images', nodeBinDir: '/home/peter/.nvm/versions/node/v22/bin', driverSource: "console.log('driver');\n",
  });
  execFileSync('bash', ['-n'], {input: script});
  assert.match(script, /DIR="\$HOME"\/'lab\/lagrange-images'/, 'a home-relative directory expands on the worker');
  assert.match(script, /flock -w 900 9/);
  assert.match(script, /\.lab\/owner/, 'a non-empty directory without the owner marker is refused, never cleaned');
  assert.match(script, /base64 -d > \.lab\/driver\.mjs/);
  assert.match(script, /exec node \.lab\/driver\.mjs/, 'the driver takes over the session\'s stdin');
  assert.ok(script.includes(Buffer.from("console.log('driver');\n").toString('base64')));
});

test('the worker program refuses a directory it could misuse', () => {
  for (const dir of ['~', '/home/peter', '~/lab/other', 'lagrange-images', '~/lab/lagrange images', '~/$(id)/lagrange-images', "~/a'b/lagrange-images"]) {
    assert.throws(() => renderRemoteScript({dir, nodeBinDir: null, driverSource: 'x'}), /lab checkout directory/, dir);
  }
  assert.throws(() => renderRemoteScript({dir: '~/lab/lagrange-images', nodeBinDir: '/bin; rm', driverSource: 'x'}), /unusable node directory/);
  assert.throws(() => renderRemoteScript({dir: '~/lab/lagrange-images', nodeBinDir: null, driverSource: ''}), /driverSource/);
});

test('the driver splits the session into the snapshot and the commands, whatever the chunk boundaries', () => {
  const tar = Buffer.from('0123456789abcdef');
  const session = Buffer.concat([Buffer.from(`TAR ${tar.length}\n`), tar, Buffer.from('{"run":{"id":1,"lane":"fast","file":"test/a.test.js"}}\n{"end":true}\n')]);
  for (const size of [1, 3, 7, session.length]) {
    const received = [];
    const lines = [];
    let ended = 0;
    const reader = createFrameReader({onTarChunk: (part) => received.push(part), onTarEnd: () => { ended += 1; }, onLine: (line) => lines.push(line)});
    for (let at = 0; at < session.length; at += size) reader.push(session.subarray(at, at + size));
    reader.end();
    assert.equal(Buffer.concat(received).toString(), tar.toString(), `chunk size ${size}: the tar bytes, exactly`);
    assert.equal(ended, 1);
    assert.deepEqual(lines, ['{"run":{"id":1,"lane":"fast","file":"test/a.test.js"}}', '{"end":true}']);
  }
  assert.throws(() => createFrameReader({onTarChunk() {}, onTarEnd() {}, onLine() {}}).push(Buffer.from('HELLO\n')), /TAR header/);
  const short = createFrameReader({onTarChunk() {}, onTarEnd() {}, onLine() {}});
  short.push(Buffer.from('TAR 10\nabc'));
  assert.throws(() => short.end(), /before the snapshot was complete/);
});

test('the driver runs only a known lane over a plain test path', () => {
  assert.deepEqual(parseCommand('{"run":{"id":3,"lane":"recovery","file":"test/x.test.js"}}'), {run: {id: 3, lane: 'recovery', file: 'test/x.test.js'}});
  assert.deepEqual(parseCommand('{"end":true}'), {end: true});
  for (const bad of ['{"run":{"id":1,"lane":"nightly","file":"test/x.test.js"}}', '{"run":{"id":1,"lane":"fast","file":"src/x.js"}}',
    '{"run":{"id":1,"lane":"fast","file":"test/$(id).test.js"}}', '{"run":{"id":"1","lane":"fast","file":"test/x.test.js"}}', '{"run":{"id":1,"lane":"__proto__","file":"test/x.test.js"}}']) {
    assert.throws(() => parseCommand(bad), /unusable lab command/, bad);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(LANES).map(([lane, {flag}]) => [lane, flag])), LANE_FLAGS, 'controller and driver agree on the lane flags');
});

test('only LAB-prefixed JSON lines are facts', () => {
  assert.deepEqual(parseLabLine('LAB {"t":"done","id":1,"code":0}'), {t: 'done', id: 1, code: 0});
  assert.equal(parseLabLine('LAB not json'), null);
  assert.equal(parseLabLine('ok 1 - something'), null);
});

const dispatched = (...entries) => entries.map(([id, lane, file]) => ({id, lane, file}));

test('the verdict sums every worker, counts sweeps by name, and times each file from its own process', () => {
  const green = aggregate([
    {name: 'a', dispatched: dispatched([1, 'fast', 'test/a.test.js'], [2, 'recovery', 'test/r.test.js']), facts: [
      {t: 'ready'},
      {t: 'result', lane: 'fast', file: '/w/test/a.test.js', name: 'a works', nesting: 0, status: 'pass', ms: 120},
      {t: 'summary', lane: 'fast', key: 'tests', value: 3}, {t: 'summary', lane: 'fast', key: 'pass', value: 3},
      {t: 'done', id: 1, lane: 'fast', file: 'test/a.test.js', code: 0, ms: 900},
      {t: 'result', lane: 'recovery', file: '/w/test/r.test.js', name: 'exhaustive-recovery: every write', nesting: 0, status: 'pass', ms: 800},
      {t: 'summary', lane: 'recovery', key: 'tests', value: 1}, {t: 'done', id: 2, lane: 'recovery', file: 'test/r.test.js', code: 0, ms: 1500},
    ]},
    {name: 'b', dispatched: dispatched([3, 'fast', 'test/b.test.js']), facts: [
      {t: 'ready'}, {t: 'summary', lane: 'fast', key: 'tests', value: 2}, {t: 'summary', lane: 'fast', key: 'pass', value: 2},
      {t: 'done', id: 3, lane: 'fast', file: 'test/b.test.js', code: 0, ms: 400},
    ]},
    {name: 'c', dispatched: [], sshCode: 255, facts: []},
  ]);
  assert.equal(green.ok, true);
  assert.deepEqual(green.totals.fast, {tests: 5, pass: 5});
  assert.equal(green.totals.recovery.sweeps, 1);
  assert.deepEqual(green.fileMs.fast['test/a.test.js'], {ms: 900, worker: 'a'}, 'the file\'s whole process, not its tests\' sum');
  assert.deepEqual(green.problems, []);
  assert.match(green.notes[0], /c: never became ready \(ssh exit 255\); it took no files/);
});

test('a lost file, a crash without a reported failure, a worker error or an undispatched file fails the run', () => {
  const lost = aggregate([{name: 'a', sshCode: 255, dispatched: dispatched([1, 'fast', 'test/a.test.js']), facts: [{t: 'ready'}]}]);
  assert.equal(lost.ok, false);
  assert.match(lost.problems[0], /\[fast\] test\/a\.test\.js never finished \(ssh exit 255\)/, 'a silent worker is not a passing worker');

  const crashed = aggregate([{name: 'a', dispatched: dispatched([1, 'fast', 'test/a.test.js']), facts: [
    {t: 'ready'}, {t: 'done', id: 1, lane: 'fast', file: 'test/a.test.js', code: 1, ms: 50, stderr: 'SyntaxError: bad'},
  ]}]);
  assert.equal(crashed.ok, false);
  assert.match(crashed.problems[0], /exited 1 without a reported failure: SyntaxError: bad/);

  const failed = aggregate([{name: 'a', dispatched: dispatched([1, 'fast', 'test/a.test.js']), facts: [
    {t: 'ready'},
    {t: 'result', lane: 'fast', file: '/w/test/a.test.js', name: 'inner', nesting: 1, status: 'fail', ms: 3, error: {message: 'boom'}},
    {t: 'summary', lane: 'fast', key: 'fail', value: 1}, {t: 'done', id: 1, lane: 'fast', file: 'test/a.test.js', code: 1, ms: 50},
  ]}]);
  assert.equal(failed.ok, false);
  assert.equal(failed.failures[0].error.message, 'boom');
  assert.deepEqual(failed.problems, [], 'a reported test failure is a failure, not also a crash');

  const rerun = aggregate([
    {name: 'flaky', sshCode: 255, dispatched: dispatched([1, 'fast', 'test/a.test.js']), facts: [{t: 'ready'}]},
    {name: 'steady', dispatched: dispatched([1, 'fast', 'test/a.test.js']), facts: [{t: 'ready'}, {t: 'done', id: 1, lane: 'fast', file: 'test/a.test.js', code: 0, ms: 10}]},
  ]);
  assert.equal(rerun.ok, true, 'a file lost with a dropped worker and completed on another is not a failure');
  assert.match(rerun.notes[0], /flaky: \[fast\] test\/a\.test\.js was lost when the worker dropped \(ssh exit 255\) and re-run on another worker/);

  const locked = aggregate([{name: 'a', dispatched: [], facts: [{t: 'error', reason: 'another lab run holds this worker'}]}]);
  assert.equal(locked.ok, false);
  const orphaned = aggregate([], {undispatched: [{id: 9, lane: 'fast', file: 'test/z.test.js'}]});
  assert.equal(orphaned.ok, false);
  assert.match(orphaned.problems[0], /1 file\(s\) were never dispatched/);
});

test('timings are stored in controller time and smoothed', () => {
  const workers = new Map([['slow', {speed: 2}]]);
  const first = recordTimings({}, {fast: {'test/a.test.js': {ms: 4000, worker: 'slow'}}}, workers);
  assert.equal(first.fast['test/a.test.js'], 2000, 'a slow worker\'s 4 s is 2 s of controller time');
  const second = recordTimings(first, {fast: {'test/a.test.js': {ms: 8000, worker: 'slow'}}}, workers);
  assert.equal(second.fast['test/a.test.js'], 3000, 'half the old estimate plus half the new one');
  assert.equal(first.fast['test/a.test.js'], 2000, 'the previous timings object is not mutated');
});

async function collect(events, lane = 'fast') {
  const previous = process.env.LAB_LANE;
  process.env.LAB_LANE = lane;
  try {
    async function* source() { yield* events; }
    const lines = [];
    for await (const chunk of labSuiteReporter(source())) lines.push(parseLabLine(chunk.trimEnd()));
    return lines;
  } finally {
    if (previous === undefined) delete process.env.LAB_LANE; else process.env.LAB_LANE = previous;
  }
}

test('the reporter emits top-level results, every failure with its own message, and the run summary', async () => {
  const cause = Object.assign(new Error('expected 1 to equal 2'), {code: 'ERR_ASSERTION'});
  const facts = await collect([
    {type: 'test:pass', data: {name: 'top', nesting: 0, file: '/w/test/a.test.js', details: {duration_ms: 12.5}}},
    {type: 'test:pass', data: {name: 'inner pass', nesting: 1, file: '/w/test/a.test.js', details: {duration_ms: 1}}},
    {type: 'test:fail', data: {name: 'inner fail', nesting: 1, file: '/w/test/a.test.js', details: {duration_ms: 2, error: Object.assign(new Error('test failed'), {cause, failureType: 'testCodeFailure'})}}},
    {type: 'test:pass', data: {name: 'skipped one', nesting: 0, file: '/w/test/b.test.js', skip: true, details: {duration_ms: 0}}},
    {type: 'test:diagnostic', data: {nesting: 0, message: 'tests 3'}},
    {type: 'test:diagnostic', data: {nesting: 0, message: 'duration_ms 1234.5'}},
    {type: 'test:diagnostic', data: {nesting: 0, message: 'a free-form note'}},
    {type: 'test:diagnostic', data: {nesting: 1, message: 'tests 99'}},
  ], 'recovery');
  assert.deepEqual(facts, [
    {t: 'result', lane: 'recovery', file: '/w/test/a.test.js', name: 'top', nesting: 0, status: 'pass', ms: 12.5},
    {t: 'result', lane: 'recovery', file: '/w/test/a.test.js', name: 'inner fail', nesting: 1, status: 'fail', ms: 2,
      error: {message: 'expected 1 to equal 2', name: 'Error', code: 'ERR_ASSERTION', failureType: 'testCodeFailure'}},
    {t: 'result', lane: 'recovery', file: '/w/test/b.test.js', name: 'skipped one', nesting: 0, status: 'skip', ms: 0},
    {t: 'summary', lane: 'recovery', key: 'tests', value: 3},
    {t: 'summary', lane: 'recovery', key: 'duration_ms', value: 1234.5},
  ]);
  assert.deepEqual(Object.keys(LANES), ['fast', 'recovery']);
});

test('a learned speed beats the probe sample; the probe is only the prior for a worker with no history', () => {
  const probes = {fast: {reachable: true, cores: 12}, slow: {reachable: true, cores: 4}};
  const {workers} = selectWorkers(INVENTORY, {}, probes, {speeds: {slow: {factor: 1.8}}});
  const byName = Object.fromEntries(workers.map((entry) => [entry.name, entry]));
  assert.equal(byName.slow.speed, 1.8);
  assert.equal(byName.slow.speedSource, 'learned');
  assert.equal(byName.slow.singleThread, 3, 'the learned factor does not replace the single-core sample (300 / 100)');
  assert.equal(byName.fast.speed, 1.5, 'no history: the probe sample (150 / 100)');
  assert.equal(byName.fast.speedSource, 'probe');
  const noSample = selectWorkers({...INVENTORY, controller: {testCapability: {bootId: 'boot-controller'}}}, {}, probes);
  assert.equal(noSample.workers.find((entry) => entry.name === 'fast').speedSource, 'default');
});

const measured = (worker, entries) => Object.fromEntries(entries.map(([file, ms]) => [file, {ms, worker}]));

test('a worker\'s speed is the median ratio of its measured times to the stored reference times, smoothed', () => {
  const timings = {fast: {'test/a.test.js': 10_000, 'test/b.test.js': 20_000, 'test/c.test.js': 4000, 'test/tiny.test.js': 200}};
  const fileMs = {fast: {
    ...measured('w', [['test/a.test.js', 20_000], ['test/b.test.js', 30_000], ['test/c.test.js', 12_000]]),
    'test/tiny.test.js': {ms: 5000, worker: 'w'},
  }};
  // Ratios 2.0, 1.5, 3.0 -> median 2.0; the tiny file (reference under a second, dominated by
  // process start-up) and a file with no reference do not vote.
  const first = learnSpeeds({}, timings, fileMs, {now: 't1'});
  assert.deepEqual(first.w, {factor: 2, observed: 2, samples: 3, updatedAt: 't1'});
  const second = learnSpeeds({w: {factor: 1}}, timings, fileMs, {now: 't2'});
  assert.equal(second.w.factor, 1.5, 'half the previous estimate plus half the observation');
  assert.equal(second.w.observed, 2);
});

test('too few usable files leaves a worker\'s speed alone, and each worker learns only from its own files', () => {
  const timings = {fast: {'test/a.test.js': 10_000, 'test/b.test.js': 10_000, 'test/c.test.js': 10_000, 'test/d.test.js': 10_000}};
  const fileMs = {fast: {
    ...measured('one', [['test/a.test.js', 30_000], ['test/b.test.js', 30_000]]),
    ...measured('two', [['test/c.test.js', 5000], ['test/d.test.js', 5000]]),
  }, recovery: measured('two', [['test/r.test.js', 5000]])};
  const speeds = {one: {factor: 1.2}};
  const next = learnSpeeds(speeds, {...timings, recovery: {'test/r.test.js': 10_000}}, fileMs);
  assert.deepEqual(next.one, {factor: 1.2}, 'two samples are not enough');
  assert.equal(next.two.factor, 0.5, 'three samples across both lanes, all at half the reference time');
  assert.deepEqual(speeds, {one: {factor: 1.2}}, 'the previous speeds object is not mutated');
});

test('learning and recording keep one reference scale: a worker that runs as predicted changes nothing', () => {
  // The worker was known to run at 1.5x the reference; this run measured exactly 1.5x again.
  const timings = {fast: {'test/a.test.js': 10_000, 'test/b.test.js': 20_000, 'test/c.test.js': 4000}};
  const fileMs = {fast: measured('w', [['test/a.test.js', 15_000], ['test/b.test.js', 30_000], ['test/c.test.js', 6000]])};
  const speeds = learnSpeeds({w: {factor: 1.5}}, timings, fileMs);
  assert.equal(speeds.w.factor, 1.5);
  const next = recordTimings(timings, fileMs, new Map([['w', {speed: speeds.w.factor}]]));
  assert.deepEqual(next, timings, 'the stored reference times do not drift');
});

test('a run learns speeds first and normalizes its times with the updated speed, not the old one', () => {
  // Stored with a prior of 1.0, the worker actually ran every file at 2x the reference. Learning
  // moves it to 1.5; normalizing 20 s with 1.5 (not 1.0) keeps the reference from absorbing the
  // worker's slowness: 10 s * 0.5 + (20 s / 1.5) * 0.5.
  const timings = {fast: {'test/a.test.js': 10_000, 'test/b.test.js': 10_000, 'test/c.test.js': 10_000}};
  const fileMs = {fast: measured('w', [['test/a.test.js', 20_000], ['test/b.test.js', 20_000], ['test/c.test.js', 20_000]])};
  const result = updateLearning({speeds: {w: {factor: 1}}, timings, fileMs, workers: [{name: 'w', speed: 1}], now: 't'});
  assert.equal(result.speeds.w.factor, 1.5);
  assert.equal(result.timings.fast['test/a.test.js'], Math.round(10_000 * 0.5 + (20_000 / 1.5) * 0.5));
});
