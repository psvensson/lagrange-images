#!/usr/bin/env node
// Run this repository's test lanes across the Lagrange home-lab workers (bead lagrange-images-labt).
//
//   node scripts/lab-suite.mjs                      both lanes, every reachable worker
//   node scripts/lab-suite.mjs --lanes fast         the ordinary lane only
//   node scripts/lab-suite.mjs test/x.test.js ...   only these files (targeted iteration)
//   node scripts/lab-suite.mjs --nodes tv-dator     only these workers
//   node scripts/lab-suite.mjs --dry-run            print the plan and ship nothing
//
// WHAT IT IS. A way for an agent or a person on a thermally constrained workstation to get a
// full-suite receipt in about a minute without running a single test file locally. It is NOT a
// merge authority: `.github/workflows/test.yml` on the exact PR head stays that (docs/runbook.md).
//
// WHAT IT RUNS. Exactly the lanes CI runs, with the same selection flags: `fast` is `node --test
// --test-skip-pattern=exhaustive-recovery:` and `recovery` is `--test-name-pattern=exhaustive-
// recovery:`, over node's own default test-file set, one file per `node --test` process — which is
// how node isolates files anyway. The recovery lane is given only the files whose source names a
// sweep (`test/ci-split.test.js` requires every sweep to carry the prefix literally). Env-gated
// real-lane tests skip on workers exactly as they do in the ordinary CI lanes, because no LAGRANGE_*
// integration variable is set there.
//
// HOW IT SHARES THE WORK. Dynamically (bead lagrange-images-kq98). All (lane, file) jobs go into one
// queue, longest first by recorded duration. Each worker keeps `slots` files in flight and is sent
// the next job from the queue as each one finishes, so a worker that turns out slower than expected
// — a throttling laptop, a busy machine — simply takes fewer files. A static split cannot do this:
// measured over four consecutive runs it missed per-worker finish times by 20-60 s, because a file's
// time on a worker depends on what else runs beside it. The first wave spreads the longest files one
// per machine, fastest single core first; learned per-worker speeds (`learnSpeeds`) predict finish
// times for the report. Slots default to about a third of the logical cores (see `selectWorkers`).
//
// WHAT IT SHIPS. The working tree as it is — HEAD plus uncommitted and untracked-but-not-ignored
// files — snapshotted into a git tree object through a temporary index (the real index is never
// touched), sent as a `git archive` tar at the start of one SSH session per worker, under a `flock`,
// with `npm ci --ignore-scripts` only when the lockfile changed. The worker side of that session is
// scripts/lab-suite-worker.mjs, shipped from the same snapshot. So a branch can be tested before it is
// committed or pushed, and the receipt names the exact tree it tested.
//
// WHERE. Workers come from the Lagrange lab inventory (`~/.config/lagrange/lab/inventory.json`,
// owned by the Lagrange repository's `scripts/lab.js`; this script only reads it): Linux nodes with
// the `runner` role that answer SSH now. The controller's own machine is never used — a node whose
// probed boot id equals the controller's is the same box under another name. Per-worker settings
// that belong to THIS repository (checkout directory, slots, exclusion) live in
// `~/.config/lagrange-images/lab.json`, never in the Lagrange inventory.
//
// THE NAME. Not `lab-test.mjs`: node's default test-file patterns include `**/*-test.{js,mjs}`, so
// a script with that name would itself be picked up and executed by `npm test` and by CI.
//
// SAFETY ON THE WORKER. The checkout directory must be named `lagrange-images`, and it is cleaned
// only when it is empty or carries this script's owner marker, so a misconfigured path cannot wipe
// someone's directory. One run at a time per worker (`flock`), everything under `nice`.

import {spawn, execFileSync} from 'node:child_process';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const LANES = Object.freeze({
  fast: Object.freeze({flag: '--test-skip-pattern=exhaustive-recovery:', sweepsOnly: false}),
  recovery: Object.freeze({flag: '--test-name-pattern=exhaustive-recovery:', sweepsOnly: true}),
});

const SWEEP_MARKER = 'exhaustive-recovery:';
const OWNER_MARKER = 'lagrange-images-lab/v1';
const DEFAULT_DIR = '~/lab/lagrange-images';
const DEFAULT_COST_MS = 2000;
const SAFE_PATH = /^[~A-Za-z0-9_./-]+$/;
const SAFE_TEST_FILE = /^test\/[A-Za-z0-9_./-]+\.(?:c|m)?js$/;
const SAFE_NODE_NAME = /^[A-Za-z0-9_.-]+$/;
const SAFE_SSH = /^[A-Za-z0-9_.@:-]+$/;

// --- pure planning --------------------------------------------------------------------------

// node:test's default file set (Node 22), applied to repository-relative paths: `**/*.test.*`,
// `**/*-test.*`, `**/*_test.*`, `**/test-*.*`, `**/test.*` and everything under a `test/`
// directory, for .js/.cjs/.mjs, never under node_modules.
export function isDefaultTestFile(path) {
  if (!/\.(?:c|m)?js$/.test(path)) return false;
  const segments = path.split('/');
  if (segments.includes('node_modules')) return false;
  if (segments.slice(0, -1).includes('test')) return true;
  const base = segments.at(-1).replace(/\.(?:c|m)?js$/, '');
  return base === 'test' || base.startsWith('test-') || base.endsWith('.test') || base.endsWith('-test') || base.endsWith('_test');
}

