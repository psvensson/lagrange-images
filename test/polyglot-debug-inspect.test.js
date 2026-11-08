import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVATION_STACK_REPORT_V1,
  AuthorityError,
  CONDITION_INSPECTION_REPORT_V1,
  ConditionRuntime,
  OBJECT_READ_OPERATION,
  authorizedInspectExecutionCondition,
  captureActivationStackReport,
  captureConditionAndStackReport,
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
  invokeCapturedRestart,
  listAvailableRestarts,
  objectRef,
  objectResource,
  publishSmalltalkClassGlobals,
} from '../src/runtime.js';

test('authorizedInspectExecutionCondition captures unhandled and handled Smalltalk conditions, activation stacks, and scopes', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const imageId = 'debug-inspect-smalltalk-image';
  await runtime.images.createImage({id: imageId, name: 'Debug Inspect Smalltalk Image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
  });

  const {classRef: probeClass} = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId,
    name: 'DebugProbe',
    superclassRef: objectRef(imageId, 'smalltalk/class/Object'),
    instanceVariables: ['tag'],
  });
  await publishSmalltalkClassGlobals({
    images: runtime.images,
    imageId,
    names: ['DebugProbe'],
  });

  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    classRef: probeClass,
    methods: [
      {
        selector: 'innerSignal:',
        source: '[ :val | [ Error new signal ] ensure: [ val ] ]',
      },
      {
        selector: 'outerCompute:',
        source: '[ :val | ^ self innerSignal: val + 1 ]',
      },
    ],
  });

  const unhandledEntryBlock = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    blockId: 'debug-unhandled-entry',
    source: '[ DebugProbe new outerCompute: 10 ]',
  });
  const unhandledBlockRef = objectRef(imageId, unhandledEntryBlock.block.id);
  const unhandledActivation = await runtime.invocations.prepareActivation({
    block: unhandledBlockRef,
    arguments: [],
  });

  // Verify no-existence-oracle: denying object/read on the entry block refuses before execution
  const emptyAuth = runtime.authority.issue({
    principal: 'debug-test',
    grants: [],
  });
  await assert.rejects(
    async () => await authorizedInspectExecutionCondition({
      images: runtime.images,
      executor: runtime.executor,
      invocations: runtime.invocations,
      activation: unhandledActivation,
      authority: emptyAuth,
      require: (demand) => runtime.authority.require(emptyAuth, demand),
    }),
    (err) => err instanceof AuthorityError,
  );

  const readAuth = runtime.authority.issue({
    principal: 'debug-test',
    grants: [
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, unhandledEntryBlock.block.id)},
    ],
  });

  const unhandledResult = await authorizedInspectExecutionCondition({
    images: runtime.images,
    executor: runtime.executor,
    invocations: runtime.invocations,
    activation: unhandledActivation,
    authority: readAuth,
    require: (demand) => runtime.authority.require(readAuth, demand),
  });

  assert.equal(unhandledResult.status, 'unhandled-condition');
  assert.equal(unhandledResult.errorName, 'SmalltalkUnhandledConditionError');
  assert.ok(unhandledResult.conditionReport);
  assert.equal(unhandledResult.conditionReport.schema, CONDITION_INSPECTION_REPORT_V1);
  assert.equal(unhandledResult.conditionReport.handled, false);
  assert.ok(unhandledResult.conditionReport.description.includes('smalltalk/class/Error'));

  const stackReport = unhandledResult.stackReport;
  assert.equal(stackReport.schema, ACTIVATION_STACK_REPORT_V1);
  assert.ok(stackReport.depth >= 3);
  const selectors = stackReport.frames
    .map((frame) => frame.selector)
    .filter((sel) => sel !== null);
  assert.ok(selectors.includes('outerCompute:'));
  assert.ok(selectors.includes('innerSignal:'));
  assert.ok(selectors.includes('signal'));

  // Verify the ensure protection scope was active at the signal point
  assert.ok(
    unhandledResult.conditionReport.scopes.some((scope) => scope.kind.includes('ensure') && scope.active),
  );

  // Now test a handled condition that resumes with a value
  const handledEntryBlock = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    blockId: 'debug-handled-entry',
    source: '[ [ DebugProbe new outerCompute: 10 ] on: Error do: [ :ex | ex resume: 42 ] ]',
  });
  const handledBlockRef = objectRef(imageId, handledEntryBlock.block.id);
  const handledActivation = await runtime.invocations.prepareActivation({
    block: handledBlockRef,
    arguments: [],
  });
  const handledAuth = runtime.authority.issue({
    principal: 'debug-test',
    grants: [
      {operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, handledEntryBlock.block.id)},
    ],
  });

  const handledResult = await authorizedInspectExecutionCondition({
    images: runtime.images,
    executor: runtime.executor,
    invocations: runtime.invocations,
    activation: handledActivation,
    authority: handledAuth,
    require: (demand) => runtime.authority.require(handledAuth, demand),
  });

  assert.equal(handledResult.status, 'completed');
  assert.deepEqual(handledResult.value, integerValue(42n));
  assert.ok(handledResult.conditionReport);
  assert.equal(handledResult.conditionReport.handled, true);
  assert.ok(Number.isInteger(handledResult.conditionReport.handlerScopeId));
  assert.ok(
    handledResult.conditionReport.stackReport.frames.some((frame) => frame.selector === 'outerCompute:'),
  );

  await runtime.close();
});

