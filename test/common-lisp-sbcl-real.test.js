// The real-SBCL half of the Common Lisp neutrality falsifier (bead lagrange-images-9p4): a Lisp
// source artifact, a declared runtime definition, a callable Block, one deterministic function
// executed by a real SBCL through the neutral stdio value bridge — then capture -> managed install
// -> a fresh runtime over the same durable store executes it with the SBCL binary as composition
// wiring only. Skips unless LAGRANGE_SBCL_INTEGRATION=1 (`npm run test:common-lisp`).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  COMMON_LISP_SBCL_PROVIDER_ID,
  COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1,
  COMMON_LISP_SOURCE_V1,
  CommonLispCallError,
  addProjectMember,
  captureCurrentGraphProjectRelease,
  createArtifactBackedCommonLispSbclProvider,
  createCommonLispRuntimeDefinitionContent,
  createDeploymentProfile,
  createProject,
  createRuntime,
  installForeignRuntimeCallable,
  integerValue,
  objectRef,
  readProjectDescriptor,
  textValue,
} from '../src/runtime.js';
import {installManagedProjectRelease} from '../src/project/managed-installation.js';
import {readManagedProjectInstallation} from '../src/project/installation-state.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const enabled = process.env.LAGRANGE_SBCL_INTEGRATION === '1';
// The provider takes an absolute executable path (composition wiring, never a PATH lookup at
// call time); resolve it once here from the environment or from `which`.
const sbclPath = enabled ? (process.env.LAGRANGE_SBCL_PATH ?? execFileSync('which', ['sbcl'], {encoding: 'utf8'}).trim()) : '/usr/bin/sbcl';
const sbclIdentity = enabled ? `sbcl/${execFileSync(sbclPath, ['--version'], {encoding: 'utf8'}).trim().replace(/^SBCL\s+/, '')}` : 'sbcl/unavailable';

const STUDIO = 'studio';
const PROD = 'prod';
const PROJECT_ID = 'project:lisp-app';
const SOURCE = [
  '(defun lagrange-add (a b) (+ a b))',
  '(defun lagrange-greet (name) (concatenate (quote string) "hello, " name "!"))',
  '(defun lagrange-big (n) (expt 2 n))',
  '',
].join('\n');
const EXPORTS = [
  {service: 'demo', operation: 'add', function: 'lagrange-add', arity: 2},
  {service: 'demo', operation: 'greet', function: 'lagrange-greet', arity: 1},
  {service: 'demo', operation: 'big', function: 'lagrange-big', arity: 1},
];

function composeRuntime(filename, workspaceRoot) {
  return createRuntime({
    backend: {instance: new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)})},
    foreignRuntimeProviders: [[COMMON_LISP_SBCL_PROVIDER_ID, createArtifactBackedCommonLispSbclProvider({sbclPath, sbclIdentity, workspaceRoot})]],
    foreignRuntimeDefinitionBindings: [[COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1, COMMON_LISP_SBCL_PROVIDER_ID]],
  });
}

async function run(runtime, blockRef, args) {
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(blockRef, args));
}

