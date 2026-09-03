import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  bytesValue,
  canonicalizeSemanticExport,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';

class FakeCuisToolchainRunner {
  constructor() { this.runs = []; }

  async run(request) {
    this.runs.push(request);
    const script = await readFile(request.args[4], 'utf8');
    // The build drives FeatureRequirement satisfyRequirementsAndInstall directly (NOT
    // CodePackageFile installPackage:, which swallows FeatureRequirementUnsatisfied into a
    // popup and would falsely succeed on a missing dependency). The package is resolved by
    // path and the error handler quits non-zero so a missing dependency is a real failure.
    assert.match(script, /CodePackageFile packageNameFrom: fullName/);
    assert.match(script, /\(FeatureRequirement name: pkName\) pathName: fullName; satisfyRequirementsAndInstall/);
    assert.match(script, /on: FeatureRequirementUnsatisfied/);
    assert.match(script, /quitPrimitive: 1/);
    assert.match(script, /Smalltalk saveAndQuitAs: 'Derived' clearAllClassState: false/);
    assert.equal(script.includes('Smalltalk saveAs:'), false);
    assert.equal(await readFile(`${request.cwd}/Cuis7.9-8090.image`, 'utf8'), 'base-image');
    assert.equal(await readFile(`${request.cwd}/Cuis7.9-8090.changes`, 'utf8'), 'base-changes');
    assert.equal(await readFile(`${request.cwd}/Cuis7.8.sources`, 'utf8'), 'base-sources');
    assert.equal(await readFile(`${request.cwd}/JSON.pck.st`, 'utf8'), 'json-package');
    await writeFile(`${request.cwd}/Derived.image`, Buffer.from('derived-image'));
    await writeFile(`${request.cwd}/Derived.changes`, Buffer.from('derived-changes'));
    return Object.freeze({
      exitCode: 0,
      signal: null,
      stdout: 'BUILD\tSTART\nBUILD\tPACKAGE\tJSON.pck.st\tDONE\n',
      stderr: '',
    });
  }
}

async function put(runtime, id, representation, content, {metadata = {}, dependencies = [], logicalPath = null} = {}) {
  return await runtime.images.putCodeArtifact('demo', {
    id,
    languageId: 'smalltalk',
    representation,
    content,
    ...(logicalPath ? {logicalPath} : {}),
    metadata,
    dependencies,
  });
}

async function fixture(runtime) {
  const baseImage = await put(runtime, 'base-image', CUIS_IMAGE_V1, bytesValue(Buffer.from('base-image')), {
    logicalPath: 'Cuis7.9-8090.image',
  });
  const baseChanges = await put(runtime, 'base-changes', CUIS_CHANGES_V1, bytesValue(Buffer.from('base-changes')), {
    logicalPath: 'Cuis7.9-8090.changes',
  });
  const baseSources = await put(runtime, 'base-sources', CUIS_SOURCES_V1, bytesValue(Buffer.from('base-sources')), {
    logicalPath: 'Cuis7.8.sources',
  });
  const json = await put(runtime, 'json-package', CUIS_PACKAGE_V1, textValue('json-package'), {
    logicalPath: 'JSON.pck.st',
  });
  const build = await put(runtime, 'build', CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {
    dependencies: [
      {role: 'base-image', artifact: objectRef('demo', baseImage.id)},
      {role: 'base-changes', artifact: objectRef('demo', baseChanges.id)},
      {role: 'base-sources', artifact: objectRef('demo', baseSources.id)},
      {role: 'package', artifact: objectRef('demo', json.id)},
    ],
  });
  return {baseImage, baseChanges, baseSources, json, build};
}

test('OpenSmalltalk Cuis toolchain materializes explicit graph and persists runnable image outputs', async () => {
  const runner = new FakeCuisToolchainRunner();
  const provider = createOpenSmalltalkCuisToolchainProvider({
    vmPath: '/opt/opensmalltalk/squeak',
    vmIdentity: 'opensmalltalk-vm/202606270913/sha256:dff5',
    runner,
  });
  assert.equal(provider.cacheKey, undefined);
  assert.match(provider.identity, /^opensmalltalk-cuis-toolchain\/v0\/[0-9a-f]{64}$/);

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const {baseImage, baseChanges, baseSources, json, build} = await fixture(runtime);
    const result = await runtime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'demo',
      roots: [objectRef('demo', build.id)],
      target: {representation: CUIS_IMAGE_V1, fileName: 'Derived.image'},
      options: {},
      outputIds: {image: 'derived-image', changes: 'derived-changes'},
    });

    assert.equal(result.reused, false);
    assert.equal(result.derivationKey, null);
    assert.deepEqual(result.outputs.map(({name}) => name), ['image', 'changes']);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].args.slice(0, 3), ['-vm-sound-null', '-vm-display-null', 'Cuis7.9-8090.image']);
    assert.equal(runner.runs[0].args[3], '-s');

    const image = await runtime.images.getCodeArtifact('demo', 'derived-image');
    const changes = await runtime.images.getCodeArtifact('demo', 'derived-changes');
    assert.deepEqual(image.content, bytesValue(Buffer.from('derived-image')));
    assert.deepEqual(changes.content, bytesValue(Buffer.from('derived-changes')));
    assert.equal(image.logicalPath, 'Derived.image');
    assert.equal(image.metadata.companionChangesFileName, 'Derived.changes');
    assert.equal(image.metadata.vmIdentity, provider.vmIdentity);
    assert.equal(image.metadata.snapshotMethod, 'saveAndQuitAs/v0');
    assert.deepEqual(image.metadata.packageArtifactIds, [json.id]);
    assert.deepEqual(image.metadata.packageFileNames, ['JSON.pck.st']);
    assert.equal(image.metadata.sourcesFileName, 'Cuis7.8.sources');
    assert.deepEqual(image.dependencies, [{role: 'sources', artifact: objectRef('demo', baseSources.id)}]);
    const provenance = [build, baseImage, baseChanges, baseSources, json].map(({id}) => objectRef('demo', id));
    assert.deepEqual(image.derivedFrom, provenance);
    assert.deepEqual(changes.derivedFrom, provenance);
    assert.deepEqual(result.diagnostics, [{
      severity: 'note', source: 'opensmalltalk-cuis', stream: 'stdout',
      message: 'BUILD\tSTART\nBUILD\tPACKAGE\tJSON.pck.st\tDONE\n',
    }]);
  } finally {
    await runtime.close();
  }
});

