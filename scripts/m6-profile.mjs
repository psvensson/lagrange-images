#!/usr/bin/env node
import {mkdirSync, readFileSync, writeFileSync, openSync, closeSync, lstatSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {MARKERS, parseOptions, fingerprintSources, observeWorkerFacts, assertWorkerFacts, classifyOutcome} from './m6-profile/contract.mjs';
import {runOwnedChild} from './m6-profile/lifecycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = ['m6-profile.mjs', ...['contract.mjs', 'observation.mjs', 'preload.mjs', 'lifecycle.mjs'].map((name) => 'm6-profile/' + name)];
const exists = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const driverFacts = () => DRIVER.map((name) => ({path: join(HERE, name), sha256: digest(join(HERE, name))}));

export async function main(args) {
  const options = parseOptions(args);
  const sources = fingerprintSources(options);
  const plan = {schema: 'm6-profile-plan/1', ...MARKERS, mode: options.execute ? 'execute' : 'plan',
    createdAt: new Date().toISOString(), options, sources, driver: driverFacts(),
    observations: 'Logical backend calls only; frozen transaction-scoped methods are not individually instrumented. Inclusive spans overlap.',
    resourceOwner: 'External executor owns placement, machine lock, cgroup caps and lease cleanup'};
  if (!options.execute) return plan;
  if (!/^[a-f0-9]{64}$/.test(options.fixtureSha256 || '') ||
      sources.fixtureSha256 !== options.fixtureSha256) throw new Error('Execute requires matching --fixture-sha256 from reviewed plan');
  const facts = observeWorkerFacts();
  assertWorkerFacts(facts, options);
  const thermal = await import(pathToFileURL(realpathSync(options.thermalOwner)).href);
  if (typeof thermal.readThermalHeadroom !== 'function') throw new Error('Existing thermal owner must export readThermalHeadroom');
  const readThermal = () => {
    const reading = thermal.readThermalHeadroom();
    if (!['ok', 'unmeasurable'].includes(reading.state)) throw new Error('Existing thermal owner refuses: ' + reading.state);
    return reading;
  };
  const initialThermal = readThermal();
  if (exists(options.outputDir) || exists(options.dataDir)) throw new Error('Fresh output and data paths required; previous evidence is preserved');
  mkdirSync(options.outputDir);
  const save = (name, value) => writeFileSync(join(options.outputDir, name), JSON.stringify(value, null, 2) + '\n');
  save('plan.json', {...plan, workerFacts: facts, thermal: initialThermal});
  const metricsFile = join(options.outputDir, 'observation.json');
  const logPath = join(options.outputDir, 'canonical.log');
  const log = openSync(logPath, 'wx');
  const controller = new AbortController();
  let cancellationSignal = null;
  const cancel = (signal) => { cancellationSignal ||= signal; controller.abort(); };
  const term = () => cancel('SIGTERM');
  const interrupt = () => cancel('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  let child;
  try {
    child = await runOwnedChild({
      argv: ['--import', pathToFileURL(join(HERE, 'm6-profile/preload.mjs')).href, sources.fixture, options.dataDir],
      cwd: sources.imagesRoot,
      env: {...process.env, M6_PROFILE_CONFIG: JSON.stringify({imagesRoot: sources.imagesRoot,
        fixture: sources.fixture, metricsFile, maxOperations: options.maxOperations})},
      maxMs: options.maxMs, maxLogBytes: options.maxLogBytes, signal: controller.signal,
      onChunk: (chunk) => writeFileSync(log, chunk),
      onStarted: (value) => save('started.json', {...MARKERS, ...value}),
      thermalCheck: () => { readThermal(); return false; },
    });
  } finally {
    closeSync(log); process.removeListener('SIGTERM', term); process.removeListener('SIGINT', interrupt);
  }
  let metrics = null;
  try { metrics = JSON.parse(readFileSync(metricsFile, 'utf8')); } catch { /* Missing or incomplete observation is a failed diagnostic. */ }
  let inputChange = null;
  try {
    const after = fingerprintSources(options);
    if (JSON.stringify(after) !== JSON.stringify(sources) || JSON.stringify(driverFacts()) !== JSON.stringify(plan.driver)) inputChange = 'source-input-changed';
  } catch { inputChange = 'source-input-unavailable'; }
  const outcome = classifyOutcome({...child, metrics, reason: inputChange || child.reason});
  const receipt = {schema: 'm6-profile-terminal/1', ...outcome, child, cancellationSignal,
    sources, driver: plan.driver, workerFacts: facts, initialThermal,
    log: {path: logPath, sha256: digest(logPath), bytes: child.keptLogBytes},
    metricsFile, observedChildRuntime: metrics?.runtimeFacts ?? null, metricMeaning: plan.observations};
  save('terminal.json', receipt);
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.mode !== 'plan' && result.status !== 'diagnostic-completed') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(JSON.stringify({...MARKERS, status: 'refused-or-runner-failed',
      name: error.name, message: error.message}) + '\n');
    process.exitCode = 1;
  }
}