test('real SBCL executes a Lisp function through the generic foreign-runtime path and survives capture -> managed install -> fresh runtime', {skip: !enabled, timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-lisp-'));
  const filename = join(directory, 'image.sqlite');
  let release;
  try {
    const runtimeA = await composeRuntime(filename, join(directory, 'a'));
    try {
      const images = runtimeA.images;
      await images.createImage({id: STUDIO});
      const source = await images.putCodeArtifact(STUDIO, {id: 'lisp-source', languageId: 'common-lisp', representation: COMMON_LISP_SOURCE_V1, content: textValue(SOURCE), logicalPath: 'demo.lisp'});
      const definition = await images.putCodeArtifact(STUDIO, {
        id: 'lisp-runtime', languageId: 'common-lisp', representation: COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1,
        content: textValue(createCommonLispRuntimeDefinitionContent({exports: EXPORTS})),
        dependencies: [{role: 'source', artifact: objectRef(STUDIO, source.id)}],
      });
      const add = await installForeignRuntimeCallable({images, imageId: STUDIO, runtimeDefinition: objectRef(STUDIO, definition.id), interface: {service: 'demo', operation: 'add'}, argumentCount: 2, interfaceId: 'add-if', blockId: 'add'});
      const greet = await installForeignRuntimeCallable({images, imageId: STUDIO, runtimeDefinition: objectRef(STUDIO, definition.id), interface: {service: 'demo', operation: 'greet'}, argumentCount: 1, interfaceId: 'greet-if', blockId: 'greet'});
      const big = await installForeignRuntimeCallable({images, imageId: STUDIO, runtimeDefinition: objectRef(STUDIO, definition.id), interface: {service: 'demo', operation: 'big'}, argumentCount: 1, interfaceId: 'big-if', blockId: 'big'});
      assert.deepEqual(await run(runtimeA, objectRef(STUDIO, add.block.id), [integerValue(40), integerValue(2)]), integerValue(42));
      assert.deepEqual(await run(runtimeA, objectRef(STUDIO, greet.block.id), [textValue('Lagrange ✓')]), textValue('hello, Lagrange ✓!'));
      // Bignums cross faithfully: 2^100 is a canonical integer Value on both sides.
      assert.deepEqual(await run(runtimeA, objectRef(STUDIO, big.block.id), [integerValue(100)]), integerValue('1267650600228229401496703205376'));
      // A Lisp error surfaces as the Lisp call error carrying the guest's condition text, not a crash.
      await assert.rejects(run(runtimeA, objectRef(STUDIO, add.block.id), [textValue('x'), integerValue(1)]), (e) => e instanceof CommonLispCallError);
      // ...and the runtime keeps serving afterwards.
      assert.deepEqual(await run(runtimeA, objectRef(STUDIO, add.block.id), [integerValue(1), integerValue(1)]), integerValue(2));

      await createProject({images, imageId: STUDIO, projectId: PROJECT_ID, name: 'Lisp app'});
      await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key: 'lisp/add', role: 'entry', target: objectRef(STUDIO, add.block.id)});
      await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key: 'lisp/greet', role: 'entry', target: objectRef(STUDIO, greet.block.id)});
      const descriptor = await readProjectDescriptor({images, imageId: STUDIO, projectId: PROJECT_ID});
      const profile = createDeploymentProfile({project: descriptor, profileId: 'full', members: ['lisp/add', 'lisp/greet']});
      let material;
      ({release, material} = await captureCurrentGraphProjectRelease({images, projectImageId: STUDIO, projectId: PROJECT_ID, profile}));
      await images.createImage({id: PROD});
      await installManagedProjectRelease({images, targetImageId: PROD, release, material});
    } finally {
      await runtimeA.close();
    }

    // A genuinely fresh runtime: nothing survives from the authoring process except the durable
    // store and the composition wiring (which SBCL binary to run). No source path, workspace or
    // process handle is remembered anywhere.
    const runtimeB = await composeRuntime(filename, join(directory, 'b'));
    try {
      const installation = await readManagedProjectInstallation({images: runtimeB.images, targetImageId: PROD, projectId: PROJECT_ID});
      assert.equal(installation.releaseId, release.releaseId);
      const byKey = new Map(installation.members.map((m) => [m.key, m]));
      assert.equal(byKey.get('lisp/add').target.imageId, PROD, 'the installed Block lives in the target image');
      assert.deepEqual(await run(runtimeB, byKey.get('lisp/add').target, [integerValue(20), integerValue(22)]), integerValue(42));
      assert.deepEqual(await run(runtimeB, byKey.get('lisp/greet').target, [textValue('fresh')]), textValue('hello, fresh!'));
      // The installed graph carries the definition and the source as ordinary artifacts in PROD.
      const installedBlock = await runtimeB.images.getBlock(PROD, byKey.get('lisp/add').target.objectId);
      const installedInterface = await runtimeB.images.getCodeArtifact(PROD, installedBlock.code.objectId);
      const definitionRef = installedInterface.dependencies.find((d) => d.role === 'runtime-definition').artifact;
      assert.equal(definitionRef.imageId, PROD);
      const installedDefinition = await runtimeB.images.getCodeArtifact(PROD, definitionRef.objectId);
      assert.equal(installedDefinition.representation, COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1);
      const installedSource = await runtimeB.images.getCodeArtifact(PROD, installedDefinition.dependencies[0].artifact.objectId);
      assert.equal(installedSource.representation, COMMON_LISP_SOURCE_V1);
      assert.equal(installedSource.content.value, SOURCE);
      assert.equal(installedSource.logicalPath, 'demo.lisp', 'the materialization path survived release (ADR 0079)');
    } finally {
      await runtimeB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
