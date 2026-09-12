import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, mkdtemp, rm, lstat, readlink, appendFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const REQUIRED_CHECKS = Object.freeze([
  'node-test', 'recovery-test', 'lagrange-backend-integration',
  'cargo-rustc-oci-integration', 'common-lisp-integration', 'opensmalltalk-cuis-integration',
]);

// These modules already have mandatory real lanes. Their native-environment module loading is
// still checked on every head. Unknown files remain inputs to both native lanes.
export const REAL_TEST_FILES = Object.freeze([
  'test/lagrange-backend-real.test.js', 'test/cargo-rustc-oci-real.test.js',
  'test/common-lisp-sbcl-real.test.js', 'test/opensmalltalk-cuis-real.test.js',
  'test/opensmalltalk-cuis-toolchain-real.test.js', 'test/opensmalltalk-cuis-multipackage-real.test.js',
  'test/opensmalltalk-cuis-semantic-export-real.test.js', 'test/cuis-export-materialize-real.test.js',
  'test/cuis-json-native-import-real.test.js', 'test/cuis-yaxo-native-import-real.test.js',
  'test/two-lane-callable-real.test.js', 'test/mixed-language-project-real.test.js',
]);
const DOC_CHECKS = ['test/steering-docs.test.js', 'test/agent-governance.test.js', 'test/ci-split.test.js'];
const FORMAT = 'ci-native-proof/v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const laneName = lane => {
  if (!['node-test', 'recovery-test'].includes(lane)) throw new Error(`unsupported CI proof lane: ${lane}`);
  return lane;
};

export function inputFingerprint(entries, lane, environment) {
  laneName(lane);
  const inputs = entries.filter(([path]) => !path.startsWith('docs/') && !REAL_TEST_FILES.includes(path))
    .map(entry => [...entry]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return hash(JSON.stringify([FORMAT, lane, environment, inputs]));
}

export function validProducer(producer) {
  const {repository, base, pr, run, jobs, headTree, baseTree} = producer ?? {};
  return Boolean(sha(base) && sha(headTree) && headTree === baseTree
    && pr?.merged_at && pr.merge_commit_sha === base && pr.base?.ref === 'main'
    && pr.head?.repo?.full_name === repository && sha(pr.head?.sha)
    && run?.head_sha === pr.head.sha && run.event === 'pull_request'
    && run.path === '.github/workflows/test.yml' && run.status === 'completed' && run.conclusion === 'success'
    && Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
    && Array.isArray(jobs) && REQUIRED_CHECKS.every(name => {
      const matches = jobs.filter(job => job.name === name);
      return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success';
    }));
}

export function reusableReceipt(plan, receipt, producer) {
  return Boolean(validProducer(producer) && plan?.environment?.imageOS && plan.environment.imageVersion
    && receipt?.format === FORMAT && receipt.result === 'passed'
    && receipt.lane === plan.lane && receipt.key === plan.key
    && same(receipt.environment, plan.environment)
    && receipt.head === producer.pr.head.sha && receipt.tree === producer.baseTree
    && receipt.runId === producer.run.id && receipt.attempt === producer.run.run_attempt);
}

function runnerEnvironment() {
  return {
    node: process.version, platform: process.platform, arch: process.arch,
    imageOS: process.env.ImageOS ?? '', imageVersion: process.env.ImageVersion ?? '',
    options: process.env.NODE_OPTIONS ?? '',
    variables: Object.entries(process.env).filter(([key]) => /^(LAGRANGE_|TZ$|LANG$|LC_)/.test(key))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  };
}

const git = args => execFileSync('git', args, {encoding: 'utf8'}).trim();
async function snapshot(lane) {
  const paths = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
  const entries = [];
  for (const path of paths) {
    const stat = await lstat(path);
    const mode = stat.isSymbolicLink() ? 'symlink' : String(stat.mode & 0o777);
    const bytes = stat.isSymbolicLink() ? await readlink(path) : await readFile(path);
    entries.push([path, mode, hash(bytes)]);
  }
  const environment = runnerEnvironment();
  return {lane, environment, key: inputFingerprint(entries, lane, environment), tree: git(['rev-parse', 'HEAD^{tree}'])};
}

async function context() {
  if (!process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_REPOSITORY) return null;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  const head = event.pull_request?.head?.sha, base = event.pull_request?.base?.sha;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !sha(head) || !sha(base)) return null;
  if (event.pull_request.base.repo?.full_name !== repository || event.pull_request.base.ref !== 'main') return null;
  return {repository, head, base, runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT)};
}

