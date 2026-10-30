import {readFileSync, realpathSync, statSync} from 'node:fs';
import {hostname, homedir, platform} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export const MARKERS = Object.freeze({diagnosticOnly: true, acceptance: false});
const FIXTURE = 'fixtures/real-lagrange-m6-shared-server-process.js';
const REQUIRED = ['imagesRoot', 'fixture', 'dataDir', 'outputDir', 'worker', 'controllerBootId', 'thermalOwner'];
const FLAGS = Object.freeze({'images-root': 'imagesRoot', fixture: 'fixture', 'data-dir': 'dataDir',
  'output-dir': 'outputDir', worker: 'worker', 'controller-boot-id': 'controllerBootId',
  'thermal-owner': 'thermalOwner', 'fixture-sha256': 'fixtureSha256',
  'max-ms': 'maxMs', 'max-operations': 'maxOperations', 'max-log-bytes': 'maxLogBytes'});
export function parseOptions(args) {
  const result = {execute: false, maxMs: 180000, maxOperations: 40, maxLogBytes: 16777216};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--execute') { result.execute = true; continue; }
    const key = FLAGS[flag.slice(2)];
    if (!flag.startsWith('--') || !key || args[index + 1] === undefined) throw new Error('Unknown or incomplete option: ' + flag);
    result[key] = args[++index];
  }
  for (const key of REQUIRED) if (!result[key]) throw new Error('Required option: ' + key);
  for (const key of ['maxMs', 'maxOperations', 'maxLogBytes']) {
    result[key] = Number(result[key]);
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(key + ' must be a finite positive integer');
  }
  if (result.maxMs > 900000 || result.maxOperations > 10000 || result.maxLogBytes > 67108864) throw new Error('Diagnostic caps exceed bounded runner ceiling');
  for (const key of ['imagesRoot', 'fixture', 'dataDir', 'outputDir', 'thermalOwner']) result[key] = resolve(result[key]);
  assertFixtureLocation(result.fixture, result.imagesRoot);
  return result;
}
export function assertFixtureLocation(fixture, imagesRoot) {
  if (resolve(fixture) !== join(resolve(imagesRoot), FIXTURE)) throw new Error('Explicit canonical fixture must belong to images root');
}
export function assertWorkerFacts(facts, options) {
  if (facts.platform !== 'linux' || facts.hostname !== options.worker || !facts.bootId ||
      facts.bootId === options.controllerBootId) throw new Error('Refusing controller or unnamed/non-Linux worker');
  if (!(facts.cpuLimit > 0 && facts.cpuLimit <= 2) ||
      !(facts.memoryLimit > 0 && facts.memoryLimit <= 12 * 1024 ** 3)) throw new Error('Observed cgroup CPU/memory caps required');
  if (!facts.lockHeld || !facts.holderAncestor || facts.holder?.project !== 'lagrange-images' ||
      !facts.holder?.agent || !facts.holder?.purpose) throw new Error('Existing machine lock and live ancestor holder required');
}
export function observeWorkerFacts() {
  const read = (path) => readFileSync(path, 'utf8').trim();
  const relative = read('/proc/self/cgroup').split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  if (!relative || relative.split('/').includes('..')) throw new Error('Linux cgroup v2 observation required');
  let at = join('/sys/fs/cgroup', relative);
  const limits = [];
  while (at !== '/sys/fs/cgroup') {
    const [quota, period] = read(join(at, 'cpu.max')).split(/\s+/);
    const memory = read(join(at, 'memory.max'));
    limits.push({path: at, cpu: quota === 'max' ? Infinity : Number(quota) / Number(period),
      memory: memory === 'max' ? Infinity : Number(memory)});
    const parent = dirname(at);
    if (parent === at || !parent.startsWith('/sys/fs/cgroup')) throw new Error('Invalid cgroup ancestry');
    at = parent;
  }
  const lockPath = join(homedir(), '.lab/machine.lock');
  statSync(lockPath);
  const holder = JSON.parse(read(join(homedir(), '.lab/machine.holder.json')));
  const probe = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '73', lockPath, 'true']);
  let pid = process.pid;
  let holderAncestor = false;
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    if (pid === holder.pid) { holderAncestor = true; break; }
    const text = read('/proc/' + pid + '/stat');
    pid = Number(text.slice(text.lastIndexOf(') ') + 2).split(/\s+/)[1]);
  }
  return {platform: platform(), hostname: hostname(), bootId: read('/proc/sys/kernel/random/boot_id'),
    cpuLimit: Math.min(...limits.map((x) => x.cpu)), memoryLimit: Math.min(...limits.map((x) => x.memory)),
    cgroups: limits.map((x) => ({...x, cpu: Number.isFinite(x.cpu) ? x.cpu : null,
      memory: Number.isFinite(x.memory) ? x.memory : null})),
    lockPath, lockHeld: probe.status === 73, holder, holderAncestor};
}
export function fingerprintSources(options) {
  const imagesRoot = realpathSync(options.imagesRoot);
  const fixture = realpathSync(options.fixture);
  assertFixtureLocation(fixture, imagesRoot);
  const paths = [fixture, ...['src/runtime.js', 'src/backend/lagrange-backend.js',
    'src/backend/lagrange-schema.js', 'src/image/graph-image-service.js',
    'src/compilation/compilation-service.js', 'test/support/life-m5-witness.js',
    'test/fixtures/life-m5-release.json', 'package.json', 'package-lock.json'].map((p) => join(imagesRoot, p)),
  realpathSync(options.thermalOwner)];
  const files = paths.map((path) => ({path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex')}));
  return {imagesRoot, fixture, files, fixtureSha256: files[0].sha256,
    scope: 'Selected fixture/instrumentation input bytes; external executor retains full source archive/dependency identity. Root path or git HEAD alone asserts no clean commit provenance'};
}
export function classifyOutcome({code, signal, reason = null, metrics, reaped, groupGone}) {
  let status;
  if (!reaped || !groupGone) status = 'cleanup-failed';
  else if (metrics?.uncaught && !metrics.uncaught.ownedPrefixStop) status = 'runtime-failed';
  else if (metrics?.telemetryFailure) status = 'telemetry-failed';
  else if (reason) status = 'diagnostic-interrupted';
  else if (code !== 0 && !signal && metrics?.stopRequested && metrics?.uncaught?.ownedPrefixStop) status = 'diagnostic-prefix';
  else if (code === 0 && !signal && metrics?.exitCode === 0 && metrics?.schema === 'm6-profile-observation/1' &&
      !metrics.stopRequested && !metrics.uncaught) status = 'diagnostic-completed';
  else status = 'child-failed';
  return {...MARKERS, status, partial: status !== 'diagnostic-completed', reason};
}
