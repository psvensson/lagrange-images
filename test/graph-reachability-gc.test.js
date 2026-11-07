import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMAGE_GC_PLAN_V1,
  IMAGE_GC_RECEIPT_V1,
  IMAGE_GRAPH_INDEX_V1,
  IMAGE_REACHABILITY_CLOSURE_V1,
  SWEPT_RECORD_KIND,
  addProjectMember,
  buildImageGraphIndex,
  collectUnreachableImageRecords,
  computeReachableImageClosure,
  createProject,
  createRuntime,
  defineMethodsFromSource,
  discoverDefaultImageRoots,
  ensureClassFromDeclaration,
  evaluateCommonLispSource,
  evaluateSymmetricSmalltalkBlock,
  findArtifactDependents,
  findArtifactSources,
  findArtifactsByLogicalPath,
  findDerivedArtifacts,
  findIncomingReferences,
  findOutgoingReferences,
  installCommonLispProgram,
  installCommonLispRuntime,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  planImageGarbageCollection,
  projectObjectId,
  reconcileMethodsFromSource,
  reconstructImageRecordsAtFrontier,
  textValue,
} from '../src/runtime.js';

test('buildImageGraphIndex indexes forward/reverse references and derivation/dependency chains', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({
      id: 'idx-img',
      name: 'Index Test Image',
    });

    const shape = await runtime.images.putShape(image.id, {
      id: 'shape-box',
      slots: [
        {id: 'child', name: 'child'},
        {id: 'fn', name: 'fn'},
      ],
    });

    const sourceArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'art-source',
      languageId: 'common-lisp',
      representation: 'common-lisp/source-v0',
      logicalPath: 'src/math.lisp',
      content: textValue('(defun double (x) (* x 2))'),
    });

    const irArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'art-ir',
      languageId: 'common-lisp',
      representation: 'lagrange-code/v1',
      logicalPath: 'src/math.lisp',
      content: textValue('{}'),
      derivedFrom: [objectRef(image.id, sourceArtifact.id)],
    });

    const helperDepArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'art-helper',
      representation: 'neutral-expression/v1',
      content: textValue('{}'),
    });

    const execArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'art-exec',
      representation: 'wasm-module/v1',
      content: textValue('{}'),
      derivedFrom: [objectRef(image.id, irArtifact.id)],
      dependencies: [
        {
          role: 'helper',
          artifact: objectRef(image.id, helperDepArtifact.id),
        },
      ],
    });

    const env = await runtime.images.putLexicalEnvironment(image.id, {
      id: 'env-root',
      parent: null,
      bindings: {},
    });

    const block = await runtime.images.putBlock(image.id, {
      id: 'block-double',
      code: objectRef(image.id, execArtifact.id),
      environment: objectRef(image.id, env.id),
    });

    const leafObj = await runtime.images.putObject(image.id, {
      id: 'obj-leaf',
      shape: objectRef(image.id, shape.id),
      slots: {
        child: integerValue(0n),
        fn: integerValue(0n),
      },
    });

    const rootObj = await runtime.images.putObject(image.id, {
      id: 'obj-root',
      shape: objectRef(image.id, shape.id),
      slots: {
        child: objectRef(image.id, leafObj.id),
        fn: objectRef(image.id, block.id),
      },
    });

    const records = await runtime.images.listRecords(image.id);
    const index = buildImageGraphIndex(records, {imageId: image.id});

    assert.equal(index.format, IMAGE_GRAPH_INDEX_V1);
    assert.equal(index.imageId, image.id);
    assert.equal(index.recordCount, 9);

    // Direct and transitive outgoing references from rootObj
    assert.deepEqual(findOutgoingReferences(index, rootObj.id, {transitive: false}), [
      block.id,
      leafObj.id,
      shape.id,
    ]);
    assert.deepEqual(
      findOutgoingReferences(index, rootObj.id, {transitive: true}),
      [
        execArtifact.id,
        helperDepArtifact.id,
        irArtifact.id,
        sourceArtifact.id,
        block.id,
        env.id,
        leafObj.id,
        shape.id,
      ].sort(),
    );

    // Direct and transitive incoming references to sourceArtifact
    assert.deepEqual(findIncomingReferences(index, sourceArtifact.id, {transitive: false}), [
      irArtifact.id,
    ]);
    assert.deepEqual(
      findIncomingReferences(index, sourceArtifact.id, {transitive: true}),
      [execArtifact.id, irArtifact.id, block.id, rootObj.id].sort(),
    );

    // Derivation lookup (source -> derived and derived -> source)
    const directDerived = findDerivedArtifacts(index, sourceArtifact.id, {transitive: false});
    assert.deepEqual(directDerived.artifactIds, [irArtifact.id]);

    const transitiveDerived = findDerivedArtifacts(index, sourceArtifact.id, {transitive: true});
    assert.deepEqual(transitiveDerived.artifactIds, [execArtifact.id, irArtifact.id]);
    assert.deepEqual(transitiveDerived.blocksReferencingDerived, [block.id]);

    const upstreamSources = findArtifactSources(index, execArtifact.id, {transitive: true});
    assert.deepEqual(upstreamSources.sourceArtifactIds, [irArtifact.id, sourceArtifact.id]);

    // Dependency reverse lookup
    const depDependents = findArtifactDependents(index, helperDepArtifact.id, {transitive: true});
    assert.deepEqual(depDependents.dependentArtifactIds, [execArtifact.id]);

    // Logical path lookup
    const byPath = findArtifactsByLogicalPath(index, 'src/math.lisp');
    assert.deepEqual(byPath.artifactIds, [irArtifact.id, sourceArtifact.id]);
  } finally {
    await runtime.close();
  }
});

