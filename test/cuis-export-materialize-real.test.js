import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SOURCES_V1,
  OBJECT_CREATE_OPERATION,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  bytesValue,
  createAuthorityService,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  defineClass,
  installCallableInterfaceV2,
  installImageCreationBatchBinding,
  installSmalltalkKernel,
  objectRef,
  objectResource,
  packCompositeValue,
  textValue,
} from '../src/runtime.js';
import {
  MEMBER_UNION_FIELDS,
  CUIS_EXPORT_FIELDS,
  ensureCuisExportSchema,
  manifestToBatchMembers,
} from '../src/language/cuis-export-materialization.js';

// Stage 2 (Bead lagrange-images-i3f): the real Stage-1 multi-package manifest is materialized through
// the actual ADR 0067 authorized atomic creation batch (ONE batch, local: refs across the whole
// graph), then read back as ordinary image objects. This proves the semantic structure extracted from
// the real Cuis world crosses the final boundary and becomes normal Lagrange image structure — and
// that semantic identity (string data) stays distinct from server-minted ObjectRef. The success
// criterion is the resulting ordinary graph (public getObject), never private batch internals.

const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';
const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';
const IMAGE_ID = 'cuis-export-image';

const CLUSTER = [
  {fileName: 'ExtendedClipboard.pck.st', env: 'LAGRANGE_CUIS_EXTENDEDCLIPBOARD_PACKAGE_PATH', blob: 'd561a0dcedf37e6bd93c15cb07498c34ce6d3c5f'},
  {fileName: 'FFI.pck.st', env: 'LAGRANGE_CUIS_FFI_PACKAGE_PATH', blob: '76bcc869cb66a602d4658465177913269697118b'},
  {fileName: 'Graphics-Files-Additional.pck.st', env: 'LAGRANGE_CUIS_GRAPHICS_FILES_ADDITIONAL_PACKAGE_PATH', blob: '6cddf265949b90fd58d0fea0498df6a1c3594685'},
  {fileName: 'Alien-Core.pck.st', env: 'LAGRANGE_CUIS_ALIEN_CORE_PACKAGE_PATH', blob: '59a2b4bdaa0f21287e3af3479cc31f6a71957758'},
  {fileName: 'WeakDictionaries.pck.st', env: 'LAGRANGE_CUIS_WEAKDICTIONARIES_PACKAGE_PATH', blob: '773620a6f3c15bb21deca5e9895ecfac881c8b64'},
  {fileName: 'Compression.pck.st', env: 'LAGRANGE_CUIS_COMPRESSION_PACKAGE_PATH', blob: '243d8265b411fc36a72dd101f21a18e7c94b2d87'},
];

const MEMBER_TYPES = {member: {kind: 'record', fields: MEMBER_UNION_FIELDS}};

async function putArtifact(runtime, id, representation, content, {metadata = {}, dependencies = [], logicalPath = null} = {}) {
  return await runtime.images.putCodeArtifact(IMAGE_ID, {
    id, languageId: 'smalltalk', representation, content, ...(logicalPath ? {logicalPath} : {}), metadata, dependencies,
  });
}

