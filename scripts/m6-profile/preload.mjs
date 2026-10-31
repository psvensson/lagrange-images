import {channel} from 'node:diagnostics_channel';
import {isMainThread} from 'node:worker_threads';
import {getHeapStatistics} from 'node:v8';
import {realpathSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createObserver, ProfilePrefixStop} from './observation.mjs';
import {assertFixtureLocation} from './contract.mjs';

// Worker threads inherit --import; only the fixture's main thread owns observation.
if (isMainThread && process.env.M6_PROFILE_CONFIG) {
  const config = JSON.parse(process.env.M6_PROFILE_CONFIG);
  const root = realpathSync(config.imagesRoot);
  const fixture = realpathSync(process.argv[1]);
  assertFixtureLocation(fixture, root);
  if (fixture !== config.fixture) throw new Error('Profiler preload/fixture root mismatch');
  if (JSON.stringify(process.argv.slice(1)) !== JSON.stringify(config.fixtureArgv ?? [config.fixture])) {
    throw new Error('Profiler preload/literal fixture argv mismatch');
  }
  const persist = (state) => {
    writeFileSync(config.metricsFile + '.tmp', JSON.stringify(state) + '\n');
    renameSync(config.metricsFile + '.tmp', config.metricsFile);
  };
  const observer = createObserver({maxOperations: config.maxOperations, persist});
  const stages = channel('lagrange-images.m6-stage/1');
  const onStage = (record) => observer.stage(record);
  stages.subscribe(onStage);
  const heartbeat = setInterval(() => observer.snapshot(), 1000);
  heartbeat.unref();
  observer.state.runtimeFacts = {nodeVersion: process.version, arch: process.arch, execPath: process.execPath, heapSizeLimit: getHeapStatistics().heap_size_limit};
  const persistWithoutMaskingFailure = () => {
    try { persist(observer.state); } catch (failure) { observer.state.telemetryFailure ||= {name: failure.name, code: failure.code ?? null}; }
  };
  process.on('uncaughtExceptionMonitor', (error) => {
    observer.state.uncaught = {name: error?.name ?? 'Error', code: error?.code ?? null,
      ownedPrefixStop: error instanceof ProfilePrefixStop};
    persistWithoutMaskingFailure();
  });
  process.on('exit', (code) => {
    clearInterval(heartbeat); stages.unsubscribe(onStage);
    observer.state.exitCode = code; observer.snapshot(); persistWithoutMaskingFailure();
  });
  const load = (relative) => import(pathToFileURL(join(root, relative)).href);
  const [{LagrangeBackend}, {ImageService}, {CompilationService}] = await Promise.all([
    load('src/backend/lagrange-backend.js'), load('src/image/graph-image-service.js'),
    load('src/compilation/compilation-service.js'),
  ]);
  for (const name of ['get', 'put', 'scan', 'append', 'readStream', 'streamHead']) observer.patch(LagrangeBackend.prototype, name, 'backend.' + name, true);
  observer.patchTransaction(LagrangeBackend.prototype);
  observer.patch(ImageService.prototype, 'listCodeArtifacts', 'images.listCodeArtifacts');
  for (const name of ['compileArtifact', 'compileGroup', 'findReusableArtifact']) observer.patch(CompilationService.prototype, name, 'compilation.' + name);
  persist(observer.state);
}
