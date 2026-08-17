import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SOURCES_V1,
  FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0,
  OPENSMALLTALK_CUIS_ARTIFACT_PROVIDER_V0,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  booleanValue,
  bytesValue,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

class RecordingProvider {
  constructor() {
    this.identity = 'recording-runtime/v0';
    this.starts = [];
  }

  async start(request) {
    this.starts.push(request);
    return {
      handle: {id: request.runtimeId},
      metadata: {definition: request.spec.runtimeDefinition.root.ref},
    };
  }

  async call() { return booleanValue(true); }
  async stop() {}
}

class FakeCuisSession {
  constructor() {
    this.lines = ['READY\tlagrange-cuis-stdio/v1'];
  }

  async writeLine(line) {
    const fields = line.split('\t');
    if (fields[0] === 'QUIT') {
      this.lines.push('BYE');
      return;
    }
    const [, requestId, service, operation] = fields;
    if (service === 'json' && operation === 'package-proof') {
      this.lines.push(`OK\t${requestId}\tb:1`);
      return;
    }
    this.lines.push(`ERR\t${requestId}\tunsupported`);
  }

  async nextLine() {
    if (this.lines.length === 0) throw new Error('fake Cuis session has no queued output');
    return this.lines.shift();
  }

  async waitForExit() { return {code: 0, signal: null, stderr: ''}; }
  kill() {}
  stderrText() { return ''; }
}

class FakeCuisRunner {
  constructor() { this.starts = []; }
  async start(request) {
    this.starts.push(request);
    return new FakeCuisSession();
  }
}

async function put(runtime, imageId, id, representation, content, {languageId = null, metadata = {}, dependencies = [], derivedFrom = []} = {}) {
  return await runtime.images.putCodeArtifact(imageId, {
    id,
    languageId,
    representation,
    content,
    metadata,
    dependencies,
    derivedFrom,
  });
}

test('foreign runtime definition service resolves only the explicit durable artifact graph', async () => {
  const provider = new RecordingProvider();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [['test/recording', provider]],
  });
  try {
    await runtime.images.createImage({id: 'runtime-image'});
    const payload = await put(runtime, 'runtime-image', 'payload', 'example/runtime-payload-v1', textValue('payload'), {
      derivedFrom: [objectRef('runtime-image', 'historical-origin')],
      metadata: {meaning: 'explicit input'},
    });
    const definition = await put(runtime, 'runtime-image', 'definition', 'example/runtime-definition-v1', textValue('definition/v0'), {
      dependencies: [{role: 'payload', artifact: objectRef('runtime-image', payload.id)}],
    });

    const instance = await runtime.foreignRuntimeDefinitions.start({
      providerId: 'test/recording',
      definition: objectRef('runtime-image', definition.id),
    });

    assert.equal(instance.providerId, 'test/recording');
    assert.deepEqual(instance.metadata.definition, objectRef('runtime-image', definition.id));
    assert.equal(provider.starts.length, 1);
    const graph = provider.starts[0].spec.runtimeDefinition;
    assert.equal(graph.protocol, FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0);
    assert.deepEqual(graph.root.ref, objectRef('runtime-image', definition.id));
    assert.deepEqual(graph.artifacts.map(({artifact}) => artifact.id), ['definition', 'payload']);
    assert.equal(Object.hasOwn(graph.artifacts[1].artifact, 'derivedFrom'), false);
    assert.equal(Object.isFrozen(graph), true);
    assert.equal(Object.isFrozen(graph.artifacts[1].artifact.metadata), true);
    assert.equal(JSON.stringify(graph).includes('test/recording'), false);

    await runtime.foreignRuntimes.stop(instance.runtimeId);
  } finally {
    await runtime.close();
  }
});

