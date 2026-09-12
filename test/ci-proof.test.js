import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  REQUIRED_CHECKS, REAL_TEST_FILES, inputFingerprint, reusableReceipt, validProducer,
} from '../scripts/ci-proof.mjs';

const environment = {node: 'v22.19.0', platform: 'linux', arch: 'x64', imageOS: 'ubuntu24', imageVersion: '20260901.1', options: '', variables: []};
const entries = [
  ['src/runtime.js', '100644', 'runtime'], ['test/owner.test.js', '100644', 'tests'],
  ['test/support/recovery-harness.js', '100644', 'helper'], ['package-lock.json', '100644', 'lock'],
  ['.github/workflows/test.yml', '100644', 'workflow'], ['scripts/ci-proof.mjs', '100644', 'policy'],
  ['docs/native-import.md', '100644', 'docs'], ['test/cuis-yaxo-native-import-real.test.js', '100644', 'yaxo'],
];
const fingerprint = (files = entries, env = environment, lane = 'node-test') => inputFingerprint(files, lane, env);

test('CI reuse invalidates every runtime, test, helper, dependency, workflow and unknown input', () => {
  const original = fingerprint();
  for (let index = 0; index < 6; index++) {
    const changed = entries.map((entry, i) => i === index ? [...entry.slice(0, 2), 'changed'] : entry);
    assert.notEqual(fingerprint(changed), original, entries[index][0]);
    assert.notEqual(fingerprint(entries.filter((_, i) => i !== index)), original, `deleted ${entries[index][0]}`);
  }
  assert.notEqual(fingerprint([...entries, ['new-input', '100644', 'unknown']]), original);
  assert.notEqual(fingerprint(entries, environment, 'recovery-test'), original);
  for (const key of ['node', 'platform', 'arch', 'imageOS', 'imageVersion', 'options']) {
    assert.notEqual(fingerprint(entries, {...environment, [key]: 'changed'}), original, key);
  }
  assert.notEqual(fingerprint(entries, {...environment, variables: [['LAGRANGE_TEST', '1']]}), original);
});

test('documentation and exclusive integration changes keep only the native fingerprint', () => {
  for (const index of [6, 7]) {
    assert.equal(fingerprint(entries.map((entry, i) => i === index ? [...entry.slice(0, 2), 'changed'] : entry)), fingerprint());
  }
  assert.equal(fingerprint([...entries].reverse()), fingerprint(), 'file order is irrelevant');
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  for (const file of REAL_TEST_FILES) {
    assert.ok(pkg.includes(file) || workflow.includes(file), `${file} must have an always-running real lane`);
    readFileSync(new URL(`../${file}`, import.meta.url));
  }
});

const head = 'a'.repeat(40), tree = 'b'.repeat(40), base = 'c'.repeat(40);
const producer = {
  repository: 'owner/repo', base,
  pr: {merged_at: 'date', merge_commit_sha: base, base: {ref: 'main'}, head: {sha: head, repo: {full_name: 'owner/repo'}}},
  run: {id: 123, run_attempt: 1, head_sha: head, event: 'pull_request', path: '.github/workflows/test.yml', status: 'completed', conclusion: 'success'},
  jobs: REQUIRED_CHECKS.map(name => ({name, conclusion: 'success', status: 'completed'})),
  headTree: tree, baseTree: tree,
};
const plan = {lane: 'node-test', key: fingerprint(), environment};
const receipt = {format: 'ci-native-proof/v1', lane: 'node-test', key: fingerprint(), environment, head, tree, runId: 123, attempt: 1, result: 'passed'};

test('CI reuse requires the merged base tree and all six successful exact-head checks', () => {
  assert.equal(validProducer(producer), true);
  for (const patch of [
    {headTree: 'd'.repeat(40)}, {baseTree: 'd'.repeat(40)},
    {pr: {...producer.pr, merged_at: null}}, {pr: {...producer.pr, merge_commit_sha: head}},
    {pr: {...producer.pr, base: {ref: 'other'}}},
    {pr: {...producer.pr, head: {...producer.pr.head, repo: {full_name: 'other/repo'}}}},
    {run: {...producer.run, head_sha: base}}, {run: {...producer.run, conclusion: 'failure'}},
    {run: {...producer.run, event: 'push'}}, {run: {...producer.run, path: 'other.yml'}},
    {jobs: producer.jobs.slice(1)},
    {jobs: producer.jobs.map((job, index) => index === 0 ? {...job, conclusion: 'cancelled'} : job)},
  ]) assert.equal(validProducer({...producer, ...patch}), false, JSON.stringify(patch));
});

test('CI receipts cannot substitute another lane, input, environment, head, tree or run', () => {
  assert.equal(reusableReceipt(plan, receipt, producer), true);
  assert.equal(reusableReceipt(plan, null, producer), false);
  for (const patch of [
    {format: 'old'}, {lane: 'recovery-test'}, {key: 'other'}, {environment: {...environment, node: 'v23'}},
    {head: base}, {tree: base}, {runId: 124}, {attempt: 2}, {result: 'failed'},
  ]) assert.equal(reusableReceipt(plan, {...receipt, ...patch}, producer), false, JSON.stringify(patch));
  assert.equal(reusableReceipt(plan, receipt, {...producer, jobs: []}), false);
  assert.equal(reusableReceipt({...plan, environment: {...environment, imageVersion: ''}}, receipt, producer), false);
});

test('an unavailable CI context falls back to a full run without publishing a success', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-proof-test-'));
  try {
    execFileSync('git', ['init', '--quiet'], {cwd: directory});
    writeFileSync(join(directory, 'input.js'), 'test input');
    execFileSync('git', ['add', 'input.js'], {cwd: directory});
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], {cwd: directory});
    const output = join(directory, 'output');
    const env = {...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: output};
    for (const key of ['GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GITHUB_STEP_SUMMARY', 'GH_TOKEN']) delete env[key];
    const script = fileURLToPath(new URL('../scripts/ci-proof.mjs', import.meta.url));
    const result = execFileSync(process.execPath, [script, 'decide', 'node-test'], {cwd: directory, env, encoding: 'utf8'});
    assert.match(result, /run full suite/);
    assert.equal(readFileSync(output, 'utf8'), 'reuse=false\n');
    assert.throws(() => readFileSync(join(directory, 'ci-proof/node-test/proof.json')), {code: 'ENOENT'});
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('workflow keeps full fallback commands and publishes receipts only after proof steps', () => {
  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  for (const lane of ['node-test', 'recovery-test']) {
    assert.ok(workflow.includes(`node scripts/ci-proof.mjs decide ${lane}`));
    assert.ok(workflow.includes(`node scripts/ci-proof.mjs check ${lane}`));
    assert.ok(workflow.includes(`node scripts/ci-proof.mjs publish ${lane}`));
    assert.ok(workflow.includes(`name: ci-proof-${lane}`));
  }
  assert.equal((workflow.match(/if: steps.proof.outputs.reuse != 'true'/g) ?? []).length, 2);
  assert.equal((workflow.match(/if: steps.proof.outputs.reuse == 'true'/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /if: always\(\)/, 'a failed lane cannot publish a passed receipt');
  assert.match(workflow, /actions: read/);
  assert.ok(workflow.indexOf('npm run test:fast') < workflow.indexOf('ci-proof.mjs publish node-test'));
  assert.ok(workflow.indexOf('ci-proof.mjs publish node-test') < workflow.indexOf('npm run beads:init'));
  assert.ok(workflow.indexOf('npm run beads:ready') < workflow.indexOf('name: ci-proof-node-test'), 'bootstrap must pass before artifact upload');
});
