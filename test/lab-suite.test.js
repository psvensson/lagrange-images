import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {
  LANES,
  aggregate,
  buildJobs,
  isDefaultTestFile,
  parseLabLine,
  planShards,
  recordTimings,
  renderRemoteScript,
  selectWorkers,
} from '../scripts/lab-suite.mjs';
import labSuiteReporter from '../scripts/lab-suite-reporter.mjs';

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
  assert.equal(fast.slots, 11, 'cores minus one by default');
  assert.equal(fast.speed, 1.5, 'relative to the controller\'s probe sample');
  assert.equal(fast.nodeBinDir, '/home/peter/.nvm/versions/node/v22/bin');
  assert.equal(fast.dir, '~/lab/lagrange-images');
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

test('every job is planned exactly once, and the two lanes\' long poles land on different workers', () => {
  const files = Array.from({length: 40}, (_, index) => `test/f${String(index).padStart(2, '0')}.test.js`);
  const jobs = buildJobs({files, lanes: ['fast', 'recovery'], sweepFiles: ['test/f00.test.js', 'test/f01.test.js']});
  const timings = {fast: {'test/f10.test.js': 80_000}, recovery: {'test/f00.test.js': 75_000, 'test/f01.test.js': 5000}};
  for (let index = 11; index < 40; index += 1) timings.fast[`test/f${index}.test.js`] = 3000;
  const plans = planShards(jobs, [worker('a', 11, 1.4), worker('b', 7, 2), worker('c', 3, 2)], timings);
  const planned = plans.flatMap((plan) => Object.entries(plan.lanes).flatMap(([lane, list]) => list.map((file) => `${lane} ${file}`))).sort();
  assert.deepEqual(planned, jobs.map(({lane, file}) => `${lane} ${file}`).sort(), 'no job lost or duplicated');
  const holder = (lane, file) => plans.find((plan) => plan.lanes[lane].includes(file)).worker.name;
  assert.notEqual(holder('fast', 'test/f10.test.js'), holder('recovery', 'test/f00.test.js'),
    'a worker runs its lanes one after the other, so the two longest files must not share one');
  for (const plan of plans) assert.ok(plan.estimatedMs >= 0);
});

test('a file with no recorded timing costs the median, and no workers is an explicit error', () => {
  const plans = planShards([{lane: 'fast', file: 'test/new.test.js'}], [worker('only', 1)], {fast: {'test/a.test.js': 4000, 'test/b.test.js': 6000, 'test/c.test.js': 8000}});
  assert.equal(plans[0].estimatedMs, 6000);
  assert.throws(() => planShards([], []), /no usable lab workers/);
});

test('the worker program is valid bash, locks the worker, guards the directory and quotes every path', () => {
  const script = renderRemoteScript({
    dir: '~/lab/lagrange-images', nodeBinDir: '/home/peter/.nvm/versions/node/v22/bin', slots: 7,
    lanes: {fast: ['test/a.test.js', 'test/support/b.js'], recovery: ['test/c.test.js']},
  });
  execFileSync('bash', ['-n'], {input: script});
  assert.match(script, /DIR="\$HOME"\/'lab\/lagrange-images'/, 'a home-relative directory expands on the worker');
  assert.match(script, /flock -w 900 9/);
  assert.match(script, /\.lab\/owner/, 'a non-empty directory without the owner marker is refused, never cleaned');
  assert.match(script, /npm ci --ignore-scripts/);
  assert.match(script, /--test-concurrency=7/);
  assert.match(script, /run_lane fast '--test-skip-pattern=exhaustive-recovery:' 'test\/a\.test\.js' 'test\/support\/b\.js'/);
  assert.match(script, /run_lane recovery '--test-name-pattern=exhaustive-recovery:' 'test\/c\.test\.js'/);
  assert.equal(renderRemoteScript({dir: '/mnt/old/lab/lagrange-images', nodeBinDir: null, slots: 1, lanes: {fast: ['test/a.test.js'], recovery: []}}).includes('run_lane recovery'), false,
    'an empty lane is not run');
});