test('artifact-backed Cuis provider materializes a durable runtime definition without host paths in identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-artifact-provider-test-'));
  const runner = new FakeCuisRunner();
  const provider = createArtifactBackedOpenSmalltalkCuisProvider({
    vmPath: '/opt/opensmalltalk/squeak',
    vmIdentity: 'opensmalltalk-vm/test/sha256:1234',
    runner,
    workspaceRoot: root,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [[OPENSMALLTALK_CUIS_PROVIDER_ID, provider]],
  });
  let stagedImagePath = null;
  try {
    assert.match(provider.identity, /^opensmalltalk-cuis-artifact-runtime\/v0\/[0-9a-f]{64}$/);
    assert.equal(provider.identity.startsWith(OPENSMALLTALK_CUIS_ARTIFACT_PROVIDER_V0), true);
    assert.equal(provider.identity.includes('/opt/'), false);

    await runtime.images.createImage({id: 'runtime-image'});
    const image = await put(runtime, 'runtime-image', 'cuis-image', CUIS_IMAGE_V1, bytesValue(Buffer.from('fake-image')), {
      languageId: 'smalltalk', metadata: {fileName: 'Derived.image'},
    });
    const changes = await put(runtime, 'runtime-image', 'cuis-changes', CUIS_CHANGES_V1, textValue('fake changes'), {
      languageId: 'smalltalk', metadata: {fileName: 'Derived.changes'},
    });
    const sources = await put(runtime, 'runtime-image', 'cuis-sources', CUIS_SOURCES_V1, bytesValue(Buffer.from('fake sources')), {
      languageId: 'smalltalk', metadata: {fileName: 'Cuis.sources'},
    });
    const pkg = await put(runtime, 'runtime-image', 'json-package', CUIS_PACKAGE_V1, textValue("'fake package'!"), {
      languageId: 'smalltalk', metadata: {fileName: 'JSON.pck.st', identity: 'cuis-package/JSON/test'},
    });
    const definition = await put(runtime, 'runtime-image', 'cuis-runtime', CUIS_RUNTIME_DEFINITION_V1, textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0), {
      languageId: 'smalltalk',
      dependencies: [
        {role: 'image', artifact: objectRef('runtime-image', image.id)},
        {role: 'changes', artifact: objectRef('runtime-image', changes.id)},
        {role: 'sources', artifact: objectRef('runtime-image', sources.id)},
        {role: 'package', artifact: objectRef('runtime-image', pkg.id)},
      ],
    });

    const instance = await runtime.foreignRuntimeDefinitions.start({
      providerId: OPENSMALLTALK_CUIS_PROVIDER_ID,
      definition: objectRef('runtime-image', definition.id),
    });
    assert.deepEqual(instance.metadata.definition, objectRef('runtime-image', definition.id));
    assert.deepEqual(instance.metadata.imageArtifact, objectRef('runtime-image', image.id));
    assert.deepEqual(instance.metadata.changesArtifact, objectRef('runtime-image', changes.id));
    assert.deepEqual(instance.metadata.sourcesArtifact, objectRef('runtime-image', sources.id));
    assert.deepEqual(instance.metadata.packages, [{
      artifact: objectRef('runtime-image', pkg.id),
      identity: 'cuis-package/JSON/test',
      fileName: 'JSON.pck.st',
    }]);
    assert.equal(JSON.stringify(instance.metadata).includes(root), false);

    assert.equal(runner.starts.length, 1);
    stagedImagePath = runner.starts[0].args[2];
    assert.equal(await readFile(stagedImagePath, 'utf8'), 'fake-image');
    assert.equal(await readFile(join(dirname(stagedImagePath), 'Derived.changes'), 'utf8'), 'fake changes');
    assert.equal(await readFile(join(dirname(stagedImagePath), 'Cuis.sources'), 'utf8'), 'fake sources');
    assert.equal(await readFile(join(runner.starts[0].cwd, 'JSON.pck.st'), 'utf8'), "'fake package'!");
    const script = await readFile(runner.starts[0].args[4], 'utf8');
    assert.match(script, /CodePackageFile installPackage: DirectoryEntry currentDirectory \/\/ 'JSON\.pck\.st'/);

    const packageProof = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'json', operation: 'package-proof'},
      arguments: [],
    });
    assert.deepEqual(packageProof, booleanValue(true));

    await runtime.foreignRuntimes.stop(instance.runtimeId);
    await assert.rejects(readFile(stagedImagePath), /ENOENT/);
  } finally {
    await runtime.close();
    await rm(root, {recursive: true, force: true});
  }
});
