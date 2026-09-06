import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  booleanValue,
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_SOURCES_V1,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  WASM_FUNCTION_MODULE_DEPENDENCY_ROLE,
  WASM_FUNCTION_V2,
  assertWasmFunctionV2Artifact,
  assertWasmModuleV2Artifact,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
  authorizedReplaceSmalltalkMethod,
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
  publishSmalltalkClassGlobals,
  readBehavior,
  readModuleImplementationBytes,
  reconcileMethodsFromSource,
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
    // dispatches INTO the real upstream method, which then sends `printOn:base:` to itself. Native
    // Integer now implements that (bead lagrange-images-nv1.6), so execution travels one level
    // deeper: the printing method writes its answer to the argument it was handed. Here that
    // argument is deliberately an integer rather than a stream, so the failure names the WRITE it
    // attempted. What this pins is the dispatch chain — a message-not-understood on `jsonWriteOn:`
    // would mean the extension landed on some other class, and one on `printOn:base:` would mean
    // the native Integer protocol had gone missing.
    const send = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'native-image', id: 'send-json-write-on', source: '[ :n :s | n jsonWriteOn: s ]',
    });
    const inner = await runtime.invocations
      .invokeBlock(objectRef('native-image', send.block.id), [integerValue(3), integerValue(0)])
      .then((activation) => runtime.executor.execute(activation))
      .then((result) => assert.fail(`writing to an integer answered ${JSON.stringify(result)}`), (error) => error);
    assert.match(inner.message, /message not understood: nextPutAll: sent to a integer Value/);
    for (const selector of [/jsonWriteOn:/, /printOn:base:/]) {
      assert.doesNotMatch(inner.message, selector, 'both methods were found and entered');
    }

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

// THE M3 ACCEPTANCE TARGET, green. The pinned upstream package's own public behaviour —
// `Json render: <integer>` — is produced entirely by native execution with Cuis absent, and equals
// the recorded real-Cuis oracle. Both halves are the package's own upstream code, taken from the
// canonical export with nothing edited between: the class-side `render:` entry point and the
// `Integer>>jsonWriteOn:` extension on a class the package does not define.
//
// ONE QUALIFICATION, stated because a milestone claim should carry it: `render:` is not compiled
// byte-for-byte as written. The adapter translates one proven Cuis dialect idiom in method bodies
// — the unary `String new` becomes an empty native Text value (bead lagrange-images-nv1.5) — and
// this path depends on that translation. It is keyed on a source token rather than on a semantic
// identity, which is the narrowest seam in the chain and is documented as such. Everything else in
// both methods is compiled as the export delivered it.
test('the M3 acceptance target imports AND EXECUTES natively, matching the recorded real-Cuis oracle', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());

  const runtime = await nativeRuntime();
  try {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: ACCEPTANCE_TARGET_SCOPE,
    });
    assert.deepEqual(imported.classes.map(({identity}) => identity), ['cuis-class/JSON/Json']);

    // Both real upstream methods are now installed at their own owners: the class-side entry point
    // on the imported class's Metaclass, and the extension on the PRE-EXISTING kernel Integer.
    assert.ok(await methodBlockRef({
      images: runtime.images,
      imageId: 'native-image',
      classRef: objectRef('native-image', 'smalltalk/metaclass/Json'),
      selector: 'render:',
    }), 'the package\'s own class-side entry point compiled natively');
    assert.ok(await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: kernel.integerClass, selector: 'jsonWriteOn:',
    }), 'the package\'s own Integer extension compiled natively');

    // Exact replay of the whole acceptance-target scope is write-free, the guarantee every earlier
    // slice established and this one must not lose now that the scope actually succeeds.
    const frontierBeforeReplay = await runtime.images.frontier('native-image');
    const replayed = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: ACCEPTANCE_TARGET_SCOPE,
    });
    assert.deepEqual(replayed, imported);
    assert.equal(await runtime.images.frontier('native-image'), frontierBeforeReplay);

    // RUN IT. This is the M3 acceptance behaviour, and it is now green: the whole imported path
    // executes natively with Cuis ABSENT. `render:` evaluates `WriteStream on: String new`,
    // dispatches `jsonWriteOn:` to an ordinary native integer, that upstream extension sends
    // `printOn:base:`, native Integer printing writes through `nextPutAll:`, and `contents` builds
    // the answer preserving the backing's class.
    //
    // The oracle is asserted as KIND AND VALUE, deliberately not as textual equality. Real Cuis
    // answers a String OBJECT (measured: `render 3 -> class=String value='3'`); the native answer
    // is a text VALUE. That correspondence is the milestone's intent — the recorded oracle and the
    // Cuis bridge have always expressed a Cuis String result as a native Text — but it is a claim
    // about the RESULT CLASS, so it is stated rather than quietly reduced to string contents.
    await publishSmalltalkClassGlobals({images: runtime.images, imageId: 'native-image', names: ['Json']});
    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'native-image', id: 'm3-acceptance', source: '[ :n | Json render: n ]',
    });
    const render = async (value) => await runtime.executor.execute(
      await runtime.invocations.invokeBlock(objectRef('native-image', block.id), [integerValue(value)]),
    );

    // The four recorded real-Cuis cases, verbatim.
    for (const [value, expected] of [
      ['3', '3'],
      ['0', '0'],
      ['-3', '-3'],
      ['123456789012345678901234567890', '123456789012345678901234567890'],
    ]) {
      assert.deepEqual(await render(value), textValue(expected), `Json render: ${value}`);
    }

    // The RESULT CLASS, as a second and genuinely independent claim. The equality above is one
    // Value-envelope comparison; this asks the answer itself, in Smalltalk, what class it belongs
    // to. Real Cuis answers a String OBJECT (measured: `render 3 -> class=String value='3'`); the
    // native counterpart is the text Value's class, and that correspondence is what the milestone
    // means rather than a reduction to string contents.
    const classOfAnswer = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm3-acceptance-class',
      source: '[ :n | (Json render: n) class == Text ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', classOfAnswer.block.id), [integerValue(3)],
      )),
      booleanValue(true),
      'the answer is a Text, asked of the answer rather than inferred from its envelope',
    );

    // ... and it really was native the whole way: this runtime has no Cuis toolchain provider and
    // no foreign-runtime provider to have fallen back to (asserted when it was created), and the
    // Cuis build runtime was closed before this one existed.
    assert.deepEqual(runtime.toolchainProviders.list(), []);
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
  } finally {
    await runtime.close();
  }
});

