import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SEMANTIC_EXPORT_V1,
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  bytesValue,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  findSmalltalkKernel,
  importCuisNativePackage,
  installSmalltalkAllocationProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  methodBlockRef,
  objectRef,
  readBehavior,
  textValue,
} from '../src/runtime.js';
import {referencesOfRecord} from '../src/graph/references.js';

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';

// The multi-package cluster (Bead lagrange-images-d57), in dependency-satisfiable order.
const CLUSTER = [
  {fileName: 'ExtendedClipboard.pck.st', env: 'LAGRANGE_CUIS_EXTENDEDCLIPBOARD_PACKAGE_PATH', blob: 'd561a0dcedf37e6bd93c15cb07498c34ce6d3c5f'},
  {fileName: 'FFI.pck.st', env: 'LAGRANGE_CUIS_FFI_PACKAGE_PATH', blob: '76bcc869cb66a602d4658465177913269697118b'},
  {fileName: 'Graphics-Files-Additional.pck.st', env: 'LAGRANGE_CUIS_GRAPHICS_FILES_ADDITIONAL_PACKAGE_PATH', blob: '6cddf265949b90fd58d0fea0498df6a1c3594685'},
  {fileName: 'Alien-Core.pck.st', env: 'LAGRANGE_CUIS_ALIEN_CORE_PACKAGE_PATH', blob: '59a2b4bdaa0f21287e3af3479cc31f6a71957758'},
  {fileName: 'WeakDictionaries.pck.st', env: 'LAGRANGE_CUIS_WEAKDICTIONARIES_PACKAGE_PATH', blob: '773620a6f3c15bb21deca5e9895ecfac881c8b64'},
  {fileName: 'Compression.pck.st', env: 'LAGRANGE_CUIS_COMPRESSION_PACKAGE_PATH', blob: '243d8265b411fc36a72dd101f21a18e7c94b2d87'},
];

const NATIVE_LAYOUT_PACKAGE = `'From Cuis7.9'!
'Lagrange ADR 0085 M1 native class-layout fixture'!
!provides: 'LagrangeNativeImportM1' 1 0!
!requires: 'Cuis-Base' 60 5557 nil!
SystemOrganization addCategory: #LagrangeNativeImportM1!

!classDefinition: #LagrangeNativeImportBase category: #LagrangeNativeImportM1!
Object subclass: #LagrangeNativeImportBase
\tinstanceVariableNames: 'baseValue'
\tclassVariableNames: ''
\tpoolDictionaries: ''
\tcategory: 'LagrangeNativeImportM1'!
!classDefinition: 'LagrangeNativeImportBase class' category: #LagrangeNativeImportM1!
LagrangeNativeImportBase class
\tinstanceVariableNames: ''!

!classDefinition: #LagrangeNativeImportChild category: #LagrangeNativeImportM1!
LagrangeNativeImportBase subclass: #LagrangeNativeImportChild
\tinstanceVariableNames: 'childFirst childSecond'
\tclassVariableNames: ''
\tpoolDictionaries: ''
\tcategory: 'LagrangeNativeImportM1'!
!classDefinition: 'LagrangeNativeImportChild class' category: #LagrangeNativeImportM1!
LagrangeNativeImportChild class
\tinstanceVariableNames: ''!

!LagrangeNativeImportBase methodsFor: 'accessing' stamp: 'Lagrange 9/4/2026 15:00'!
baseValue
\t^ baseValue! !

!LagrangeNativeImportBase methodsFor: 'accessing' stamp: 'Lagrange 9/4/2026 15:00'!
baseValue: aValue
\tbaseValue := aValue! !

!LagrangeNativeImportChild methodsFor: 'accessing' stamp: 'Lagrange 9/4/2026 15:00'!
childFirst
\t^ childFirst! !

!LagrangeNativeImportChild methodsFor: 'accessing' stamp: 'Lagrange 9/4/2026 15:00'!
childFirst: aValue
\tchildFirst := aValue! !

!LagrangeNativeImportChild methodsFor: 'accessing' stamp: 'Lagrange 9/4/2026 15:00'!
childSecond
\t^ childSecond! !

!LagrangeNativeImportChild methodsFor: 'accessing' stamp: 'Lagrange 9/4/2026 15:00'!
childSecond: aValue
\tchildSecond := aValue! !
`;

