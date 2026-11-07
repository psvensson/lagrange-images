import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  DEFAULT_PROJECT_MANIFEST_PATH,
  GIT_DEPENDENCY_SPEC_V1,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  PROJECT_FILE_PROJECTION_DIFF_V1,
  PROJECT_FILE_PROJECTION_MANIFEST_V1,
  PROJECT_FILE_PROJECTION_V1,
  ProjectFileProjectionError,
  addProjectMember,
  authorizedExportProjectFileProjection,
  authorizedImportProjectFileProjection,
  createProject,
  createProjectId,
  createRuntime,
  diffProjectAgainstFileProjection,
  diffProjectFileProjection,
  exportProjectFileProjection,
  importProjectFileProjection,
  integerValue,
  normalizeGitDependencySpec,
  objectRef,
  objectResource,
  projectObjectId,
  readProjectDescriptor,
  readProjectFileProjectionFromDirectory,
  textValue,
  writeProjectFileProjectionToDirectory,
} from '../src/runtime.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seedPolyglotProject(images, imageId, projectId) {
  await images.createImage({id: imageId});

  // 1. Symmetric Smalltalk source artifact
  await images.putCodeArtifact(imageId, {
    id: 'st-counter-src',
    languageId: 'symmetric-smalltalk',
    representation: 'smalltalk-source/v1',
    logicalPath: 'src/Counter.st',
    content: textValue('Object subclass: #Counter instanceVariableNames: \'count\'\nincrement ^ count := count + 1\n'),
  });

  // 2. Multi-file Common Lisp system closure (utils.lisp -> math.lisp -> math-lib.asd)
  await images.putCodeArtifact(imageId, {
    id: 'cl-utils-src',
    languageId: 'common-lisp',
    representation: 'common-lisp/source-v0',
    logicalPath: 'src/utils.lisp',
    content: textValue('(in-package :cl-user)\n(defun square (x) (* x x))\n'),
  });
  await images.putCodeArtifact(imageId, {
    id: 'cl-math-src',
    languageId: 'common-lisp',
    representation: 'common-lisp/source-v0',
    logicalPath: 'src/math.lisp',
    dependencies: [{role: 'component:utils', artifact: objectRef(imageId, 'cl-utils-src')}],
    content: textValue('(in-package :cl-user)\n(defun hyp-sq (a b) (+ (square a) (square b)))\n'),
  });
  await images.putCodeArtifact(imageId, {
    id: 'cl-math-asd',
    languageId: 'common-lisp',
    representation: 'common-lisp/system-v0',
    logicalPath: 'math-lib.asd',
    dependencies: [
      {role: 'component:utils', artifact: objectRef(imageId, 'cl-utils-src')},
      {role: 'component:math', artifact: objectRef(imageId, 'cl-math-src')},
    ],
    content: textValue('(defsystem "math-lib" :serial t :components ((:file "src/utils") (:file "src/math")))\n'),
  });

  // 3. Structured configuration object closure
  await images.putShape(imageId, {
    id: 'settings-shape',
    slots: [
      {id: 'env', name: 'env'},
      {id: 'maxRetries', name: 'maxRetries'},
    ],
  });
  await images.putObject(imageId, {
    id: 'settings-obj',
    shape: objectRef(imageId, 'settings-shape'),
    slots: {
      env: textValue('production'),
      maxRetries: integerValue(3),
    },
  });

  await createProject({
    images,
    imageId,
    projectId,
    name: 'PolyglotProjectionApp',
  });
  await addProjectMember({
    images,
    imageId,
    projectId,
    key: 'code/counter.st',
    role: 'source',
    target: objectRef(imageId, 'st-counter-src'),
  });
  await addProjectMember({
    images,
    imageId,
    projectId,
    key: 'system/math-lib',
    role: 'system',
    target: objectRef(imageId, 'cl-math-asd'),
  });
  await addProjectMember({
    images,
    imageId,
    projectId,
    key: 'config/settings',
    role: 'configuration',
    target: objectRef(imageId, 'settings-obj'),
  });
}

