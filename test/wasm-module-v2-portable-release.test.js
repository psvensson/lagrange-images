// ygi step 4: a compiled WASM module survives portable release. A Project whose member is a Block
// over compiled WASM is captured (bundle), managed-installed into a fresh image, the runtime is
// shut down, and a GENUINELY FRESH runtime over the same durable store executes the installed
// Block — recovering the exact implementation dependency and the complete executable semantics
// from wasm-module/v2 content + the wasm-binary/v1 edge alone: the old semantic metadata is
// absent (the bundle strips metadata), and neither the compiler, the semantic source nor any cache
// participates — at BLOCK level, since wasm-function/v2 (ADR 0082) selects its entry from content.
// The frozen v1 form is the falsifier: the same flow over a v1 module reproduces the broken
// installed graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  LAGRANGE_CODE_V0,
  LAGRANGE_CODE_V1,
  WASM_MODULE_V1,
  WASM_FUNCTION_V2,
  WASM_MODULE_V2,
  WasmModuleCache,
  addProjectMember,
  assembleWasmFunctionArtifact,
  captureCurrentGraphProjectRelease,
  compileWasmFunctionArtifact,
  createDeploymentProfile,
  createProject,
  createRuntime,
  functionModuleRef,
  installWasmBlockTree,
  integerValue,
  objectRef,
  readModuleContract,
  readModuleDescriptor,
  readProjectDescriptor,
  textValue,
} from '../src/runtime.js';
import {installManagedProjectRelease} from '../src/project/managed-installation.js';
import {readManagedProjectInstallation} from '../src/project/installation-state.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const STUDIO = 'studio';
const PROD = 'prod';
const PROJECT_ID = 'project:wasm-app';

async function composeRuntime(filename) {
  return await createRuntime({backend: {instance: new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)})}});
}

async function withDurableStore(body) {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-wasm-v2-release-'));
  try {
    return await body(join(directory, 'image.sqlite'));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

const ADD_ONE = {
  parameters: [{id: 'arg:0:value', name: 'value'}],
  captures: [],
  body: {op: 'integer-add', left: {op: 'argument', index: 0}, right: {op: 'literal', value: integerValue(1)}},
};

// A v1 (lexical-cell ABI) program with a nested Block, so the tree lane, cellBindings and closure
// sites all travel through the release too. The root assigns a temporary (which is what makes it
// lagrange-code/v1) and RETURNS a closure capturing its parameter as a snapshot; invoking that
// closure later is allowed (a cell capture would be an escaping mutable closure, refused by design).
const NESTED_V1 = {
  parameters: [{id: 'root:parameter:0', name: 'x'}],
  temporaries: [{id: 'root:temporary:0', name: 'a'}],
  captures: [],
  body: {
    op: 'sequence',
    statements: [
      {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(40)}},
      {
        op: 'block', blockId: 'root/block:0',
        captures: [{id: 'root:parameter:0', mode: 'snapshot', name: 'x', value: {op: 'argument', index: 0}}],
        program: {
          parameters: [], temporaries: [], captures: [{id: 'root:parameter:0', mode: 'snapshot', name: 'x'}],
          body: {op: 'integer-add', left: {op: 'binding', id: 'root:parameter:0'}, right: {op: 'literal', value: integerValue(2)}},
        },
      },
    ],
  },
};

async function run(runtime, blockRef, args = []) {
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(blockRef, args));
}

// Author a Project in `studio` with two WASM members: a single-function Block (v0 lane) and a
// nested-Block tree (v1 lexical-cell lane).
async function authorProject(runtime) {
  const images = runtime.images;
  await images.createImage({id: STUDIO});
  await images.putCodeArtifact(STUDIO, {id: 'add-one:semantic', representation: LAGRANGE_CODE_V0, content: textValue(JSON.stringify(ADD_ONE))});
  const {moduleArtifact, functionArtifact} = await compileWasmFunctionArtifact({
    images, compilation: runtime.compilation, semanticRef: objectRef(STUDIO, 'add-one:semantic'),
    moduleId: 'add-one:module', functionId: 'add-one:function',
  });
  assert.equal(moduleArtifact.representation, WASM_MODULE_V2);
  const addOne = await images.putBlock(STUDIO, {id: 'add-one:block', code: objectRef(STUDIO, functionArtifact.id), environment: null});

  await images.putCodeArtifact(STUDIO, {id: 'nested:semantic', representation: LAGRANGE_CODE_V1, content: textValue(JSON.stringify(NESTED_V1))});
  const tree = await installWasmBlockTree({images, compilation: runtime.compilation, semanticRef: objectRef(STUDIO, 'nested:semantic'), id: 'nested'});
  assert.equal(tree.moduleArtifact.representation, WASM_MODULE_V2);

  await createProject({images, imageId: STUDIO, projectId: PROJECT_ID, name: 'WASM app'});
  await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key: 'app/add-one', role: 'entry', target: objectRef(STUDIO, addOne.id)});
  await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key: 'app/nested', role: 'entry', target: objectRef(STUDIO, tree.block.id)});
  return {memberKeys: ['app/add-one', 'app/nested']};
}