// Build the real cluster derived image with semanticExport, and return the canonical manifest text.
async function buildRealManifest(runtime, stem) {
  const baseImage = await putArtifact(runtime, `bi-${stem}`, CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {logicalPath: 'Cuis7.9-8090.image'});
  const baseChanges = await putArtifact(runtime, `bc-${stem}`, CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {logicalPath: 'Cuis7.9-8090.changes'});
  const baseSources = await putArtifact(runtime, `bs-${stem}`, CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {logicalPath: 'Cuis7.8.sources'});
  const deps = [
    {role: 'base-image', artifact: objectRef(IMAGE_ID, baseImage.id)},
    {role: 'base-changes', artifact: objectRef(IMAGE_ID, baseChanges.id)},
    {role: 'base-sources', artifact: objectRef(IMAGE_ID, baseSources.id)},
  ];
  for (const spec of CLUSTER) {
    const pkg = await putArtifact(runtime, `p-${stem}-${spec.fileName}`, CUIS_PACKAGE_V1, textValue(await readFile(process.env[spec.env], 'utf8')), {
      logicalPath: spec.fileName, metadata: {identity: `cuis-package/${spec.fileName.replace(/\.pck\.st$/, '')}/${CUIS_COMMIT}/gitblob:${spec.blob}`},
    });
    deps.push({role: 'package', artifact: objectRef(IMAGE_ID, pkg.id)});
  }
  await putArtifact(runtime, `buildroot-${stem}`, CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {dependencies: deps});
  await runtime.toolchains.run({
    providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
    imageId: IMAGE_ID,
    roots: [objectRef(IMAGE_ID, `buildroot-${stem}`)],
    target: {representation: CUIS_IMAGE_V1, fileName: `${stem}.image`},
    options: {semanticExport: true},
    outputIds: {image: `${stem}-image`, changes: `${stem}-changes`, 'semantic-export': `${stem}-export`},
  });
  const exportArtifact = await runtime.images.getCodeArtifact(IMAGE_ID, `${stem}-export`);
  return exportArtifact.content.value;
}

// Decode the version-token string the batch returns into the created objects (the shipped batch-test
// idiom). Token: object-version/v0:<objectResource(imageId,objectId)>:<version>, objectResource is
// base64url(imageId).base64url(objectId).
async function createdObjects(runtime, tokenText) {
  const objects = [];
  for (const token of tokenText.split(',')) {
    const resource = token.split(':')[1];
    const objectId = Buffer.from(resource.slice(resource.indexOf('.') + 1), 'base64url').toString('utf8');
    objects.push(await runtime.images.getObject(IMAGE_ID, objectId));
  }
  return objects;
}

const slotText = (obj, slotId) => obj.slots[slotId]?.value;
// A package relationship is a scalar slot EDGE: slot-packageref holds a ref Value to the package object.
const packageEdgeId = (obj) => (obj.slots['slot-packageref']?.kind === 'ref' ? obj.slots['slot-packageref'].objectId : null);

// Install the schema + binding + return a `materialize(manifest)` that runs ONE ADR 0067 batch.
// `grants` may be an array or a function of the installed schema (so callers need not pre-install it).
async function seedMaterializer(runtime, authority, grants) {
  await installSmalltalkKernel({images: runtime.images, imageId: IMAGE_ID});
  const schema = await ensureCuisExportSchema({images: runtime.images, imageId: IMAGE_ID});
  const resolvedGrants = typeof grants === 'function' ? grants(schema) : grants;
  const callableInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: IMAGE_ID, interfaceId: 'cuis-export-create-many',
    functionName: 'cuis-export-create-many', parameters: [{kind: 'list', element: 'member'}], result: 'string', types: MEMBER_TYPES,
  });
  // The binding fields map (already keyed by the representation classes' object ids). Assert it lines
  // up with the installed schema refs, then pass it through unchanged.
  assert.ok(CUIS_EXPORT_FIELDS[schema.packageClassRef.objectId], 'package field map present');
  assert.ok(CUIS_EXPORT_FIELDS[schema.classClassRef.objectId], 'class field map present');
  assert.ok(CUIS_EXPORT_FIELDS[schema.methodClassRef.objectId], 'method field map present');
  const fields = CUIS_EXPORT_FIELDS;
  await installImageCreationBatchBinding({
    images: runtime.images, callableInterface: objectRef(IMAGE_ID, callableInterface.id),
    fields, bindingId: 'cuis-export-batch', blockId: 'cuis-export-batch-block',
  });
  const context = resolvedGrants === null ? null : authority.issue({principal: 'alice', grants: resolvedGrants});
  const materialize = async (manifest) => {
    const {members} = manifestToBatchMembers(manifest);
    const activation = await runtime.invocations.invokeBlock(objectRef(IMAGE_ID, 'cuis-export-batch-block'), [
      packCompositeValue(members, {kind: 'list', element: 'member'}, MEMBER_TYPES),
    ]);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  const historyLength = async () => (await runtime.images.history(IMAGE_ID)).length;
  return {schema, materialize, historyLength};
}

