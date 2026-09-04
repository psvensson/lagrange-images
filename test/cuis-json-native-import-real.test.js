import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_SOURCES_V1,
  CuisNativeImportError,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  bytesValue,
  createOpenSmalltalkCuisProvider,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  findSmalltalkKernel,
  importCuisNativePackage,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  readBehavior,
  textValue,
} from '../src/runtime.js';

// ADR 0085 M3 forcing harness (Bead lagrange-images-nv1.1).
//
// The pressure source is the pinned upstream Cuis JSON package that scripts/integration-setup.sh
// already downloads — not a fixture written here. The path this file forces is exactly:
//
//   real upstream JSON package
//     -> real Cuis toolchain -> canonical smalltalk/cuis-semantic-export-v2
//     -> existing native import adapter -> native class/method owners
//
// Nothing between the canonical export and the adapter edits the manifest, and no CuisExport*
// object is materialized: the canonical artifact is the input the adapter is meant to consume.
//
// This file is expected to CHANGE as M3 progresses. Its refusal assertion records the CURRENT
// first unsupported semantic of the real package, so repairing that semantic makes this file go
// red and the next blocker has to be classified deliberately. It is NOT a permanent contract that
// a real package must be refused, and the base-class inventory below is an OBSERVATION of the
// pinned package, not a work queue: each repair is chosen by the first RED, one at a time.
const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';

const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';
const CUIS_IMAGE_IDENTITY = `cuis/${CUIS_COMMIT}/Cuis7.9-8090.image/gitblob:523dc5e74b5b550922b56ff2406415c19700ee8e`;
const CUIS_JSON_IDENTITY = `cuis-package/JSON/${CUIS_COMMIT}/gitblob:47fab65d0d9017d706aa07d39ab0451619488ccd`;

async function put(runtime, id, representation, content, {logicalPath = null, metadata = {}} = {}) {
  return await runtime.images.putCodeArtifact('build-image', {
    id, languageId: 'smalltalk', representation, content, ...(logicalPath ? {logicalPath} : {}), metadata, dependencies: [],
  });
}

// One real build per test-file run. The build runtime is closed before the text is returned, so
// every consumer below already sits on the native side of the boundary.
let semanticExportText = null;
async function jsonSemanticExport() {
  if (semanticExportText !== null) return semanticExportText;
  const buildRuntime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({
      vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 900_000,
    })]],
  });
  try {
    await buildRuntime.images.createImage({id: 'build-image'});
    const baseImage = await put(buildRuntime, 'json-bi', CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {
      logicalPath: 'Cuis7.9-8090.image', metadata: {identity: CUIS_IMAGE_IDENTITY},
    });
    const baseChanges = await put(buildRuntime, 'json-bc', CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {
      logicalPath: 'Cuis7.9-8090.changes',
    });
    const baseSources = await put(buildRuntime, 'json-bs', CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {
      logicalPath: 'Cuis7.8.sources',
    });
    const jsonPackage = await put(buildRuntime, 'json-pkg', CUIS_PACKAGE_V1, textValue(await readFile(process.env.LAGRANGE_CUIS_JSON_PACKAGE_PATH, 'utf8')), {
      logicalPath: 'JSON.pck.st', metadata: {identity: CUIS_JSON_IDENTITY},
    });
    await buildRuntime.images.putCodeArtifact('build-image', {
      id: 'json-buildroot',
      languageId: 'smalltalk',
      representation: CUIS_BUILD_V1,
      content: textValue(CUIS_BUILD_CONTRACT_V0),
      metadata: {},
      dependencies: [
        {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
        {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
        {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
        {role: 'package', artifact: objectRef('build-image', jsonPackage.id)},
      ],
    });
    await buildRuntime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'build-image',
      roots: [objectRef('build-image', 'json-buildroot')],
      target: {representation: CUIS_IMAGE_V1, fileName: 'JsonNativeImport.image'},
      options: {semanticExport: CUIS_SEMANTIC_EXPORT_V2},
      outputIds: {image: 'json-derived-image', changes: 'json-derived-changes', 'semantic-export': 'json-derived-export'},
    });
    const artifact = await buildRuntime.images.getCodeArtifact('build-image', 'json-derived-export');
    assert.equal(artifact.representation, CUIS_SEMANTIC_EXPORT_V2);
    semanticExportText = artifact.content.value;
    return semanticExportText;
  } finally {
    // The toolchain process has already exited; closing its owning runtime makes the cut explicit.
    await buildRuntime.close();
  }
}

