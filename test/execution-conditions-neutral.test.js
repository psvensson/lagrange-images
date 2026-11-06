import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  NoActiveOccurrenceError,
  NonLocalReturnHomeError,
  SmalltalkNoActiveOccurrenceError,
  SmalltalkUnhandledConditionError,
  UnhandledConditionError,
  createRuntime,
  integerValue,
  normalizeDispatchResolution,
  objectRef,
  performNonLocalReturn,
  runConditionHandler,
  runUnwindProtection,
  signalConditionOccurrence,
  textValue,
  transferConditionOccurrence,
} from '../src/runtime.js';
import {instanceSlotRead} from '../src/language/smalltalk-primitives-objects.js';
import {SmalltalkSuperFrameMissingError, superSend} from '../src/language/smalltalk-primitives-super.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('STRUCTURAL: src/execution/conditions.js is language-neutral and smalltalk-primitives-control delegates to it', async () => {
  const executionConditions = await readFile(join(ROOT, 'src', 'execution', 'conditions.js'), 'utf8');
  const codeOnly = executionConditions
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  assert.doesNotMatch(codeOnly, /Smalltalk/, 'src/execution/conditions.js must not define Smalltalk-specific identifiers');
  assert.doesNotMatch(codeOnly, /from ['"]\.\.\/language\//, 'src/execution/conditions.js must not import from src/language/');

  const smalltalkControl = await readFile(join(ROOT, 'src', 'language', 'smalltalk-primitives-control.js'), 'utf8');
  for (const helper of [
    'performNonLocalReturn',
    'runConditionHandler',
    'runUnwindProtection',
    'signalConditionOccurrence',
    'transferConditionOccurrence',
  ]) {
    assert.match(
      smalltalkControl,
      new RegExp(`\\b${helper}\\b`),
      `src/language/smalltalk-primitives-control.js must delegate ${helper} to src/execution/conditions.js`,
    );
  }

  const unhandled = new SmalltalkUnhandledConditionError('Error (app/cond-1)');
  assert.ok(unhandled instanceof UnhandledConditionError);
  assert.equal(unhandled.name, 'SmalltalkUnhandledConditionError');
  assert.equal(unhandled.message, 'unhandled Smalltalk condition: Error (app/cond-1)');

  const noOccurrence = new SmalltalkNoActiveOccurrenceError('condition-resume');
  assert.ok(noOccurrence instanceof NoActiveOccurrenceError);
  assert.equal(noOccurrence.name, 'SmalltalkNoActiveOccurrenceError');
});

