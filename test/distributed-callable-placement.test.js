import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PER_OBJECT_RESIDENCY,
  PlacementPolicy,
  RELOCATED_RECORD_KIND,
  WHOLE_IMAGE_RESIDENCY,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  installCommonLispBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
} from '../src/runtime.js';
import {records} from '../src/image/storage-layout.js';

test('PlacementPolicy routes dispatchApply for Smalltalk and Common Lisp blocks and closures to the resident node of argument or lexically captured objects, and relocates block closures across nodes', async () => {
  const nodeB = await createRuntime({backend: {mode: 'mock'}});
  const nodeA = await createRuntime({backend: {mode: 'mock'}});

  try {
    const IMAGE_ID = 'dist-callable-img';
    await nodeB.images.createImage({id: IMAGE_ID, name: 'Distributed Callable Image'});
    await installSymmetricSmalltalkStandardImage({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
    });
    await installCommonLispRuntime({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
    });

    // Define Smalltalk class CounterAccount with instance variables `balance` and `step`
    const kernel = await ensureClassFromDeclaration({
      images: nodeB.images,
      imageId: IMAGE_ID,
      name: 'CounterAccount',
      instanceVariables: ['balance', 'step'],
    });
    const classObj = await nodeB.images.getObject(IMAGE_ID, kernel.classRef.objectId);
    const shapeRef = classObj.slots['behavior-instance-shape'];
    const shapeRec = await nodeB.images.getShape(IMAGE_ID, shapeRef.objectId);
    const balanceSlotId = shapeRec.slots.find((s) => s.name === 'balance').id;
    const stepSlotId = shapeRec.slots.find((s) => s.name === 'step').id;

    await defineMethodsFromSource({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
      classRef: kernel.classRef,
      methods: [
        {selector: 'current', source: '[ ^balance ]'},
        {selector: 'deposit:', source: '[ :delta | balance := balance + delta + step. ^balance ]'},
      ],
    });

    const accountRecord = await nodeB.images.putObject(IMAGE_ID, {
      id: 'account/distributed-1',
      shape: shapeRef,
      behavior: kernel.classRef,
      slots: {
        [balanceSlotId]: integerValue(100n),
        [stepSlotId]: integerValue(5n),
      },
    });
    const accountRef = objectRef(IMAGE_ID, accountRecord.id);

    // Install a Smalltalk block taking (acc, delta) as arguments
    const stArgBlockInstalled = await installSymmetricSmalltalkBlock({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
      source: '[ :acc :delta | acc deposit: delta ]',
    });
    const stArgBlockRef = objectRef(IMAGE_ID, stArgBlockInstalled.block.id);

    // Install a Common Lisp function taking (acc, delta) as arguments and sending `:deposit:` + `:current`
    const clProgram = await installCommonLispProgram({
      images: nodeB.images,
      compilation: nodeB.compilation,
      runtime: nodeB,
      imageId: IMAGE_ID,
      source:
        '(defun boost-account (acc delta) (send acc :deposit: delta) (+ (send acc :current) 1))',
    });
    const clFnBlockRef = clProgram.functions['BOOST-ACCOUNT'].blockRef;

    // Install a Smalltalk closure and a Common Lisp closure that capture `accountRef` in their lexical environments
    const stCaptureEnv = await nodeB.images.putLexicalEnvironment(IMAGE_ID, {
      id: 'env/st-captured-acc',
      bindings: {
        'cap-acc': {name: 'capturedAcc', value: accountRef},
      },
    });
    const stCapturedBlockInstalled = await installSymmetricSmalltalkBlock({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
      source: '[ :delta | capturedAcc deposit: delta ]',
      captures: {capturedAcc: 'cap-acc'},
      environment: objectRef(IMAGE_ID, stCaptureEnv.id),
    });
    const stCapturedBlockRef = objectRef(IMAGE_ID, stCapturedBlockInstalled.block.id);

    const clCapturedBlockInstalled = await installCommonLispBlock({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
      source: '(+ (send captured-acc :deposit: delta) 2)',
      parameters: ['delta'],
      captures: {
        'CAPTURED-ACC': {id: 'cap-acc-cl', name: 'CAPTURED-ACC', value: accountRef},
      },
    });
    const clCapturedBlockRef = objectRef(IMAGE_ID, clCapturedBlockInstalled.block.id);

    // Register both nodes with PlacementPolicy and relocate `accountRef` from node-b to node-a
    const placement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });

    const relocatedAccount = await placement.relocateObject({
      ref: accountRef,
      fromNode: 'node-b',
      toNode: 'node-a',
    });
    assert.equal(relocatedAccount.residencyKind, PER_OBJECT_RESIDENCY);
    assert.equal((await placement.inspectResidency(accountRef)).node, 'node-a');

    // 1. Argument-driven compute-near-object routing for Smalltalk and Common Lisp callable blocks
    assert.equal(
      await placement.selectBlockExecutionNode(stArgBlockRef, {
        arguments: [accountRef, integerValue(25n)],
      }),
      'node-a',
    );
    assert.equal(
      await placement.selectBlockExecutionNode(clFnBlockRef, {
        arguments: [accountRef, integerValue(20n)],
      }),
      'node-a',
    );

    nodeA.images.remoteResolution.resetStats();
    nodeB.images.remoteResolution.resetStats();

    const stArgResult = await placement.dispatchApply({
      fromNode: 'node-b',
      block: stArgBlockRef,
      arguments: [accountRef, integerValue(25n)],
    });
    assert.equal(stArgResult.node, 'node-a');
    assert.equal(stArgResult.fromNode, 'node-b');
    assert.equal(stArgResult.routedRemotely, true);
    // 100 + 25 + 5 = 130
    assert.deepEqual(stArgResult.value, integerValue(130n));
    assert.equal(
      nodeA.images.remoteResolution.stats().perObjectRecordWrites,
      0,
      'executing on node-a writes to resident accountRef locally without cross-node per-object writes',
    );
    assert.ok(nodeA.images.remoteResolution.stats().localRecordWrites > 0);

    const clArgResult = await placement.dispatchApply({
      fromNode: 'node-b',
      block: clFnBlockRef,
      arguments: [accountRef, integerValue(20n)],
    });
    assert.equal(clArgResult.node, 'node-a');
    assert.equal(clArgResult.routedRemotely, true);
    // (130 + 20 + 5) + 1 = 156
    assert.deepEqual(clArgResult.value, integerValue(156n));

    // 2. Lexical-capture-driven compute-near-object routing (arguments contain only an immediate integer!)
    assert.equal(
      await placement.selectBlockExecutionNode(stCapturedBlockRef, {
        arguments: [integerValue(10n)],
      }),
      'node-a',
      'Smalltalk closure capturing relocated accountRef routes to node-a even with immediate-only arguments',
    );
    assert.equal(
      await placement.selectBlockExecutionNode(clCapturedBlockRef, {
        arguments: [integerValue(10n)],
      }),
      'node-a',
      'Common Lisp closure capturing relocated accountRef routes to node-a even with immediate-only arguments',
    );

    const stCapturedResult = await placement.dispatchApply({
      fromNode: 'node-b',
      block: stCapturedBlockRef,
      arguments: [integerValue(10n)],
    });
    assert.equal(stCapturedResult.node, 'node-a');
    assert.equal(stCapturedResult.routedRemotely, true);
    // 155 + 10 + 5 = 170
    assert.deepEqual(stCapturedResult.value, integerValue(170n));

    const clCapturedResult = await placement.dispatchApply({
      fromNode: 'node-b',
      block: clCapturedBlockRef,
      arguments: [integerValue(15n)],
    });
    assert.equal(clCapturedResult.node, 'node-a');
    assert.equal(clCapturedResult.routedRemotely, true);
    // (170 + 15 + 5) + 2 = 192
    assert.deepEqual(clCapturedResult.value, integerValue(192n));

    // 3. Relocate a callable block closure (block + lexical-environment + code-artifact) to node-a
    const factorObj = await nodeB.images.putObject(IMAGE_ID, {
      id: 'factor/box-1',
      shape: shapeRef,
      behavior: kernel.classRef,
      slots: {
        [balanceSlotId]: integerValue(6n),
        [stepSlotId]: integerValue(1n),
      },
    });
    const factorRef = objectRef(IMAGE_ID, factorObj.id);
    const relocatableClosureInstalled = await installCommonLispBlock({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId: IMAGE_ID,
      source: '(* (send factor-box :current) x)',
      parameters: ['x'],
      captures: {
        'FACTOR-BOX': {id: 'cap-factor', name: 'FACTOR-BOX', value: factorRef},
      },
    });
    const relocatableBlockRef = objectRef(IMAGE_ID, relocatableClosureInstalled.block.id);
    const relocatableEnvRef = relocatableClosureInstalled.block.environment;
    const relocatableCodeRef = relocatableClosureInstalled.block.code;

    const closureMove = await placement.relocateBlockClosure({
      block: relocatableBlockRef,
      fromNode: 'node-b',
      toNode: 'node-a',
      includeCodeArtifact: true,
      includeCapturedObjects: true,
    });
    assert.equal(closureMove.fromNode, 'node-b');
    assert.equal(closureMove.toNode, 'node-a');
    assert.equal(closureMove.relocatedRefs.length, 4);

    assert.equal((await placement.inspectResidency(relocatableBlockRef)).node, 'node-a');
    assert.equal((await placement.inspectResidency(relocatableEnvRef)).node, 'node-a');
    assert.equal((await placement.inspectResidency(relocatableCodeRef)).node, 'node-a');
    assert.equal((await placement.inspectResidency(factorRef)).node, 'node-a');

    assert.equal(
      (await nodeB.backend.get(records(IMAGE_ID), relocatableBlockRef.objectId))?.kind,
      RELOCATED_RECORD_KIND,
    );
    assert.equal(
      (await nodeA.backend.get(records(IMAGE_ID), relocatableBlockRef.objectId))?.kind,
      'block',
    );

    // Cross-node reads from nodeB transparently resolve the relocated block, environment, and code artifact on nodeA
    assert.equal((await nodeB.images.getBlock(IMAGE_ID, relocatableBlockRef.objectId))?.id, relocatableBlockRef.objectId);
    assert.equal(
      (await nodeB.images.getLexicalEnvironment(IMAGE_ID, relocatableEnvRef.objectId))?.id,
      relocatableEnvRef.objectId,
    );
    assert.equal(
      (await nodeB.images.getCodeArtifact(IMAGE_ID, relocatableCodeRef.objectId))?.id,
      relocatableCodeRef.objectId,
    );

    const relocatedExec = await placement.dispatchApply({
      fromNode: 'node-b',
      block: relocatableBlockRef,
      arguments: [integerValue(7n)],
    });
    assert.equal(relocatedExec.node, 'node-a');
    assert.equal(relocatedExec.routedRemotely, true);
    assert.deepEqual(relocatedExec.value, integerValue(42n));

    // Relocate the closure back from node-a to node-b
    const closureBack = await placement.relocateBlockClosure({
      block: relocatableBlockRef,
      fromNode: 'node-a',
      toNode: 'node-b',
      includeCodeArtifact: true,
      includeCapturedObjects: true,
    });
    assert.equal(closureBack.relocatedRefs.length, 4);
    assert.equal((await placement.inspectResidency(relocatableBlockRef)).node, 'node-b');
    assert.equal((await placement.inspectResidency(relocatableBlockRef)).kind, WHOLE_IMAGE_RESIDENCY);
  } finally {
    await nodeA.close();
    await nodeB.close();
  }
});