test('the pinned upstream Cuis JSON package is a real M3 pressure source, not a fixture', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());
  assert.equal(manifest.format, CUIS_SEMANTIC_EXPORT_V2);
  assert.deepEqual(manifest.packages, [{name: 'JSON', requires: ['Cuis-Base']}]);

  // The real package declares three classes, and only one of them descends from the single
  // structural root identity M1 maps. The other two name ordinary Cuis base classes.
  assert.deepEqual(
    manifest.classes.map(({identity, superclass}) => [identity, superclass]),
    [
      ['cuis-class/JSON/Json', 'cuis-class/Cuis-Base/Object'],
      ['cuis-class/JSON/JsonObject', 'cuis-class/Cuis-Base/OrderedDictionary'],
      ['cuis-class/JSON/JsonSyntaxError', 'cuis-class/Cuis-Base/Error'],
    ],
  );

  // Most of this package's behavior is extension methods on classes it does not define — the
  // canonical export attributes them to JSON but targets the base class. Recorded here so the
  // shape of the pressure is visible; which of these ever becomes work is decided one RED at a
  // time, by the acceptance target, not by this list.
  const baseClassTargets = [...new Set(
    manifest.methods.map(({class: target}) => target).filter((target) => target.startsWith('cuis-class/Cuis-Base/')),
  )].sort();
  assert.deepEqual(baseClassTargets, [
    'cuis-class/Cuis-Base/Array2D',
    'cuis-class/Cuis-Base/Association',
    'cuis-class/Cuis-Base/CharacterSequence',
    'cuis-class/Cuis-Base/Collection',
    'cuis-class/Cuis-Base/Dictionary',
    'cuis-class/Cuis-Base/False',
    'cuis-class/Cuis-Base/FileEntry',
    'cuis-class/Cuis-Base/FloatArray',
    'cuis-class/Cuis-Base/Integer',
    'cuis-class/Cuis-Base/Number',
    'cuis-class/Cuis-Base/Object',
    'cuis-class/Cuis-Base/Text',
    'cuis-class/Cuis-Base/True',
    'cuis-class/Cuis-Base/UndefinedObject',
    'cuis-class/Cuis-Base/WriteStream',
  ]);

  // The acceptance target's own two methods come from the real package, unmodified.
  const render = manifest.methods.find(({identity}) => identity === 'cuis-method/JSON/Json/class/render:');
  assert.equal(render.source, "render: anObject\n\t| s |\n\ts := WriteStream on: String new.\n\tanObject jsonWriteOn: s.\n\t^ s contents.");
  const integerWrite = manifest.methods.find(({identity}) => identity === 'cuis-method/JSON/Integer/instance/jsonWriteOn:');
  assert.equal(integerWrite.class, 'cuis-class/Cuis-Base/Integer');
  assert.equal(integerWrite.source, 'jsonWriteOn: aWriteStream\n\t^ self printOn: aWriteStream base: 10');

  assert.doesNotMatch(JSON.stringify(manifest), /\b(?:oop|offset|address)\b/i);
});

test('real Cuis is the M3 oracle for the acceptance target and never the executor', {skip: !enabled, timeout: 300_000}, async () => {
  const provider = createOpenSmalltalkCuisProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH,
    imagePath: process.env.LAGRANGE_CUIS_IMAGE_PATH,
    vmIdentity: VM_IDENTITY,
    imageIdentity: CUIS_IMAGE_IDENTITY,
    startupTimeoutMs: 120_000,
    callTimeoutMs: 30_000,
    stopTimeoutMs: 10_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [[OPENSMALLTALK_CUIS_PROVIDER_ID, provider]],
  });
  try {
    const instance = await runtime.foreignRuntimes.start({
      providerId: OPENSMALLTALK_CUIS_PROVIDER_ID,
      spec: {packages: [{path: process.env.LAGRANGE_CUIS_JSON_PACKAGE_PATH, identity: CUIS_JSON_IDENTITY}]},
    });
    const render = async (value) => await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'json', operation: 'render'},
      arguments: [value],
    });
    // The M3 acceptance target is one externally meaningful behavior of the package's own public
    // protocol, chosen as the smallest entry point that still runs real package code:
    // `Json render: <native integer>`. It reaches the package's own `Integer>>jsonWriteOn:`
    // extension through the imported class-side `render:`. These are the expected results the
    // native import must eventually produce with Cuis absent.
    assert.deepEqual(await render(integerValue(3)), textValue('3'), 'the M3 acceptance oracle');
    assert.deepEqual(await render(integerValue(0)), textValue('0'));
    assert.deepEqual(await render(integerValue(-3)), textValue('-3'));
    assert.deepEqual(
      await render(integerValue('123456789012345678901234567890')),
      textValue('123456789012345678901234567890'),
      'the same real protocol answers arbitrary-precision integers',
    );
  } finally {
    await runtime.close();
  }
});