// =================================================================================================
// SLICE D of bead lagrange-images-qax: the REAL Cuis-origin E3 acceptance (ADR 0088, GitHub #218).
//
// Everything above this point proves READS over real upstream material. This proves the WRITE, end
// to end, against the pinned upstream method `Json>>ctorMap` — imported from the canonical export
// with nothing edited between, then replaced twice, in a runtime that has no Cuis toolchain provider
// and no Cuis foreign-runtime provider to have fallen back to.
//
// WHY REVISION A IS NOT MANUFACTURED. A is the genuine upstream accessor, taken from the manifest
// this file's own real toolchain build produced. It is deliberately NOT replaced during fixture
// setup, and its answer is MEASURED rather than chosen: `ctorMap:` is deliberately left out of the
// import scope, so nothing in this test can assign the slot and a fresh native `Json` answers this
// image's `nil`. A distinct integer would make the winner-preservation arithmetic prettier, but it
// would also mean the subject of an E3 ACCEPTANCE was written by the acceptance. B and C — the two
// revisions the test itself supplies — answer 11 and 22, which is where the distinctness is needed.
//
// WHAT THE CONSUMER SIDE MAY TOUCH. Every leg that models the Object Environment uses only the
// public authorized seams: `authorizedDescribeSmalltalkMethod`, `authorizedReadSmalltalkMethodForUpdate`
// and `authorizedReplaceSmalltalkMethod`. It never opens a MethodDictionary, never mints or parses a
// token, never names an execution lane, never reconstructs a Block id, and never treats the write
// receipt as current truth — Block C is discovered by a fresh authorized read, not from the receipt.
// The one owner-path call is the COMPETING EDITOR in step 4, which is Images-owned test setup
// standing in for a second writer; using the public writer there would have this test race itself.