const nativeMethodReconciliationPackage = (answer) => `'From Cuis7.9'!
'Lagrange ADR 0085 native imported-method reconciliation fixture'!
!provides: 'LagrangeNativeMethodReconciliation' 1 0!
!requires: 'Cuis-Base' 60 5557 nil!
SystemOrganization addCategory: #LagrangeNativeMethodReconciliation!

!classDefinition: #LagrangeNativeMethodTarget category: #LagrangeNativeMethodReconciliation!
Object subclass: #LagrangeNativeMethodTarget
\tinstanceVariableNames: ''
\tclassVariableNames: ''
\tpoolDictionaries: ''
\tcategory: 'LagrangeNativeMethodReconciliation'!
!classDefinition: 'LagrangeNativeMethodTarget class' category: #LagrangeNativeMethodReconciliation!
LagrangeNativeMethodTarget class
\tinstanceVariableNames: ''!

!LagrangeNativeMethodTarget methodsFor: 'testing' stamp: 'Lagrange 9/4/2026 20:00'!
stable
\t^ 9! !

!LagrangeNativeMethodTarget methodsFor: 'testing' stamp: 'Lagrange 9/4/2026 20:00'!
value
\t^ ${answer}! !
`;

async function put(runtime, id, representation, content, {metadata = {}, dependencies = [], logicalPath = null} = {}) {
  return await runtime.images.putCodeArtifact('build-image', {
    id, languageId: 'smalltalk', representation, content, ...(logicalPath ? {logicalPath} : {}), metadata, dependencies,
  });
}

