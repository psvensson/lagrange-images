import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVATION_STACK_REPORT_V1,
  ActivationCancelledError,
  ConditionRuntime,
  OBJECT_READ_OPERATION,
  authorizedInspectExecutionCondition,
  captureActivationStackReport,
  commonLispFunctionBlockId,
  commonLispVariableBindingId,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  installCommonLispProgram,
  installCommonLispRuntime,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  objectResource,
  publishSmalltalkClassGlobals,
  textValue,
} from '../src/runtime.js';

test('pre-aborted AbortSignal cancels activation immediately with ActivationCancelledError and stack frame snapshot', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const imageId = 'cancel-preaborted-img';
  await runtime.images.createImage({id: imageId, name: 'Cancel Pre-Aborted Image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
  });

  const entry = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    blockId: 'preaborted-entry',
    source: '[ 40 + 2 ]',
  });
  const activation = await runtime.invocations.prepareActivation({
    block: objectRef(imageId, entry.block.id),
    arguments: [],
  });

  const controller = new AbortController();
  controller.abort('user-requested-stop');

  await assert.rejects(
    async () => await runtime.executor.execute(activation, {signal: controller.signal}),
    (err) => {
      assert.ok(err instanceof ActivationCancelledError);
      assert.equal(err.name, 'ActivationCancelledError');
      assert.equal(err.reason, 'user-requested-stop');
      assert.match(err.message, /user-requested-stop/);
      assert.equal(err.frames.length, 1);
      assert.equal(err.frames[0].block.objectId, entry.block.id);
      return true;
    },
  );
});

test('mid-loop cancellation stops Smalltalk whileTrue: and Common Lisp loop while running ensure:/unwind-protect cleanups', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const imageId = 'cancel-loop-unwind-img';
  await runtime.images.createImage({id: imageId, name: 'Cancel Loop Unwind Image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
  });
  await installCommonLispRuntime({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
  });

  const {classRef: workerClass} = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId,
    name: 'LoopWorker',
    superclassRef: objectRef(imageId, 'smalltalk/class/Object'),
    instanceVariables: ['steps', 'cleaned'],
  });
  await publishSmalltalkClassGlobals({
    images: runtime.images,
    imageId,
    names: ['LoopWorker'],
  });
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    classRef: workerClass,
    methods: [
      {selector: 'steps', source: '[ ^ steps ]'},
      {selector: 'cleaned', source: '[ ^ cleaned ]'},
      {
        selector: 'tick',
        source: '[ steps := steps + 1. ^ steps ]',
      },
      {
        selector: 'runLoop',
        source: `[
          steps := 0.
          cleaned := 0.
          [ [ steps < 100 ] whileTrue: [ self tick ] ]
            ensure: [ cleaned := 99 ].
          ^ steps
        ]`,
      },
    ],
  });

  // Allocate a durable LoopWorker instance so we can inspect its slots after cancellation
  const workerClassRecord = await runtime.images.getObject(imageId, workerClass.objectId);
  const workerShapeRef = workerClassRecord.slots['behavior-instance-shape'];
  const workerShape = await runtime.images.getShape(imageId, workerShapeRef.objectId);
  const stepsSlotId = workerShape.slots.find((s) => s.name === 'steps').id;
  const cleanedSlotId = workerShape.slots.find((s) => s.name === 'cleaned').id;

  await runtime.images.putObject(imageId, {
    id: 'worker-1',
    shape: workerShapeRef,
    behavior: workerClass,
    slots: {
      [stepsSlotId]: integerValue(0n),
      [cleanedSlotId]: integerValue(0n),
    },
  });

  // Intercept sendMessage on invocations or abort after 3 ticks via a custom AbortController hook:
  const stController = new AbortController();
  const originalPrepareDispatch = runtime.invocations.prepareDispatch.bind(runtime.invocations);
  let tickSends = 0;
  runtime.invocations.prepareDispatch = async (request, options) => {
    if (request.message?.value === 'tick') {
      tickSends += 1;
      if (tickSends >= 3) {
        stController.abort('abort-at-tick-3');
      }
    }
    return await originalPrepareDispatch(request, options);
  };

  try {
    const runLoopAct = await runtime.invocations.sendMessage(
      {
        languageId: 'symmetric-smalltalk',
        receiver: objectRef(imageId, 'worker-1'),
        message: textValue('runLoop'),
        arguments: [],
      },
      {dispatchImage: imageId},
    );

    await assert.rejects(
      async () => await runtime.executor.execute(runLoopAct, {signal: stController.signal}),
      (err) => {
        assert.ok(err instanceof ActivationCancelledError);
        assert.equal(err.reason, 'abort-at-tick-3');
        return true;
      },
    );

    const updatedWorker = await runtime.images.getObject(imageId, 'worker-1');
    assert.deepEqual(updatedWorker.slots[stepsSlotId], integerValue(2n));
    assert.deepEqual(updatedWorker.slots[cleanedSlotId], integerValue(99n));
  } finally {
    runtime.invocations.prepareDispatch = originalPrepareDispatch;
  }

  // Also verify Common Lisp `unwind-protect` runs its cleanup forms when cancelled mid-loop
  await installCommonLispProgram({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    source: `
      (defvar *cl-loop-count* 0)
      (defvar *cl-cleanup-ran* 0)
      (defun cl-step ()
        (setq *cl-loop-count* (+ *cl-loop-count* 1)))
      (defun cl-cancellable-loop ()
        (unwind-protect
          (loop for i from 1 to 50 do (cl-step))
          (setq *cl-cleanup-ran* 77)))
    `,
  });

  const clController = new AbortController();
  const originalPrepareActivation = runtime.invocations.prepareActivation.bind(runtime.invocations);
  let clSteps = 0;
  const clStepBlockId = commonLispFunctionBlockId('CL-STEP');
  runtime.invocations.prepareActivation = async (request) => {
    if (request.block?.objectId === clStepBlockId) {
      clSteps += 1;
      if (clSteps >= 4) {
        clController.abort('cl-loop-cancelled');
      }
    }
    return await originalPrepareActivation(request);
  };

  try {
    const clAct = await runtime.invocations.prepareActivation({
      block: objectRef(imageId, commonLispFunctionBlockId('CL-CANCELLABLE-LOOP')),
      arguments: [],
    });
    await assert.rejects(
      async () => await runtime.executor.execute(clAct, {signal: clController.signal}),
      (err) => {
        assert.ok(err instanceof ActivationCancelledError);
        assert.equal(err.reason, 'cl-loop-cancelled');
        return true;
      },
    );

    const cleanupBinding = await runtime.images.getObject(imageId, commonLispVariableBindingId('*CL-CLEANUP-RAN*'));
    assert.deepEqual(cleanupBinding.slots['global-binding-value'], integerValue(77n));
  } finally {
    runtime.invocations.prepareActivation = originalPrepareActivation;
  }
});