async function captureAndInstall(runtime, memberKeys) {
  const descriptor = await readProjectDescriptor({images: runtime.images, imageId: STUDIO, projectId: PROJECT_ID});
  const profile = createDeploymentProfile({project: descriptor, profileId: 'full', members: memberKeys});
  const {release, material} = await captureCurrentGraphProjectRelease({images: runtime.images, projectImageId: STUDIO, projectId: PROJECT_ID, profile});
  await runtime.images.createImage({id: PROD});
  const installed = await installManagedProjectRelease({images: runtime.images, targetImageId: PROD, release, material});
  return {release, installed};
}

// In the fresh runtime, forbid every path that is NOT "installed graph -> execution": the
// compilation service must not be asked for anything, and no semantic source may be read.
function forbidCompilerAndSource(runtime) {
  const refuse = (what) => async () => { throw new Error(`fresh runtime must not ${what}`); };
  runtime.compilation.compileArtifact = refuse('compile');
  runtime.compilation.compileGroup = refuse('compile a group');
  const getCodeArtifact = runtime.images.getCodeArtifact.bind(runtime.images);
  const reads = [];
  runtime.images.getCodeArtifact = async (imageId, id) => {
    const artifact = await getCodeArtifact(imageId, id);
    if (artifact?.representation?.startsWith('lagrange-code/')) throw new Error(`fresh runtime must not read semantic source ${imageId}/${id}`);
    reads.push(artifact?.representation ?? null);
    return artifact;
  };
  return reads;
}

test('capture -> bundle -> managed install -> fresh runtime executes compiled WASM with the semantic metadata absent and without compiler, source or cache participation', {timeout: 60_000}, async () => {
  await withDurableStore(async (filename) => {
    let release;
    let memberKeys;
    const runtimeA = await composeRuntime(filename);
    try {
      ({memberKeys} = await authorProject(runtimeA));
      assert.deepEqual(await run(runtimeA, objectRef(STUDIO, 'add-one:block'), [integerValue(41)]), integerValue(42));
      const closureA = await run(runtimeA, objectRef(STUDIO, 'nested'), [integerValue(40)]);
      assert.deepEqual(await run(runtimeA, closureA), integerValue(42));
      ({release} = await captureAndInstall(runtimeA, memberKeys));
    } finally {
      await runtimeA.close();
    }

    const runtimeB = await composeRuntime(filename);
    try {
      const installation = await readManagedProjectInstallation({images: runtimeB.images, targetImageId: PROD, projectId: PROJECT_ID});
      assert.ok(installation);
      assert.equal(installation.releaseId, release.releaseId);
      const byKey = new Map(installation.members.map((member) => [member.key, member]));

      // The installed module: v2 content + exactly one implementation edge into PROD, and the
      // provenance metadata GONE (the bundle strips it) — meaning must not depend on it.
      const installedBlock = await runtimeB.images.getBlock(PROD, byKey.get('app/add-one').target.objectId);
      const installedFunction = await runtimeB.images.getCodeArtifact(PROD, installedBlock.code.objectId);
      const installedModule = await runtimeB.images.getCodeArtifact(PROD, functionModuleRef(installedFunction).objectId);
      assert.equal(installedModule.representation, WASM_MODULE_V2);
      assert.deepEqual(installedModule.metadata, {}, 'the old semantic metadata is absent after release');
      assert.equal(installedModule.dependencies.length, 1);
      assert.equal(installedModule.dependencies[0].role, 'implementation');
      assert.equal(installedModule.dependencies[0].artifact.imageId, PROD, 'the implementation edge was recovered INTO the target image');
      const installedBinary = await runtimeB.images.getCodeArtifact(PROD, installedModule.dependencies[0].artifact.objectId);
      assert.equal(installedBinary.representation, 'wasm-binary/v1');
      // Complete executable semantics from content alone.
      const contract = readModuleDescriptor(installedModule);
      assert.equal(contract.functions[0].entry, 'run');
      assert.equal(contract.functions[0].parameters, 1);

      // Execute the INSTALLED Blocks through the installation descriptor ONLY, with compiler and
      // semantic source forbidden: wasm-function/v2 selects its entry from content and reaches the
      // module through its dependency, so nothing stripped by the bundle is needed (ADR 0082).
      const reads = forbidCompilerAndSource(runtimeB);
      assert.equal(installedFunction.representation, WASM_FUNCTION_V2);
      assert.deepEqual(installedFunction.metadata, {});
      assert.deepEqual(await run(runtimeB, byKey.get('app/add-one').target, [integerValue(41)]), integerValue(42));
      const closureB = await run(runtimeB, byKey.get('app/nested').target, [integerValue(40)]);
      assert.deepEqual(await run(runtimeB, closureB), integerValue(42), 'the nested-Block tree (lexical-cell ABI, closure prototypes via derivedFrom) executes from the installed graph');
      assert.ok(reads.includes(WASM_MODULE_V2) && reads.includes('wasm-binary/v1'), 'execution read the descriptor and its implementation');
      assert.ok(!reads.includes(WASM_MODULE_V1));

      // The nested-Block tree's module (lexical-cell ABI) is recovered completely as well: every
      // function descriptor with its cellBindings, the closure sites, and compilable bytes.
      const nestedBlock = await runtimeB.images.getBlock(PROD, byKey.get('app/nested').target.objectId);
      const nestedFunction = await runtimeB.images.getCodeArtifact(PROD, nestedBlock.code.objectId);
      const nestedModule = await runtimeB.images.getCodeArtifact(PROD, functionModuleRef(nestedFunction).objectId);
      assert.equal(nestedModule.representation, WASM_MODULE_V2);
      assert.deepEqual(nestedModule.metadata, {});
      const nested = await readModuleContract(nestedModule, {resolveImplementation: (ref) => runtimeB.images.getCodeArtifact(ref.imageId, ref.objectId)});
      assert.equal(nested.functions.length, 2, 'root + nested Block');
      assert.ok(nested.functions.every((f) => Array.isArray(f.cellBindings)), 'cellBindings recovered for the lexical-cell ABI');
      assert.equal(nested.closureSites.length, 1);
      assert.equal(nested.closureSites[0].blockId, 'root/block:0');
      assert.equal(WebAssembly.validate(nested.bytes), true);
      const compiled = await new WasmModuleCache().get(nestedModule, nested.bytes);
      assert.deepEqual(
        WebAssembly.Module.exports(compiled).map(({name}) => name).filter((name) => nested.functions.some((f) => f.entry === name)).sort(),
        nested.functions.map((f) => f.entry).sort(),
        'every described entry is exported by the recovered bytes',
      );
    } finally {
      await runtimeB.close();
    }
  });
});