async function buildCluster(runtime, {stem}) {
  const baseImage = await put(runtime, `bi-${stem}`, CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {logicalPath: 'Cuis7.9-8090.image'});
  const baseChanges = await put(runtime, `bc-${stem}`, CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {logicalPath: 'Cuis7.9-8090.changes'});
  const baseSources = await put(runtime, `bs-${stem}`, CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {logicalPath: 'Cuis7.8.sources'});
  const deps = [
    {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
    {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
    {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
  ];
  for (const spec of CLUSTER) {
    const pkg = await put(runtime, `p-${stem}-${spec.fileName}`, CUIS_PACKAGE_V1, textValue(await readFile(process.env[spec.env], 'utf8')), {
      logicalPath: spec.fileName, metadata: {identity: `cuis-package/${spec.fileName.replace(/\.pck\.st$/, '')}/${CUIS_COMMIT}/gitblob:${spec.blob}`},
    });
    deps.push({role: 'package', artifact: objectRef('build-image', pkg.id)});
  }
  const build = await put(runtime, `build-${stem}`, CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {});
  await runtime.images.putCodeArtifact('build-image', {
    id: `buildroot-${stem}`, languageId: 'smalltalk', representation: CUIS_BUILD_V1,
    content: textValue(CUIS_BUILD_CONTRACT_V0), metadata: {}, dependencies: deps,
  });
  const result = await runtime.toolchains.run({
    providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
    imageId: 'build-image',
    roots: [objectRef('build-image', `buildroot-${stem}`)],
    target: {representation: CUIS_IMAGE_V1, fileName: `${stem}.image`},
    options: {semanticExport: true},
    outputIds: {image: `${stem}-image`, changes: `${stem}-changes`, 'semantic-export': `${stem}-export`},
  });
  const exportArtifact = await runtime.images.getCodeArtifact('build-image', `${stem}-export`);
  assert.equal(exportArtifact.representation, CUIS_SEMANTIC_EXPORT_V1);
  return {result, exportText: exportArtifact.content.value};
}

async function buildNativeLayoutFixture(runtime, {stem}) {
  const baseImage = await put(runtime, `layout-bi-${stem}`, CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {logicalPath: 'Cuis7.9-8090.image'});
  const baseChanges = await put(runtime, `layout-bc-${stem}`, CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {logicalPath: 'Cuis7.9-8090.changes'});
  const baseSources = await put(runtime, `layout-bs-${stem}`, CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {logicalPath: 'Cuis7.8.sources'});
  const pkg = await put(runtime, `layout-p-${stem}`, CUIS_PACKAGE_V1, textValue(NATIVE_LAYOUT_PACKAGE), {logicalPath: 'LagrangeNativeImportM1.pck.st'});
  await runtime.images.putCodeArtifact('build-image', {
    id: `layout-buildroot-${stem}`,
    languageId: 'smalltalk',
    representation: CUIS_BUILD_V1,
    content: textValue(CUIS_BUILD_CONTRACT_V0),
    metadata: {},
    dependencies: [
      {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
      {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
      {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
      {role: 'package', artifact: objectRef('build-image', pkg.id)},
    ],
  });
  await runtime.toolchains.run({
    providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
    imageId: 'build-image',
    roots: [objectRef('build-image', `layout-buildroot-${stem}`)],
    target: {representation: CUIS_IMAGE_V1, fileName: `${stem}.image`},
    options: {semanticExport: CUIS_SEMANTIC_EXPORT_V2},
    outputIds: {image: `${stem}-image`, changes: `${stem}-changes`, 'semantic-export': `${stem}-export`},
  });
  const artifact = await runtime.images.getCodeArtifact('build-image', `${stem}-export`);
  assert.equal(artifact.representation, CUIS_SEMANTIC_EXPORT_V2);
  return artifact.content.value;
}

async function buildNativeMethodReconciliationFixture(runtime, {stem, answer}) {
  const baseImage = await put(runtime, `method-bi-${stem}`, CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {logicalPath: 'Cuis7.9-8090.image'});
  const baseChanges = await put(runtime, `method-bc-${stem}`, CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {logicalPath: 'Cuis7.9-8090.changes'});
  const baseSources = await put(runtime, `method-bs-${stem}`, CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {logicalPath: 'Cuis7.8.sources'});
  const pkg = await put(runtime, `method-p-${stem}`, CUIS_PACKAGE_V1, textValue(nativeMethodReconciliationPackage(answer)), {
    logicalPath: 'LagrangeNativeMethodReconciliation.pck.st',
  });
  await runtime.images.putCodeArtifact('build-image', {
    id: `method-buildroot-${stem}`,
    languageId: 'smalltalk',
    representation: CUIS_BUILD_V1,
    content: textValue(CUIS_BUILD_CONTRACT_V0),
    metadata: {},
    dependencies: [
      {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
      {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
      {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
      {role: 'package', artifact: objectRef('build-image', pkg.id)},
    ],
  });
  await runtime.toolchains.run({
    providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
    imageId: 'build-image',
    roots: [objectRef('build-image', `method-buildroot-${stem}`)],
    target: {representation: CUIS_IMAGE_V1, fileName: `${stem}.image`},
    options: {semanticExport: CUIS_SEMANTIC_EXPORT_V2},
    outputIds: {image: `${stem}-image`, changes: `${stem}-changes`, 'semantic-export': `${stem}-export`},
  });
  const artifact = await runtime.images.getCodeArtifact('build-image', `${stem}-export`);
  assert.equal(artifact.representation, CUIS_SEMANTIC_EXPORT_V2);
  return JSON.parse(artifact.content.value);
}

test('real Cuis v2 export carries ordered local declarations and complete method source', {skip: !enabled, timeout: 600_000}, async () => {
  const toolchainProvider = createOpenSmalltalkCuisToolchainProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 600_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, toolchainProvider]],
  });
  await runtime.images.createImage({id: 'build-image'});
  try {
    const firstText = await buildNativeLayoutFixture(runtime, {stem: 'NativeLayoutA'});
    const secondText = await buildNativeLayoutFixture(runtime, {stem: 'NativeLayoutB'});
    assert.equal(secondText, firstText, 'equivalent real class declarations export byte-identically');

    const manifest = JSON.parse(firstText);
    assert.equal(manifest.format, CUIS_SEMANTIC_EXPORT_V2);
    assert.deepEqual(manifest.packages, [{name: 'LagrangeNativeImportM1', requires: ['Cuis-Base']}]);
    const base = manifest.classes.find((candidate) => candidate.name === 'LagrangeNativeImportBase');
    const child = manifest.classes.find((candidate) => candidate.name === 'LagrangeNativeImportChild');
    assert.equal(base.superclass, 'cuis-class/Cuis-Base/Object');
    assert.deepEqual(base.instanceVariables, ['baseValue']);
    assert.equal(child.superclass, 'cuis-class/LagrangeNativeImportM1/LagrangeNativeImportBase');
    assert.deepEqual(child.instanceVariables, ['childFirst', 'childSecond']);
    assert.equal(child.instanceVariables.includes('baseValue'), false, 'the export must not flatten inherited layout');
    assert.deepEqual(
      manifest.methods.map(({class: target, side, selector}) => [target, side, selector]),
      [
        ['cuis-class/LagrangeNativeImportM1/LagrangeNativeImportBase', 'instance', 'baseValue'],
        ['cuis-class/LagrangeNativeImportM1/LagrangeNativeImportBase', 'instance', 'baseValue:'],
        ['cuis-class/LagrangeNativeImportM1/LagrangeNativeImportChild', 'instance', 'childFirst'],
        ['cuis-class/LagrangeNativeImportM1/LagrangeNativeImportChild', 'instance', 'childFirst:'],
        ['cuis-class/LagrangeNativeImportM1/LagrangeNativeImportChild', 'instance', 'childSecond'],
        ['cuis-class/LagrangeNativeImportM1/LagrangeNativeImportChild', 'instance', 'childSecond:'],
      ],
    );
    assert.equal(
      manifest.methods.find(({selector}) => selector === 'baseValue:').source,
      'baseValue: aValue\n\tbaseValue := aValue',
    );

    const serialized = JSON.stringify(manifest);
    assert.doesNotMatch(serialized, /\b(?:oop|offset|address)\b/i);
  } finally {
    await runtime.close();
  }
});

test('real Cuis v2 classes and methods become native WASM behavior after the VM is gone', {skip: !enabled, timeout: 600_000}, async () => {
  let exportText;
  const buildRuntime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({
      vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 600_000,
    })]],
  });
  try {
    await buildRuntime.images.createImage({id: 'build-image'});
    exportText = await buildNativeLayoutFixture(buildRuntime, {stem: 'NativeImport'});
  } finally {
    // The toolchain process has already exited; closing its owning runtime makes the cut explicit.
    // Nothing below retains an image, provider, service or handle from this side of the boundary.
    await buildRuntime.close();
  }

  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    assert.deepEqual(runtime.toolchainProviders.list(), [], 'the native runtime has no Cuis toolchain provider');
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), [], 'the native runtime has no foreign runtime fallback');
    await runtime.images.createImage({id: 'native-image'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', lane: 'neutral',
    });
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'native-image'});

    const manifest = JSON.parse(exportText);
    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest,
    });
    const byIdentity = new Map(imported.classes.map((entry) => [entry.identity, entry]));
    const base = byIdentity.get('cuis-class/LagrangeNativeImportM1/LagrangeNativeImportBase');
    const child = byIdentity.get('cuis-class/LagrangeNativeImportM1/LagrangeNativeImportChild');
    assert.ok(base && child);

    const baseBehavior = await readBehavior(runtime.images, base.classRef);
    const childBehavior = await readBehavior(runtime.images, child.classRef);
    const baseMetaclass = await readBehavior(runtime.images, base.metaclassRef);
    const childMetaclass = await readBehavior(runtime.images, child.metaclassRef);
    assert.deepEqual(baseBehavior.record.behavior, base.metaclassRef);
    assert.deepEqual(childBehavior.record.behavior, child.metaclassRef);
    assert.deepEqual(baseBehavior.superclass, kernel.objectClass, 'the exact Cuis-Base/Object mapping is structural M1 compatibility');
    assert.deepEqual(childBehavior.superclass, base.classRef);
    assert.deepEqual(childMetaclass.superclass, base.metaclassRef);
    assert.deepEqual(baseMetaclass.record.behavior, kernel.metaclassClass);

    const baseShape = await runtime.images.getShape(
      baseBehavior.instanceShape.imageId, baseBehavior.instanceShape.objectId,
    );
    const childShape = await runtime.images.getShape(
      childBehavior.instanceShape.imageId, childBehavior.instanceShape.objectId,
    );
    assert.deepEqual(baseShape.slots.map(({name}) => name), ['baseValue']);
    assert.deepEqual(childShape.slots.map(({name}) => name), ['baseValue', 'childFirst', 'childSecond']);
    assert.deepEqual(childShape.slots[0], baseShape.slots[0], 'native inheritance composes the declared base slot');

    const frontierBeforeReplay = await runtime.images.frontier('native-image');
    const replayed = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest,
    });
    assert.deepEqual(replayed, imported);
    assert.equal(await runtime.images.frontier('native-image'), frontierBeforeReplay, 'A -> A import replay is write-free');

    const allocate = async (id) => {
      const installed = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'native-image', id, source: '[ :class | class basicNew ]',
      });
      const activation = await runtime.invocations.invokeBlock(
        objectRef('native-image', installed.block.id), [child.classRef],
      );
      return await runtime.executor.execute(activation);
    };
    const instance = await allocate('allocate-imported-child');
    const peer = await allocate('allocate-imported-peer');
    assert.equal(instance.kind, 'ref');
    assert.equal(peer.kind, 'ref');
    assert.notEqual(instance.objectId, peer.objectId);

    const allocated = await runtime.images.getObject('native-image', instance.objectId);
    assert.deepEqual(allocated.behavior, child.classRef);
    assert.deepEqual(allocated.shape, childBehavior.instanceShape);
    assert.deepEqual(
      Object.values(allocated.slots),
      [kernel.nil, kernel.nil, kernel.nil],
      'the native allocation owner initializes the complete imported layout',
    );
    const mutate = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'mutate-imported-child',
      source: "[ :object :other | object baseValue: 'base-state'. object childFirst: 42. object childSecond: other ]",
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', mutate.block.id), [instance, peer],
      )),
      instance,
      'a real Cuis setter answers its receiver rather than the assigned value',
    );
    const readImported = async (id, selector) => {
      const block = await installSymmetricSmalltalkBlock({
        images: runtime.images,
        imageId: 'native-image',
        id,
        source: `[ :object | object ${selector} ]`,
      });
      return await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', block.block.id), [instance],
      ));
    };
    assert.deepEqual(
      await readImported('read-imported-base', 'baseValue'),
      textValue('base-state'),
      'the child reaches the imported base reader through native inheritance',
    );
    assert.deepEqual(await readImported('read-imported-first', 'childFirst'), integerValue(42));
    assert.deepEqual(await readImported('read-imported-second', 'childSecond'), peer);

    const reread = await runtime.images.getObject('native-image', instance.objectId);
    const slotByName = new Map(childShape.slots.map(({id, name}) => [name, id]));
    assert.deepEqual(reread.slots[slotByName.get('baseValue')], textValue('base-state'));
    assert.deepEqual(reread.slots[slotByName.get('childFirst')], integerValue(42));
    assert.deepEqual(reread.slots[slotByName.get('childSecond')], peer);

    const records = await runtime.images.listRecords('native-image');
    assert.equal(
      records.some((record) => record.kind === 'object' && record.behavior?.objectId === 'smalltalk/class/CuisExportClass'),
      false,
      'no CuisExportClass representation participates in native construction, allocation or state',
    );
    assert.equal(await runtime.images.getObject('native-image', 'smalltalk/class/CuisExportClass'), null);
    const importedMethodSelectors = [
      'baseValue', 'baseValue:', 'childFirst', 'childFirst:', 'childSecond', 'childSecond:',
    ];
    const importedMethodBlocks = records.filter((record) =>
      record.kind === 'block' && record.metadata?.smalltalk === 'method'
        && importedMethodSelectors.includes(record.metadata.selector));
    assert.equal(importedMethodBlocks.length, importedMethodSelectors.length);
    assert.ok(importedMethodBlocks.every((record) => record.metadata.lane === 'wasm'));
    for (const block of importedMethodBlocks) {
      assert.equal(
        (await runtime.images.getCodeArtifact(block.code.imageId, block.code.objectId)).representation,
        'wasm-function/v2',
      );
    }
    const nativeImportGraph = records.filter((record) =>
      record.id.includes('LagrangeNativeImport') || record.id === instance.objectId || record.id === peer.objectId);
    const nativeIdentityText = JSON.stringify(nativeImportGraph.flatMap((record) => [
      record.id,
      ...(record.kind === 'shape' ? record.slots.map(({id}) => id) : []),
      ...(record.kind === 'object' ? Object.keys(record.slots) : []),
      ...(record.kind === 'lexical-environment' ? Object.keys(record.bindings) : []),
      ...referencesOfRecord(record).flatMap((ref) => [ref.imageId, ref.objectId]),
    ]));
    assert.doesNotMatch(
      nativeIdentityText,
      /cuis-(?:class|method)\//,
      'Cuis semantic identity is not native runtime identity',
    );
    assert.doesNotMatch(
      nativeIdentityText,
      /@[0-9a-f]{6,}|\b0x[0-9a-f]+\b|\/\d{7,}\b|\b\d{9,}\b/i,
      'no Spur address/oop form leaks into durable identity or graph references',
    );
    assert.doesNotMatch(nativeIdentityText, /\b(?:oop|offset|address)\b/i);
  } finally {
    await runtime.close();
  }
});