test('exportProjectFileProjection projects a polyglot Project to a clean Git-friendly file tree and importProjectFileProjection round-trips it into a fresh image with identical contentIdentity', async () => {
  await withRuntime(async (runtime) => {
    const projectId = createProjectId();
    await seedPolyglotProject(runtime.images, 'src-img', projectId);

    const gitDeps = [
      {
        name: 'core-collections',
        repository: 'https://git.example.com/lagrange/core-collections.git',
        revision: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        subdir: 'packages/collections',
        role: 'library',
        registry: 'private-git',
      },
    ];

    const exported = await exportProjectFileProjection({
      images: runtime.images,
      imageId: 'src-img',
      projectId,
      gitDependencies: gitDeps,
    });

    assert.equal(exported.format, PROJECT_FILE_PROJECTION_V1);
    assert.equal(exported.projectId, projectId);
    assert.equal(exported.manifest.format, PROJECT_FILE_PROJECTION_MANIFEST_V1);
    assert.equal(exported.manifest.gitDependencies.length, 1);
    assert.equal(exported.manifest.gitDependencies[0].format, GIT_DEPENDENCY_SPEC_V1);

    // Source files are projected as raw, unadorned UTF-8 text at their logicalPaths!
    assert.equal(
      exported.files['src/Counter.st'],
      'Object subclass: #Counter instanceVariableNames: \'count\'\nincrement ^ count := count + 1\n',
    );
    assert.equal(
      exported.files['src/utils.lisp'],
      '(in-package :cl-user)\n(defun square (x) (* x x))\n',
    );
    assert.equal(
      exported.files['src/math.lisp'],
      '(in-package :cl-user)\n(defun hyp-sq (a b) (+ (square a) (square b)))\n',
    );
    assert.equal(
      exported.files['math-lib.asd'],
      '(defsystem "math-lib" :serial t :components ((:file "src/utils") (:file "src/math")))\n',
    );
    assert.ok(Object.hasOwn(exported.files, 'objects/config/settings.bundle.json'));
    assert.ok(Object.hasOwn(exported.files, DEFAULT_PROJECT_MANIFEST_PATH));

    // Import into a brand-new image
    await runtime.images.createImage({id: 'dst-img'});
    const imported = await importProjectFileProjection({
      images: runtime.images,
      imageId: 'dst-img',
      files: exported.files,
    });

    assert.equal(imported.projectId, projectId);
    assert.deepEqual(imported.addedMemberKeys, ['code/counter.st', 'config/settings', 'system/math-lib']);
    assert.deepEqual(imported.createdArtifactIds, ['cl-math-asd', 'cl-math-src', 'cl-utils-src', 'st-counter-src']);

    // Re-exporting from dst-img produces the exact same files map and contentIdentity!
    const reexported = await exportProjectFileProjection({
      images: runtime.images,
      imageId: 'dst-img',
      projectId,
      gitDependencies: gitDeps,
    });
    assert.equal(reexported.contentIdentity, exported.contentIdentity);
    assert.deepEqual(reexported.files, exported.files);
  });
});

