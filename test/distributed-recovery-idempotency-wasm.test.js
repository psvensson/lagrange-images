import assert from 'node:assert/strict';
import test from 'node:test';
import './ensure-node-crypto.test-helper.js';

import {
  FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
  FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE,
  FOREIGN_RUNTIME_PLACEMENT_RECEIPT_V1,
  PER_OBJECT_RESIDENCY,
  PLACEMENT_RECOVERY_REPORT_V1,
  PlacementIdempotencyConflictError,
  PlacementPolicy,
  RELOCATED_RECORD_KIND,
  WASM_PLACEMENT_RECEIPT_V1,
  createForeignRuntimeCallableContent,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  installCommonLispBlock,
  installCommonLispRuntime,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {records} from '../src/image/storage-layout.js';

test('reconcileInterruptedRelocations detects and heals split-brain after an interrupted relocation between target commit and source tombstone write', async () => {
  const nodeB = await createRuntime({backend: {mode: 'mock'}});
  const nodeA = await createRuntime({backend: {mode: 'mock'}});

  try {
    const imageId = 'dist-recovery-img';
    await nodeB.images.createImage({id: imageId, name: 'Recovery Image'});
    await installSymmetricSmalltalkStandardImage({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      lane: 'wasm',
    });

    const kernel = await ensureClassFromDeclaration({
      images: nodeB.images,
      imageId,
      name: 'Wallet',
      instanceVariables: ['funds'],
    });
    const classObj = await nodeB.images.getObject(imageId, kernel.classRef.objectId);
    const shapeRef = classObj.slots['behavior-instance-shape'];
    const shapeRec = await nodeB.images.getShape(imageId, shapeRef.objectId);
    const fundsSlotId = shapeRec.slots.find((s) => s.name === 'funds').id;

    await defineMethodsFromSource({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      classRef: kernel.classRef,
      methods: [
        {selector: 'funds', source: '[ ^funds ]'},
        {selector: 'credit:', source: '[ :amt | funds := funds + amt. ^funds ]'},
      ],
    });

    const walletRec = await nodeB.images.putObject(imageId, {
      id: 'wallet/interrupted-1',
      shape: shapeRef,
      behavior: kernel.classRef,
      slots: {[fundsSlotId]: integerValue(50n)},
    });
    const walletRef = objectRef(imageId, walletRec.id);

    const placement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });

    // Inject a one-shot crash when node-b attempts to commit the source relocated tombstone
    const origNodeBTransaction = nodeB.backend.transaction.bind(nodeB.backend);
    let failNextNodeBTx = true;
    nodeB.backend.transaction = async (fn) => {
      if (failNextNodeBTx) {
        failNextNodeBTx = false;
        throw new Error('simulated crash before source tombstone commit');
      }
      return origNodeBTransaction(fn);
    };

    await assert.rejects(
      () =>
        placement.relocateObject({
          ref: walletRef,
          fromNode: 'node-b',
          toNode: 'node-a',
        }),
      /simulated crash before source tombstone commit/,
    );

    // Falsification: both node-b and node-a currently hold a live record for walletRef,
    // so inspectResidency must detect the duplicate live record split-brain before recovery!
    await assert.rejects(
      () => placement.inspectResidency(walletRef),
      /duplicate live object records/,
    );

    // Now run reconcileInterruptedRelocations to heal the interrupted relocation
    const recoveryReport = await placement.reconcileInterruptedRelocations({imageId});
    assert.equal(recoveryReport.format, PLACEMENT_RECOVERY_REPORT_V1);
    assert.equal(recoveryReport.healedCount, 1);
    assert.equal(recoveryReport.healed[0].fromNode, 'node-b');
    assert.equal(recoveryReport.healed[0].toNode, 'node-a');
    assert.deepEqual(recoveryReport.healed[0].ref, walletRef);

    // Verify node-b now holds the relocated tombstone and node-a is the sole live owner
    const rawOnB = await nodeB.backend.get(records(imageId), walletRef.objectId);
    assert.equal(rawOnB.kind, RELOCATED_RECORD_KIND);
    assert.equal(rawOnB.node, 'node-a');

    const residency = await placement.inspectResidency(walletRef);
    assert.equal(residency.node, 'node-a');
    assert.equal(residency.kind, PER_OBJECT_RESIDENCY);

    // Verify dispatchSend routes to node-a and mutates the recovered object cleanly
    const sendReceipt = await placement.dispatchSend({
      fromNode: 'node-b',
      receiver: walletRef,
      message: 'credit:',
      arguments: [integerValue(25n)],
    });
    assert.equal(sendReceipt.node, 'node-a');
    assert.deepEqual(sendReceipt.value, integerValue(75n));
  } finally {
    await nodeA.close();
    await nodeB.close();
  }
});