const createGrants = (schema) => [
  {operation: OBJECT_CREATE_OPERATION, resource: objectResource(IMAGE_ID, schema.packageClassRef.objectId)},
  {operation: OBJECT_CREATE_OPERATION, resource: objectResource(IMAGE_ID, schema.classClassRef.objectId)},
  {operation: OBJECT_CREATE_OPERATION, resource: objectResource(IMAGE_ID, schema.methodClassRef.objectId)},
];

// Install the Smalltalk kernel (defineClass requires it) then the representation-class schema.
async function setupSchema(runtime) {
  await installSmalltalkKernel({images: runtime.images, imageId: IMAGE_ID});
  return await ensureCuisExportSchema({images: runtime.images, imageId: IMAGE_ID});
}

async function makeRuntime(withToolchain = false) {
  const authority = createAuthorityService();
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    ...(withToolchain
      ? {toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 600_000})]]}
      : {}),
  });
  await runtime.images.createImage({id: IMAGE_ID});
  return {runtime, authority};
}

// A small synthetic manifest for the fast (no-VM) authority/failure proofs.
const SMALL_MANIFEST = {
  format: 'smalltalk/cuis-semantic-export-v1',
  packages: [{name: 'Compression', requires: []}],
  classes: [{identity: 'cuis-class/Compression/Archive', package: 'Compression', name: 'Archive', superclassName: 'Object', superclass: 'cuis-class/Cuis-Base/Object'}],
  methods: [{identity: 'cuis-method/Compression/ByteArray/instance/unzipped', package: 'Compression', class: 'cuis-class/Cuis-Base/ByteArray', side: 'instance', selector: 'unzipped', source: 'unzipped\n\t^ (GZipReadStream on: self) upToEnd'}],
};

// --- the strong Stage-2 proof: real manifest -> one batch -> ordinary graph --------------------------