async function api(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`},
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub proof lookup returned HTTP ${response.status}`);
  return response.json();
}

async function priorProof(plan, current) {
  if (!current || !process.env.GH_TOKEN || !plan.environment.imageOS || !plan.environment.imageVersion) return null;
  const prefix = `repos/${current.repository}`;
  // A synthetic merge checkout with additional content cannot inherit a proof of just the PR head.
  const checkedHead = await api(`${prefix}/git/commits/${current.head}`);
  if (checkedHead.tree?.sha !== plan.tree) return null;
  const baseCommit = await api(`${prefix}/git/commits/${current.base}`);
  const prs = await api(`${prefix}/commits/${current.base}/pulls?per_page=100`);
  for (const pr of prs.filter(pr => pr.merged_at && pr.merge_commit_sha === current.base)) {
    if (!sha(pr.head?.sha)) continue;
    const headCommit = await api(`${prefix}/git/commits/${pr.head.sha}`);
    const runs = await api(`${prefix}/actions/workflows/test.yml/runs?head_sha=${pr.head.sha}&event=pull_request&status=success&per_page=10`);
    for (const run of runs.workflow_runs ?? []) {
      const {jobs} = await api(`${prefix}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      const producer = {repository: current.repository, base: current.base, pr, run, jobs,
        headTree: headCommit.tree?.sha, baseTree: baseCommit.tree?.sha};
      if (!validProducer(producer)) continue;
      const {artifacts} = await api(`${prefix}/actions/runs/${run.id}/artifacts?per_page=100`);
      const name = `ci-proof-${plan.lane}`;
      const matches = (artifacts ?? []).filter(a => a.name === name && !a.expired && a.size_in_bytes < 100_000);
      if (matches.length !== 1) continue;
      const directory = await mkdtemp(join(tmpdir(), 'ci-prior-proof-'));
      try {
        // gh owns authenticated artifact download and its signed redirect. No token is copied
        // into a URL or forwarded by this script to an artifact-storage host.
        execFileSync('gh', ['run', 'download', String(run.id), '--repo', current.repository, '--name', name, '--dir', directory],
          {stdio: 'pipe', timeout: 30_000});
        const receipt = JSON.parse(await readFile(join(directory, 'proof.json'), 'utf8'));
        if (reusableReceipt(plan, receipt, producer)) return {runId: run.id, head: pr.head.sha};
      } finally { await rm(directory, {recursive: true, force: true}); }
    }
  }
  return null;
}

async function main(mode, lane) {
  laneName(lane);
  const directory = join(process.env.RUNNER_TEMP ?? tmpdir(), 'ci-proof', lane);
  const planPath = join(directory, 'plan.json');
  if (mode === 'decide') {
    const plan = await snapshot(lane);
    let current = null, prior = null;
    try { current = await context(); prior = await priorProof(plan, current); }
    catch { /* Any unavailable or malformed evidence executes the full lane. */ }
    await mkdir(directory, {recursive: true});
    await writeFile(planPath, JSON.stringify({...plan, current, prior}));
    const message = prior ? `${lane}: reuse successful run ${prior.runId}; identical declared inputs and runner environment`
      : `${lane}: run full suite; no matching trusted prior proof`;
    console.log(message);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `reuse=${Boolean(prior)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    return;
  }
  if (mode === 'check') {
    const flag = lane === 'node-test' ? '--test-skip-pattern=exhaustive-recovery:' : '--test-name-pattern=exhaustive-recovery:';
    const files = lane === 'node-test' ? [...DOC_CHECKS, ...REAL_TEST_FILES] : [...REAL_TEST_FILES];
    execFileSync(process.execPath, ['--test', flag, ...files], {stdio: 'inherit'});
    return;
  }
  if (mode === 'publish') {
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const after = await snapshot(lane);
    if (after.key !== plan.key || after.tree !== plan.tree) throw new Error('CI proof inputs changed during verification');
    const current = await context();
    if (!current || !Number.isSafeInteger(current.runId) || !Number.isSafeInteger(current.attempt)) throw new Error('No CI producer identity');
    await writeFile(join(directory, 'proof.json'), JSON.stringify({
      format: FORMAT, lane, key: plan.key, environment: plan.environment, result: 'passed',
      head: current.head, tree: plan.tree, runId: current.runId, attempt: current.attempt,
      reusedFrom: plan.prior,
    }));
    return;
  }
  throw new Error(`unknown CI proof operation: ${mode}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2], process.argv[3]);
}
