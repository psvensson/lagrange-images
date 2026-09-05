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
  OBJECT_READ_OPERATION,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  bytesValue,
  createOpenSmalltalkCuisProvider,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  findSmalltalkKernel,
  importCuisNativePackage,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  methodBindings,
  methodBlockRef,
  objectRef,
  objectResource,
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

// The AUTHORIZED native browsing seam over REAL imported Cuis material (bead lagrange-images-jtz,
// Object Environment E1). Proving it here rather than only on a fixture is the point: an
// independently authored upstream class and one of its own methods must browse as ordinary native
// Symmetric Smalltalk through the SAME public function an ordinary native class uses, in a runtime
// that has no Cuis VM, provider or toolchain to fall back on.
function browseRequire(runtime, objectIds) {
  const context = runtime.authority.issue({
    principal: 'environment-e1',
    grants: objectIds.map((objectId) => ({
      operation: OBJECT_READ_OPERATION,
      resource: objectResource('native-image', objectId),
    })),
  });
  return (demand) => runtime.authority.require(context, demand);
}

// Nothing about a native description may name the Cuis origin, and nothing may name storage.
function assertOriginNeutralNativeDescription(description, label) {
  const text = JSON.stringify(description);
  for (const token of [
    'cuis', 'Cuis', 'JSON', 'gitblob', 'oop',
    '_version', 'behavior-', 'method-dictionary', 'instance-shape', 'instance-slot', 'selector:',
  ]) {
    assert.equal(text.includes(token), false, `${label} must not carry ${token}: ${text}`);
  }
}

test('an M1-imported real Cuis class browses as an ordinary authorized native class', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());

  const runtime = await nativeRuntime();
  try {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: ['cuis-class/JSON/Json'], methods: []},
    });
    const {classRef, metaclassRef} = imported.classes[0];

    const description = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'native-image',
      classRef,
      require: browseRequire(runtime, [classRef.objectId]),
    });

    assert.equal(description.format, 'smalltalk-class-description/v1');
    // Exact ref identity across the import result and the description: the seam reports the class
    // the importer produced, it does not mint a second identity for it.
    assert.deepEqual(description.class, classRef);
    assert.equal(description.name, 'Json');
    assert.equal(description.side, 'instance');
    assert.deepEqual(description.superclass, kernel.objectClass);
    assert.deepEqual(description.classSide, metaclassRef);
    // The real upstream declared layout, by name and in order — never a slot id.
    assert.deepEqual(description.layout, {instanceVariables: ['stream', 'ctorMap'], indexed: 'none'});
    // This scope imported the class alone, so it publishes no protocol of its own yet.
    assert.deepEqual(description.selectors, []);
    // Cuis origin is optional metadata, and Images owns no durable association to report.
    assert.equal(description.provenance, null);
    assertOriginNeutralNativeDescription(description, 'imported class description');

    // Authority does not follow the refs a description hands out: the superclass and the class side
    // are locators, and browsing either needs its own object/read.
    const classOnly = browseRequire(runtime, [classRef.objectId]);
    for (const ref of [description.superclass, description.classSide]) {
      await assert.rejects(
        authorizedDescribeSmalltalkClass({images: runtime.images, imageId: 'native-image', classRef: ref, require: classOnly}),
        (error) => error?.name === 'AuthorityError',
        `browsing ${ref.objectId} must need its own grant`,
      );
    }
    // A denied caller cannot tell the imported class from one this scope never constructed.
    const denied = browseRequire(runtime, []);
    for (const ref of [classRef, objectRef('native-image', 'smalltalk/class/JsonObject')]) {
      await assert.rejects(
        authorizedDescribeSmalltalkClass({images: runtime.images, imageId: 'native-image', classRef: ref, require: denied}),
        (error) => error?.name === 'AuthorityError',
      );
    }
  } finally {
    await runtime.close();
  }
});