test('the real multi-package manifest materializes into ordinary objects through ONE ADR 0067 batch', {skip: !enabled, timeout: 900_000}, async () => {
  const {runtime, authority} = await makeRuntime(true);
  try {
    const manifestText = await buildRealManifest(runtime, 'MatCluster');
    const manifest = JSON.parse(manifestText);
    // Measure the single-batch request size against the codec/backend limits (no silent chunking).
    // The packed composite is a bytes Value ({kind:'bytes', base64}); its decoded byte length is the
    // payload size (base64 is ~4/3 the decoded length, so decoded < base64 length).
    const {members} = manifestToBatchMembers(manifest);
    const packed = packCompositeValue(members, {kind: 'list', element: 'member'}, MEMBER_TYPES);
    const payloadBytes = Buffer.from(packed.base64, 'base64').byteLength;
    assert.ok(payloadBytes < 64 * 1024 * 1024, `batch payload ${payloadBytes} within 64MB`);
    assert.ok(members.length < 1_000_000, 'member count within MAX_LIST_LENGTH');

    const {schema, materialize, historyLength} = await seedMaterializer(runtime, authority, createGrants);
    const before = await historyLength();
    const token = await materialize(manifest);
    assert.equal(token.kind, 'text');
    const objects = await createdObjects(runtime, token.value);
    assert.equal(objects.length, members.length, 'one object per manifest member');

    // Index the created objects by their semantic identity slot (the durable identity is the
    // server-minted ObjectRef; the semantic identity is string data in a slot).
    const byIdentity = new Map();
    for (const obj of objects) byIdentity.set(slotText(obj, 'slot-semanticidentity'), obj);
    const behaviorName = (obj) => obj.behavior.objectId;

    // (1) All expected packages exist as CuisExportPackage instances, with requirements as identity
    // strings. For every requirement whose target is ALSO materialized, prove the requirement identity
    // resolves semantically to that object's identity (the dependency graph is resolvable without v1
    // storing it as ObjectRefs).
    for (const pkg of manifest.packages) {
      const obj = byIdentity.get(`cuis-package/${pkg.name}`);
      assert.ok(obj, `package object exists: ${pkg.name}`);
      assert.equal(behaviorName(obj), schema.packageClassRef.objectId, `${pkg.name} behavior is CuisExportPackage`);
      assert.equal(slotText(obj, 'slot-entityname'), pkg.name);
      const reqs = (obj.indexed ?? []).map((v) => v.value);
      assert.deepEqual(reqs, pkg.requires.map((r) => `cuis-package/${r}`), `${pkg.name} requirements as identity strings`);
      for (const reqIdentity of reqs) {
        const target = byIdentity.get(reqIdentity);
        if (target) {
          assert.equal(slotText(target, 'slot-semanticidentity'), reqIdentity, `${pkg.name} requirement ${reqIdentity} resolves semantically to the materialized package's identity`);
        }
      }
    }
    // The FFI diamond requirement explicitly (Alien-Core + WeakDictionaries both materialized).
    const ffi = byIdentity.get('cuis-package/FFI');
    const ffiReqs = (ffi.indexed ?? []).map((v) => v.value);
    assert.ok(ffiReqs.includes('cuis-package/Alien-Core') && ffiReqs.includes('cuis-package/WeakDictionaries'), 'FFI requires Alien-Core + WeakDictionaries as identity strings');
    assert.equal(slotText(byIdentity.get('cuis-package/Alien-Core'), 'slot-semanticidentity'), 'cuis-package/Alien-Core');
    assert.equal(slotText(byIdentity.get('cuis-package/WeakDictionaries'), 'slot-semanticidentity'), 'cuis-package/WeakDictionaries');

    // (2) Every exported class points at its owning package's ObjectRef via the slot package edge.
    for (const cls of manifest.classes) {
      const obj = byIdentity.get(cls.identity);
      assert.ok(obj, `class object exists: ${cls.identity}`);
      assert.equal(behaviorName(obj), schema.classClassRef.objectId);
      const pkgObj = byIdentity.get(`cuis-package/${cls.package}`);
      assert.equal(packageEdgeId(obj), pkgObj.id, `${cls.identity} package edge -> materialized ${cls.package} ObjectRef`);
    }

    // (3) Exported-to-exported superclass relationships are real ObjectRefs; base superclass stays a
    // reserved identity string with an empty relationship edge.
    const zipArchiveNewer = manifest.classes.find((c) => c.superclass && c.superclass.startsWith('cuis-class/') && !c.superclass.startsWith('cuis-class/Cuis-Base/'));
    if (zipArchiveNewer) {
      const obj = byIdentity.get(zipArchiveNewer.identity);
      const supObj = byIdentity.get(zipArchiveNewer.superclass);
      const supEdge = (obj.indexed ?? []).filter((v) => v.kind === 'ref' && v.objectId === supObj.id);
      assert.ok(supEdge.length >= 1, `exported superclass ${zipArchiveNewer.superclass} is a real ObjectRef edge`);
    }
    const archive = byIdentity.get('cuis-class/Compression/Archive');
    assert.ok(archive, 'Compression Archive materialized');
    assert.equal(slotText(archive, 'slot-superclassidentity'), 'cuis-class/Cuis-Base/Object', 'base superclass stays the reserved identity string');
    assert.equal((archive.indexed ?? []).length, 0, 'base superclass -> EMPTY superclass edge (no manufactured ObjectRef)');

    // (4) Methods point to owning Package + target Class correctly; the ByteArray>>unzipped case.
    const unzipped = byIdentity.get('cuis-method/Compression/ByteArray/instance/unzipped');
    assert.ok(unzipped, 'ByteArray>>unzipped materialized');
    assert.equal(behaviorName(unzipped), schema.methodClassRef.objectId);
    const compression = byIdentity.get('cuis-package/Compression');
    assert.equal(packageEdgeId(unzipped), compression.id, 'unzipped owning-package edge -> materialized Compression ObjectRef');
    assert.equal(slotText(unzipped, 'slot-targetclassidentity'), 'cuis-class/Cuis-Base/ByteArray', 'target stays the reserved base identity (no manufactured Compression ByteArray)');
    assert.equal((unzipped.indexed ?? []).length, 0, 'unzipped target-class edge is EMPTY (base target, no manufactured ObjectRef)');
    assert.equal(slotText(unzipped, 'slot-side'), 'instance');
    assert.equal(slotText(unzipped, 'slot-selector'), 'unzipped');
    assert.match(slotText(unzipped, 'slot-source'), /GZipReadStream/, 'source survives per canonical manifest');
    // No manufactured Cuis-Base class/package objects.
    assert.ok(![...byIdentity.keys()].some((k) => k === 'cuis-package/Cuis-Base'), 'no Cuis-Base package materialized');
    assert.ok(![...byIdentity.keys()].some((k) => typeof k === 'string' && k.startsWith('cuis-class/Cuis-Base/')), 'no Cuis-Base class materialized');

    // (5) representation != execution: a CuisExportClass instance's behavior is the CuisExportClass
    // representation class, NOT a Behavior for the represented Cuis class. It does not dispatch as
    // the Cuis class it describes.
    assert.equal(archive.behavior.objectId, schema.classClassRef.objectId, 'the Archive REPRESENTATION instance behavior is CuisExportClass');
    assert.equal(slotText(archive, 'slot-semanticidentity'), 'cuis-class/Compression/Archive', 'semantic identity is string data, not the ObjectRef');

    // (6) Atomicity over the whole manifest: exactly members.length object.put events.
    const after = await historyLength();
    assert.equal(after - before, members.length, 'one history event per object, all-or-none');
  } finally {
    await runtime.close();
  }
});

