import assert from 'node:assert/strict';
import test from 'node:test';
import './ensure-node-crypto.test-helper.js';

import {
  AuthorityError,
  OBJECT_READ_OPERATION,
  PROJECT_GRAPH_V1,
  PROJECT_MEMBER_ROLES,
  PROJECT_TEST_REPORT_V1,
  addProjectMember,
  addProjectNamespaceMember,
  addRelatedProjectMember,
  addSubprojectMember,
  authorizedResolveNestedProjectGraph,
  authorizedRunProjectTests,
  classifyProjectMembers,
  commonLispFunctionBindingId,
  createNamespace,
  createProject,
  createProjectNote,
  createProjectTestCase,
  createProjectWorkItem,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  evaluateSymmetricSmalltalkBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  integerValue,
  listProjectWorkItems,
  objectRef,
  objectResource,
  projectObjectId,
  publishSmalltalkClassGlobals,
  readProjectDescriptor,
  readProjectNote,
  readProjectWorkItem,
  resolveNestedProjectGraph,
  runProjectTests,
  updateProjectWorkItem,
} from '../src/runtime.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

test('Project member conventions: code + notes + tests + data + work items with durable CRUD and classification', async () => {
  await withRuntime(async (runtime) => {
    const imageId = 'proj-conv-1';
    await runtime.images.createImage({id: imageId, name: 'Conventions Image'});
    await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId,
      lane: 'neutral',
    });

    const ns = await createNamespace({
      images: runtime.images,
      imageId,
      namespaceId: 'ns-conv-1',
    });
    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      name: 'Alpha Project',
      version: '0.1.0',
      namespace: ns,
    });

    // 1. Add a code member and a data member
    const classInstalled = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId,
      name: 'AlphaCalc',
      instanceVariables: ['base'],
    });
    await addProjectMember({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      key: 'class/AlphaCalc',
      role: PROJECT_MEMBER_ROLES.CODE,
      target: classInstalled.classRef,
    });

    await runtime.images.putShape(imageId, {
      id: 'data-config-shape',
      slots: [{id: 'base', name: 'base'}],
    });
    await runtime.images.putObject(imageId, {
      id: 'data-config-1',
      shape: objectRef(imageId, 'data-config-shape'),
      behavior: null,
      slots: {base: integerValue(100n)},
    });
    const dataRef = objectRef(imageId, 'data-config-1');
    await addProjectMember({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      key: 'data/config',
      role: PROJECT_MEMBER_ROLES.DATA,
      target: dataRef,
    });

    // 2. Create durable in-image Note
    const note = await createProjectNote({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      noteId: 'arch-1',
      title: 'Architecture Decision',
      body: 'Keep state inside the image graph.',
      tags: ['architecture', 'persistence'],
    });
    assert.equal(note.noteId, 'arch-1');
    assert.deepEqual(note.tags, ['architecture', 'persistence']);

    const readBackNote = await readProjectNote({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      noteId: 'arch-1',
    });
    assert.equal(readBackNote.title, 'Architecture Decision');
    assert.equal(readBackNote.body, 'Keep state inside the image graph.');
    assert.deepEqual(readBackNote.tags, ['architecture', 'persistence']);

    // 3. Create & update durable in-image Work Items linked to code/note/data targets
    const wi1 = await createProjectWorkItem({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      workItemId: 'wi-101',
      title: 'Implement offset calculation',
      description: 'Add offset method to AlphaCalc',
      status: 'open',
      priority: 1,
      assignee: 'alice',
      relatedTargets: [classInstalled.classRef, note.target],
    });
    assert.equal(wi1.status, 'open');
    assert.equal(wi1.priority, 1);
    assert.equal(wi1.relatedTargets.length, 2);

    await createProjectWorkItem({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      workItemId: 'wi-102',
      title: 'Verify data config defaults',
      status: 'in_progress',
      priority: 0,
      assignee: 'bob',
      relatedTargets: [dataRef],
    });

    const updatedWi1 = await updateProjectWorkItem({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      workItemId: 'wi-101',
      status: 'completed',
      description: 'Completed and verified in image.',
    });
    assert.equal(updatedWi1.status, 'completed');
    assert.equal(updatedWi1.description, 'Completed and verified in image.');

    const allWorkItems = await listProjectWorkItems({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
    });
    // Sorted by priority ascending (wi-102 priority 0 before wi-101 priority 1)
    assert.deepEqual(
      allWorkItems.map((item) => item.workItemId),
      ['wi-102', 'wi-101'],
    );

    const completedItems = await listProjectWorkItems({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
      status: 'completed',
    });
    assert.deepEqual(
      completedItems.map((item) => item.workItemId),
      ['wi-101'],
    );

    // 4. Classify Project members by convention role
    const descriptor = await readProjectDescriptor({
      images: runtime.images,
      imageId,
      projectId: 'alpha',
    });
    const classified = classifyProjectMembers(descriptor);
    assert.equal(classified.code.length, 1);
    assert.equal(classified.data.length, 1);
    assert.equal(classified.notes.length, 1);
    assert.equal(classified.workItems.length, 2);
  });
});