test('a non-Smalltalk language uses the generic condition, unwind, resume, and non-local return protocol', async (t) => {
  const customExecutor = {
    async execute({activation, code}, context) {
      const spec = JSON.parse(code.content.value);
      const facade = context.conditions;
      switch (spec.op) {
        case 'handle':
          return await runConditionHandler({
            facade,
            conditionClass: spec.tag,
            handlerBlock: activation.arguments[1],
            protectedBlock: activation.arguments[0],
          });
        case 'protect':
          return await runUnwindProtection({
            facade,
            kind: 'unwind-protect',
            protectedBlock: activation.arguments[0],
            cleanupBlock: activation.arguments[1],
            onlyWhenCurtailed: Boolean(spec.onlyWhenCurtailed),
          });
        case 'signal':
          return await signalConditionOccurrence({
            facade,
            condition: activation.arguments[0],
            matches: async (handledTag) => handledTag.value === activation.arguments[0].value,
            describeCondition: () => activation.arguments[0].value,
          });
        case 'resume':
          return transferConditionOccurrence({
            facade,
            sameCondition: (candidate) => candidate.value === activation.arguments[0].value,
            value: activation.arguments[1],
            kind: 'resume',
            operation: 'lisp-invoke-restart-resume',
          });
        case 'return-from-block':
          return performNonLocalReturn({
            context,
            value: activation.arguments[0],
            formatDeadHome: ({frame}) => frame.metadata?.homeName ?? 'anonymous',
          });
        default:
          return spec.literal;
      }
    },
  };

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    codeExecutors: {'test-lisp-control/v1': customExecutor},
    dispatchers: {
      'test-lisp': {
        async resolveMessage(request) {
          return {
            block: request.receiver,
            frame: {
              metadata: {homeName: request.message.value},
            },
          };
        },
      },
    },
  });
  t.after(async () => runtime.close());

  await runtime.images.createImage({id: 'lisp'});
  async function makeBlock(id, spec) {
    await runtime.images.putCodeArtifact('lisp', {
      id: `${id}:code`,
      languageId: 'test-lisp',
      representation: 'test-lisp-control/v1',
      content: textValue(JSON.stringify(spec)),
    });
    await runtime.images.putBlock('lisp', {
      id,
      code: objectRef('lisp', `${id}:code`),
    });
    return objectRef('lisp', id);
  }

  const handleBlock = await makeBlock('handle', {op: 'handle', tag: textValue('division-by-zero')});
  const signalBlock = await makeBlock('signal', {op: 'signal'});
  const resumeBlock = await makeBlock('resume', {op: 'resume'});

  // Handler that resumes the active condition occurrence with 42.
  await runtime.images.putCodeArtifact('lisp', {
    id: 'resuming-handler:code',
    languageId: 'test-lisp',
    representation: 'test-lisp-control/v1',
    content: textValue(JSON.stringify({op: 'custom'})),
  });
  runtime.codeExecutors.executors.set('test-lisp-control/v1', {
    async execute({activation, code}, context) {
      const spec = JSON.parse(code.content.value);
      if (spec.op === 'signal-and-add-one') {
        const resumed = await signalConditionOccurrence({
          facade: context.conditions,
          condition: textValue('division-by-zero'),
          matches: async (handledTag) => handledTag.value === 'division-by-zero',
          describeCondition: () => 'division-by-zero',
        });
        return integerValue(Number(resumed.value) + 1);
      }
      if (spec.op === 'resume-with-41') {
        return transferConditionOccurrence({
          facade: context.conditions,
          sameCondition: (candidate) => candidate.value === activation.arguments[0].value,
          value: integerValue(41),
          kind: 'resume',
          operation: 'lisp-resume',
        });
      }
      return await customExecutor.execute({activation, code}, context);
    },
  });

  const protectedSignal = await makeBlock('protected-signal', {op: 'signal-and-add-one'});
  const handlerResume = await makeBlock('handler-resume', {op: 'resume-with-41'});
  const resumedResult = await runtime.executor.execute(
    await runtime.invocations.invokeBlock(handleBlock, [protectedSignal, handlerResume]),
  );
  assert.deepEqual(resumedResult, integerValue(42));

  // Unhandled condition raises language-neutral UnhandledConditionError.
  await assert.rejects(
    runtime.executor.execute(await runtime.invocations.invokeBlock(signalBlock, [textValue('unhandled-tag')])),
    (error) => error instanceof UnhandledConditionError && error.name === 'UnhandledConditionError',
  );

  // Resume outside an active occurrence raises language-neutral NoActiveOccurrenceError.
  await assert.rejects(
    runtime.executor.execute(await runtime.invocations.invokeBlock(resumeBlock, [textValue('none'), integerValue(1)])),
    (error) => error instanceof NoActiveOccurrenceError && error.name === 'NoActiveOccurrenceError',
  );

  // Non-local return across a neutral (non-OO) dispatch frame.
  const nlrBlock = await makeBlock('nlr', {op: 'return-from-block'});
  const dispatched = await runtime.invocations.prepareDispatch({
    languageId: 'test-lisp',
    receiver: nlrBlock,
    message: textValue('defun-compute'),
    arguments: [integerValue(99)],
  });
  assert.deepEqual(dispatched.frame, {metadata: {homeName: 'defun-compute'}});
  const nlrAnswer = await runtime.executor.execute(dispatched.activation, {invocationFrame: dispatched.frame});
  assert.deepEqual(nlrAnswer, integerValue(99));

  // Once the neutral home activation has returned, a second return targeting that dead frame fails closed.
  await assert.rejects(
    async () => performNonLocalReturn({
      context: {
        invocationFrame: dispatched.frame,
        conditions: {
          homeActivationState: (frame) => runtime.executor.homeActivationState(frame),
        },
      },
      value: integerValue(1),
      formatDeadHome: ({frame}) => frame.metadata?.homeName ?? 'unknown',
    }),
    (error) => error instanceof NonLocalReturnHomeError && /defun-compute/.test(error.message),
  );
});

test('neutral invocation frames are accepted by normalizeDispatchResolution and refused by Smalltalk OO slot/super primitives', async () => {
  const neutralResolution = normalizeDispatchResolution({
    block: objectRef('app', 'fn-block'),
    frame: {
      environment: objectRef('app', 'module-env'),
      metadata: {module: 'core'},
    },
  });
  assert.deepEqual(neutralResolution.frame, {
    environment: objectRef('app', 'module-env'),
    metadata: {module: 'core'},
  });

  // Partial OO frame (self without definingBehavior) is still rejected.
  assert.throws(
    () => normalizeDispatchResolution({
      block: objectRef('app', 'fn-block'),
      frame: {self: objectRef('app', 'receiver')},
    }),
    /message dispatcher frame must contain/,
  );

  // Empty frame is rejected.
  assert.throws(
    () => normalizeDispatchResolution({
      block: objectRef('app', 'fn-block'),
      frame: {},
    }),
    /message dispatcher frame must contain/,
  );

  // Smalltalk instance-slot-read and super-send fail closed when given a neutral non-OO frame.
  await assert.rejects(
    instanceSlotRead({
      images: {},
      primitiveImage: 'app',
      target: objectRef('app', 'obj'),
      slotIdValue: textValue('slot-x'),
      context: {invocationFrame: neutralResolution.frame},
    }),
    (error) => error.name === 'SmalltalkSlotFrameMissingError',
  );

  await assert.rejects(
    superSend({
      images: {},
      activation: {
        block: objectRef('app', 'smalltalk/primitive/super-send'),
        arguments: [textValue('initialize')],
      },
      context: {invocationFrame: neutralResolution.frame},
      primitive: 'super-send',
    }),
    SmalltalkSuperFrameMissingError,
  );
});