test('real Cuis A import -> A replay -> B method change -> B replay advances only the native selector binding', {skip: !enabled, timeout: 900_000}, async () => {
  let manifestA;
  let manifestB;
  const buildRuntime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({
      vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 600_000,
    })]],
  });
  try {
    await buildRuntime.images.createImage({id: 'build-image'});
    manifestA = await buildNativeMethodReconciliationFixture(buildRuntime, {stem: 'NativeMethodA', answer: 1});
    manifestB = await buildNativeMethodReconciliationFixture(buildRuntime, {stem: 'NativeMethodB', answer: 2});
    const sourceBySelector = (manifest) => new Map(manifest.methods.map(({selector, source}) => [selector, source]));
    assert.equal(sourceBySelector(manifestA).get('value'), 'value\n\t^ 1');
    assert.equal(sourceBySelector(manifestB).get('value'), 'value\n\t^ 2');
    assert.equal(sourceBySelector(manifestA).get('stable'), sourceBySelector(manifestB).get('stable'));
    assert.deepEqual(manifestB.classes, manifestA.classes, 'class identity and layout remain unchanged');
    const positions = (manifest) => manifest.methods.map(({
      identity, package: packageName, class: classIdentity, side, selector,
    }) => ({identity, package: packageName, class: classIdentity, side, selector}));
    assert.deepEqual(positions(manifestB), positions(manifestA),
      'package, class, side, selector and canonical method identity remain unchanged');
  } finally {
    // Both real exports are now portable semantic data. The runtime/provider/toolchain boundary is
    // gone before any native import or execution below.
    await buildRuntime.close();
  }

  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    assert.deepEqual(runtime.toolchainProviders.list(), []);
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
    await runtime.images.createImage({id: 'native-image'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    await installSmalltalkAllocationProtocol({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', lane: 'neutral',
    });
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'native-image'});

    const targetIdentity = 'cuis-class/LagrangeNativeMethodReconciliation/LagrangeNativeMethodTarget';
    const importedA = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest: manifestA,
    });
    const targetA = importedA.classes.find(({identity}) => identity === targetIdentity);
    const valueA = await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: targetA.classRef, selector: 'value',
    });
    const stableA = await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: targetA.classRef, selector: 'stable',
    });
    const blockA = await runtime.images.getBlock(valueA.imageId, valueA.objectId);
    const semanticA = await runtime.images.getCodeArtifact('native-image', `${blockA.id}:semantic`);
    const behaviorA = await readBehavior(runtime.images, targetA.classRef);
    const dictionaryA = await runtime.images.getObject(behaviorA.methods.imageId, behaviorA.methods.objectId);

    const allocate = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'native-image', id: 'method-reconciliation-allocation',
      source: '[ :class | class basicNew ]',
    });
    const instance = await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('native-image', allocate.block.id), [targetA.classRef],
    ));
    const execute = async (id, selector) => {
      const send = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'native-image', id, source: `[ :object | object ${selector} ]`,
      });
      return await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', send.block.id), [instance],
      ));
    };
    assert.deepEqual(await execute('execute-native-method-a', 'value'), integerValue(1));

    const historyA = await runtime.images.history('native-image');
    assert.deepEqual(await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest: manifestA,
    }), importedA);
    assert.equal((await runtime.images.history('native-image')).length, historyA.length, 'A replay is write-free');
    assert.deepEqual(await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: targetA.classRef, selector: 'value',
    }), valueA);

    const importedB = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest: manifestB,
    });
    const targetB = importedB.classes.find(({identity}) => identity === targetIdentity);
    const valueB = await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: targetB.classRef, selector: 'value',
    });
    const stableB = await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: targetB.classRef, selector: 'stable',
    });
    const blockB = await runtime.images.getBlock(valueB.imageId, valueB.objectId);
    const semanticB = await runtime.images.getCodeArtifact('native-image', `${blockB.id}:semantic`);
    const dictionaryB = await runtime.images.getObject(behaviorA.methods.imageId, behaviorA.methods.objectId);
    assert.deepEqual(targetB.classRef, targetA.classRef, 'native Class identity is stable');
    assert.notDeepEqual(valueB, valueA, 'value now names immutable native revision B');
    assert.notEqual(semanticB.id, semanticA.id);
    assert.notDeepEqual(blockB.code, blockA.code);
    assert.deepEqual(stableB, stableA, 'unrelated selector binding is unchanged');
    assert.equal(dictionaryB._version, dictionaryA._version + 1, 'MethodDictionary advances exactly once');
    assert.ok(await runtime.images.getBlock(valueA.imageId, valueA.objectId), 'immutable A remains durable');
    assert.deepEqual(await execute('execute-native-method-b', 'value'), integerValue(2));
    assert.deepEqual(await execute('execute-native-method-stable', 'stable'), integerValue(9));

    const historyB = await runtime.images.history('native-image');
    assert.deepEqual(await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest: manifestB,
    }), importedB);
    assert.equal((await runtime.images.history('native-image')).length, historyB.length, 'B replay is write-free');
    assert.deepEqual(await methodBlockRef({
      images: runtime.images, imageId: 'native-image', classRef: targetB.classRef, selector: 'value',
    }), valueB);
    assert.equal((await runtime.images.getObject(behaviorA.methods.imageId, behaviorA.methods.objectId))._version,
      dictionaryB._version);
  } finally {
    await runtime.close();
  }
});

