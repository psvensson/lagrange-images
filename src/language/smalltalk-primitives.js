import {randomUUID} from 'node:crypto';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {
  SmalltalkNoActiveOccurrenceError,
  SmalltalkUnhandledConditionError,
} from '../execution/conditions.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  SMALLTALK_PRIMITIVE_ARITY,
  SMALLTALK_PRIMITIVE_NAMES,
  SmalltalkPrimitiveLocalityError,
  SmalltalkPrimitiveReceiverError,
  parsePrimitiveCode,
  primitiveCodeContent,
  requireSendMessage,
} from './smalltalk-primitive-support.js';
import {
  SmalltalkIndexedBoundsError,
  SmalltalkNotIndexedError,
  SmalltalkNotInstantiableError,
  SmalltalkSlotAccessError,
  SmalltalkSlotFrameMissingError,
  basicNew,
  basicNewSized,
  classOf,
  indexedAt,
  indexedAtPut,
  indexedSize,
  instanceSlotRead,
  instanceSlotWrite,
} from './smalltalk-primitives-objects.js';
import {
  SmalltalkDictionaryConflictError,
  SmalltalkDictionaryKeyNotFoundError,
  SmalltalkDictionaryProtocolError,
  builtInEqualsPrimitive,
  builtInHashPrimitive,
  dictionaryAt,
  dictionaryAtPut,
  dictionaryIncludesKey,
  dictionaryInitialize,
  dictionaryKeysAndValuesDo,
  dictionarySize,
} from './smalltalk-primitives-dictionary.js';
import {
  SMALLTALK_INTEGER_ARITY,
  SmalltalkDivideByZeroError,
  SmalltalkIntegerOperandError,
  integerOperation,
} from './smalltalk-primitives-integer.js';
import {
  blockEnsure,
  blockOnDo,
  blockWhile,
  conditionSignal,
  conditionTransferOut,
  nonLocalReturn,
  requireConditions,
} from './smalltalk-primitives-control.js';
import {
  performSend,
  performSendWith,
  symbolIntern,
} from './smalltalk-primitives-symbol.js';
import {canonicalizeValue, isObjectRef} from '../value/index.js';

// The executor for the `smalltalk-kernel-primitive/v1` representation, and nothing else: the
// primitive registry and shared guards live in `smalltalk-primitive-support.js`, and each family's
// semantics live in the sibling `smalltalk-primitives-*.js` modules — objects (allocation, indexed,
// slots), dictionary (equality and the Dictionary operations), integer, and control (loops, unwind,
// conditions, non-local return). This module is the one place that knows which invocation shape
// each family uses, and the one public surface: everything the split moved is re-exported below, so
// no importer changed.

// Dispatched with the protected Block as receiver, exactly like the loop primitives — so they share
// the guard rather than growing a second one.
const UNWIND_PRIMITIVES = Object.freeze({
  [SMALLTALK_PRIMITIVE.BLOCK_ON_DO]: true,
  [SMALLTALK_PRIMITIVE.BLOCK_ENSURE]: true,
  [SMALLTALK_PRIMITIVE.BLOCK_IF_CURTAILED]: true,
});

// The loop primitives, kept as a set because their invocation shape and therefore their guard
// differ from every other primitive's.
const LOOP_PRIMITIVES = Object.freeze({
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_TRUE]: true,
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_FALSE]: false,
});