const CTOR_MAP_IDENTITY = 'cuis-method/JSON/Json/instance/ctorMap';
// The pinned upstream source, exactly as the canonical export delivers it. Asserted rather than
// described, so a substituted fixture or an edited manifest cannot reach the sequence below.
const CTOR_MAP_UPSTREAM_SOURCE = 'ctorMap\n\t^ ctorMap';
const REPLACEMENT_B = '[ ^ 11 ]';
const REPLACEMENT_C = '[ ^ 22 ]';

// An authority context that RECORDS every demand it is asked, so a proof can assert WHAT was
// demanded rather than only that a call succeeded or was refused.
function recordingRequire(runtime, grants) {
  const context = runtime.authority.issue({principal: 'environment-e3', grants});
  const demands = [];
  const require = (demand) => {
    demands.push(demand);
    return runtime.authority.require(context, demand);
  };
  require.demands = demands;
  return require;
}

const readGrant = (objectId) => ({operation: OBJECT_READ_OPERATION, resource: objectResource('native-image', objectId)});
const writeGrant = (objectId) => ({operation: OBJECT_WRITE_OPERATION, resource: objectResource('native-image', objectId)});

// A delegate compilation service that records every artifact compilation asked of it. Prototype
// delegation, so the owner's own instance keeps working behind it. This is the compiler owner's
// admission point: if it records nothing, nothing was compiled.
function countingCompilation(compilation) {
  const compiled = [];
  const delegate = Object.create(compilation);
  delegate.compileArtifact = async (...args) => {
    compiled.push(args[1]?.id ?? null);
    return await compilation.compileArtifact(...args);
  };
  return {compilation: delegate, compiled};
}

// THE EXECUTABLE ARTIFACT, OPENED RATHER THAN BELIEVED.
//
// `block.metadata.lane` is a LABEL the installer wrote, and bead lagrange-images-it3 established
// that an implementation which merely labelled a neutral artifact `wasm` passes any metadata-only
// check. So every lane claim below also walks the Block to its code artifact, validates it against
// the wasm-function/v2 contract, follows its single `module` dependency to the compiled module,
// resolves that module's implementation BYTES, and hands them to the host's own WebAssembly decoder
// — requiring that the function artifact's declared entry really is an exported function of the
// module that was compiled. A label cannot survive `new WebAssembly.Module`.
async function assertGenuinelyWasm(runtime, method, label) {
  const block = await runtime.images.getBlock(method.imageId, method.objectId);
  assert.equal(block.metadata?.lane, 'wasm', `${label}: the method evolution owner recorded the WASM lane`);
  assert.equal(block.metadata?.smalltalk, 'method', `${label}: and recorded it on an ordinary native method Block`);

  const fn = await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId);
  assert.equal(fn.representation, WASM_FUNCTION_V2, `${label}: the bound code artifact is a WASM function`);
  assertWasmFunctionV2Artifact(fn);
  const moduleDependencies = fn.dependencies.filter(({role}) => role === WASM_FUNCTION_MODULE_DEPENDENCY_ROLE);
  assert.equal(moduleDependencies.length, 1, `${label}: exactly one module dependency`);
  const moduleArtifact = await runtime.images.getCodeArtifact(
    moduleDependencies[0].artifact.imageId, moduleDependencies[0].artifact.objectId,
  );
  assertWasmModuleV2Artifact(moduleArtifact);
  const bytes = await readModuleImplementationBytes(moduleArtifact, {
    resolveImplementation: (ref) => runtime.images.getCodeArtifact(ref.imageId, ref.objectId),
  });
  assert.deepEqual([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d], `${label}: the module bytes carry the WASM magic`);
  const {entry} = JSON.parse(fn.content.value);
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes));
  assert.ok(
    exports.some(({name, kind}) => name === entry && kind === 'function'),
    `${label}: the artifact's entry ${entry} must be a real exported function of the compiled module`,
  );
}