// --- the schema install is idempotent (ensure-exact-or-create), so a retry / reused image works ----

test('ensureCuisExportSchema is idempotent: re-installing reuses the same refs', async () => {
  const {runtime} = await makeRuntime(false);
  try {
    await installSmalltalkKernel({images: runtime.images, imageId: IMAGE_ID});
    const first = await ensureCuisExportSchema({images: runtime.images, imageId: IMAGE_ID});
    const second = await ensureCuisExportSchema({images: runtime.images, imageId: IMAGE_ID});
    assert.deepEqual(
      {p: first.packageClassRef.objectId, c: first.classClassRef.objectId, m: first.methodClassRef.objectId},
      {p: second.packageClassRef.objectId, c: second.classClassRef.objectId, m: second.methodClassRef.objectId},
      're-installing the schema reuses the same class refs (ensure-exact-or-create)',
    );
  } finally {
    await runtime.close();
  }
});

test('a divergent pre-existing shape at a deterministic schema id conflicts rather than being silently adopted', async () => {
  const {runtime} = await makeRuntime(false);
  try {
    await installSmalltalkKernel({images: runtime.images, imageId: IMAGE_ID});
    // Occupy the package shape id with a DIFFERENT layout BEFORE the schema install runs.
    await runtime.images.putShape(IMAGE_ID, {id: 'cuis-export/package-shape/v1', slots: [{id: 'slot-other', name: 'other'}]});
    await assert.rejects(
      ensureCuisExportSchema({images: runtime.images, imageId: IMAGE_ID}),
      /conflict|Conflict/,
      'a divergent shape at the deterministic id conflicts rather than being silently adopted',
    );
  } finally {
    await runtime.close();
  }
});

// --- ADR 0067 failure proofs at this consumer boundary (fast, no VM) ---------------------------------

test('deny object/create on CuisExportMethod -> zero objects and zero history', async () => {
  const {runtime, authority} = await makeRuntime(false);
  try {
    // Grant only Package + Class; deny Method (grant function of the installed schema).
    const denyMethod = (schema) => [
      {operation: OBJECT_CREATE_OPERATION, resource: objectResource(IMAGE_ID, schema.packageClassRef.objectId)},
      {operation: OBJECT_CREATE_OPERATION, resource: objectResource(IMAGE_ID, schema.classClassRef.objectId)},
    ];
    const {schema, materialize, historyLength} = await seedMaterializer(runtime, authority, denyMethod);
    const before = await historyLength();
    await assert.rejects(materialize(SMALL_MANIFEST), /not authorized: object\/create/);
    assert.equal(await historyLength(), before, 'a denied batch commits nothing');
    const objs = await runtime.images.listObjects(IMAGE_ID);
    assert.ok(!objs.some((o) => o.behavior?.objectId === schema.methodClassRef.objectId), 'no CuisExportMethod object exists');
  } finally {
    await runtime.close();
  }
});