test('PlacementPolicy enforces idempotencyKey deduplication, conflict refusal, durable relocation replay, and transient error retry', async () => {
  const nodeB = await createRuntime({backend: {mode: 'mock'}});
  const nodeA = await createRuntime({backend: {mode: 'mock'}});

  try {
    const imageId = 'dist-idempotency-img';
    await nodeB.images.createImage({id: imageId, name: 'Idempotency Image'});
    await installSymmetricSmalltalkStandardImage({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      lane: 'wasm',
    });

    const kernel = await ensureClassFromDeclaration({
      images: nodeB.images,
      imageId,
      name: 'Ledger',
      instanceVariables: ['total'],
    });
    const classObj = await nodeB.images.getObject(imageId, kernel.classRef.objectId);
    const shapeRef = classObj.slots['behavior-instance-shape'];
    const shapeRec = await nodeB.images.getShape(imageId, shapeRef.objectId);
    const totalSlotId = shapeRec.slots.find((s) => s.name === 'total').id;

    await defineMethodsFromSource({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      classRef: kernel.classRef,
      methods: [
        {selector: 'total', source: '[ ^total ]'},
        {selector: 'add:', source: '[ :x | total := total + x. ^total ]'},
      ],
    });

    const ledgerRec = await nodeB.images.putObject(imageId, {
      id: 'ledger/idemp-1',
      shape: shapeRef,
      behavior: kernel.classRef,
      slots: {[totalSlotId]: integerValue(10n)},
    });
    const ledgerRef = objectRef(imageId, ledgerRec.id);

    const placement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });

    // 1. Relocate with idempotencyKey and replay both in-memory and across a fresh PlacementPolicy
    const move1 = await placement.relocateObject({
      ref: ledgerRef,
      fromNode: 'node-b',
      toNode: 'node-a',
      idempotencyKey: 'move-ledger-1',
    });
    assert.equal(move1.replayed, false);
    assert.equal(move1.toNode, 'node-a');

    const move1Replay = await placement.relocateObject({
      ref: ledgerRef,
      fromNode: 'node-b',
      toNode: 'node-a',
      idempotencyKey: 'move-ledger-1',
    });
    assert.equal(move1Replay.replayed, true);
    assert.equal(move1Replay.version, move1.version);

    // Fresh coordinator instance without in-memory cache converges from durable relocated state
    const freshPlacement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });
    const durableReplay = await freshPlacement.relocateObject({
      ref: ledgerRef,
      fromNode: 'node-b',
      toNode: 'node-a',
      idempotencyKey: 'move-ledger-1',
    });
    assert.equal(durableReplay.replayed, true);
    assert.equal(durableReplay.toNode, 'node-a');

    // 2. Idempotent dispatchSend prevents double-mutation on retry and rejects conflicting reuse
    const firstSend = await placement.dispatchSend({
      fromNode: 'node-b',
      receiver: ledgerRef,
      message: 'add:',
      arguments: [integerValue(15n)],
      idempotencyKey: 'tx-add-15',
    });
    assert.equal(firstSend.replayed, false);
    assert.deepEqual(firstSend.value, integerValue(25n));

    const duplicateSend = await placement.dispatchSend({
      fromNode: 'node-b',
      receiver: ledgerRef,
      message: 'add:',
      arguments: [integerValue(15n)],
      idempotencyKey: 'tx-add-15',
    });
    assert.equal(duplicateSend.replayed, true);
    assert.deepEqual(duplicateSend.value, integerValue(25n));

    // Verify ledger total is still 25, not 40!
    const checkTotal = await placement.dispatchSend({
      fromNode: 'node-b',
      receiver: ledgerRef,
      message: 'total',
    });
    assert.deepEqual(checkTotal.value, integerValue(25n));

    // Reusing 'tx-add-15' with different arguments throws PlacementIdempotencyConflictError
    await assert.rejects(
      () =>
        placement.dispatchSend({
          fromNode: 'node-b',
          receiver: ledgerRef,
          message: 'add:',
          arguments: [integerValue(99n)],
          idempotencyKey: 'tx-add-15',
        }),
      (err) => err instanceof PlacementIdempotencyConflictError,
    );

    // 3. Transient failure retry policy recovers on attempt 2
    let transientFailuresRemaining = 1;
    const origSendMessage = nodeA.invocations.sendMessage.bind(nodeA.invocations);
    nodeA.invocations.sendMessage = async (...args) => {
      if (transientFailuresRemaining > 0) {
        transientFailuresRemaining -= 1;
        throw new Error('transient transport hiccup');
      }
      return origSendMessage(...args);
    };

    const retriedSend = await placement.dispatchSend({
      fromNode: 'node-b',
      receiver: ledgerRef,
      message: 'add:',
      arguments: [integerValue(17n)],
      idempotencyKey: 'tx-add-17-retry',
      retry: {maxAttempts: 3},
    });
    assert.equal(retriedSend.attempts, 2);
    assert.deepEqual(retriedSend.value, integerValue(42n));
  } finally {
    await nodeA.close();
    await nodeB.close();
  }
});