test('computeReachableImageClosure respects explicit roots and includeDerivedArtifacts', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({
      id: 'closure-img',
      name: 'Closure Test Image',
    });

    const sourceArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'art-src',
      representation: 'common-lisp/source-v0',
      content: textValue('(+ 1 2)'),
    });

    const cachedExecArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'art-cached-wasm',
      representation: 'wasm-module/v1',
      content: textValue('{}'),
      derivedFrom: [objectRef(image.id, sourceArtifact.id)],
    });

    const orphanArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'art-orphan',
      representation: 'common-lisp/source-v0',
      content: textValue('(+ 99 100)'),
    });

    const records = await runtime.images.listRecords(image.id);

    const withoutDerived = computeReachableImageClosure({
      records,
      imageId: image.id,
      roots: [sourceArtifact.id],
      includeDefaultRoots: false,
      includeDerivedArtifacts: false,
    });
    assert.equal(withoutDerived.format, IMAGE_REACHABILITY_CLOSURE_V1);
    assert.deepEqual(withoutDerived.reachableIds, [sourceArtifact.id]);
    assert.deepEqual(
      withoutDerived.unreachableIds,
      [cachedExecArtifact.id, orphanArtifact.id].sort(),
    );

    const withDerived = computeReachableImageClosure({
      records,
      imageId: image.id,
      roots: [sourceArtifact.id],
      includeDefaultRoots: false,
      includeDerivedArtifacts: true,
    });
    assert.deepEqual(
      withDerived.reachableIds,
      [cachedExecArtifact.id, sourceArtifact.id].sort(),
    );
    assert.deepEqual(withDerived.unreachableIds, [orphanArtifact.id]);
  } finally {
    await runtime.close();
  }
});