// Workers from the Lagrange inventory plus this repository's per-node config and a live probe.
// `probes` maps node name -> {reachable, cores} from `probeWorkers`. Answers {workers, skipped}.
export function selectWorkers(inventory, config = {}, probes = {}, {only = null, exclude = [], speeds = {}} = {}) {
  const controllerBoot = inventory?.controller?.testCapability?.bootId ?? null;
  const controllerSample = inventory?.controller?.testCapability?.cpuSampleMs ?? null;
  const workers = [];
  const skipped = [];
  for (const node of Object.values(inventory?.nodes ?? {})) {
    const name = node.name;
    const perNode = config.nodes?.[name] ?? {};
    const skip = (reason) => skipped.push({name, reason});
    if (only && !only.includes(name)) continue;
    if (exclude.includes(name) || perNode.exclude) { skip('excluded by configuration'); continue; }
    if (!SAFE_NODE_NAME.test(name ?? '') || !SAFE_SSH.test(node.ssh ?? '')) { skip('unusable name or ssh target'); continue; }
    if ((node.os ?? 'linux') !== 'linux') { skip(`not linux (${node.os})`); continue; }
    if (!Array.isArray(node.roles) || !node.roles.includes('runner')) { skip('no runner role'); continue; }
    const capability = node.testCapability ?? {};
    if (controllerBoot && capability.bootId === controllerBoot) { skip('same machine as the controller'); continue; }
    // A node is used only on the strength of a probe made for this run: an inventory entry says
    // what a machine was, not that it answers now.
    const probe = probes[name];
    if (!probe) { skip('not probed'); continue; }
    if (!probe.reachable) { skip(`unreachable: ${probe.reason ?? 'ssh failed'}`); continue; }
    const cores = probe.cores ?? capability.cores ?? 2;
    // About a third of the logical cores. A test file is two processes plus V8's compiler and GC
    // threads, so it needs more than one core: measured on a 12-core worker, the whole ordinary lane
    // took 124 s at 11 slots, 116 s at 6 and 117 s at 4 — the machine saturates at about four files —
    // while the longest file went from 96 s at 4 slots to 123 s at 11 (49 s alone). More slots only
    // slow every file down, and the longest files decide the run.
    const slots = perNode.slots ?? Math.max(1, Math.round(cores / 3));
    // A worker's measured speed (see `learnSpeeds`) beats the probe's one-shot CPU sample, which
    // missed real finish times by 20-40 s on the first runs; the sample is only the prior for a
    // worker with no history yet.
    const learned = speeds[name]?.factor;
    const probed = controllerSample && capability.cpuSampleMs ? capability.cpuSampleMs / controllerSample : null;
    const speed = Number.isFinite(learned) && learned > 0 ? learned : probed ?? 1;
    const speedSource = Number.isFinite(learned) && learned > 0 ? 'learned' : probed ? 'probe' : 'default';
    const nodeBinDir = capability.nodePath ? dirname(capability.nodePath) : null;
    const dir = perNode.dir ?? config.defaultDir ?? DEFAULT_DIR;
    // Single-core speed, for placing the longest files: the probe's CPU sample is a single-threaded
    // measurement, which is what one long file needs. The learned factor is the wrong guide there —
    // it is measured at the worker's own concurrency, so a small machine running three files at a
    // time looks faster per file than a big one running eleven (measured: a 4-core machine with the
    // best learned factor, given the longest file, finished 70 s after the 12-core one).
    const singleThread = probed ?? speed;
    workers.push({name, ssh: node.ssh, dir, nodeBinDir, cores, slots, speed, speedSource, singleThread});
  }
  if (only) {
    for (const name of only) {
      if (!workers.some((worker) => worker.name === name) && !skipped.some((entry) => entry.name === name)) {
        skipped.push({name, reason: 'not in the Lagrange lab inventory'});
      }
    }
  }
  return {workers, skipped};
}

// Jobs are (lane, file) pairs. The recovery lane gets only files that name a sweep.
export function buildJobs({files, lanes, sweepFiles}) {
  const sweeps = new Set(sweepFiles);
  const jobs = [];
  for (const lane of lanes) {
    if (!LANES[lane]) throw new TypeError(`unknown lane: ${lane}`);
    for (const file of files) {
      if (LANES[lane].sweepsOnly && !sweeps.has(file)) continue;
      jobs.push({lane, file});
    }
  }
  return jobs;
}

// Gives every job an id and a cost in reference milliseconds (see `recordTimings`); a file with no
// recorded timing costs the median of its lane's recorded timings.
export function costJobs(jobs, timings = {}) {
  const medians = Object.fromEntries(Object.keys(LANES).map((lane) => {
    const known = Object.values(timings[lane] ?? {}).filter((value) => Number.isFinite(value)).sort((x, y) => x - y);
    return [lane, known.length ? known[Math.floor(known.length / 2)] : DEFAULT_COST_MS];
  }));
  return jobs.map((job, id) => ({...job, id, cost: timings[job.lane]?.[job.file] ?? medians[job.lane]}));
}