test('malformed manifest -> translator rejects -> zero objects and zero history', async () => {
  const {runtime, authority} = await makeRuntime(false);
  try {
    const {materialize, historyLength} = await seedMaterializer(runtime, authority, createGrants);
    const before = await historyLength();
    await assert.rejects(materialize({format: 'wrong', packages: [], classes: [], methods: []}), /format/);
    await assert.rejects(materialize(null), /cuis-semantic-export-v1|format|object/);
    assert.equal(await historyLength(), before, 'a malformed manifest commits nothing');
  } finally {
    await runtime.close();
  }
});

test('unresolved local relationship -> rejected before write (the lane catches it)', async () => {
  const {runtime, authority} = await makeRuntime(false);
  try {
    const {schema, historyLength} = await seedMaterializer(runtime, authority, createGrants);
    const before = await historyLength();
    // A class whose superclass identity is a NON-base, NON-exported class produces a local: ref to a
    // member that does not exist -> the lane's unknown-local-name check fires before any write. Build
    // such a manifest through the translator by hand-forging a dangling edge (a base ref is fine; a
    // dangling local: is not). The translator only emits local: for exported classes, so forge the
    // member list directly to simulate a corrupt manifest that slipped through.
    const {members} = manifestToBatchMembers(SMALL_MANIFEST);
    const forged = members.map((m) => ({...m}));
    const cls = forged.find((m) => m.class === schema.classClassRef.objectId);
    cls.superclassref = ['local:cuis-class/Ghost/Missing']; // dangling local ref
    const activation = await runtime.invocations.invokeBlock(objectRef(IMAGE_ID, 'cuis-export-batch-block'), [
      packCompositeValue(forged, {kind: 'list', element: 'member'}, MEMBER_TYPES),
    ]);
    await assert.rejects(
      runtime.executor.execute(activation, {authority: authority.issue({principal: 'alice', grants: createGrants(schema)})}),
      /unknown local name/,
    );
    assert.equal(await historyLength(), before, 'a dangling local ref commits nothing');
  } finally {
    await runtime.close();
  }
});

test('injected backend transaction failure -> zero partial Package/Class/Method graph', async () => {
  const {runtime, authority} = await makeRuntime(false);
  try {
    const {schema, materialize, historyLength} = await seedMaterializer(runtime, authority, createGrants);
    const before = await historyLength();
    // Force the backend to fail AT COMMIT only during materialize: the real transaction stages all
    // put+append operations onto a draft, then a throw inside the callback discards the draft
    // (MockBackend commits all-or-none). Wrap AFTER the schema/binding writes so the failure happens
    // exactly at the batch's commit, proving no partial Package/Class/Method graph survives.
    const realTransaction = runtime.images.backend.transaction.bind(runtime.images.backend);
    runtime.images.backend.transaction = async (callback) => realTransaction(async (tx) => {
      await callback(tx);
      throw new Error('injected backend transaction failure');
    });
    await assert.rejects(materialize(SMALL_MANIFEST), /injected backend transaction failure/);
    runtime.images.backend.transaction = realTransaction;
    assert.equal(await historyLength(), before, 'a failed transaction commits no history');
    const objs = await runtime.images.listObjects(IMAGE_ID);
    assert.ok(!objs.some((o) => o.behavior?.objectId === schema.packageClassRef.objectId
      || o.behavior?.objectId === schema.classClassRef.objectId
      || o.behavior?.objectId === schema.methodClassRef.objectId), 'no partial Package/Class/Method graph');
  } finally {
    await runtime.close();
  }
});