test('polyglot Common Lisp and Smalltalk stack-frame, condition, and restart introspection and invocation', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const imageId = 'debug-inspect-polyglot-image';
  await runtime.images.createImage({id: imageId, name: 'Debug Inspect Polyglot Image'});
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

  await installCommonLispProgram({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    source: `
      (defun fallback-compute (x)
        (+ x 100))

      (defun setup-active-restarts ()
        (setq %active-restarts
          (list (cons 'use-fallback #'fallback-compute)))
        (restart-case
          (handler-case
            (error "recoverable failure")
            (error (c)
              (invoke-restart 'use-value 77)))
          (use-value (v) (+ v 1))))
    `,
  });

  const setupBlockRef = objectRef(imageId, commonLispFunctionBlockId('SETUP-ACTIVE-RESTARTS'));
  const setupActivation = await runtime.invocations.prepareActivation({
    block: setupBlockRef,
    arguments: [],
  });

  const restartFallbackBlock = await installSymmetricSmalltalkBlock({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    blockId: 'runtime-restart-block',
    source: '[ :delta | 500 + delta ]',
  });
  const restartFallbackBlockRef = objectRef(imageId, restartFallbackBlock.block.id);

  const conditionRuntime = new ConditionRuntime();
  conditionRuntime.enterRestart({
    name: 'smalltalk-override',
    block: restartFallbackBlockRef,
    description: 'Override result with 500 + delta',
  });

  const setupAnswer = await runtime.executor.execute(setupActivation, {conditionRuntime});
  assert.deepEqual(setupAnswer, integerValue(78n));

  // Inspect restarts from both ConditionRuntime and the in-image %active-restarts binding
  const activeRestartsBindingRef = objectRef(
    imageId,
    commonLispVariableBindingId('%ACTIVE-RESTARTS'),
  );
  const availableRestarts = await listAvailableRestarts({
    images: runtime.images,
    conditionRuntime,
    restartBindingRef: activeRestartsBindingRef,
  });

  const restartNames = availableRestarts.map((entry) => entry.name);
  assert.ok(restartNames.includes('smalltalk-override'));
  assert.ok(restartNames.includes('USE-FALLBACK'));

  // Invoke both the ConditionRuntime restart and the in-image Common Lisp restart via invokeCapturedRestart
  const stRestartResult = await invokeCapturedRestart({
    executor: runtime.executor,
    invocations: runtime.invocations,
    images: runtime.images,
    conditionRuntime,
    restarts: availableRestarts,
    restart: 'smalltalk-override',
    arguments: [integerValue(23n)],
  });
  assert.deepEqual(stRestartResult, integerValue(523n));

  const clRestartResult = await invokeCapturedRestart({
    executor: runtime.executor,
    invocations: runtime.invocations,
    images: runtime.images,
    conditionRuntime,
    restarts: availableRestarts,
    restart: 'USE-FALLBACK',
    arguments: [integerValue(9n)],
  });
  assert.deepEqual(clRestartResult, integerValue(109n));

  const report = await captureConditionAndStackReport({
    conditionRuntime,
    images: runtime.images,
    restartBindingRef: activeRestartsBindingRef,
  });
  assert.equal(report.schema, CONDITION_INSPECTION_REPORT_V1);
  assert.equal(report.restarts.length, 2);
  assert.equal(captureActivationStackReport(conditionRuntime).schema, ACTIVATION_STACK_REPORT_V1);

  await runtime.close();
});