test('Cuis semantic export captures package/class/method structure with semantic (not heap) identities', {skip: !enabled, timeout: 600_000}, async () => {
  const toolchainProvider = createOpenSmalltalkCuisToolchainProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 600_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, toolchainProvider]],
  });
  await runtime.images.createImage({id: 'build-image'});
  try {
    const {exportText} = await buildCluster(runtime, {stem: 'ClusterExport'});
    const manifest = JSON.parse(exportText);
    assert.equal(manifest.format, CUIS_SEMANTIC_EXPORT_V1);

    // Structure: every cluster package appears with its requirements.
    const packageByName = new Map(manifest.packages.map((p) => [p.name, p]));
    for (const name of ['ExtendedClipboard', 'FFI', 'Graphics-Files-Additional', 'Alien-Core', 'WeakDictionaries', 'Compression']) {
      assert.ok(packageByName.has(name), `manifest has package ${name}`);
    }
    assert.deepEqual(packageByName.get('FFI').requires, ['Alien-Core', 'WeakDictionaries']);
    assert.deepEqual(packageByName.get('Alien-Core').requires, ['WeakDictionaries']);
    assert.deepEqual(packageByName.get('ExtendedClipboard').requires, ['FFI', 'Graphics-Files-Additional']);
    assert.deepEqual(packageByName.get('Graphics-Files-Additional').requires, ['Compression']);

    // Classes carry semantic identities + superclass refs (base classes -> Cuis-Base).
    for (const cls of manifest.classes) {
      assert.equal(cls.identity, `cuis-class/${cls.package}/${cls.name}`);
    }
    const archive = manifest.classes.find((c) => c.package === 'Compression' && c.name === 'Archive');
    assert.ok(archive, 'Compression defines class Archive');
    assert.equal(archive.superclassName, 'Object');
    assert.equal(archive.superclass, 'cuis-class/Cuis-Base/Object');

    // Extension method: ByteArray>>unzipped is OWNED by Compression but TARGETS base ByteArray.
    // Per ADR 0072 §3 the method carries `class` (a cuis-class identity), not a raw className; the
    // target class name is the identity's last segment.
    const classNameOf = (m) => m.class.slice(m.class.lastIndexOf('/') + 1);
    const unzipped = manifest.methods.find((m) => m.selector === 'unzipped' && classNameOf(m) === 'ByteArray');
    assert.ok(unzipped, 'manifest has ByteArray>>unzipped');
    assert.equal(unzipped.package, 'Compression');
    assert.equal(unzipped.class, 'cuis-class/Cuis-Base/ByteArray');
    assert.equal(unzipped.side, 'instance');
    assert.match(unzipped.source, /GZipReadStream/);

    // Method identity form: cuis-method/<owningPkg>/<targetClassName>/<side>/<selector>, with the
    // target-class name matching the `class` ref's last segment. No HEAP identity leaks: an actual
    // Spur oop is a memory address (`@`+hex, `0x`+hex, or a long bare decimal). Match THOSE — not
    // the substring 'oop', which false-positives on legitimate Alien-Core selectors oopAt:/oopResult:.
    const heapIdentity = /@[0-9a-f]{6,}|\b0x[0-9a-f]+\b|\/\d{7,}\b|\b\d{9,}\b/i;
    for (const m of manifest.methods) {
      assert.equal(m.identity, `cuis-method/${m.package}/${classNameOf(m)}/${m.side}/${m.selector}`);
      assert.ok(!heapIdentity.test(m.identity), `no heap identity in method identity: ${m.identity}`);
    }
    // Sanity: the guard must actually be able to fire (falsification) — feed it a fake oop identity.
    assert.ok(heapIdentity.test('cuis-method/P/C/instance/0x0000abcdef12'), 'guard matches a 0x-address identity');
    assert.ok(heapIdentity.test('cuis-method/P/C/instance/foo@abcdef12'), 'guard matches an @-address identity');
  } finally {
    await runtime.close();
  }
});

test('Cuis semantic export is deterministic: two equivalent builds yield byte-identical exports', {skip: !enabled, timeout: 900_000}, async () => {
  const toolchainProvider = createOpenSmalltalkCuisToolchainProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 900_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, toolchainProvider]],
  });
  await runtime.images.createImage({id: 'build-image'});
  try {
    const first = await buildCluster(runtime, {stem: 'DetA'});
    const second = await buildCluster(runtime, {stem: 'DetB'});
    // NON-VACUITY floor (ADR 0072 falsification): byte-identity is hollow if the export captured
    // nothing, so assert both builds actually exported structure before comparing bytes.
    const manifestA = JSON.parse(first.exportText);
    const manifestB = JSON.parse(second.exportText);
    assert.ok(manifestA.classes.length > 0 && manifestA.methods.length > 0, 'first build exported no classes/methods (determinism would be vacuous)');
    assert.ok(manifestB.classes.length > 0 && manifestB.methods.length > 0, 'second build exported no classes/methods (determinism would be vacuous)');
    assert.equal(second.exportText, first.exportText, 'two equivalent builds must yield byte-identical semantic exports');
  } finally {
    await runtime.close();
  }
});