test('OpenSmalltalk Cuis toolchain validates roles, filenames and target before process execution', async () => {
  const runner = new FakeCuisToolchainRunner();
  const provider = createOpenSmalltalkCuisToolchainProvider({
    vmPath: '/vm', vmIdentity: 'vm/v1', runner,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, provider]],
  });
  await runtime.images.createImage({id: 'demo'});
  try {
    const base = await put(runtime, 'base', CUIS_IMAGE_V1, bytesValue(Buffer.from('base')), {
      logicalPath: 'Base.image',
    });
    const changes = await put(runtime, 'base-changes-validation', CUIS_CHANGES_V1, bytesValue(Buffer.from('changes')), {
      logicalPath: 'Base.changes',
    });
    // A workspace-escaping package logicalPath is refused by the CodeArtifact owner at put time.
    await assert.rejects(
      put(runtime, 'bad-package', CUIS_PACKAGE_V1, textValue('bad'), {logicalPath: '../Bad.pck.st'}),
      /logicalPath must not contain empty, \. or \.\. segments/,
    );
    assert.equal(runner.runs.length, 0);

    const noChangesBuild = await put(runtime, 'no-changes-build', CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {
      dependencies: [{role: 'base-image', artifact: objectRef('demo', base.id)}],
    });
    await assert.rejects(runtime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'demo',
      roots: [objectRef('demo', noChangesBuild.id)],
      target: {representation: CUIS_IMAGE_V1, fileName: 'Derived.image'},
    }), /requires exactly one base-changes dependency/);
    assert.equal(runner.runs.length, 0);

    await assert.rejects(runtime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'demo',
      roots: [objectRef('demo', base.id)],
      target: {representation: CUIS_IMAGE_V1, fileName: 'Derived.image'},
    }), /root must be smalltalk\/cuis-build-v1/);
    assert.equal(runner.runs.length, 0);
  } finally {
    await runtime.close();
  }
});

test('canonicalizeSemanticExport produces deterministic, semantic-identity output (ADR 0072)', () => {
  const raw = {
    format: 'smalltalk/cuis-semantic-export-v1',
    packages: [
      {name: 'FFI', requires: ['WeakDictionaries', 'Alien-Core']},
      {name: 'Compression', requires: []},
    ],
    classes: [
      {package: 'Compression', name: 'Archive', superclassName: 'Object', superclassPackage: 'Cuis-Base'},
      {package: 'Compression', name: 'ProtoObject', superclassName: '', superclassPackage: 'Cuis-Base'},
    ],
    methods: [
      {package: 'Compression', className: 'ByteArray', classPackage: 'Cuis-Base', side: 'instance', selector: 'unzipped', source: 'unzipped\r\n\t^ (GZipReadStream on: self) upToEnd  \r\n'},
    ],
  };
  const out = canonicalizeSemanticExport(raw);
  // requires sorted; packages sorted by name
  assert.deepEqual(out.packages.map((p) => p.name), ['Compression', 'FFI']);
  assert.deepEqual(out.packages.find((p) => p.name === 'FFI').requires, ['Alien-Core', 'WeakDictionaries']);
  // class identity + superclass ref (base class -> cuis-class/Cuis-Base/...); no-superclass -> null
  const archive = out.classes.find((c) => c.name === 'Archive');
  assert.equal(archive.identity, 'cuis-class/Compression/Archive');
  assert.equal(archive.superclass, 'cuis-class/Cuis-Base/Object');
  assert.equal(out.classes.find((c) => c.name === 'ProtoObject').superclass, null);
  // method identity + extension target class ref + normalized source (LF, trailing whitespace trimmed)
  const m = out.methods[0];
  assert.equal(m.identity, 'cuis-method/Compression/ByteArray/instance/unzipped');
  assert.equal(m.class, 'cuis-class/Cuis-Base/ByteArray');
  assert.equal(m.source, 'unzipped\n\t^ (GZipReadStream on: self) upToEnd');
  // determinism: canonicalizing twice (and an order-shuffled input) yields identical output
  const shuffled = {format: raw.format, packages: [...raw.packages].reverse(), classes: [...raw.classes].reverse(), methods: [...raw.methods]};
  assert.deepEqual(canonicalizeSemanticExport(shuffled), out);
  assert.deepEqual(canonicalizeSemanticExport(raw), out);
});