test('Nested / related Projects and namespace conventions resolve topological hierarchy and detect cycles safely', async () => {
  await withRuntime(async (runtime) => {
    const imageId = 'proj-graph-1';
    await runtime.images.createImage({id: imageId, name: 'Project Graph Image'});
    await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId,
      lane: 'neutral',
    });

    const nsRoot = await createNamespace({
      images: runtime.images,
      imageId,
      namespaceId: 'ns-root',
    });
    const nsExtra = await createNamespace({
      images: runtime.images,
      imageId,
      namespaceId: 'ns-extra',
    });
    const nsChild = await createNamespace({
      images: runtime.images,
      imageId,
      namespaceId: 'ns-child',
    });

    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'root-app',
      name: 'Root App',
      namespace: nsRoot,
    });
    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'sub-core',
      name: 'Subproject Core',
      namespace: nsChild,
    });
    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'related-tools',
      name: 'Related Tools',
    });

    await addProjectNamespaceMember({
      images: runtime.images,
      imageId,
      projectId: 'root-app',
      namespaceRef: nsExtra,
      name: 'ExtraNS',
    });
    await addSubprojectMember({
      images: runtime.images,
      imageId,
      projectId: 'root-app',
      subprojectId: 'sub-core',
    });
    await addRelatedProjectMember({
      images: runtime.images,
      imageId,
      projectId: 'root-app',
      relatedProjectId: 'related-tools',
    });
    // Create a cycle from sub-core back to root-app to prove cycle resistance
    await addSubprojectMember({
      images: runtime.images,
      imageId,
      projectId: 'sub-core',
      subprojectId: 'root-app',
    });

    const graph = await resolveNestedProjectGraph({
      images: runtime.images,
      imageId,
      projectId: 'root-app',
      includeRelated: true,
    });
    assert.equal(graph.format, PROJECT_GRAPH_V1);
    // Leaf projects appear before parent in post-order topological sort (sorted by member key)
    assert.deepEqual(
      graph.projects.map((p) => p.projectId),
      ['related-tools', 'sub-core', 'root-app'],
    );
    assert.equal(graph.subprojectEdges.length, 2);
    assert.equal(graph.relatedProjectEdges.length, 1);
    assert.equal(graph.namespaces.length, 3); // RootNS, ExtraNS, ChildNS
    assert.equal(graph.cycles.length, 1);
    assert.equal(graph.cycles[0].projectId, 'root-app');

    const withoutRelated = await resolveNestedProjectGraph({
      images: runtime.images,
      imageId,
      projectId: 'root-app',
      includeRelated: false,
    });
    assert.deepEqual(
      withoutRelated.projects.map((p) => p.projectId),
      ['sub-core', 'root-app'],
    );
  });
});