// The falsifier that motivated the whole slice (proof requirement 6): the SAME flow over the
// frozen v1 form reproduces the broken installed graph, because v1 keeps its executable
// contract in metadata and the bundle strips metadata.
test('FALSIFIER: the frozen v1 form does not survive release — the installed v1 module cannot be validated or executed', {timeout: 60_000}, async () => {
  await withDurableStore(async (filename) => {
    const runtimeA = await composeRuntime(filename);
    try {
      const images = runtimeA.images;
      await images.createImage({id: STUDIO});
      await images.putCodeArtifact(STUDIO, {id: 'src', representation: LAGRANGE_CODE_V0, content: textValue(JSON.stringify(ADD_ONE))});
      const v2 = await runtimeA.compilation.compileArtifact(objectRef(STUDIO, 'src'), {id: 'm2', targetRepresentation: WASM_MODULE_V2});
      const binary = await images.getCodeArtifact(STUDIO, 'm2:implementation');
      // The frozen v1 form of the same module, as an older image persisted it.
      const v1 = await images.putCodeArtifact(STUDIO, {
        id: 'm1', representation: WASM_MODULE_V1, content: binary.content,
        metadata: {...JSON.parse(v2.content.value), semanticRepresentation: LAGRANGE_CODE_V0},
      });
      const {functionArtifact} = await assembleWasmFunctionArtifact({images, semanticRef: objectRef(STUDIO, 'src'), moduleRef: objectRef(STUDIO, v1.id), functionId: 'fn1', entry: 'run'});
      const block = await images.putBlock(STUDIO, {id: 'blk1', code: objectRef(STUDIO, functionArtifact.id), environment: null});
      assert.deepEqual(await run(runtimeA, objectRef(STUDIO, block.id), [integerValue(1)]), integerValue(2), 'v1 still executes in-image');
      await createProject({images, imageId: STUDIO, projectId: PROJECT_ID, name: 'v1 app'});
      await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key: 'app/v1', role: 'entry', target: objectRef(STUDIO, block.id)});
      await captureAndInstall(runtimeA, ['app/v1']);
    } finally {
      await runtimeA.close();
    }
    const runtimeB = await composeRuntime(filename);
    try {
      const installation = await readManagedProjectInstallation({images: runtimeB.images, targetImageId: PROD, projectId: PROJECT_ID});
      const target = installation.members[0].target;
      const installedBlock = await runtimeB.images.getBlock(PROD, target.objectId);
      const installedFunction = await runtimeB.images.getCodeArtifact(PROD, installedBlock.code.objectId);
      const installedModule = await runtimeB.images.getCodeArtifact(PROD, functionModuleRef(installedFunction).objectId);
      assert.equal(installedModule.representation, WASM_MODULE_V1);
      assert.deepEqual(installedModule.metadata, {}, 'the bundle stripped the v1 contract');
      assert.throws(() => readModuleDescriptor(installedModule), /metadata\.abi/, 'the installed v1 module has no readable contract');
      await assert.rejects(run(runtimeB, target, [integerValue(1)]), 'the installed v1 module cannot execute');
    } finally {
      await runtimeB.close();
    }
  });
});