const byCostDescending = (x, y) => y.cost - x.cost || (x.lane + x.file < y.lane + y.file ? -1 : 1);

// The dispatch rules, as a pure state machine the controller drives and `simulateSchedule` replays.
// Jobs leave the queue longest first. Nothing is dispatched until `start()`, which deals the first
// wave round-robin — one job per ready worker per round, the worker with the fastest single core
// first (`singleThread`, see `selectWorkers`) — so the longest files are spread one to a machine and
// the very longest go to the fastest cores. (Measured: filling the fastest-looking worker's slots
// first gave a 4-core machine the three longest files at once, and it finished 60 s after everyone
// else.) After that a worker is topped up to
// `slots` whenever one of its files finishes, and one that becomes ready late joins on arrival. A
// worker that drops (a laptop leaving the network) loses its in-flight jobs; `requeue` puts each back
// at the front ONCE, to run on another worker, and the verdict notes it. A job lost a second time is
// abandoned and fails the run, so a file that takes machines down cannot hide behind a retry.
export class LabScheduler {
  constructor(jobs, workers) {
    this.queue = [...jobs].sort(byCostDescending);
    this.workers = new Map(workers.map((worker) => [worker.name, {worker, ready: false, alive: true, inFlight: new Map()}]));
    this.started = false;
  }

  markReady(name) {
    const state = this.workers.get(name);
    if (!state || !state.alive) return [];
    state.ready = true;
    return this.started ? this.fill(name) : [];
  }

  start() {
    this.started = true;
    const core = (state) => state.worker.singleThread ?? state.worker.speed;
    const ready = [...this.workers.values()].filter((state) => state.ready && state.alive)
      .sort((x, y) => core(x) - core(y) || (x.worker.name < y.worker.name ? -1 : 1));
    const assignments = new Map();
    let dealt = true;
    while (dealt && this.queue.length) {
      dealt = false;
      for (const state of ready) {
        if (state.inFlight.size >= state.worker.slots || !this.queue.length) continue;
        const job = this.queue.shift();
        state.inFlight.set(job.id, job);
        if (!assignments.has(state.worker.name)) assignments.set(state.worker.name, []);
        assignments.get(state.worker.name).push(job);
        dealt = true;
      }
    }
    return assignments;
  }

  fill(name) {
    const state = this.workers.get(name);
    const sent = [];
    if (!this.started || !state?.alive || !state.ready) return sent;
    while (state.inFlight.size < state.worker.slots && this.queue.length) {
      const job = this.queue.shift();
      state.inFlight.set(job.id, job);
      sent.push(job);
    }
    return sent;
  }

  complete(name, id) {
    const state = this.workers.get(name);
    if (!state?.inFlight.delete(id)) return [];
    return this.fill(name);
  }

  drop(name) {
    const state = this.workers.get(name);
    if (!state) return [];
    state.alive = false;
    const lost = [...state.inFlight.values()];
    state.inFlight.clear();
    return lost;
  }

  requeue(jobs) {
    const requeued = [];
    const abandoned = [];
    for (const job of jobs) {
      if ((job.attempt ?? 1) >= 2) { abandoned.push(job); continue; }
      requeued.push({...job, attempt: 2});
    }
    this.queue = [...requeued, ...this.queue].sort(byCostDescending);
    return {requeued, abandoned};
  }

  // Fills every ready worker, for when work reappears (a requeue) rather than when a slot frees.
  fillAll() {
    const assignments = new Map();
    for (const name of this.workers.keys()) {
      const sent = this.fill(name);
      if (sent.length) assignments.set(name, sent);
    }
    return assignments;
  }

  idle(name) {
    const state = this.workers.get(name);
    return Boolean(state && state.inFlight.size === 0);
  }

  get inFlight() {
    let total = 0;
    for (const state of this.workers.values()) total += state.inFlight.size;
    return total;
  }

  get remaining() {
    return this.queue.length;
  }
}