test('editing projected source and object files reconciles only changed artifacts/objects while preserving unchanged member targets and Project identity', async () => {
  await withRuntime(async (runtime) => {
    const projectId = createProjectId();
    await seedPolyglotProject(runtime.images, 'dev-img', projectId);

    const initialProjection = await exportProjectFileProjection({
      images: runtime.images,
      imageId: 'dev-img',
      projectId,
    });

    // 1. Re-importing an unchanged projection is a no-op that reuses all artifacts and members
    const noopImport = await importProjectFileProjection({
      images: runtime.images,
      imageId: 'dev-img',
      files: initialProjection.files,
    });
    assert.deepEqual(noopImport.unchangedMemberKeys, ['code/counter.st', 'config/settings', 'system/math-lib']);
    assert.deepEqual(noopImport.updatedMemberKeys, []);
    assert.deepEqual(noopImport.addedMemberKeys, []);
    assert.deepEqual(noopImport.createdArtifactIds, []);
    assert.deepEqual(noopImport.reusedArtifactIds, ['cl-math-asd', 'cl-math-src', 'cl-utils-src', 'st-counter-src']);

    // 2. Simulate a developer editing `src/math.lisp` and `objects/config/settings.bundle.json` in a Git checkout
    const editedFiles = {...initialProjection.files};
    editedFiles['src/math.lisp'] =
      '(in-package :cl-user)\n(defun hyp-sq (a b) (+ (square a) (square b) 1))\n';

    const bundleJson = JSON.parse(editedFiles['objects/config/settings.bundle.json']);
    for (const rec of Object.values(bundleJson.bundle.records)) {
      if (rec.kind === 'object' && rec.slots?.maxRetries) {
        rec.slots.maxRetries = integerValue(5);
      }
    }
    editedFiles['objects/config/settings.bundle.json'] = `${JSON.stringify(bundleJson, null, 2)}\n`;

    // Diff live Project against the edited file projection
    const diff = await diffProjectAgainstFileProjection({
      images: runtime.images,
      imageId: 'dev-img',
      projectId,
      files: editedFiles,
    });
    assert.equal(diff.format, PROJECT_FILE_PROJECTION_DIFF_V1);
    assert.equal(diff.identical, false);
    assert.deepEqual(diff.fileChanges.modified, ['objects/config/settings.bundle.json', 'src/math.lisp']);
    assert.deepEqual(diff.memberChanges.modified, ['config/settings', 'system/math-lib']);
    assert.deepEqual(diff.memberChanges.unchanged, ['code/counter.st']);

    // Reconcile the edited projection into `dev-img`
    const reconciled = await importProjectFileProjection({
      images: runtime.images,
      imageId: 'dev-img',
      files: editedFiles,
    });

    assert.deepEqual(reconciled.unchangedMemberKeys, ['code/counter.st']);
    assert.deepEqual(reconciled.updatedMemberKeys, ['config/settings', 'system/math-lib']);
    // `st-counter-src` and `cl-utils-src` were NOT modified, so their exact CodeArtifacts were reused!
    assert.deepEqual(reconciled.reusedArtifactIds, ['cl-utils-src', 'st-counter-src']);
    assert.equal(reconciled.createdArtifactIds.length, 2); // new revisions of cl-math-src and cl-math-asd

    // Verify the updated CodeArtifact content in the image
    const updatedDesc = await readProjectDescriptor({
      images: runtime.images,
      imageId: 'dev-img',
      projectId,
    });
    const mathSystemTarget = updatedDesc.members.find((m) => m.key === 'system/math-lib').target;
    assert.notEqual(mathSystemTarget.objectId, 'cl-math-asd', 'root system artifact advanced to new immutable revision');
    const newAsd = await runtime.images.getCodeArtifact('dev-img', mathSystemTarget.objectId);
    const utilsDep = newAsd.dependencies.find((d) => d.role === 'component:utils').artifact;
    const mathDep = newAsd.dependencies.find((d) => d.role === 'component:math').artifact;
    assert.equal(utilsDep.objectId, 'cl-utils-src', 'unchanged dependency CodeArtifact identity preserved');
    assert.notEqual(mathDep.objectId, 'cl-math-src', 'modified dependency CodeArtifact advanced to new revision');
    const newMath = await runtime.images.getCodeArtifact('dev-img', mathDep.objectId);
    assert.deepEqual(newMath.content, textValue(editedFiles['src/math.lisp']));

    // Verify `settings-obj` was updated in place at its stable ObjectRef
    const settingsTarget = updatedDesc.members.find((m) => m.key === 'config/settings').target;
    assert.equal(settingsTarget.objectId, 'settings-obj');
    const settingsObj = await runtime.images.getObject('dev-img', 'settings-obj');
    assert.deepEqual(settingsObj.slots.maxRetries, integerValue(5));
  });
});

