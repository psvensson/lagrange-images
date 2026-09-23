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
// recovery:`, over node's own default test-file set. The only difference is that the file set is
// split across machines. The recovery lane is given only the files whose source names a sweep
// (`test/ci-split.test.js` requires every sweep to carry the prefix literally), which is what makes
// its per-worker runs cheap. Env-gated real-lane tests skip on workers exactly as they do in the
// ordinary CI lanes, because no LAGRANGE_* integration variable is set there.
//
// WHAT IT SHIPS. The working tree as it is — HEAD plus uncommitted and untracked-but-not-ignored
// files — snapshotted into a git tree object through a temporary index (the real index is never
// touched), streamed with `git archive` into the worker's checkout directory under a `flock`, with
// `npm ci --ignore-scripts` only when the lockfile changed. So a branch can be tested before it is
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
export function selectWorkers(inventory, config = {}, probes = {}, {only = null, exclude = []} = {}) {
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
    const slots = perNode.slots ?? Math.max(1, cores - 1);
    const speed = controllerSample && capability.cpuSampleMs ? capability.cpuSampleMs / controllerSample : 1;
    const nodeBinDir = capability.nodePath ? dirname(capability.nodePath) : null;
    const dir = perNode.dir ?? config.defaultDir ?? DEFAULT_DIR;
    workers.push({name, ssh: node.ssh, dir, nodeBinDir, cores, slots, speed});
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

// Longest-processing-time assignment. A worker runs its lanes one after the other, and within a
// lane the files run `slots` at a time, so a worker's estimated finish is the sum over its lanes of
// max(assigned work / slots, its longest single file) — a file cannot be split, and the two long
// poles of different lanes must not land on the same worker. Jobs in descending cost go to the
// worker whose estimated finish would be earliest after taking the job. Costs are in
// controller-milliseconds (see `recordTimings`), scaled by each worker's relative speed; files with
// no recorded timing cost the median of that lane's recorded timings.
export function planShards(jobs, workers, timings = {}) {
  if (workers.length === 0) throw new Error('no usable lab workers');
  const medians = Object.fromEntries(Object.keys(LANES).map((lane) => {
    const known = Object.values(timings[lane] ?? {}).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    return [lane, known.length ? known[Math.floor(known.length / 2)] : DEFAULT_COST_MS];
  }));
  const costed = jobs.map((job) => ({...job, cost: timings[job.lane]?.[job.file] ?? medians[job.lane]}))
    .sort((a, b) => b.cost - a.cost || (a.lane + a.file < b.lane + b.file ? -1 : 1));
  const shards = workers.map((worker) => ({worker, jobs: [], lanes: {}}));
  const finish = (shard, extra = null) => Object.keys(LANES).reduce((total, lane) => {
    const state = shard.lanes[lane] ?? {load: 0, longest: 0};
    let {load, longest} = state;
    if (extra && extra.lane === lane) {
      load += extra.scaled;
      longest = Math.max(longest, extra.scaled);
    }
    return total + (load === 0 ? 0 : Math.max(load / shard.worker.slots, longest));
  }, 0);
  for (const job of costed) {
    let best = null;
    let bestFinish = Infinity;
    for (const shard of shards) {
      const candidate = finish(shard, {lane: job.lane, scaled: job.cost * shard.worker.speed});
      if (candidate < bestFinish) { bestFinish = candidate; best = shard; }
    }
    const scaled = job.cost * best.worker.speed;
    const state = best.lanes[job.lane] ??= {load: 0, longest: 0};
    state.load += scaled;
    state.longest = Math.max(state.longest, scaled);
    best.jobs.push(job);
  }
  return shards.map((shard) => ({
    worker: shard.worker,
    lanes: Object.fromEntries(Object.keys(LANES).map((lane) => [lane, shard.jobs.filter((job) => job.lane === lane).map((job) => job.file).sort()])),
    estimatedMs: Math.round(finish(shard)),
  }));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The bash program one worker runs, with the snapshot tar on stdin. Everything it interpolates is
// validated against a closed character set first.
export function renderRemoteScript({dir, nodeBinDir, slots, lanes, lockWaitSeconds = 900}) {
  if (!SAFE_PATH.test(dir) || dir.split('/').filter(Boolean).at(-1) !== 'lagrange-images' || dir.split('/').filter(Boolean).length < 2) {
    throw new TypeError(`lab checkout directory must be a plain path ending in /lagrange-images: ${dir}`);
  }
  if (nodeBinDir !== null && !SAFE_PATH.test(nodeBinDir)) throw new TypeError(`unusable node directory: ${nodeBinDir}`);
  if (!Number.isInteger(slots) || slots < 1 || slots > 256) throw new TypeError(`slots must be an integer 1..256: ${slots}`);
  const laneCalls = [];
  for (const [lane, files] of Object.entries(lanes)) {
    if (!LANES[lane]) throw new TypeError(`unknown lane: ${lane}`);
    for (const file of files) if (!SAFE_TEST_FILE.test(file)) throw new TypeError(`unusable test file path: ${file}`);
    if (files.length) laneCalls.push(`run_lane ${lane} ${shellQuote(LANES[lane].flag)} ${files.map(shellQuote).join(' ')}`);
  }
  const expandedDir = dir.startsWith('~/') ? `"$HOME"/${shellQuote(dir.slice(2))}` : shellQuote(dir);
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
if ! tar -xf -; then emit '{"t":"error","reason":"snapshot extraction failed"}'; exit 71; fi
${nodeBinDir ? `export PATH=${shellQuote(nodeBinDir)}:"$PATH"` : ':'}
emit "{\\"t\\":\\"phase\\",\\"phase\\":\\"extracted\\",\\"node\\":\\"$(node --version 2>/dev/null)\\"}"
lock=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$(cat .lab/lock.sha 2>/dev/null)" != "$lock" ]; then
  emit '{"t":"phase","phase":"npm-ci"}'
  if ! nice -n 10 npm ci --ignore-scripts --no-audit --no-fund > .lab/npm-ci.log 2>&1; then
    tail -n 20 .lab/npm-ci.log >&2; emit '{"t":"error","reason":"npm ci failed"}'; exit 72
  fi
  printf '%s\\n' "$lock" > .lab/lock.sha
fi
status=0
run_lane() {
  lane=$1; flag=$2; shift 2
  emit "{\\"t\\":\\"phase\\",\\"phase\\":\\"lane\\",\\"lane\\":\\"$lane\\",\\"files\\":$#}"
  LAB_LANE=$lane nice -n 10 node --test --test-concurrency=${slots} "$flag" --test-reporter=./scripts/lab-suite-reporter.mjs "$@"
  code=$?
  emit "{\\"t\\":\\"exit\\",\\"lane\\":\\"$lane\\",\\"code\\":$code}"
  [ "$code" -ne 0 ] && status=1
  return 0
}
${laneCalls.join('\n')}
exit $status
`;
}

export function parseLabLine(text) {
  if (!text.startsWith('LAB ')) return null;
  try { return JSON.parse(text.slice(4)); } catch { return null; }
}

// Folds every worker's facts into one verdict. A worker that never reported an exit for a lane it
// was given, or that reported an error, fails the run: a missing shard is not a passing shard.
export function aggregate(shardResults) {
  const totals = {};
  const failures = [];
  const problems = [];
  const fileMs = {};
  for (const {plan, facts, sshCode} of shardResults) {
    const name = plan.worker.name;
    const exits = {};
    for (const fact of facts) {
      if (fact.t === 'summary') {
        totals[fact.lane] ??= {};
        totals[fact.lane][fact.key] = (totals[fact.lane][fact.key] ?? 0) + (fact.key === 'duration_ms' ? 0 : fact.value);
      } else if (fact.t === 'result') {
        if (fact.status === 'fail') failures.push({worker: name, ...fact});
        // Sweeps are counted by name: node reports a file with no matching test as one empty
        // entry, so the recovery lane's raw `tests` count mostly counts files, not sweeps.
        if (fact.nesting === 0 && typeof fact.name === 'string' && fact.name.startsWith(SWEEP_MARKER)) {
          totals[fact.lane] ??= {};
          totals[fact.lane].sweeps = (totals[fact.lane].sweeps ?? 0) + 1;
        }
        if (fact.nesting === 0 && fact.file && Number.isFinite(fact.ms)) {
          const file = relativeTestPath(fact.file);
          fileMs[fact.lane] ??= {};
          const entry = fileMs[fact.lane][file] ??= {ms: 0, worker: name};
          entry.ms += fact.ms;
        }
      } else if (fact.t === 'exit') {
        exits[fact.lane] = fact.code;
      } else if (fact.t === 'error') {
        problems.push(`${name}: ${fact.reason}`);
      }
    }
    for (const [lane, files] of Object.entries(plan.lanes)) {
      if (files.length === 0) continue;
      if (!(lane in exits)) problems.push(`${name}: lane ${lane} never finished (ssh exit ${sshCode})`);
      else if (exits[lane] !== 0) problems.push(`${name}: lane ${lane} exited ${exits[lane]}`);
    }
  }
  const fail = Object.values(totals).reduce((sum, lane) => sum + (lane.fail ?? 0) + (lane.cancelled ?? 0), 0);
  return {totals, failures, problems, fileMs, ok: problems.length === 0 && fail === 0 && failures.length === 0};
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

function runShard(plan, tree, {onFact, onLog, timeoutMs}) {
  const script = renderRemoteScript({dir: plan.worker.dir, nodeBinDir: plan.worker.nodeBinDir, slots: plan.worker.slots, lanes: plan.lanes});
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const command = `bash -c "$(printf %s ${encoded} | base64 -d)"`;
  return new Promise((done) => {
    const facts = [];
    const archive = spawn('git', ['archive', '--format=tar', tree], {cwd: REPO, stdio: ['ignore', 'pipe', 'inherit']});
    const ssh = spawn('ssh', sshArgs(plan.worker.ssh, command), {stdio: ['pipe', 'pipe', 'pipe']});
    archive.stdout.pipe(ssh.stdin);
    const timer = setTimeout(() => { onLog(`${plan.worker.name}: timed out after ${timeoutMs / 1000}s`); ssh.kill('SIGKILL'); }, timeoutMs);
    let buffer = '';
    ssh.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const text = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const fact = parseLabLine(text);
        if (fact) { facts.push(fact); onFact(plan.worker.name, fact); }
      }
    });
    let stderr = '';
    ssh.stderr.on('data', (chunk) => { stderr += chunk; });
    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && stderr.trim()) onLog(`${plan.worker.name}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`);
      done({plan, facts, sshCode: code});
    });
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
  const {workers, skipped} = selectWorkers(inventory, config, probes, {only: options.only, exclude: options.exclude});
  for (const {name, reason} of skipped) process.stdout.write(`skip  ${name}: ${reason}\n`);
  const plans = planShards(jobs, workers, timings).filter((plan) => Object.values(plan.lanes).some((list) => list.length));
  process.stdout.write(`tree  ${snapshot.tree}${snapshot.dirty ? ` (HEAD ${snapshot.head.slice(0, 12)} + working tree)` : ` (HEAD ${snapshot.head.slice(0, 12)})`}\n`);
  for (const plan of plans) {
    const counts = Object.entries(plan.lanes).filter(([, list]) => list.length).map(([lane, list]) => `${lane} ${list.length}`).join(', ');
    process.stdout.write(`plan  ${plan.worker.name.padEnd(16)} slots ${String(plan.worker.slots).padStart(2)}  ${counts}  est ${Math.round(plan.estimatedMs / 1000)}s  ${plan.worker.dir}\n`);
  }
  if (options.dryRun) return 0;

  const started = Date.now();
  const onLog = (text) => process.stdout.write(`note  ${text}\n`);
  const onFact = (name, fact) => {
    if (fact.t === 'phase' && fact.phase !== 'extracted') process.stdout.write(`${name.padEnd(16)} ${fact.phase}${fact.lane ? ` ${fact.lane} (${fact.files} files)` : ''}\n`);
    else if (fact.t === 'exit') process.stdout.write(`${name.padEnd(16)} ${fact.lane} exit ${fact.code} at ${Math.round((Date.now() - started) / 1000)}s\n`);
    else if (fact.t === 'error') process.stdout.write(`${name.padEnd(16)} ERROR ${fact.reason}\n`);
    else if (fact.t === 'result' && fact.status === 'fail') process.stdout.write(`${name.padEnd(16)} not ok ${fact.name}\n`);
  };
  const results = await Promise.all(plans.map((plan) => runShard(plan, snapshot.tree, {onFact, onLog, timeoutMs: options.timeoutMs})));
  const verdict = aggregate(results);
  const wallMs = Date.now() - started;

  await mkdir(cacheDir, {recursive: true});
  await writeFile(timingsPath, `${JSON.stringify(recordTimings(timings, verdict.fileMs, new Map(workers.map((worker) => [worker.name, worker]))), null, 1)}\n`);
  const receipt = {
    format: 'lagrange-images-lab-receipt/v1', tree: snapshot.tree, head: snapshot.head, dirty: snapshot.dirty,
    lanes: options.lanes, files: options.files.length ? files : 'default', startedAt: new Date(started).toISOString(), wallMs,
    workers: results.map(({plan, sshCode}) => ({name: plan.worker.name, slots: plan.worker.slots, lanes: Object.fromEntries(Object.entries(plan.lanes).map(([lane, list]) => [lane, list.length])), sshCode})),
    totals: verdict.totals, problems: verdict.problems,
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
  for (const [lane, counts] of Object.entries(verdict.totals)) {
    const sweeps = lane === 'recovery' ? ` (sweeps ${counts.sweeps ?? 0})` : '';
    process.stdout.write(`# lane ${lane}: tests ${counts.tests ?? 0}${sweeps} pass ${counts.pass ?? 0} fail ${counts.fail ?? 0} cancelled ${counts.cancelled ?? 0} skipped ${counts.skipped ?? 0} todo ${counts.todo ?? 0}\n`);
  }
  const fail = Object.values(verdict.totals).reduce((sum, lane) => sum + (lane.fail ?? 0), 0);
  process.stdout.write(`# fail ${fail}\n# wall ${Math.round(wallMs / 1000)}s\n# receipt ${receiptPath}\nEXIT=${verdict.ok ? 0 : 1}\n`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`lab-suite: ${error.message}\n`);
    process.exitCode = 2;
  });
}

export {main};