// Replays the dispatch rules with each job taking cost * speed on the worker it lands on, to predict
// each worker's finish time and the whole run's. The prediction is a report, not a plan: the real
// run dispatches by what actually finishes.
export function simulateSchedule(jobs, workers) {
  if (workers.length === 0) throw new Error('no usable lab workers');
  const scheduler = new LabScheduler(jobs, workers);
  for (const worker of workers) scheduler.markReady(worker.name);
  const speedOf = new Map(workers.map((worker) => [worker.name, worker.speed]));
  const finish = new Map(workers.map((worker) => [worker.name, 0]));
  const counts = new Map(workers.map((worker) => [worker.name, 0]));
  const events = [];
  const launch = (name, list, now) => {
    for (const job of list) {
      events.push({at: now + job.cost * speedOf.get(name), name, id: job.id});
      counts.set(name, counts.get(name) + 1);
    }
  };
  for (const [name, list] of scheduler.start()) launch(name, list, 0);
  while (events.length) {
    events.sort((x, y) => x.at - y.at);
    const event = events.shift();
    finish.set(event.name, Math.max(finish.get(event.name), event.at));
    launch(event.name, scheduler.complete(event.name, event.id), event.at);
  }
  return {
    makespanMs: Math.round(Math.max(0, ...finish.values())),
    workers: Object.fromEntries(workers.map((worker) => [worker.name, {jobs: counts.get(worker.name), finishMs: Math.round(finish.get(worker.name))}])),
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The bash program one worker runs: guard the checkout directory, take the worker's lock, clean the
// directory, install the driver and hand the session's stdin to it. Everything it interpolates is
// validated against a closed character set first; the driver source travels base64-encoded.
export function renderRemoteScript({dir, nodeBinDir, driverSource, lockWaitSeconds = 900}) {
  if (!SAFE_PATH.test(dir) || dir.split('/').filter(Boolean).at(-1) !== 'lagrange-images' || dir.split('/').filter(Boolean).length < 2) {
    throw new TypeError(`lab checkout directory must be a plain path ending in /lagrange-images: ${dir}`);
  }
  if (nodeBinDir !== null && !SAFE_PATH.test(nodeBinDir)) throw new TypeError(`unusable node directory: ${nodeBinDir}`);
  if (typeof driverSource !== 'string' || driverSource.length === 0) throw new TypeError('driverSource must be the worker driver\'s source text');
  const expandedDir = dir.startsWith('~/') ? `"$HOME"/${shellQuote(dir.slice(2))}` : shellQuote(dir);
  const driver = Buffer.from(driverSource, 'utf8').toString('base64');
  return `set -u
DIR=${expandedDir}
emit() { printf 'LAB %s\\n' "$1"; }
if [ -e "$DIR" ] && [ ! -f "$DIR/.lab/owner" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  emit '{"t":"error","reason":"checkout directory is not empty and is not a lab checkout"}'; exit 70
fi
mkdir -p "$DIR/.lab" || { emit '{"t":"error","reason":"cannot create checkout directory"}'; exit 70; }
printf '%s\\n' ${shellQuote(OWNER_MARKER)} > "$DIR/.lab/owner"
exec 9>"$DIR/.lab/lock"
if ! flock -w ${Number(lockWaitSeconds)} 9; then emit '{"t":"error","reason":"another lab run holds this worker"}'; exit 75; fi
cd "$DIR" || exit 70
find . -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .lab -exec rm -rf {} +
printf '%s' ${shellQuote(driver)} | base64 -d > .lab/driver.mjs || { emit '{"t":"error","reason":"cannot install the driver"}'; exit 70; }
${nodeBinDir ? `export PATH=${shellQuote(nodeBinDir)}:"$PATH"` : ':'}
exec node .lab/driver.mjs
`;
}

export function parseLabLine(text) {
  if (!text.startsWith('LAB ')) return null;
  try { return JSON.parse(text.slice(4)); } catch { return null; }
}

// Folds every worker's session into one verdict. Every dispatched job must report `done` somewhere;
// a job lost with its worker and not re-run to completion elsewhere, a file that exited non-zero
// without reporting a failure (a crash), an error from any worker, or a job never dispatched at all
// fails the run: a missing result is not a pass. A worker that never became ready took no jobs, and
// a lost file that was re-run to completion on another worker, are only noted.
export function aggregate(sessions, {undispatched = []} = {}) {
  const totals = {};
  const failures = [];
  const problems = [];
  const notes = [];
  const fileMs = {};
  const doneAnywhere = new Set();
  for (const {facts} of sessions) for (const fact of facts) if (fact.t === 'done') doneAnywhere.add(fact.id);
  for (const {name, facts, dispatched = [], sshCode} of sessions) {
    const done = new Map();
    const failedFiles = new Set();
    let ready = false;
    for (const fact of facts) {
      if (fact.t === 'summary') {
        totals[fact.lane] ??= {};
        totals[fact.lane][fact.key] = (totals[fact.lane][fact.key] ?? 0) + (fact.key === 'duration_ms' ? 0 : fact.value);
      } else if (fact.t === 'result') {
        if (fact.status === 'fail') {
          failures.push({worker: name, ...fact});
          if (fact.file) failedFiles.add(`${fact.lane}\u0000${relativeTestPath(fact.file)}`);
        }
        // Sweeps are counted by name: node reports a file with no matching test as one empty
        // entry, so the recovery lane's raw `tests` count mostly counts files, not sweeps.
        if (fact.nesting === 0 && typeof fact.name === 'string' && fact.name.startsWith(SWEEP_MARKER)) {
          totals[fact.lane] ??= {};
          totals[fact.lane].sweeps = (totals[fact.lane].sweeps ?? 0) + 1;
        }
      } else if (fact.t === 'done') {
        done.set(fact.id, fact);
        if (Number.isFinite(fact.ms)) {
          fileMs[fact.lane] ??= {};
          fileMs[fact.lane][fact.file] = {ms: fact.ms, worker: name};
        }
      } else if (fact.t === 'ready') {
        ready = true;
      } else if (fact.t === 'error') {
        problems.push(`${name}: ${fact.reason}`);
      }
    }
    if (!ready && dispatched.length === 0) notes.push(`${name}: never became ready (ssh exit ${sshCode}); it took no files`);
    for (const job of dispatched) {
      const fact = done.get(job.id);
      if (!fact && doneAnywhere.has(job.id)) notes.push(`${name}: [${job.lane}] ${job.file} was lost when the worker dropped (ssh exit ${sshCode}) and re-run on another worker`);
      else if (!fact) problems.push(`${name}: [${job.lane}] ${job.file} never finished (ssh exit ${sshCode})`);
      else if (fact.code !== 0 && !failedFiles.has(`${job.lane}\u0000${job.file}`)) {
        problems.push(`${name}: [${job.lane}] ${job.file} exited ${fact.code} without a reported failure${fact.stderr ? `: ${fact.stderr.split('\n').slice(-3).join(' | ')}` : ''}`);
      }
    }
  }
  if (undispatched.length) problems.push(`${undispatched.length} file(s) were never dispatched: no worker was left to run them`);
  const fail = Object.values(totals).reduce((sum, lane) => sum + (lane.fail ?? 0) + (lane.cancelled ?? 0), 0);
  return {totals, failures, problems, notes, fileMs, ok: problems.length === 0 && fail === 0 && failures.length === 0};
}

function relativeTestPath(file) {
  const at = file.lastIndexOf('/test/');
  return at === -1 ? file : file.slice(at + 1);
}

// Timings are stored in controller-milliseconds (a worker's wall time divided by its relative
// speed) and smoothed, so plans improve run over run without one noisy run dominating.
export function recordTimings(timings, fileMs, workersByName) {
  const next = structuredClone(timings);
  for (const [lane, entries] of Object.entries(fileMs)) {
    next[lane] ??= {};
    for (const [file, {ms, worker: name}] of Object.entries(entries)) {
      const worker = workersByName.get(name);
      const normalized = ms / (worker?.speed ?? 1);
      const previous = next[lane][file];
      next[lane][file] = Math.round(Number.isFinite(previous) ? previous * 0.5 + normalized * 0.5 : normalized);
    }
  }
  return next;
}

// A worker's speed, learned from its own run: for every file it ran that already had a stored
// timing of at least MIN_LEARNING_COST_MS (smaller files are dominated by process start-up), the
// ratio of its measured time to that stored reference time; the median of those ratios, smoothed
// with the previous estimate. Fewer than MIN_LEARNING_SAMPLES usable files leaves the estimate
// alone. Learning runs against the timings as they were BEFORE this run, and `recordTimings` then
// normalizes this run's times with the updated speeds, so the two stay on one reference scale: a
// worker whose measurements agree with the stored times keeps its factor, and the stored times keep
// their median.
const MIN_LEARNING_COST_MS = 1000;
const MIN_LEARNING_SAMPLES = 3;

export function learnSpeeds(speeds, timings, fileMs, {now = new Date().toISOString()} = {}) {
  const ratios = new Map();
  for (const [lane, entries] of Object.entries(fileMs)) {
    for (const [file, {ms, worker}] of Object.entries(entries)) {
      const reference = timings[lane]?.[file];
      if (!Number.isFinite(reference) || reference < MIN_LEARNING_COST_MS || !Number.isFinite(ms) || ms <= 0) continue;
      if (!ratios.has(worker)) ratios.set(worker, []);
      ratios.get(worker).push(ms / reference);
    }
  }
  const next = structuredClone(speeds);
  for (const [worker, list] of ratios) {
    if (list.length < MIN_LEARNING_SAMPLES) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const observed = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    const previous = next[worker]?.factor;
    const factor = Number.isFinite(previous) && previous > 0 ? previous * 0.5 + observed * 0.5 : observed;
    next[worker] = {factor: Math.round(factor * 1000) / 1000, observed: Math.round(observed * 1000) / 1000, samples: list.length, updatedAt: now};
  }
  return next;
}

// What one run teaches: speeds learned against the timings as they stood BEFORE the run, then this
// run's times normalized with those updated speeds. The order matters — normalizing with the old
// speed would write a slow worker's inflated times into the reference and teach every later plan
// the wrong costs.
export function updateLearning({speeds, timings, fileMs, workers, now}) {
  const nextSpeeds = learnSpeeds(speeds, timings, fileMs, now === undefined ? {} : {now});
  const byName = new Map(workers.map((worker) => [worker.name, {...worker, speed: nextSpeeds[worker.name]?.factor ?? worker.speed}]));
  return {speeds: nextSpeeds, timings: recordTimings(timings, fileMs, byName)};
}

// --- effects ---------------------------------------------------------------------------------

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, options = {}) => execFileSync('git', args, {cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options}).trim();

// HEAD plus the working tree, as a tree object, through a throwaway index.
function snapshotTree() {
  const index = join(tmpdir(), `lagrange-images-lab-index-${process.pid}`);
  const env = {...process.env, GIT_INDEX_FILE: index};
  try {
    git(['read-tree', 'HEAD'], {env});
    git(['add', '-A'], {env});
    // A worktree's node_modules is often a symlink, which `node_modules/` in .gitignore does not
    // match; it must never ship.
    git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', 'node_modules'], {env});
    const tree = git(['write-tree'], {env});
    const headTree = git(['rev-parse', 'HEAD^{tree}']);
    return {tree, head: git(['rev-parse', 'HEAD']), dirty: tree !== headTree};
  } finally {
    rm(index, {force: true}).catch(() => {});
  }
}

function listTestFiles(tree) {
  return git(['ls-tree', '-r', '--name-only', tree]).split('\n').filter(Boolean).filter(isDefaultTestFile).sort();
}

function listSweepFiles(tree) {
  let out = '';
  try { out = git(['grep', '-l', '-F', SWEEP_MARKER, tree, '--', 'test']); } catch (error) { if (error.status !== 1) throw error; }
  return out.split('\n').filter(Boolean).map((line) => line.slice(line.indexOf(':') + 1));
}

function sshArgs(target, command) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', target, command];
}