test('the worker program refuses a directory or file it could misuse', () => {
  const base = {nodeBinDir: null, slots: 2, lanes: {fast: ['test/a.test.js']}};
  for (const dir of ['~', '/home/peter', '~/lab/other', 'lagrange-images', '~/lab/lagrange images', '~/$(id)/lagrange-images', "~/a'b/lagrange-images"]) {
    assert.throws(() => renderRemoteScript({...base, dir}), /lab checkout directory/, dir);
  }
  for (const file of ['src/a.js', 'test/a b.test.js', "test/a'.test.js", 'test/$(id).test.js']) {
    assert.throws(() => renderRemoteScript({...base, dir: '~/lab/lagrange-images', lanes: {fast: [file]}}), /unusable test file path/, file);
  }
  assert.throws(() => renderRemoteScript({...base, dir: '~/lab/lagrange-images', slots: 0}), /slots/);
  assert.throws(() => renderRemoteScript({...base, dir: '~/lab/lagrange-images', lanes: {nightly: ['test/a.test.js']}}), /unknown lane/);
});

test('only LAB-prefixed JSON lines are facts', () => {
  assert.deepEqual(parseLabLine('LAB {"t":"exit","lane":"fast","code":0}'), {t: 'exit', lane: 'fast', code: 0});
  assert.equal(parseLabLine('LAB not json'), null);
  assert.equal(parseLabLine('ok 1 - something'), null);
});

const plan = (name, lanes) => ({worker: {name}, lanes});

test('the verdict sums every worker, counts sweeps by name, and treats a missing or failed lane as failure', () => {
  const green = aggregate([
    {plan: plan('a', {fast: ['test/a.test.js'], recovery: ['test/r.test.js']}), sshCode: 0, facts: [
      {t: 'result', lane: 'fast', file: '/w/test/a.test.js', name: 'a works', nesting: 0, status: 'pass', ms: 120},
      {t: 'summary', lane: 'fast', key: 'tests', value: 3}, {t: 'summary', lane: 'fast', key: 'pass', value: 3},
      {t: 'exit', lane: 'fast', code: 0},
      {t: 'result', lane: 'recovery', file: '/w/test/r.test.js', name: 'exhaustive-recovery: every write', nesting: 0, status: 'pass', ms: 900},
      {t: 'summary', lane: 'recovery', key: 'tests', value: 1}, {t: 'exit', lane: 'recovery', code: 0},
    ]},
    {plan: plan('b', {fast: ['test/b.test.js'], recovery: []}), sshCode: 0, facts: [
      {t: 'summary', lane: 'fast', key: 'tests', value: 2}, {t: 'summary', lane: 'fast', key: 'pass', value: 2},
      {t: 'exit', lane: 'fast', code: 0},
    ]},
  ]);
  assert.equal(green.ok, true);
  assert.deepEqual(green.totals.fast, {tests: 5, pass: 5});
  assert.equal(green.totals.recovery.sweeps, 1);
  assert.deepEqual(green.fileMs.fast['test/a.test.js'], {ms: 120, worker: 'a'});

  const missing = aggregate([{plan: plan('a', {fast: ['test/a.test.js'], recovery: []}), sshCode: 255, facts: []}]);
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /lane fast never finished \(ssh exit 255\)/, 'a silent worker is not a passing worker');

  const failed = aggregate([{plan: plan('a', {fast: ['test/a.test.js'], recovery: []}), sshCode: 1, facts: [
    {t: 'result', lane: 'fast', file: '/w/test/a.test.js', name: 'inner', nesting: 1, status: 'fail', ms: 3, error: {message: 'boom'}},
    {t: 'summary', lane: 'fast', key: 'fail', value: 1}, {t: 'exit', lane: 'fast', code: 1},
  ]}]);
  assert.equal(failed.ok, false);
  assert.equal(failed.failures[0].error.message, 'boom');
  assert.match(failed.problems[0], /lane fast exited 1/);

  const locked = aggregate([{plan: plan('a', {fast: ['test/a.test.js'], recovery: []}), sshCode: 75, facts: [
    {t: 'error', reason: 'another lab run holds this worker'},
  ]}]);
  assert.equal(locked.ok, false);
  assert.ok(locked.problems.some((problem) => problem.includes('another lab run holds this worker')));
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