test('relocateWasmArtifactClosure moves a WASM Block and its transitive wasm-function/v2 + wasm-module/v2 + wasm-binary/v1 closure for zero-remote-read execution, and reconcileForeignRuntimePlacement places foreign runtime closures on capable nodes', async () => {
  const nodeB = await createRuntime({backend: {mode: 'mock'}});
  const nodeA = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [
      [
        'mock-foreign-provider',
        {
          identity: 'mock-foreign-provider',
          async start() {
            return {handle: 'mock'};
          },
          async call() {
            return integerValue(77n);
          },
          async stop() {},
        },
      ],
    ],
    foreignRuntimeDefinitionBindings: [['test-foreign-def/v1', 'mock-foreign-provider']],
  });

  try {
    const imageId = 'dist-wasm-foreign-img';
    await nodeB.images.createImage({id: imageId, name: 'WASM and Foreign Placement Image'});
    await installSymmetricSmalltalkStandardImage({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      lane: 'wasm',
    });
    await installCommonLispRuntime({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      lane: 'wasm',
    });

    const kernel = await ensureClassFromDeclaration({
      images: nodeB.images,
      imageId,
      name: 'Meter',
      instanceVariables: ['reading'],
    });
    const classObj = await nodeB.images.getObject(imageId, kernel.classRef.objectId);
    const shapeRef = classObj.slots['behavior-instance-shape'];
    const shapeRec = await nodeB.images.getShape(imageId, shapeRef.objectId);
    const readingSlotId = shapeRec.slots.find((s) => s.name === 'reading').id;

    await defineMethodsFromSource({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      lane: 'wasm',
      classRef: kernel.classRef,
      methods: [{selector: 'reading', source: '[ ^reading ]'}],
    });

    const meterRec = await nodeB.images.putObject(imageId, {
      id: 'meter/wasm-1',
      shape: shapeRef,
      behavior: kernel.classRef,
      slots: {[readingSlotId]: integerValue(14n)},
    });
    const meterRef = objectRef(imageId, meterRec.id);

    // Compile a WASM-lane Common Lisp closure capturing `meterRef`
    const wasmClosureInstalled = await installCommonLispBlock({
      images: nodeB.images,
      compilation: nodeB.compilation,
      imageId,
      lane: 'wasm',
      source: '(* (send m :reading) factor)',
      parameters: ['factor'],
      captures: {
        M: {id: 'cap-meter', name: 'M', value: meterRef},
      },
    });
    const wasmBlockRef = objectRef(imageId, wasmClosureInstalled.block.id);

    const placement = new PlacementPolicy({
      nodes: {
        'node-b': nodeB,
        'node-a': nodeA,
      },
    });

    // 1. Relocate the entire WASM block + transitive WASM code artifact closure + captured meter object to node-a
    const wasmMove = await placement.relocateWasmArtifactClosure({
      target: wasmBlockRef,
      fromNode: 'node-b',
      toNode: 'node-a',
      includeCapturedObjects: true,
      idempotencyKey: 'wasm-closure-move-1',
    });
    assert.equal(wasmMove.format, WASM_PLACEMENT_RECEIPT_V1);
    assert.equal(wasmMove.targetKind, 'block');
    // Should include block + wasm-function/v2 + wasm-module/v2 + wasm-binary/v1 + lagrange-code/v2 + lexical-env + meter object
    assert.ok(
      wasmMove.relocatedRefs.length >= 6,
      `expected transitive WASM artifact closure to move >= 6 records, got ${wasmMove.relocatedRefs.length}`,
    );

    nodeA.images.remoteResolution.resetStats();
    const wasmExec = await placement.dispatchApply({
      fromNode: 'node-b',
      block: wasmBlockRef,
      arguments: [integerValue(3n)],
    });
    assert.equal(wasmExec.node, 'node-a');
    assert.equal(wasmExec.routedRemotely, true);
    assert.deepEqual(wasmExec.value, integerValue(42n));
    assert.equal(
      nodeA.images.remoteResolution.stats().perObjectRecordReads,
      0,
      'WASM block, module, binary, lexical env, and captured object are all resident on node-a (zero per-object remote reads)',
    );

    // 2. Reconcile foreign runtime definition placement: created on node-b, reconciled to capable node-a
    await nodeB.images.putCodeArtifact(imageId, {
      id: 'foreign/helper-src',
      languageId: 'foreign-demo',
      representation: 'foreign-source/v1',
      content: textValue('helper_fn()'),
    });
    await nodeB.images.putCodeArtifact(imageId, {
      id: 'foreign/def-1',
      languageId: 'foreign-demo',
      representation: 'test-foreign-def/v1',
      content: textValue(JSON.stringify({entry: 'helper_fn'})),
      dependencies: [
        {role: 'source', artifact: objectRef(imageId, 'foreign/helper-src')},
      ],
    });
    await nodeB.images.putCodeArtifact(imageId, {
      id: 'foreign/callable-1',
      languageId: 'foreign-demo',
      representation: FOREIGN_RUNTIME_CALLABLE_INTERFACE_V1,
      content: createForeignRuntimeCallableContent({
        argumentCount: 0,
        interface: {operation: 'run'},
      }),
      dependencies: [
        {
          role: FOREIGN_RUNTIME_DEFINITION_DEPENDENCY_ROLE,
          artifact: objectRef(imageId, 'foreign/def-1'),
        },
      ],
    });
    await nodeB.images.putBlock(imageId, {
      id: 'foreign/block-1',
      code: objectRef(imageId, 'foreign/callable-1'),
    });
    const foreignBlockRef = objectRef(imageId, 'foreign/block-1');

    const reconciled = await placement.reconcileForeignRuntimePlacement({
      definitionOrBlock: foreignBlockRef,
      idempotencyKey: 'reconcile-foreign-1',
    });
    assert.equal(reconciled.format, FOREIGN_RUNTIME_PLACEMENT_RECEIPT_V1);
    assert.equal(reconciled.representation, 'test-foreign-def/v1');
    assert.equal(reconciled.providerId, 'mock-foreign-provider');
    assert.deepEqual(reconciled.capableNodes, ['node-a']);
    assert.equal(reconciled.selectedNode, 'node-a');
    assert.equal(reconciled.relocatedRefs.length, 4);

    for (const movedRef of reconciled.relocatedRefs) {
      const res = await placement.inspectResidency(movedRef);
      assert.equal(res.node, 'node-a');
    }
  } finally {
    await nodeA.close();
    await nodeB.close();
  }
});