// Where a lane could leak into the Environment-facing contract, checked as KEYS AND VALUES rather
// than as a substring scan. The substring instrument would be the wrong one here: ADR 0086 revision
// identity is derived in part from the lane (bead lagrange-images-it3), and it travels inside an
// OPAQUE base64url Block id that the consumer may compare and round-trip but never interpret. What
// must not happen is a lane appearing as a field the Environment could read or a value it could act
// on, and that is exactly what this answers.
function laneVocabulary(value, path = '$', found = []) {
  if (typeof value === 'string') {
    if (value === 'wasm' || value === 'neutral') found.push(`${path} = ${value}`);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    if (/^lane$/i.test(key)) found.push(`${path}.${key}`);
    laneVocabulary(entry, `${path}.${key}`, found);
  }
  return found;
}

// THE ACCEPTANCE. One test on purpose: it is a single vertical, and splitting it would mean either
// re-running the real Cuis build's downstream import several times or sharing mutable state between
// tests that must observe one another's revisions in order.
test('the real upstream Json>>ctorMap is replaced through the authorized E3 seam with Cuis absent', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await jsonSemanticExport());

  // ---- 1. THE REAL BOUNDARY -------------------------------------------------------------------
  // The subject is named by the canonical export's own semantic identity and pinned to its upstream
  // source. The toolchain that produced this manifest ran in a runtime that was CLOSED before the
  // native runtime below existed (see `jsonSemanticExport`), so the whole sequence sits on the
  // native side of the cut.
  const upstream = manifest.methods.find(({identity}) => identity === CTOR_MAP_IDENTITY);
  assert.ok(upstream, `${CTOR_MAP_IDENTITY} is real upstream material in the canonical export`);
  assert.equal(upstream.class, 'cuis-class/JSON/Json');
  assert.equal(upstream.side, 'instance');
  assert.equal(upstream.selector, 'ctorMap');
  assert.equal(upstream.source, CTOR_MAP_UPSTREAM_SOURCE, 'the pinned upstream source, unedited');

  const runtime = await nativeRuntime();
  try {
    // Cuis is absent BEFORE the E3 sequence. Asserted here as well as inside `nativeRuntime` so the
    // pairing with the post-execution assertion in step 10 is legible at both ends.
    assert.deepEqual(runtime.toolchainProviders.list(), [], 'no Cuis toolchain provider before E3');
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), [], 'no Cuis foreign runtime before E3');

    // The MINIMUM native scope: the declaring class and the one method under test. `ctorMap:` is
    // deliberately excluded — nothing in this test may assign the slot, because A's answer is
    // measured rather than manufactured.
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: ['cuis-class/JSON/Json'], methods: [CTOR_MAP_IDENTITY]},
    });
    assert.deepEqual(imported.classes.map(({identity}) => identity), ['cuis-class/JSON/Json']);
    const {classRef} = imported.classes[0];
    assert.equal(
      await methodBlockRef({images: runtime.images, imageId: 'native-image', classRef, selector: 'ctorMap:'}),
      null,
      'the setter was NOT imported, so nothing can assign the slot A reads',
    );

    // ---- 2. AN ORDINARY NATIVE RECEIVER ---------------------------------------------------------
    // Allocated through the ordinary native allocation protocol — `basicNew` sent to the imported
    // class — and every A/B/C behaviour claim below sends `ctorMap` to THIS receiver through normal
    // native dispatch. No method Block is ever invoked directly.
    const allocate = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'native-image', id: 'e3-allocate', source: '[ :class | class basicNew ]',
    });
    const instance = await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('native-image', allocate.block.id), [classRef],
    ));

    let sends = 0;
    const sendCtorMap = async () => {
      sends += 1;
      const {block} = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'native-image', id: `e3-send-${sends}`,
        source: '[ :receiver | receiver ctorMap ]',
      });
      return await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', block.id), [instance],
      ));
    };

    // The Environment's own read authority, rebuilt for each revision: the class's own `object/read`
    // plus the CURRENT method Block's independent one (ADR 0087 — neither half alone suffices).
    // Learning which Block id to GRANT is Images-side fixture setup; every claim below still reads
    // the ref back out of the authorized seam rather than from here.
    const readerForCurrent = async () => {
      const method = await methodBlockRef({images: runtime.images, imageId: 'native-image', classRef, selector: 'ctorMap'});
      assert.ok(method, 'the position is bound');
      return browseRequire(runtime, [classRef.objectId, method.objectId]);
    };
    const describeCurrent = async () => await authorizedDescribeSmalltalkMethod({
      images: runtime.images, imageId: 'native-image', classRef, selector: 'ctorMap',
      require: await readerForCurrent(),
    });
    const readCurrentForUpdate = async () => await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images, imageId: 'native-image', classRef, selector: 'ctorMap',
      require: await readerForCurrent(),
    });

    // REVISION A, as the Environment learns it: through ADR 0087's browse seam, never from the
    // importer's transient output.
    const descriptionA = await describeCurrent();
    const a = descriptionA.method;
    assert.equal(descriptionA.format, 'smalltalk-method-description/v1');
    assert.deepEqual(descriptionA.class, classRef);
    assert.equal(descriptionA.selector, 'ctorMap');
    assert.equal(descriptionA.side, 'instance');
    assert.equal(descriptionA.source, null);
    assert.equal(descriptionA.provenance, null);
    await assertGenuinelyWasm(runtime, a, 'A (the pinned upstream revision)');
    const blockA = await runtime.images.getBlock(a.imageId, a.objectId);

    // A'S ANSWER, MEASURED. `^ ctorMap` reads an instance variable nothing has assigned, so the real
    // upstream accessor answers this image's `nil` on a fresh receiver. Recorded as the fact it is:
    // the acceptance did not choose it, and it is asserted so that a later change to allocation or
    // slot semantics reddens here rather than silently altering what "A's behaviour" means.
    assert.deepEqual(
      await sendCtorMap(),
      objectRef('native-image', 'smalltalk/nil'),
      'the genuine upstream accessor, reached by ordinary native dispatch',
    );

    // ---- 3. THE PUBLIC VERSION-AWARE READ -------------------------------------------------------
    const readA = await readCurrentForUpdate();
    assert.deepEqual(Object.keys(readA).sort(), ['descriptor', 'versionToken']);
    const {descriptor: descriptorA, versionToken: tokenA} = readA;
    // EXACTLY the canonical ADR 0087 descriptor — the same object the browse seam answers, not a
    // second description shape that happens to carry the same fields.
    assert.deepEqual(descriptorA, descriptionA, 'the read-for-update descriptor IS the ADR 0087 description');
    assert.deepEqual(descriptorA.method, a, 'and it names exactly Block A');
    assert.equal(typeof tokenA, 'string');
    assert.ok(tokenA.length > 0);

    // ---- 4. A COMPETING EDITOR REPLACES A WITH B ------------------------------------------------
    // Through the TRUSTED Images-native owner path rather than the public writer, so the stale leg
    // below is a genuine third-party conflict instead of this test racing itself.
    //
    // NO LANE IS NAMED. If this call chose `lane: 'wasm'`, the lane-preservation claim about B would
    // be vacuous — it would be proving that a named lane is honoured, which is a different rule.
    // B ends up in the WASM lane only because bead lagrange-images-it3's observed-revision rule
    // preserves A's lane.
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef,
      methods: [{selector: 'ctorMap', source: REPLACEMENT_B, expectedCurrent: a}],
    });

    const b = (await describeCurrent()).method;
    assert.notDeepEqual(b, a, 'B is a FRESH immutable revision, not a mutation of A');
    assert.deepEqual(await runtime.images.getBlock(a.imageId, a.objectId), blockA,
      'and A survives unchanged: a replacement stops pointing at the old revision, it does not edit it');
    await assertGenuinelyWasm(runtime, b, 'B (the competing editor\'s revision)');
    assert.deepEqual(await sendCtorMap(), integerValue(11), 'ordinary dispatch now answers B');
    const blockB = await runtime.images.getBlock(b.imageId, b.objectId);

    // ---- 5. THE PUBLIC WRITER, WITH A STALE TOKEN A ---------------------------------------------
    // Token A was minted in step 3, BEFORE B landed — it was never a fresh read taken after the
    // fact — so this is a real overtaken observation. The compilation service is instrumented: ADR
    // 0088 decision 5 requires the stale verdict to precede compilation, and an implementation that
    // compiled first would be indistinguishable from this one by any assertion about final state.
    const {compilation: instrumented, compiled} = countingCompilation(runtime.compilation);
    const staleWriter = recordingRequire(runtime, [writeGrant(classRef.objectId)]);
    const stale = await authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation: instrumented,
      imageId: 'native-image',
      classRef,
      selector: 'ctorMap',
      source: REPLACEMENT_C,
      expectedVersionToken: tokenA,
      require: staleWriter,
    }).then(() => null, (error) => error);

    assert.equal(stale?.name, 'SmalltalkStaleMethodPositionError',
      `an overtaken observation must be refused as stale; got ${stale?.name}: ${stale?.message}`);
    assert.deepEqual(compiled, [], 'and the replacement source was never compiled');
    assert.deepEqual(staleWriter.demands, [
      {operation: OBJECT_WRITE_OPERATION, resource: objectResource('native-image', classRef.objectId)},
    ], 'a stale call still authorizes first, and demands only the declaring class\'s write');
    // The refusal discloses nothing about the winner, and carries no backend error out with it.
    assert.equal(stale.cause, undefined);
    assert.equal(String(stale.message).includes(b.objectId), false, 'a stale refusal names no winning Block');
    // The winner survives, by the public reader AND by execution.
    assert.deepEqual((await describeCurrent()).method, b, 'B remains the exact current binding');
    assert.deepEqual(await sendCtorMap(), integerValue(11), 'and dispatch still answers B');
    await assertGenuinelyWasm(runtime, b, 'B after the refused replacement');

    // ---- 6. A FRESH PUBLIC READ OF B ------------------------------------------------------------
    const readB = await readCurrentForUpdate();
    const {descriptor: descriptorB, versionToken: tokenB} = readB;
    assert.deepEqual(descriptorB.method, b, 'the descriptor names exactly Block B');
    assert.notEqual(tokenB, tokenA, 'a new observation is a different assumption');
    assert.equal(descriptorB.source, null);

    // ---- 7. THE PUBLIC REPLACEMENT B -> C -------------------------------------------------------
    const writer = recordingRequire(runtime, [writeGrant(classRef.objectId)]);
    const receipt = await authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation: instrumented,
      imageId: 'native-image',
      classRef,
      selector: 'ctorMap',
      source: REPLACEMENT_C,
      expectedVersionToken: tokenB,
      require: writer,
    });
    assert.deepEqual(receipt, {replaced: true});
    assert.deepEqual(Object.keys(receipt), ['replaced'], 'the receipt is one key and no more');
    assert.equal(Object.isFrozen(receipt), true);
    // Exactly one authority demand: `object/write` on the declaring Class. No write on A, on B, or
    // on anything else, and no read demand at all.
    assert.deepEqual(writer.demands, [
      {operation: OBJECT_WRITE_OPERATION, resource: objectResource('native-image', classRef.objectId)},
    ]);
    // THE SPY IS DEMONSTRABLY WIRED. The same instrumented service that recorded NOTHING for the
    // stale call records this one's compilation. Without this, "never compiled" in step 5 would be
    // satisfied just as well by a spy that could never fire.
    assert.ok(compiled.length > 0, 'the same instrumented compiler DID compile the successful replacement');

    // C IS DISCOVERED BY A FRESH AUTHORIZED READ, never from the receipt — which is exactly what the
    // consumer committed to (#218 point 4) and why the receipt carries no ref to predict it from.
    const readC = await readCurrentForUpdate();
    const {descriptor: descriptorC, versionToken: tokenC} = readC;
    const c = descriptorC.method;
    assert.notDeepEqual(c, b, 'C is a fresh revision, distinct from B');
    assert.notDeepEqual(c, a, 'and distinct from A');
    assert.deepEqual(await runtime.images.getBlock(a.imageId, a.objectId), blockA, 'A is still an addressable immutable revision');
    assert.deepEqual(await runtime.images.getBlock(b.imageId, b.objectId), blockB, 'and so is B');
    await assertGenuinelyWasm(runtime, c, 'C (the publicly replaced revision)');
    assert.deepEqual(await sendCtorMap(), integerValue(22), 'and ordinary dispatch answers C');

    // ---- 8. SOURCE STAYS ABSENT -----------------------------------------------------------------
    // ADR 0087 decision 6's `source: null` is still truthful after a successful replacement: the
    // supplied text was compiled and not retained, so nothing about it is Environment-visible.
    const descriptionC = await describeCurrent();
    assert.deepEqual(descriptionC, descriptorC, 'browse and read-for-update agree on the new revision');
    assert.equal(descriptionC.source, null);
    assert.equal(descriptionC.provenance, null, 'Images owns no durable association back to the Cuis origin');
    assertOriginNeutralNativeDescription(descriptionC, 'the replaced method description');
    assert.equal(JSON.stringify(descriptionC).includes(REPLACEMENT_C), false,
      'the supplied source did not become retained, Environment-visible source');

    // ---- 9. THE AUTHORITY IS NARROW -------------------------------------------------------------
    // Not a re-proof of the C2 suite — just enough to show the REAL imported method takes the same
    // public seam under the same rule. Each of these holds a VALID, CURRENT token for C.
    for (const [label, grants] of [
      ['no grant at all', []],
      ['the full ADR 0087 read authority that minted the token', [readGrant(classRef.objectId), readGrant(c.objectId)]],
      ['object/write on the current revision instead of on the class', [writeGrant(c.objectId)]],
      ['object/write on the superseded revisions A and B', [writeGrant(a.objectId), writeGrant(b.objectId)]],
    ]) {
      const denied = recordingRequire(runtime, grants);
      const refusal = await authorizedReplaceSmalltalkMethod({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'native-image',
        classRef,
        selector: 'ctorMap',
        source: '[ ^ 33 ]',
        expectedVersionToken: tokenC,
        require: denied,
      }).then(() => null, (error) => error);
      assert.equal(refusal?.name, 'AuthorityError', `${label} must not authorize a replacement`);
      assert.deepEqual(denied.demands, [
        {operation: OBJECT_WRITE_OPERATION, resource: objectResource('native-image', classRef.objectId)},
      ], `${label}: the one demand is the declaring class's own write`);
    }
    assert.deepEqual((await describeCurrent()).method, c, 'no denied call moved the position');
    assert.deepEqual(await sendCtorMap(), integerValue(22));

    // ---- 10. CUIS IS STILL ABSENT ---------------------------------------------------------------
    // The pair matters: step 1 proves the sequence STARTED without Cuis, and this proves nothing
    // lazily started it during import, replacement or dispatch.
    assert.deepEqual(runtime.toolchainProviders.list(), [], 'nothing started a Cuis toolchain during E3');
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), [], 'and no Cuis foreign runtime');

    // ---- 11. THE LANE IS INTERNAL ---------------------------------------------------------------
    // A -> B -> C never left the WASM lane, proven above by BOTH the owner's recorded lane and a
    // genuine WebAssembly decode of the module each revision executes through.
    //
    // And none of it is Environment-facing: the descriptor's field set is exactly ADR 0087's, the
    // receipt's is one key, and no key or value in either — the token included — names a lane.
    assert.deepEqual(
      Object.keys(descriptorC).sort(),
      ['class', 'format', 'method', 'provenance', 'selector', 'side', 'source'],
      'the descriptor carries exactly the ADR 0087 field set and nothing this seam added',
    );
    assert.deepEqual(laneVocabulary(readC), [], 'the read-for-update result names no lane');
    assert.deepEqual(laneVocabulary(receipt), [], 'and neither does the receipt');

    // The replacement ARGUMENTS name no lane either — and cannot. The seam accepts a fixed argument
    // set, so a consumer that tried to choose one would be ignored rather than obeyed: this call
    // supplies `lane: 'neutral'` and the position stays genuinely WASM.
    const laneWriter = recordingRequire(runtime, [writeGrant(classRef.objectId)]);
    assert.deepEqual(await authorizedReplaceSmalltalkMethod({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef,
      selector: 'ctorMap',
      source: '[ ^ 44 ]',
      expectedVersionToken: tokenC,
      require: laneWriter,
      lane: 'neutral',
    }), {replaced: true});
    const afterLaneAttempt = (await describeCurrent()).method;
    await assertGenuinelyWasm(runtime, afterLaneAttempt, 'the revision following a caller-named lane');
    assert.deepEqual(await sendCtorMap(), integerValue(44), 'the source was applied; only the lane request was inert');
  } finally {
    await runtime.close();
  }
});