test('an M2-imported real Cuis method browses as an ordinary authorized native method', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());
  // Two of the real package's own accessors on its own class — unmodified upstream source, and the
  // part of this package that M2 can already compile natively on this HEAD.
  const accessors = ['cuis-method/JSON/Json/instance/ctorMap', 'cuis-method/JSON/Json/instance/ctorMap:'];
  for (const identity of accessors) {
    assert.ok(manifest.methods.some((method) => method.identity === identity), `${identity} is real upstream material`);
  }

  const runtime = await nativeRuntime();
  try {
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: ['cuis-class/JSON/Json'], methods: accessors},
    });
    const {classRef} = imported.classes[0];

    // The class half: the imported protocol is ordinary published protocol of an ordinary class.
    const classDescription = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'native-image', classRef,
      require: browseRequire(runtime, [classRef.objectId]),
    });
    assert.deepEqual(classDescription.selectors, ['ctorMap', 'ctorMap:']);

    const binding = (await methodBindings({images: runtime.images, imageId: 'native-image', classRef}))
      .find(({selector}) => selector === 'ctorMap');
    assert.ok(binding);

    // Class authority alone does not reach the method's Block: it is an independent semantic object.
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images: runtime.images, imageId: 'native-image', classRef, selector: 'ctorMap',
        require: browseRequire(runtime, [classRef.objectId]),
      }),
      (error) => error?.name === 'AuthorityError',
    );

    const description = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'native-image',
      classRef,
      selector: 'ctorMap',
      require: browseRequire(runtime, [classRef.objectId, binding.method.objectId]),
    });
    assert.equal(description.format, 'smalltalk-method-description/v1');
    assert.deepEqual(description.class, classRef);
    assert.equal(description.selector, 'ctorMap');
    assert.equal(description.side, 'instance');
    assert.deepEqual(description.method, binding.method, 'the exact Block the class MethodDictionary binds');
    // Images owns no durable association from this native method back to the Cuis source it was
    // translated from, nor to the package that supplied it. The seam says so rather than
    // reconstructing either from the importer's transient output or from a deterministic id.
    assert.equal(description.source, null);
    assert.equal(description.provenance, null);
    assertOriginNeutralNativeDescription(description, 'imported method description');

    // A denied caller cannot distinguish an imported method from a selector nobody implements.
    const denied = browseRequire(runtime, []);
    for (const selector of ['ctorMap', 'neverImplementedByAnyPackage']) {
      await assert.rejects(
        authorizedDescribeSmalltalkMethod({
          images: runtime.images, imageId: 'native-image', classRef, selector, require: denied,
        }),
        (error) => error?.name === 'AuthorityError',
      );
    }
  } finally {
    await runtime.close();
  }
});