test('writeProjectFileProjectionToDirectory and readProjectFileProjectionFromDirectory round-trip on disk, preserve .git, and refuse path traversal or unpinned Git revisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lagrange-file-projection-'));
  try {
    await withRuntime(async (runtime) => {
      const projectId = createProjectId();
      await seedPolyglotProject(runtime.images, 'img', projectId);
      const projection = await exportProjectFileProjection({
        images: runtime.images,
        imageId: 'img',
        projectId,
      });

      // Create a simulated .git directory and a stale file
      await mkdir(join(dir, '.git'), {recursive: true});
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(join(dir, 'stale.txt'), 'remove me\n', 'utf8');

      const writeReceipt = await writeProjectFileProjectionToDirectory({
        directory: dir,
        projection,
        cleanStaleFiles: true,
      });
      assert.equal(writeReceipt.writtenFiles.length, Object.keys(projection.files).length);

      // .git/HEAD is untouched
      assert.equal(await readFile(join(dir, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');

      const readBack = await readProjectFileProjectionFromDirectory({directory: dir});
      assert.equal(readBack.contentIdentity, projection.contentIdentity);
      assert.deepEqual(readBack.files, projection.files);

      const diff = diffProjectFileProjection({
        leftFiles: projection.files,
        rightFiles: readBack.files,
      });
      assert.equal(diff.identical, true);
    });

    // Path traversal is refused
    await assert.rejects(
      writeProjectFileProjectionToDirectory({
        directory: dir,
        projection: {
          [DEFAULT_PROJECT_MANIFEST_PATH]: '{}',
          '../escape.txt': 'bad',
        },
      }),
      (err) => err instanceof ProjectFileProjectionError,
    );

    // Unpinned branch name in Git dependency is refused by default
    assert.throws(
      () =>
        normalizeGitDependencySpec({
          name: 'unpinned-dep',
          repository: 'https://git.example.com/repo.git',
          revision: 'main',
        }),
      (err) => err instanceof ProjectFileProjectionError,
    );
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('authorizedExportProjectFileProjection and authorizedImportProjectFileProjection enforce no-existence-oracle authority ordering', async () => {
  await withRuntime(async (runtime) => {
    const projectId = createProjectId();
    await seedPolyglotProject(runtime.images, 'auth-img', projectId);

    const unpermittedCtx = runtime.authority.issue({
      principal: 'guest',
      grants: [],
    });

    // Denied export on non-existent Project gives the same AuthorityError (no-existence-oracle)
    await assert.rejects(
      authorizedExportProjectFileProjection({
        authority: runtime.authority,
        authorityContext: unpermittedCtx,
        images: runtime.images,
        imageId: 'auth-img',
        projectId: 'non-existent-project',
      }),
      /AuthorityError|not authorized/i,
    );

    // Granting read on Project object AND member targets allows export
    const readCtx = runtime.authority.issue({
      principal: 'exporter',
      grants: [
        {operation: OBJECT_READ_OPERATION, resource: objectResource('auth-img', projectObjectId(projectId))},
        {operation: OBJECT_READ_OPERATION, resource: objectResource('auth-img', 'st-counter-src')},
        {operation: OBJECT_READ_OPERATION, resource: objectResource('auth-img', 'cl-math-asd')},
        {operation: OBJECT_READ_OPERATION, resource: objectResource('auth-img', 'settings-obj')},
      ],
    });
    const exported = await authorizedExportProjectFileProjection({
      authority: runtime.authority,
      authorityContext: readCtx,
      images: runtime.images,
      imageId: 'auth-img',
      projectId,
    });
    assert.equal(exported.projectId, projectId);

    // Import into `auth-dst` requires object/write on the Project object
    await runtime.images.createImage({id: 'auth-dst'});
    await assert.rejects(
      authorizedImportProjectFileProjection({
        authority: runtime.authority,
        authorityContext: readCtx,
        images: runtime.images,
        imageId: 'auth-dst',
        files: exported.files,
      }),
      /AuthorityError|not authorized/i,
    );

    const writeCtx = runtime.authority.issue({
      principal: 'importer',
      grants: [
        {operation: OBJECT_WRITE_OPERATION, resource: objectResource('auth-dst', projectObjectId(projectId))},
      ],
    });
    const imported = await authorizedImportProjectFileProjection({
      authority: runtime.authority,
      authorityContext: writeCtx,
      images: runtime.images,
      imageId: 'auth-dst',
      files: exported.files,
    });
    assert.equal(imported.projectId, projectId);
  });
});