async function probeWorkers(inventory) {
  const entries = Object.values(inventory?.nodes ?? {}).filter((node) => SAFE_SSH.test(node.ssh ?? ''));
  const results = await Promise.all(entries.map((node) => new Promise((done) => {
    const child = spawn('ssh', sshArgs(node.ssh, 'nproc'), {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const cores = Number.parseInt(out.trim(), 10);
      done([node.name, code === 0 && Number.isInteger(cores)
        ? {reachable: true, cores}
        : {reachable: false, reason: err.trim().split('\n').at(-1) || `ssh exit ${code}`}]);
    });
  })));
  return Object.fromEntries(results);
}

// One worker's session: the snapshot first, then job commands as the scheduler releases them.
function openSession(worker, {tarBuffer, driverSource, onFact, onClose}) {
  const script = renderRemoteScript({dir: worker.dir, nodeBinDir: worker.nodeBinDir, driverSource});
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const ssh = spawn('ssh', sshArgs(worker.ssh, `bash -c "$(printf %s ${encoded} | base64 -d)"`), {stdio: ['pipe', 'pipe', 'pipe']});
  const facts = [];
  let buffer = '';
  let stderr = '';
  let ended = false;
  ssh.stdin.on('error', () => {});
  ssh.stdin.write(`TAR ${tarBuffer.length}\n`);
  ssh.stdin.write(tarBuffer);
  ssh.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const fact = parseLabLine(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (fact) { facts.push(fact); onFact(worker.name, fact); }
    }
  });
  ssh.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  ssh.on('close', (code) => onClose(worker.name, code, stderr));
  return {
    facts,
    send(job) { ssh.stdin.write(`${JSON.stringify({run: {id: job.id, lane: job.lane, file: job.file}})}\n`); },
    end() { if (ended) return; ended = true; ssh.stdin.write('{"end":true}\n'); ssh.stdin.end(); },
    get ended() { return ended; },
    kill() { ssh.kill('SIGKILL'); },
  };
}