// The package owns a method declaration on a class it does not define. That is ordinary Smalltalk
// extension-method behavior, and the native result is ordinary too: the explicit identity mapping
// resolves the target and the EXISTING kernel Integer's EXISTING MethodDictionary owns the binding.
test('a real upstream extension method installs on the existing native class it extends', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());

  const runtime = await nativeRuntime();
  try {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    const classRecordBefore = await runtime.images.getObject('native-image', 'smalltalk/class/Integer');
    const behaviorBefore = await readBehavior(runtime.images, kernel.integerClass);
    assert.equal(
      await methodBlockRef({
        images: runtime.images, imageId: 'native-image', classRef: kernel.integerClass, selector: 'jsonWriteOn:',
      }),
      null,
      'jsonWriteOn: is the package\'s selector, not something this image already had',
    );

    const scope = {
      // `cuis-class/Cuis-Base/Integer` is deliberately NOT a class this import makes native: it is
      // an existing native class resolved through the adapter's exact-identity mapping, and the
      // covered METHOD is what was requested.
      classes: ['cuis-class/JSON/Json'],
      methods: ['cuis-method/JSON/Integer/instance/jsonWriteOn:'],
    };
    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });
    assert.deepEqual(imported.classes.map(({identity}) => identity), ['cuis-class/JSON/Json']);

    const behaviorAfter = await readBehavior(runtime.images, kernel.integerClass);
    const classRecordAfter = await runtime.images.getObject('native-image', 'smalltalk/class/Integer');
    assert.equal(classRecordAfter._version, classRecordBefore._version, 'the mapped Class record does not move');
    assert.deepEqual(behaviorAfter.superclass, behaviorBefore.superclass);
    assert.deepEqual(behaviorAfter.instanceShape, behaviorBefore.instanceShape);
    assert.deepEqual(
      behaviorAfter.methods,
      behaviorBefore.methods,
      'the existing MethodDictionary owns the binding; no second Integer and no proxy subclass',
    );
    assert.ok(await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: kernel.integerClass, selector: 'jsonWriteOn:',
    }));

    // The behavioral proof that the mapping named the right class: an ORDINARY native integer
    // dispatches INTO the real upstream method. The failure is the method body's own
    // `printOn:base:` requirement, not `jsonWriteOn:` — a message-not-understood on `jsonWriteOn:`
    // would mean the extension landed on some other class. That inner gap is the next RED and is
    // deliberately not pre-implemented here.
    const send = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'native-image', id: 'send-json-write-on', source: '[ :n :s | n jsonWriteOn: s ]',
    });
    await assert.rejects(
      runtime.invocations.invokeBlock(objectRef('native-image', send.block.id), [integerValue(3), integerValue(0)])
        .then((activation) => runtime.executor.execute(activation)),
      /message not understood: printOn:base: sent to a integer Value/,
    );

    const frontierBeforeReplay = await runtime.images.frontier('native-image');
    const replayed = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });
    assert.deepEqual(replayed, imported);
    assert.equal(
      await runtime.images.frontier('native-image'),
      frontierBeforeReplay,
      'exact replay of the mapped-target extension import is write-free',
    );
  } finally {
    await runtime.close();
  }
});

test('the M3 acceptance target refuses native import at its first unsupported semantic', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());

  const runtime = await nativeRuntime();
  try {
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

    // M3 blocker 3 (Bead lagrange-images-nv1.4): `Json class>>render:` opens with
    // `WriteStream on: String new`. Unlike the two blockers before it, this is NOT an adapter
    // refusal — `WriteStream` and `String` are global
    // NAME references inside imported method source, which the native compiler resolves through
    // this image's global namespace. The gap therefore belongs to the native library/namespace
    // owners, not to the Cuis mapping seam, and it is classified in its own bead before any
    // compatibility code is written.
    assert.equal(refusal instanceof CuisNativeImportError, false, 'the native compiler refuses this, not the adapter');
    assert.match(refusal.message, /unbound Symmetric Smalltalk name: WriteStream/);

    // A native-owner rejection after preflight leaves whatever the owners already admitted, and
    // this case's residue is worth pinning because it is MORE than newly created material. The
    // canonical manifest is sorted by identity, so `.../Integer/instance/jsonWriteOn:` reconciles
    // before `.../Json/class/render:` reaches the compiler: the class was admitted, AND the
    // extension selector is already installed on the PRE-EXISTING kernel Integer. The adapter's
    // preflight-before-first-write rule is about adapter-owned defects; it is not an
    // all-or-nothing import promise, and the docs say so rather than implying otherwise.
    assert.ok(
      await runtime.images.getObject('native-image', 'smalltalk/class/Json'),
      'the valid class was admitted before the compiler rejected the method',
    );
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    assert.ok(
      await methodBlockRef({
        images: runtime.images, imageId: 'native-image', classRef: kernel.integerClass, selector: 'jsonWriteOn:',
      }),
      'the earlier method group had already reconciled onto the pre-existing kernel Integer',
    );
  } finally {
    await runtime.close();
  }
});