test('planImageGarbageCollection and collectUnreachableImageRecords protect pinned frontiers, sweep unreachable records, and preserve live Smalltalk, Common Lisp, and Project execution', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    const image = await runtime.images.createImage({
      id: 'gc-polyglot-img',
      name: 'GC Polyglot Image',
    });
    await installSymmetricSmalltalkStandardImage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: image.id,
    });
    await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: image.id,
    });

    // 1. Install Smalltalk class GcProbe with v1 method `compute [ ^10 ]`
    const kernel = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: image.id,
      name: 'GcProbe',
      instanceVariables: [],
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: image.id,
      classRef: kernel.classRef,
      methods: [{selector: 'compute', source: '[ ^10 ]'}],
    });
    const v1MethodBlock = (await runtime.images.listBlocks(image.id)).find(
      (b) => b.metadata?.smalltalk === 'method' && b.metadata?.selector === 'compute' && b.id.includes('GcProbe'),
    );
    assert.ok(v1MethodBlock);
    const v1MethodBlockId = v1MethodBlock.id;
    const v1CodeArtifactId = v1MethodBlock.code.objectId;

    // 2. Install Common Lisp v1 function and global cons cell
    const clV1 = await installCommonLispProgram({
      images: runtime.images,
      compilation: runtime.compilation,
      runtime,
      imageId: image.id,
      source: '(defun cl-probe (x) (+ x 10)) (defvar *cl-pinned* (cons 11 22))',
    });
    const v1ClBlockId = clV1.functions['CL-PROBE'].blockRef.objectId;
    const v1ConsObjectId = clV1.variables['*CL-PINNED*'].value.objectId;

    // 3. Create a Project referencing a live member object
    const probeShape = await runtime.images.putShape(image.id, {
      id: 'probe-custom-shape',
      slots: [{id: 'tag', name: 'tag'}],
    });
    const projectMemberObj = await runtime.images.putObject(image.id, {
      id: 'project-kept-object',
      shape: objectRef(image.id, probeShape.id),
      slots: {tag: textValue('kept-by-project')},
    });
    await createProject({
      images: runtime.images,
      imageId: image.id,
      projectId: 'gc-test-project',
      name: 'GC Test Project',
    });
    await addProjectMember({
      images: runtime.images,
      imageId: image.id,
      projectId: 'gc-test-project',
      key: 'kept-obj',
      role: 'fixture',
      target: objectRef(image.id, projectMemberObj.id),
    });

    // Capture frontierV1 where v1MethodBlockId, v1CodeArtifactId, v1ClBlockId, and v1ConsObjectId are live/reachable
    const frontierV1 = await runtime.images.frontier(image.id);

    // 4. Advance image state past frontierV1:
    //    - Create ephemeral orphan records that are never rooted
    const orphanShape = await runtime.images.putShape(image.id, {
      id: 'orphan-shape',
      slots: [{id: 'val', name: 'val'}],
    });
    const orphanObject = await runtime.images.putObject(image.id, {
      id: 'orphan-object',
      shape: objectRef(image.id, orphanShape.id),
      slots: {val: integerValue(404n)},
    });
    const orphanArtifact = await runtime.images.putCodeArtifact(image.id, {
      id: 'orphan-artifact',
      representation: 'neutral-expression/v1',
      content: textValue('{}'),
    });
    const orphanBlock = await runtime.images.putBlock(image.id, {
      id: 'orphan-block',
      code: objectRef(image.id, orphanArtifact.id),
      environment: null,
    });

    //    - Replace Smalltalk GcProbe >> compute with v2 returning 42
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: image.id,
      classRef: kernel.classRef,
      methods: [{selector: 'compute', source: '[ ^42 ]'}],
    });
    const computeBlocksAfterV2 = (await runtime.images.listBlocks(image.id)).filter(
      (b) => b.metadata?.smalltalk === 'method' && b.metadata?.selector === 'compute' && b.id.includes('GcProbe'),
    );
    assert.equal(computeBlocksAfterV2.length, 2);

    //    - Replace Common Lisp `cl-probe` with v2 and update `*cl-pinned*` to a new cons cell
    const clV2 = await installCommonLispProgram({
      images: runtime.images,
      compilation: runtime.compilation,
      runtime,
      imageId: image.id,
      source: '(defun cl-probe (x) (+ x 42))',
    });
    assert.notEqual(clV2.functions['CL-PROBE'].blockRef.objectId, v1ClBlockId);

    await evaluateCommonLispSource({
      runtime,
      imageId: image.id,
      source: '(setq *cl-pinned* (cons 30 40))',
    });

    // Step A: Plan & execute GC WITH frontierV1 pinned!
    const planWithPin = await planImageGarbageCollection({
      images: runtime.images,
      imageId: image.id,
      pinnedFrontiers: [frontierV1],
    });
    assert.equal(planWithPin.format, IMAGE_GC_PLAN_V1);
    assert.deepEqual(planWithPin.pinnedFrontiers, [frontierV1]);

    // Ephemeral orphans created after frontierV1 must be scheduled for sweep
    assert.ok(planWithPin.sweptIds.includes(orphanShape.id));
    assert.ok(planWithPin.sweptIds.includes(orphanObject.id));
    assert.ok(planWithPin.sweptIds.includes(orphanArtifact.id));
    assert.ok(planWithPin.sweptIds.includes(orphanBlock.id));

    // Historical v1 records from frontierV1 must be protected by the pinned frontier!
    assert.ok(planWithPin.pinnedByFrontierIds.includes(v1MethodBlockId));
    assert.ok(planWithPin.pinnedByFrontierIds.includes(v1CodeArtifactId));
    assert.ok(planWithPin.pinnedByFrontierIds.includes(v1ClBlockId));
    assert.ok(planWithPin.pinnedByFrontierIds.includes(v1ConsObjectId));
    assert.ok(planWithPin.retainedIds.includes(v1MethodBlockId));
    assert.ok(planWithPin.retainedIds.includes(v1CodeArtifactId));
    assert.ok(planWithPin.retainedIds.includes(v1ClBlockId));
    assert.ok(planWithPin.retainedIds.includes(v1ConsObjectId));

    const gcReceiptWithPin = await collectUnreachableImageRecords({
      images: runtime.images,
      imageId: image.id,
      pinnedFrontiers: [frontierV1],
    });
    assert.equal(gcReceiptWithPin.format, IMAGE_GC_RECEIPT_V1);
    assert.ok(gcReceiptWithPin.sweptIds.includes(orphanObject.id));
    assert.equal(await runtime.images.getRecord(image.id, orphanObject.id), null);
    assert.equal(await runtime.images.getRecord(image.id, orphanBlock.id), null);
    assert.equal(await runtime.images.getRecord(image.id, orphanArtifact.id), null);

    // Pinned v1 records remain live in storage while frontierV1 is pinned
    assert.notEqual(await runtime.images.getRecord(image.id, v1MethodBlockId), null);
    assert.notEqual(await runtime.images.getRecord(image.id, v1CodeArtifactId), null);
    assert.notEqual(await runtime.images.getRecord(image.id, v1ClBlockId), null);
    assert.notEqual(await runtime.images.getRecord(image.id, v1ConsObjectId), null);

    // Step B: Unpin frontierV1 and run GC again -> superseded v1 records are now swept!
    const gcReceiptUnpinned = await collectUnreachableImageRecords({
      images: runtime.images,
      imageId: image.id,
      pinnedFrontiers: [],
    });
    assert.ok(gcReceiptUnpinned.sweptIds.includes(v1MethodBlockId));
    assert.ok(gcReceiptUnpinned.sweptIds.includes(v1CodeArtifactId));
    assert.ok(gcReceiptUnpinned.sweptIds.includes(v1ClBlockId));
    assert.ok(gcReceiptUnpinned.sweptIds.includes(v1ConsObjectId));
    assert.ok(gcReceiptUnpinned.receipts.every((entry) => entry.kind === SWEPT_RECORD_KIND));

    assert.equal(await runtime.images.getRecord(image.id, v1MethodBlockId), null);
    assert.equal(await runtime.images.getRecord(image.id, v1CodeArtifactId), null);
    assert.equal(await runtime.images.getRecord(image.id, v1ClBlockId), null);
    assert.equal(await runtime.images.getRecord(image.id, v1ConsObjectId), null);

    // Project member object and its shape remain retained through the Project descriptor
    assert.notEqual(await runtime.images.getRecord(image.id, projectMemberObj.id), null);
    assert.notEqual(await runtime.images.getRecord(image.id, probeShape.id), null);

    // Historical frontierV1 can STILL be reconstructed from the append-only history stream
    const reconstructedV1 = await reconstructImageRecordsAtFrontier({
      images: runtime.images,
      imageId: image.id,
      frontier: frontierV1,
    });
    assert.ok(reconstructedV1.some((record) => record.id === v1MethodBlockId));
    assert.ok(reconstructedV1.some((record) => record.id === v1ConsObjectId));

    // Live execution of both Symmetric Smalltalk and Common Lisp succeeds after GC!
    const stValue = await evaluateSymmetricSmalltalkBlock({
      runtime,
      imageId: image.id,
      source: '[ :cls | cls new compute ]',
      arguments: [kernel.classRef],
    });
    assert.deepEqual(stValue, integerValue(42n));

    const clValue = await evaluateCommonLispSource({
      runtime,
      imageId: image.id,
      source:
        '(let ((fresh (cons 7 8))) (+ (cl-probe 10) (car *cl-pinned*) (cdr *cl-pinned*) (car fresh) (cdr fresh)))',
    });
    // (10 + 42) + 30 + 40 + 7 + 8 = 137
    assert.deepEqual(clValue, integerValue(137n));

    // Default roots discovery check
    const remainingRecords = await runtime.images.listRecords(image.id);
    const defaultRoots = discoverDefaultImageRoots(remainingRecords, {imageId: image.id});
    assert.ok(defaultRoots.includes('smalltalk-kernel/v1'));
    assert.ok(defaultRoots.includes('smalltalk-global-namespace/v1'));
    assert.ok(defaultRoots.includes('common-lisp/namespace/v1'));
    assert.ok(defaultRoots.includes(projectObjectId('gc-test-project')));
  } finally {
    await runtime.close();
  }
});