test('WASM resumable execution records live suspension/resumption metadata on stack frames and retires suspended instances on cancellation', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const imageId = 'wasm-resumption-cancel-img';
  await runtime.images.createImage({id: imageId, name: 'WASM Resumption Cancel Image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
  });

  const {classRef: pipelineClass} = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId,
    name: 'WasmPipeline',
    superclassRef: objectRef(imageId, 'smalltalk/class/Object'),
    instanceVariables: ['trace'],
  });
  await publishSmalltalkClassGlobals({
    images: runtime.images,
    imageId,
    names: ['WasmPipeline'],
  });
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    classRef: pipelineClass,
    lane: 'wasm',
    methods: [
      {selector: 'stepA:', source: '[ :x | ^ x + 10 ]'},
      {selector: 'stepB:', source: '[ :x | ^ x + 20 ]'},
      {
        selector: 'computePipeline:',
        source: `[ :n |
          | a b |
          a := self stepA: n.
          b := self stepB: a.
          ^ a + b
        ]`,
      },
    ],
  });

  const pipelineClassRec = await runtime.images.getObject(imageId, pipelineClass.objectId);
  const pipelineShapeRef = pipelineClassRec.slots['behavior-instance-shape'];
  const pipelineShape = await runtime.images.getShape(imageId, pipelineShapeRef.objectId);
  const traceSlotId = pipelineShape.slots.find((s) => s.name === 'trace').id;
  await runtime.images.putObject(imageId, {
    id: 'pipeline-1',
    shape: pipelineShapeRef,
    behavior: pipelineClass,
    slots: {[traceSlotId]: integerValue(0n)},
  });

  // 1. Run computePipeline: 5 to completion while capturing the live stack inside stepB:
  const conditionRuntime = new ConditionRuntime();
  const originalPrepareDispatch = runtime.invocations.prepareDispatch.bind(runtime.invocations);
  let midStepBStackReport = null;
  runtime.invocations.prepareDispatch = async (request, options) => {
    if (request.message?.value === 'stepB:') {
      midStepBStackReport = captureActivationStackReport(conditionRuntime);
    }
    return await originalPrepareDispatch(request, options);
  };

  let answer;
  try {
    const act = await runtime.invocations.sendMessage(
      {
        languageId: 'symmetric-smalltalk',
        receiver: objectRef(imageId, 'pipeline-1'),
        message: textValue('computePipeline:'),
        arguments: [integerValue(5n)],
      },
      {dispatchImage: imageId},
    );
    answer = await runtime.executor.execute(act, {conditionRuntime});
  } finally {
    runtime.invocations.prepareDispatch = originalPrepareDispatch;
  }

  // (5 + 10) + ((5 + 10) + 20) = 15 + 35 = 50
  assert.deepEqual(answer, integerValue(50n));
  assert.ok(midStepBStackReport);
  assert.equal(midStepBStackReport.schema, ACTIVATION_STACK_REPORT_V1);
  assert.equal(midStepBStackReport.suspendedFrameCount, 1);

  const outerWasmFrame = midStepBStackReport.frames.find((f) => f.selector === 'computePipeline:');
  assert.ok(outerWasmFrame);
  assert.equal(outerWasmFrame.executionLane, 'wasm');
  assert.equal(outerWasmFrame.wasmState, 'suspended');
  assert.equal(outerWasmFrame.suspensionCount, 2);
  assert.equal(outerWasmFrame.resumedCount, 1);
  assert.equal(outerWasmFrame.lastSuspension?.abi, 'lagrange-value-handle-resumable/v2');
  assert.equal(outerWasmFrame.lastSuspension?.effectKind, 'send');
  assert.ok(typeof outerWasmFrame.lastSuspension?.resumeEntry === 'string');

  const completedReport = captureActivationStackReport(conditionRuntime);
  const computePipelineResumptions = completedReport.wasmResumptions.filter((e) => e.selector === 'computePipeline:');
  assert.equal(computePipelineResumptions.length, 6); // stepA:, stepB:, and + each suspend and resume
  assert.deepEqual(
    computePipelineResumptions.map((e) => e.event),
    ['suspend', 'resume', 'suspend', 'resume', 'suspend', 'resume'],
  );

  // 2. Now cancel mid-suspension inside stepB: and verify WASM retirement + authorizedInspectExecutionCondition
  const cancelController = new AbortController();
  runtime.invocations.prepareDispatch = async (request, options) => {
    if (request.message?.value === 'stepB:') {
      cancelController.abort('cancelled-at-stepB');
    }
    return await originalPrepareDispatch(request, options);
  };

  try {
    const cancelAct = await runtime.invocations.sendMessage(
      {
        languageId: 'symmetric-smalltalk',
        receiver: objectRef(imageId, 'pipeline-1'),
        message: textValue('computePipeline:'),
        arguments: [integerValue(5n)],
      },
      {dispatchImage: imageId},
    );

    const auth = runtime.authority.issue({
      principal: 'debugger-client',
      grants: [
        {
          operation: OBJECT_READ_OPERATION,
          resource: objectResource(cancelAct.block.imageId, cancelAct.block.objectId),
        },
      ],
    });

    const inspection = await authorizedInspectExecutionCondition({
      images: runtime.images,
      executor: runtime.executor,
      invocations: runtime.invocations,
      activation: cancelAct,
      authority: auth,
      signal: cancelController.signal,
      require: (demand) => runtime.authority.require(auth, demand),
    });

    assert.equal(inspection.status, 'cancelled');
    assert.equal(inspection.errorName, 'ActivationCancelledError');
    assert.match(inspection.description, /cancelled-at-stepB/);
    assert.ok(inspection.stackReport.frames.some((f) => f.selector === 'computePipeline:' && f.wasmState === 'suspended'));
  } finally {
    runtime.invocations.prepareDispatch = originalPrepareDispatch;
  }
});