test('In-image polyglot Project test runner executes Smalltalk and Common Lisp tests across subprojects and isolates failures', async () => {
  await withRuntime(async (runtime) => {
    const imageId = 'proj-test-runner-1';
    await runtime.images.createImage({id: imageId, name: 'Test Runner Image'});
    const cl = await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId,
      lane: 'neutral',
    });

    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'parent-suite',
      name: 'Parent Suite',
    });
    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'child-suite',
      name: 'Child Suite',
    });
    await addSubprojectMember({
      images: runtime.images,
      imageId,
      projectId: 'parent-suite',
      subprojectId: 'child-suite',
    });

    // 1. Install a Smalltalk class & receiver with passing and failing test selectors
    const {classRef: mathSuiteClassRef} = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId,
      name: 'MathSuite',
      instanceVariables: ['seed'],
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId,
      lane: 'neutral',
      classRef: mathSuiteClassRef,
      methods: [
        {selector: 'seed:', source: '[ :v | seed := v. ^self ]'},
        {selector: 'testAdd', source: '[ ^seed + 8 ]'},
        {selector: 'testFalse', source: '[ ^false ]'},
      ],
    });
    await publishSmalltalkClassGlobals({
      images: runtime.images,
      imageId,
      names: ['MathSuite'],
    });

    const suiteReceiver = await evaluateSymmetricSmalltalkBlock({
      runtime,
      imageId,
      source: '[ | s | s := MathSuite new. s seed: 34. s ]',
    });

    // Register passing Smalltalk test case with expected value 42
    await createProjectTestCase({
      images: runtime.images,
      imageId,
      projectId: 'parent-suite',
      testId: 'st-add-42',
      name: 'Smalltalk seed + 8 equals 42',
      target: suiteReceiver,
      languageId: 'symmetric-smalltalk',
      selector: 'testAdd',
      expected: integerValue(42n),
    });

    // Register failing Smalltalk test case (returns false)
    await createProjectTestCase({
      images: runtime.images,
      imageId,
      projectId: 'parent-suite',
      testId: 'st-intentional-fail',
      name: 'Smalltalk boolean false failure',
      target: suiteReceiver,
      languageId: 'symmetric-smalltalk',
      selector: 'testFalse',
    });

    // Register throwing Smalltalk test case (unknown selector triggers runtime error)
    await createProjectTestCase({
      images: runtime.images,
      imageId,
      projectId: 'parent-suite',
      testId: 'st-throwing-selector',
      name: 'Smalltalk missing selector error',
      target: suiteReceiver,
      languageId: 'symmetric-smalltalk',
      selector: 'nonExistentSelector',
    });

    // 2. Define a Common Lisp function and register its binding as a test in `child-suite`
    await installCommonLispProgram({
      images: runtime.images,
      compilation: runtime.compilation,
      runtime,
      imageId,
      lane: 'neutral',
      source: '(defun verify-lisp-math () (= (* 6 7) 42))',
    });
    const clBindingRef = objectRef(imageId, commonLispFunctionBindingId('VERIFY-LISP-MATH'));

    await createProjectTestCase({
      images: runtime.images,
      imageId,
      projectId: 'child-suite',
      testId: 'cl-math-check',
      name: 'Common Lisp (* 6 7) == 42',
      target: clBindingRef,
      languageId: 'common-lisp',
      expected: cl.t,
    });

    // Run tests including subprojects: should run child-suite (1 pass) + parent-suite (1 pass, 2 fails)
    const report = await runProjectTests({
      runtime,
      imageId,
      projectId: 'parent-suite',
      includeSubprojects: true,
    });

    assert.equal(report.format, PROJECT_TEST_REPORT_V1);
    assert.equal(report.totalCount, 4);
    assert.equal(report.passedCount, 2);
    assert.equal(report.failedCount, 2);
    assert.equal(report.passed, false);

    const byKey = Object.fromEntries(report.results.map((r) => [r.key, r]));
    assert.equal(byKey['test/cl-math-check'].status, 'passed');
    assert.equal(byKey['test/st-add-42'].status, 'passed');
    assert.equal(byKey['test/st-intentional-fail'].status, 'failed');
    assert.match(byKey['test/st-intentional-fail'].error, /falsy outcome/);
    assert.equal(byKey['test/st-throwing-selector'].status, 'failed');
    assert.ok(byKey['test/st-throwing-selector'].error.length > 0);

    // Run filtered to only the passing tests -> report.passed === true
    const passingOnlyReport = await runProjectTests({
      runtime,
      imageId,
      projectId: 'parent-suite',
      includeSubprojects: true,
      filterKeys: ['test/cl-math-check', 'test/st-add-42'],
    });
    assert.equal(passingOnlyReport.passed, true);
    assert.equal(passingOnlyReport.totalCount, 2);
    assert.equal(passingOnlyReport.passedCount, 2);
    assert.equal(passingOnlyReport.failedCount, 0);
  });
});

test('Authorized Project graph and test runner enforce no-existence-oracle authority ordering', async () => {
  await withRuntime(async (runtime) => {
    const imageId = 'proj-conv-auth-1';
    await runtime.images.createImage({id: imageId, name: 'Auth Conventions Image'});

    const emptyCtx = runtime.authority.issue({
      principal: 'principal:unprivileged',
      grants: [],
    });

    let readCalls = 0;
    const spyImages = new Proxy(runtime.images, {
      get(target, prop, receiver) {
        if (prop === 'getObject' || prop === 'getRecord') {
          return (...args) => {
            readCalls += 1;
            return target[prop](...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await assert.rejects(
      () =>
        authorizedResolveNestedProjectGraph({
          authority: runtime.authority,
          authorityContext: emptyCtx,
          images: spyImages,
          imageId,
          projectId: 'non-existent-project',
        }),
      (err) => err instanceof AuthorityError,
    );
    assert.equal(readCalls, 0, 'must not probe image store before authority check');

    await assert.rejects(
      () =>
        authorizedRunProjectTests({
          authority: runtime.authority,
          authorityContext: emptyCtx,
          images: spyImages,
          invocations: runtime.invocations,
          executor: runtime.executor,
          imageId,
          projectId: 'non-existent-project',
        }),
      (err) => err instanceof AuthorityError,
    );
    assert.equal(readCalls, 0, 'must not probe image store before authority check');

    // Grant read on root project only, verify subproject read is also checked
    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'root-p',
      name: 'Root P',
    });
    await createProject({
      images: runtime.images,
      imageId,
      projectId: 'secret-sub',
      name: 'Secret Sub',
    });
    await addSubprojectMember({
      images: runtime.images,
      imageId,
      projectId: 'root-p',
      subprojectId: 'secret-sub',
    });

    const rootOnlyCtx = runtime.authority.issue({
      principal: 'principal:partial-reader',
      grants: [
        {
          operation: OBJECT_READ_OPERATION,
          resource: objectResource(imageId, projectObjectId('root-p')),
        },
      ],
    });

    await assert.rejects(
      () =>
        authorizedResolveNestedProjectGraph({
          authority: runtime.authority,
          authorityContext: rootOnlyCtx,
          images: runtime.images,
          imageId,
          projectId: 'root-p',
        }),
      (err) => err instanceof AuthorityError,
    );
  });
});