// Drives the scheduler from the sessions' facts until every session has closed.
function runSessions({workers, jobs, tarBuffer, driverSource, timeoutMs, startWaitMs = 20_000, log}) {
  return new Promise((finish) => {
    const scheduler = new LabScheduler(jobs, workers);
    const started = Date.now();
    const sessions = new Map();
    const dispatched = new Map(workers.map((worker) => [worker.name, []]));
    const finishedAt = new Map();
    const sshCodes = new Map();
    const open = new Set(workers.map((worker) => worker.name));
    let startTimer = null;
    const send = (name, list) => {
      for (const job of list) {
        dispatched.get(name).push(job);
        sessions.get(name).send(job);
      }
    };
    const beginIfDue = () => {
      if (scheduler.started) return;
      const alive = [...scheduler.workers.values()].filter((state) => state.alive);
      if (alive.length && alive.every((state) => state.ready)) begin();
    };
    const begin = () => {
      if (scheduler.started) return;
      clearTimeout(startTimer);
      for (const [name, list] of scheduler.start()) send(name, list);
      settle();
    };
    // Once the queue is empty and nothing is in flight anywhere, every worker is told to finish and a
    // worker that never became ready is not waited for. Idle workers stay connected until then,
    // because a worker that drops puts its files back on the queue.
    const settle = () => {
      if (!scheduler.started || scheduler.remaining > 0 || scheduler.inFlight > 0) return;
      for (const [name, state] of scheduler.workers) {
        const session = sessions.get(name);
        if (!state.alive || !session || session.ended) continue;
        if (!state.ready) { session.kill(); continue; }
        session.end();
      }
    };
    const onFact = (name, fact) => {
      const at = `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`;
      if (fact.t === 'ready') {
        log(`${at} ${name.padEnd(16)} ready`);
        send(name, scheduler.markReady(name));
        if (!scheduler.started && !startTimer) startTimer = setTimeout(begin, startWaitMs);
        beginIfDue();
      } else if (fact.t === 'done') {
        // A worker's finish is its last completed file, not its session's end: idle workers stay
        // connected until nothing is in flight anywhere (see `settle`).
        finishedAt.set(name, Date.now() - started);
        send(name, scheduler.complete(name, fact.id));
        settle();
      } else if (fact.t === 'phase' && fact.phase === 'npm-ci') {
        log(`${at} ${name.padEnd(16)} npm ci`);
      } else if (fact.t === 'error') {
        log(`${at} ${name.padEnd(16)} ERROR ${fact.reason}`);
      } else if (fact.t === 'result' && fact.status === 'fail') {
        log(`${at} ${name.padEnd(16)} not ok ${fact.name}`);
      }
    };
    const onClose = (name, code, stderr) => {
      open.delete(name);
      sshCodes.set(name, code);
      const lost = scheduler.drop(name);
      if (lost.length || (code !== 0 && code !== null)) {
        log(`     ${name.padEnd(16)} closed (ssh exit ${code})${lost.length ? `, ${lost.length} file(s) lost` : ''}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`);
      }
      if (lost.length && scheduler.started) {
        const {requeued, abandoned} = scheduler.requeue(lost);
        if (requeued.length) log(`     ${name.padEnd(16)} ${requeued.length} file(s) put back on the queue`);
        if (abandoned.length) log(`     ${name.padEnd(16)} ${abandoned.length} file(s) lost a second time, not retried`);
        for (const [target, list] of scheduler.fillAll()) send(target, list);
      }
      beginIfDue();
      settle();
      if (open.size === 0) {
        clearTimeout(timer);
        clearTimeout(startTimer);
        finish({
          sessions: workers.map((worker) => ({
            name: worker.name, facts: sessions.get(worker.name).facts, dispatched: dispatched.get(worker.name),
            finishedMs: finishedAt.get(worker.name) ?? null, sshCode: sshCodes.get(worker.name) ?? null,
          })),
          undispatched: [...scheduler.queue],
          wallMs: Date.now() - started,
        });
      }
    };
    const timer = setTimeout(() => {
      log(`     timed out after ${Math.round(timeoutMs / 1000)}s`);
      for (const session of sessions.values()) session.kill();
    }, timeoutMs);
    for (const worker of workers) sessions.set(worker.name, openSession(worker, {tarBuffer, driverSource, onFact, onClose}));
  });
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const options = {lanes: Object.keys(LANES), only: null, exclude: [], dryRun: false, receipt: null, files: [], timeoutMs: 30 * 60_000};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => { const next = argv[index += 1]; if (next === undefined) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--lanes') options.lanes = value().split(',').filter(Boolean);
    else if (arg === '--nodes') options.only = value().split(',').filter(Boolean);
    else if (arg === '--exclude') options.exclude = value().split(',').filter(Boolean);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--receipt') options.receipt = value();
    else if (arg === '--timeout-minutes') options.timeoutMs = Number(value()) * 60_000;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg.replace(/^\.\//, ''));
  }
  for (const lane of options.lanes) if (!LANES[lane]) throw new Error(`unknown lane ${lane}; lanes are ${Object.keys(LANES).join(', ')}`);
  return options;
}

const HELP = `usage: node scripts/lab-suite.mjs [test files...] [--lanes fast,recovery] [--nodes a,b]
                                 [--exclude a,b] [--dry-run] [--receipt path] [--timeout-minutes n]
Runs the CI lanes across the Lagrange lab workers. See docs/runbook.md, "Running the suite on the lab".`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${HELP}\n`); return 0; }
  const labHome = process.env.LAGRANGE_LAB_HOME ?? join(homedir(), '.config', 'lagrange', 'lab');
  const inventory = await readJson(join(labHome, 'inventory.json'), null);
  if (!inventory) throw new Error(`no Lagrange lab inventory at ${labHome}/inventory.json (see the Lagrange repository's docs/development/home-lab.md)`);
  const configPath = process.env.LAGRANGE_IMAGES_LAB_CONFIG ?? join(homedir(), '.config', 'lagrange-images', 'lab.json');
  const config = await readJson(configPath, {});
  const cacheDir = join(homedir(), '.cache', 'lagrange-images');
  const timingsPath = join(cacheDir, 'lab-timings.json');
  const timings = await readJson(timingsPath, {});
  const speedsPath = join(cacheDir, 'lab-speeds.json');
  const speeds = await readJson(speedsPath, {});

  const snapshot = snapshotTree();
  let files = listTestFiles(snapshot.tree);
  if (options.files.length) {
    const unknown = options.files.filter((file) => !files.includes(file));
    if (unknown.length) throw new Error(`not test files in this tree: ${unknown.join(', ')}`);
    files = options.files;
  }
  const sweepFiles = listSweepFiles(snapshot.tree);
  const jobs = buildJobs({files, lanes: options.lanes, sweepFiles});

  const probes = await probeWorkers(inventory);
  const {workers, skipped} = selectWorkers(inventory, config, probes, {only: options.only, exclude: options.exclude, speeds});
  for (const {name, reason} of skipped) process.stdout.write(`skip  ${name}: ${reason}\n`);
  if (workers.length === 0) throw new Error('no usable lab workers');
  const costed = costJobs(jobs, timings);
  const prediction = simulateSchedule(costed, workers);
  process.stdout.write(`tree  ${snapshot.tree}${snapshot.dirty ? ` (HEAD ${snapshot.head.slice(0, 12)} + working tree)` : ` (HEAD ${snapshot.head.slice(0, 12)})`}\n`);
  process.stdout.write(`jobs  ${costed.length} (${options.lanes.map((lane) => `${lane} ${costed.filter((job) => job.lane === lane).length}`).join(', ')}), predicted ${Math.round(prediction.makespanMs / 1000)}s\n`);
  for (const worker of workers) {
    const predicted = prediction.workers[worker.name];
    process.stdout.write(`plan  ${worker.name.padEnd(16)} slots ${String(worker.slots).padStart(2)}  speed ${worker.speed.toFixed(2)} (${worker.speedSource})  ~${predicted.jobs} files  est ${Math.round(predicted.finishMs / 1000)}s  ${worker.dir}\n`);
  }
  if (options.dryRun) return 0;

  const tarBuffer = execFileSync('git', ['archive', '--format=tar', snapshot.tree], {cwd: REPO, maxBuffer: 1024 * 1024 * 1024});
  const driverSource = git(['show', `${snapshot.tree}:scripts/lab-suite-worker.mjs`]);
  const run = await runSessions({
    workers, jobs: costed, tarBuffer, driverSource, timeoutMs: options.timeoutMs,
    log: (text) => process.stdout.write(`${text}\n`),
  });
  const verdict = aggregate(run.sessions, {undispatched: run.undispatched});

  await mkdir(cacheDir, {recursive: true});
  const learned = updateLearning({speeds, timings, fileMs: verdict.fileMs, workers});
  await writeFile(speedsPath, `${JSON.stringify(learned.speeds, null, 1)}\n`);
  await writeFile(timingsPath, `${JSON.stringify(learned.timings, null, 1)}\n`);
  const receipt = {
    format: 'lagrange-images-lab-receipt/v2', tree: snapshot.tree, head: snapshot.head, dirty: snapshot.dirty,
    lanes: options.lanes, files: options.files.length ? files : 'default', startedAt: new Date(Date.now() - run.wallMs).toISOString(),
    wallMs: run.wallMs, predictedMs: prediction.makespanMs,
    workers: run.sessions.map(({name, dispatched, finishedMs}) => {
      const worker = workers.find((entry) => entry.name === name);
      return {
        name, slots: worker.slots, speed: worker.speed, speedSource: worker.speedSource,
        learnedSpeed: learned.speeds[name]?.factor ?? null,
        files: dispatched.length, predictedFiles: prediction.workers[name].jobs,
        estimatedMs: prediction.workers[name].finishMs, actualMs: finishedMs,
      };
    }),
    // Every file's measured wall time on the worker that ran it, longest first: the evidence for
    // why a run took as long as it did.
    fileTimes: Object.entries(verdict.fileMs).flatMap(([lane, entries]) => Object.entries(entries)
      .map(([file, {ms, worker}]) => ({lane, file, worker, ms}))).sort((x, y) => y.ms - x.ms),
    totals: verdict.totals, problems: verdict.problems, notes: verdict.notes,
    failures: verdict.failures.map(({worker, lane, file, name, error}) => ({worker, lane, file: file && relativeTestPath(file), name, error})),
    ok: verdict.ok,
  };
  const receiptPath = options.receipt ?? join(cacheDir, 'lab-receipts', `${receipt.startedAt.replace(/[:.]/g, '-')}.json`);
  await mkdir(dirname(receiptPath), {recursive: true});
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 1)}\n`);

  for (const failure of receipt.failures) {
    process.stdout.write(`FAIL  [${failure.lane}] ${failure.file ?? '?'} :: ${failure.name}\n      ${(failure.error?.message ?? '').split('\n').slice(0, 4).join('\n      ')}\n`);
  }
  for (const problem of verdict.problems) process.stdout.write(`PROBLEM ${problem}\n`);
  for (const note of verdict.notes) process.stdout.write(`note  ${note}\n`);
  for (const entry of receipt.workers) {
    const seconds = (ms) => (ms === null ? '   -' : String(Math.round(ms / 1000)).padStart(4));
    process.stdout.write(`time  ${entry.name.padEnd(16)} files ${String(entry.files).padStart(3)} (est ${String(entry.predictedFiles).padStart(3)})  finished ${seconds(entry.actualMs)}s (est ${seconds(entry.estimatedMs)}s)  speed ${entry.speed.toFixed(2)} (${entry.speedSource}) -> ${entry.learnedSpeed?.toFixed(2) ?? 'unchanged'}\n`);
  }
  for (const [lane, counts] of Object.entries(verdict.totals)) {
    const sweeps = lane === 'recovery' ? ` (sweeps ${counts.sweeps ?? 0})` : '';
    process.stdout.write(`# lane ${lane}: tests ${counts.tests ?? 0}${sweeps} pass ${counts.pass ?? 0} fail ${counts.fail ?? 0} cancelled ${counts.cancelled ?? 0} skipped ${counts.skipped ?? 0} todo ${counts.todo ?? 0}\n`);
  }
  const fail = Object.values(verdict.totals).reduce((sum, lane) => sum + (lane.fail ?? 0), 0);
  process.stdout.write(`# fail ${fail}\n# wall ${Math.round(run.wallMs / 1000)}s (predicted ${Math.round(prediction.makespanMs / 1000)}s)\n# receipt ${receiptPath}\nEXIT=${verdict.ok ? 0 : 1}\n`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`lab-suite: ${error.message}\n`);
    process.exitCode = 2;
  });
}

export {main};