// The scope of the M3 acceptance target, named in the canonical export's own semantic identities:
// the package's `Json` class, its class-side `render:` entry point, and the package's own
// `Integer>>jsonWriteOn:` extension that an integer receiver reaches from there.
const ACCEPTANCE_TARGET_SCOPE = Object.freeze({
  classes: Object.freeze(['cuis-class/JSON/Json']),
  methods: Object.freeze([
    'cuis-method/JSON/Json/class/render:',
    'cuis-method/JSON/Integer/instance/jsonWriteOn:',
  ]),
});

async function nativeRuntime() {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  assert.deepEqual(runtime.toolchainProviders.list(), [], 'the native runtime has no Cuis toolchain provider');
  assert.deepEqual(runtime.foreignRuntimeProviders.list(), [], 'the native runtime has no foreign runtime fallback');
  await runtime.images.createImage({id: 'native-image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', lane: 'wasm',
  });
  return runtime;
}

test('a real upstream class imports natively from the canonical export with Cuis gone', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());

  const runtime = await nativeRuntime();
  try {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    const scope = {classes: ['cuis-class/JSON/Json'], methods: []};
    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });

    assert.deepEqual(imported.classes.map(({identity}) => identity), ['cuis-class/JSON/Json']);
    const behavior = await readBehavior(runtime.images, imported.classes[0].classRef);
    assert.deepEqual(behavior.superclass, kernel.objectClass, 'the exact Cuis-Base/Object mapping is structural M1 compatibility');
    const shape = await runtime.images.getShape(behavior.instanceShape.imageId, behavior.instanceShape.objectId);
    assert.deepEqual(
      shape.slots.map(({name}) => name),
      ['stream', 'ctorMap'],
      'the real upstream class keeps its own declared layout',
    );

    // A declaration the scope omits is not constructed: `JsonObject` and `JsonSyntaxError` are in
    // the same canonical manifest and stay absent.
    assert.equal(await runtime.images.getObject('native-image', 'smalltalk/class/JsonObject'), null);
    assert.equal(await runtime.images.getObject('native-image', 'smalltalk/class/JsonSyntaxError'), null);

    const frontierBeforeReplay = await runtime.images.frontier('native-image');
    const replayed = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });
    assert.deepEqual(replayed, imported);
    assert.equal(
      await runtime.images.frontier('native-image'),
      frontierBeforeReplay,
      'exact replay of a real scoped package import is write-free',
    );
  } finally {
    await runtime.close();
  }
});

test('the M3 acceptance target refuses native import at its first unsupported semantic', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());

  const runtime = await nativeRuntime();
  try {
    const frontierBefore = await runtime.images.frontier('native-image');
    const refusal = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: ACCEPTANCE_TARGET_SCOPE,
    }).then(
      (imported) => assert.fail(`the M3 acceptance target imported natively: ${JSON.stringify(imported)}`),
      (error) => error,
    );

    // M3 blocker 2 (Bead lagrange-images-nv1.3): most of this package's behavior is extension
    // methods on classes it does not define, and the adapter maps exactly one base semantic
    // identity — `cuis-class/Cuis-Base/Object`, and only as the M1 structural superclass root.
    // `Integer>>jsonWriteOn:` therefore has no native class to install on.
    assert.ok(refusal instanceof CuisNativeImportError, 'the target is refused, not partially imported');
    assert.equal(refusal.semanticIdentity, 'cuis-method/JSON/Integer/instance/jsonWriteOn:');
    assert.match(
      refusal.message,
      /method target cuis-class\/Cuis-Base\/Integer is outside the imported native class graph/,
    );

    // The adapter's preflight-before-first-write rule holds for a real package, not only for
    // fixtures: a refused import leaves the native image exactly where it was.
    assert.equal(
      await runtime.images.frontier('native-image'),
      frontierBefore,
      'a refused real-package import writes nothing at the native owners',
    );
  } finally {
    await runtime.close();
  }
});