// `newObjectId` is runtime machinery, not durable class semantics, so it is injectable.
function createSmalltalkKernelPrimitiveV1Executor({
  newObjectId = randomUUID,
  maxIdentityAttempts = 8,
} = {}) {
  if (typeof newObjectId !== 'function') throw new TypeError('newObjectId must be a function');
  if (!Number.isInteger(maxIdentityAttempts) || maxIdentityAttempts < 1) {
    throw new TypeError('maxIdentityAttempts must be a positive integer');
  }
  return Object.freeze({
    async execute({activation, code}, context) {
      const primitive = parsePrimitiveCode(code);
      // Primitive Blocks may only be called directly; making one a method must not smuggle `self`
      // past the primitive's own argument contract. The loop primitives are the one exception, and
      // not a weakening: they are dispatched rather than applied, so they carry their own stricter
      // structural guard on both the receiver and the argument (see `assertLoopBlock`).
      const isLoop = Object.hasOwn(LOOP_PRIMITIVES, primitive);
      const isUnwind = Object.hasOwn(UNWIND_PRIMITIVES, primitive);
      if (!isLoop && !isUnwind) {
        assertBlockApplicationReceiver(activation, `${SMALLTALK_KERNEL_PRIMITIVE_V1} ${primitive}`);
      }
      const expectedArity = SMALLTALK_PRIMITIVE_ARITY[primitive];
      if (activation.arguments.length !== expectedArity) {
        throw new TypeError(
          `Symmetric Smalltalk ${primitive} primitive expects exactly ${expectedArity} arguments, `
          + `received ${activation.arguments.length}`,
        );
      }
      const primitiveImage = activation.block.imageId;
      const images = context?.images;
      if (!images || typeof images.getObject !== 'function') {
        throw new TypeError('Symmetric Smalltalk primitives require an images service');
      }
      const [value, second, third] = activation.arguments;
      if (isUnwind) {
        if (primitive === SMALLTALK_PRIMITIVE.BLOCK_ON_DO) {
          return await blockOnDo({images, activation, context, primitive});
        }
        return await blockEnsure({
          images, activation, context, primitive,
          onlyWhenCurtailed: primitive === SMALLTALK_PRIMITIVE.BLOCK_IF_CURTAILED,
        });
      }
      if (primitive === SMALLTALK_PRIMITIVE.NON_LOCAL_RETURN) {
        return nonLocalReturn({activation, context, primitive});
      }
      if (primitive === SMALLTALK_PRIMITIVE.CONDITION_SIGNAL) {
        return await conditionSignal({images, primitiveImage, activation, context, primitive});
      }
      if (primitive === SMALLTALK_PRIMITIVE.CONDITION_RESUME
        || primitive === SMALLTALK_PRIMITIVE.CONDITION_RETURN) {
        const condition = canonicalizeValue(value);
        if (!isObjectRef(condition)) {
          throw new SmalltalkPrimitiveReceiverError(primitive, `a ${condition.kind} Value as the condition`);
        }
        return conditionTransferOut({
          facade: requireConditions(context, primitive),
          condition,
          value: canonicalizeValue(second),
          kind: primitive === SMALLTALK_PRIMITIVE.CONDITION_RESUME ? 'resume' : 'return',
          primitive,
        });
      }
      if (Object.hasOwn(SMALLTALK_INTEGER_ARITY, primitive)) {
        return await integerOperation(primitive, value, second, {
          images, primitiveImage, context, newObjectId, maxIdentityAttempts,
        });
      }
      if (isLoop) {
        return await blockWhile({
          images, activation, context, primitive, wanted: LOOP_PRIMITIVES[primitive],
        });
      }

      switch (primitive) {
        case SMALLTALK_PRIMITIVE.CLASS_OF:
          return await classOf({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.BASIC_NEW:
          return await basicNew({
            images, primitiveImage, classValue: value, newObjectId, maxIdentityAttempts, context,
          });
        case SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED:
          return await basicNewSized({
            images,
            primitiveImage,
            classValue: value,
            sizeValue: second,
            newObjectId,
            maxIdentityAttempts,
            context,
          });
        case SMALLTALK_PRIMITIVE.INDEXED_SIZE:
          return await indexedSize({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.INDEXED_AT:
          return await indexedAt({
            images, primitiveImage, value, indexValue: second, context, newObjectId, maxIdentityAttempts,
          });
        case SMALLTALK_PRIMITIVE.INDEXED_AT_PUT:
          return await indexedAtPut({
            images, primitiveImage, value, indexValue: second, newValue: third, context, newObjectId,
            maxIdentityAttempts,
          });
        case SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS:
          return await builtInEqualsPrimitive({images, primitiveImage, left: value, right: second});
        case SMALLTALK_PRIMITIVE.BUILT_IN_HASH:
          return await builtInHashPrimitive({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ:
          return await instanceSlotRead({
            images, primitiveImage, target: value, slotIdValue: second, context,
          });
        case SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE:
          return await instanceSlotWrite({
            images, primitiveImage, target: value, slotIdValue: second, newValue: third, context,
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE:
          return await dictionaryInitialize({
            images, primitiveImage, value, newObjectId, maxIdentityAttempts,
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_SIZE:
          return await dictionarySize({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY:
          return await dictionaryIncludesKey({
            images, primitiveImage, value, keyValue: second, sendMessage: requireSendMessage(context, primitive),
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_AT:
          return await dictionaryAt({
            images, primitiveImage, value, keyValue: second, sendMessage: requireSendMessage(context, primitive),
            context, newObjectId, maxIdentityAttempts,
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT:
          return await dictionaryAtPut({
            images,
            primitiveImage,
            value,
            keyValue: second,
            newValue: third,
            sendMessage: requireSendMessage(context, primitive),
            newObjectId,
            maxIdentityAttempts,
            context,
          });
        case SMALLTALK_PRIMITIVE.DICTIONARY_KEYS_AND_VALUES_DO:
          return await dictionaryKeysAndValuesDo({
            images, primitiveImage, value, blockValue: second,
            sendMessage: requireSendMessage(context, primitive, 'apply the pair Block'),
          });
        case SMALLTALK_PRIMITIVE.SYMBOL_INTERN:
          return await symbolIntern({images, primitiveImage, value});
        case SMALLTALK_PRIMITIVE.PERFORM_SEND:
          return await performSend({images, primitiveImage, value, second, context, primitive});
        case SMALLTALK_PRIMITIVE.PERFORM_SEND_WITH:
          return await performSendWith({images, primitiveImage, value, second, third, context, primitive});
        default:
          throw new TypeError(`unknown ${SMALLTALK_KERNEL_PRIMITIVE_V1} primitive: ${primitive}`);
      }
    },
  });
}

export {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  SMALLTALK_PRIMITIVE_NAMES,
  SmalltalkDictionaryConflictError,
  SmalltalkDictionaryKeyNotFoundError,
  SmalltalkDictionaryProtocolError,
  SmalltalkDivideByZeroError,
  SmalltalkIntegerOperandError,
  SmalltalkNoActiveOccurrenceError,
  SmalltalkUnhandledConditionError,
  SmalltalkIndexedBoundsError,
  SmalltalkNotIndexedError,
  SmalltalkNotInstantiableError,
  SmalltalkPrimitiveLocalityError,
  SmalltalkPrimitiveReceiverError,
  SmalltalkSlotAccessError,
  SmalltalkSlotFrameMissingError,
  createSmalltalkKernelPrimitiveV1Executor,
  parsePrimitiveCode,
  primitiveCodeContent,
};
