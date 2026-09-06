import {EXCEPTION_SHAPE_ID} from './smalltalk-condition-ids.js';
import {
  VALUE_KIND,
  canonicalizeValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {isTransientRef} from '../value/transient-ref.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// The registry and the shared guards of the kernel-primitive family. Everything here is what more
// than one primitive family needs; the families themselves live in the sibling
// `smalltalk-primitives-*.js` modules, and the executor that dispatches over them stays in
// `smalltalk-primitives.js`. Nothing in this module imports a family, which is what keeps the
// split acyclic.

// ADR 0046 introduced the representation for the image operations the shared IR cannot express;
// ADR 0047 extends the *same* language-owned primitive family rather than inventing a second ABI.
// They are ordinary Blocks for invocation, and both execution lanes reach them through ordinary
// sends, so neither lagrange-code nor the dispatcher learns collection semantics.
const SMALLTALK_KERNEL_PRIMITIVE_V1 = 'smalltalk-kernel-primitive/v1';

const SMALLTALK_PRIMITIVE = Object.freeze({
  CLASS_OF: 'class-of',
  BASIC_NEW: 'basic-new',
  BASIC_NEW_SIZED: 'basic-new-sized',
  INDEXED_SIZE: 'indexed-size',
  INDEXED_AT: 'indexed-at',
  INDEXED_AT_PUT: 'indexed-at-put',
  BUILT_IN_EQUALS: 'built-in-equals',
  BUILT_IN_HASH: 'built-in-hash',
  DICTIONARY_INITIALIZE: 'dictionary-initialize',
  DICTIONARY_SIZE: 'dictionary-size',
  DICTIONARY_INCLUDES_KEY: 'dictionary-includes-key',
  DICTIONARY_AT: 'dictionary-at',
  DICTIONARY_AT_PUT: 'dictionary-at-put',
  // Workstream 3 (MessagePack pressure: map encoding walks every pair). Dictionary-owned
  // enumeration; see `dictionaryKeysAndValuesDo` for why this is a primitive and what it promises.
  DICTIONARY_KEYS_AND_VALUES_DO: 'dictionary-keys-and-values-do',
  INSTANCE_SLOT_READ: 'instance-slot-read',
  INSTANCE_SLOT_WRITE: 'instance-slot-write',
  // ADR 0051. These two are unlike every primitive above: they are not applied as
  // `aPrimitive value: x`, but dispatched with the condition Block as the receiver.
  BLOCK_WHILE_TRUE: 'block-while-true',
  BLOCK_WHILE_FALSE: 'block-while-false',
  // ADR 0053. One comparison, because four would be four chances for the set to disagree.
  INTEGER_LESS_THAN: 'integer-less-than',
  INTEGER_SUBTRACT: 'integer-subtract',
  INTEGER_MULTIPLY: 'integer-multiply',
  // Named for what it does, not for the operator it backs: the name becomes durable CodeArtifact
  // content, and `integer-divide` would imply the host truncation ADR 0053 decision 4 rejects.
  INTEGER_FLOOR_DIVIDE: 'integer-floor-divide',
  INTEGER_MODULO: 'integer-modulo',
  // ADR 0057 workstream 3. Bitwise operations, demanded by real upstream Smalltalk (MessagePack
  // fixnum/str/array/map headers `2r10100000 bitOr: size`, and dialect byte extraction
  // `(value >> 8) bitAnd: 16rFF`). Genuinely primitive: an Integer Value is arbitrary-precision
  // (BigInt), and no finite Smalltalk composition of `//` and `\\` computes a two's-complement bit
  // pattern for a negative receiver. One primitive per operation, exactly as ADR 0053.
  INTEGER_BIT_AND: 'integer-bit-and',
  INTEGER_BIT_OR: 'integer-bit-or',
  INTEGER_BIT_XOR: 'integer-bit-xor',
  INTEGER_BIT_SHIFT: 'integer-bit-shift',
  // ADR 0054. The first three are Block operations, dispatched with the protected Block as
  // receiver; the last three are ordinary captured-Block primitives behind Exception methods.
  BLOCK_ON_DO: 'block-on-do',
  BLOCK_ENSURE: 'block-ensure',
  BLOCK_IF_CURTAILED: 'block-if-curtailed',
  CONDITION_SIGNAL: 'condition-signal',
  CONDITION_RESUME: 'condition-resume',
  CONDITION_RETURN: 'condition-return',
  // ADR 0055. Reached by a send the compiler lowers `^` to; never written by a programmer.
  NON_LOCAL_RETURN: 'non-local-return',
  // Symbol interning: takes a Text spelling, answers the canonical image-local Symbol.
  SYMBOL_INTERN: 'symbol-intern',
  // Dynamic send: extracts the selector from a Symbol and re-enters the ordinary message
  // runtime. `perform-send` is the 0-argument form; `perform-send-with` takes one argument.
  PERFORM_SEND: 'perform-send',
  PERFORM_SEND_WITH: 'perform-send-with',
  // Class-hierarchy introspection (WS3): reads a class's durable subclass registry and answers an
  // Array of its direct subclass refs. Same spirit as `class-of` reading the behavior edge — the
  // registry is ordinary durable image state maintained by `defineClass`, never hidden JS state.
  SUBCLASSES_OF: 'subclasses-of',
  // WS3 Text/ByteArray slice: a tiny byte-sequence primitive family over the native immutable
  // Value representations. A Text Value and an immediate bytes Value are physically different
  // models from Array's indexed storage, so these are deliberately a separate family rather than
  // a widening of the ADR 0047 indexed-object primitives (see smalltalk-primitives-bytes.js).
  TEXT_UTF8_BYTES: 'text-utf8-bytes',
  BYTEARRAY_UTF8_TEXT: 'bytearray-utf8-text',
  BYTEARRAY_SIZE: 'bytearray-size',
  BYTEARRAY_AT: 'bytearray-at',
  // `fromArray:` backing: an Array/OrderedCollection of integers 0..255 -> a native bytes Value.
  ARRAY_TO_BYTEARRAY: 'array-to-bytearray',
  // ADR 0089. Reached by the send the compiler lowers `super <selector>` to; never written by a
  // programmer. Arguments are the selector Text followed by the message's own arguments, so one
  // primitive covers unary, binary and keyword super sends.
  SUPER_SEND: 'super-send',
});

const SMALLTALK_PRIMITIVE_NAMES = Object.freeze(Object.values(SMALLTALK_PRIMITIVE));
const SMALLTALK_PRIMITIVE_ARITY = Object.freeze({
  [SMALLTALK_PRIMITIVE.CLASS_OF]: 1,
  [SMALLTALK_PRIMITIVE.BASIC_NEW]: 1,
  [SMALLTALK_PRIMITIVE.BASIC_NEW_SIZED]: 2,
  [SMALLTALK_PRIMITIVE.INDEXED_SIZE]: 1,
  [SMALLTALK_PRIMITIVE.INDEXED_AT]: 2,
  [SMALLTALK_PRIMITIVE.INDEXED_AT_PUT]: 3,
  [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS]: 2,
  [SMALLTALK_PRIMITIVE.BUILT_IN_HASH]: 1,
  [SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE]: 1,
  [SMALLTALK_PRIMITIVE.DICTIONARY_SIZE]: 1,
  [SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY]: 2,
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT]: 2,
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT]: 3,
  [SMALLTALK_PRIMITIVE.DICTIONARY_KEYS_AND_VALUES_DO]: 2,
  [SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ]: 2,
  [SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE]: 3,
  // One argument, the body Block; the condition Block arrives as the receiver.
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_TRUE]: 1,
  [SMALLTALK_PRIMITIVE.BLOCK_WHILE_FALSE]: 1,
  [SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_MODULO]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_AND]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_OR]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_XOR]: 2,
  [SMALLTALK_PRIMITIVE.INTEGER_BIT_SHIFT]: 2,
  [SMALLTALK_PRIMITIVE.BLOCK_ON_DO]: 2,
  [SMALLTALK_PRIMITIVE.BLOCK_ENSURE]: 1,
  [SMALLTALK_PRIMITIVE.BLOCK_IF_CURTAILED]: 1,
  [SMALLTALK_PRIMITIVE.CONDITION_SIGNAL]: 1,
  [SMALLTALK_PRIMITIVE.CONDITION_RESUME]: 2,
  [SMALLTALK_PRIMITIVE.CONDITION_RETURN]: 2,
  [SMALLTALK_PRIMITIVE.NON_LOCAL_RETURN]: 1,
  [SMALLTALK_PRIMITIVE.SYMBOL_INTERN]: 1,
  [SMALLTALK_PRIMITIVE.PERFORM_SEND]: 2,
  [SMALLTALK_PRIMITIVE.PERFORM_SEND_WITH]: 3,
  [SMALLTALK_PRIMITIVE.SUBCLASSES_OF]: 1,
  [SMALLTALK_PRIMITIVE.TEXT_UTF8_BYTES]: 1,
  [SMALLTALK_PRIMITIVE.BYTEARRAY_UTF8_TEXT]: 1,
  [SMALLTALK_PRIMITIVE.BYTEARRAY_SIZE]: 1,
  [SMALLTALK_PRIMITIVE.BYTEARRAY_AT]: 2,
  [SMALLTALK_PRIMITIVE.ARRAY_TO_BYTEARRAY]: 1,
  // Variadic (see below): this is the MINIMUM — the selector Text — and a super send adds one
  // argument per keyword or binary operand.
  [SMALLTALK_PRIMITIVE.SUPER_SEND]: 1,
});

// ADR 0089. The one primitive whose argument count is not fixed, because the message it forwards is
// not fixed: `super foo`, `super + x` and `super at: k put: v` are one operation with one, two and
// three arguments. Spelled as an explicit set rather than by giving the arity map a second shape, so
// every other primitive keeps its exact-arity guard untouched and the variadic case is enumerable.
const SMALLTALK_PRIMITIVE_VARIADIC = Object.freeze(new Set([SMALLTALK_PRIMITIVE.SUPER_SEND]));

// One locality rule for every primitive. A foreign primitive Block must fail rather than answer a
// foreign kernel's class, allocate into somebody else's image, or mutate a foreign indexed object.
class SmalltalkPrimitiveLocalityError extends TypeError {
  constructor(primitive, primitiveImage, ref) {
    super(
      `Symmetric Smalltalk ${primitive} primitive in ${primitiveImage} cannot act on `
      + `${ref.imageId}/${ref.objectId}; a primitive is local to its own image`,
    );
    this.name = 'SmalltalkPrimitiveLocalityError';
    this.primitive = primitive;
    this.primitiveImage = primitiveImage;
  }
}

class SmalltalkPrimitiveReceiverError extends TypeError {
  constructor(primitive, description) {
    super(`Symmetric Smalltalk ${primitive} primitive cannot act on ${description}`);
    this.name = 'SmalltalkPrimitiveReceiverError';
    this.primitive = primitive;
  }
}

function parsePrimitiveCode(code) {
  if (code.content?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(`${SMALLTALK_KERNEL_PRIMITIVE_V1} content must be a text Value`);
  }
  let declaration;
  try {
    declaration = JSON.parse(code.content.value);
  } catch (error) {
    throw new TypeError(`${SMALLTALK_KERNEL_PRIMITIVE_V1} content must contain valid JSON`, {cause: error});
  }
  const keys = Object.keys(declaration ?? {});
  if (keys.length !== 1 || keys[0] !== 'primitive') {
    throw new TypeError(`${SMALLTALK_KERNEL_PRIMITIVE_V1} content must contain exactly primitive`);
  }
  if (!SMALLTALK_PRIMITIVE_NAMES.includes(declaration.primitive)) {
    throw new TypeError(`unknown ${SMALLTALK_KERNEL_PRIMITIVE_V1} primitive: ${declaration.primitive}`);
  }
  return declaration.primitive;
}

function primitiveCodeContent(primitive) {
  if (!SMALLTALK_PRIMITIVE_NAMES.includes(primitive)) {
    throw new TypeError(`unknown ${SMALLTALK_KERNEL_PRIMITIVE_V1} primitive: ${primitive}`);
  }
  return JSON.stringify({primitive});
}

function assertLocalRef(value, primitiveImage, primitive, description) {
  if (!isObjectRef(value)) {
    throw new SmalltalkPrimitiveReceiverError(
      primitive,
      value?.kind ? `a ${value.kind} Value; ${description}` : `a non-ref; ${description}`,
    );
  }
  if (value.imageId !== primitiveImage) {
    throw new SmalltalkPrimitiveLocalityError(primitive, primitiveImage, value);
  }
  return value;
}

// ADR 0052 decision 6: writing into a slot, an indexed part or a Dictionary makes a value durably
// reachable, so it is an escape. Each of these boundaries rewrites the value through the one central
// promoter and then performs its existing write unchanged — the promotion is the boundary's job, not
// the graph guard's.
//
// A context without `promote` is an execution that predates this seam rather than an error: the
// value passes through, and the graph guard still refuses a transient ref, so a missed boundary
// fails loudly instead of silently persisting a dangling reference.
//
// ADR 0060: a slot or indexed write is a durability boundary *only when the receiver is durable*.
// Writing a transient value into a transient receiver keeps both inside the arena — nothing has
// escaped yet — so the value must NOT be promoted, or every `OrderedCollection`'s backing store
// would become durable the instant it is assigned. `receiver` is the object being written into;
// when it is a transient ref the write stays in the arena and the value passes through unpromoted.
async function promoted(context, value, receiver = null) {
  if (typeof context?.promote !== 'function') return value;
  if (receiver !== null && isTransientRef(receiver)) return value;
  return await context.promote(value);
}

function requireSendMessage(context, primitive, purpose = 'send hash and =') {
  if (typeof context?.sendMessage !== 'function') {
    throw new TypeError(`Symmetric Smalltalk ${primitive} primitive requires a message runtime to ${purpose}`);
  }
  return context.sendMessage;
}

// ADR 0089. Deliberately NOT `sendMessage`: this activates a method the LANGUAGE already resolved,
// and re-entering ordinary dispatch would look the selector up again from the receiver's own
// Behavior — the exact starting point a super send exists to avoid.
function requireInvokeResolvedMethod(context, primitive, purpose = 'activate the method it resolved') {
  if (typeof context?.invokeResolvedMethod !== 'function') {
    throw new TypeError(`Symmetric Smalltalk ${primitive} primitive requires a message runtime to ${purpose}`);
  }
  return context.invokeResolvedMethod;
}

// ADR 0054 decision 8. A host failure that has a condition class becomes an ordinary Smalltalk
// signal, so it is catchable — and resumable, since a handler's `resume:` answers the operation.
//
// Absent the condition protocol, the host error is thrown as before. That is what keeps an image
// without ADR 0054 working unchanged rather than acquiring a dependency it never installed.
async function signalHostCondition({
  images, primitiveImage, context, classId, hostError, newObjectId, maxIdentityAttempts,
}) {
  const facade = context?.conditions;
  const sendMessage = context?.sendMessage;
  if (!facade || typeof sendMessage !== 'function') throw hostError;
  const classRecord = await images.getObject(primitiveImage, classId);
  if (!classRecord) throw hostError;

  // ADR 0060 decision 2: a condition created, signalled, handled and discarded inside one execution
  // never leaves the arena, so a handled condition costs no durable object. An unhandled one
  // crosses the root boundary and is promoted there — exactly when its information must outlive
  // the execution. Minted into the arena like `basicNew`; the record form below is unchanged, so
  // promotion is a copy.
  if (typeof context?.mintObject === 'function') {
    const instanceRef = context.mintObject({
      imageId: primitiveImage,
      shape: objectRef(primitiveImage, EXCEPTION_SHAPE_ID),
      behavior: objectRef(primitiveImage, classId),
      slots: {'exception-message-text': textValue(hostError.message)},
      metadata: {},
    });
    // An ordinary send, exactly as below — the receiver is the arena ref, resolved arena-first.
    return await sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: instanceRef,
      message: textValue('signal'),
      arguments: [],
    });
  }

  // ADR 0054 decision 1a: a condition is an ordinary object, so it is allocated by ordinary rules —
  // including ADR 0046's identity retry. Writing once at `expectedVersion: 0` would turn an id
  // collision into a failure where every other allocation simply picks another candidate.
  const instance = await (async () => {
    for (let attempt = 0; attempt < maxIdentityAttempts; attempt += 1) {
      const candidate = newObjectId();
      if (typeof candidate !== 'string' || candidate.length === 0) {
        throw new TypeError('Smalltalk object identity generator must answer non-empty text');
      }
      try {
        return await images.putObject(primitiveImage, {
          id: candidate,
          shape: objectRef(primitiveImage, EXCEPTION_SHAPE_ID),
          behavior: objectRef(primitiveImage, classId),
          slots: {'exception-message-text': textValue(hostError.message)},
          metadata: {},
        }, {expectedVersion: 0});
      } catch (error) {
        if (error?.name !== 'VersionConflictError') throw error;
      }
    }
    throw new TypeError(
      `Symmetric Smalltalk could not find a free object identity in ${primitiveImage} `
      + `after ${maxIdentityAttempts} attempts`,
    );
  })();

  // An ordinary send, so the handler search, the transfer protocol and resumption are exactly the
  // ones Smalltalk code gets — this is not a second signalling path.
  return await sendMessage({
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver: objectRef(primitiveImage, instance.id),
    message: textValue('signal'),
    arguments: [],
  });
}

// ADR 0051 decision 4. Every other primitive is applied as `aPrimitive value: x`, so
// `assertBlockApplicationReceiver` can demand that the activation's receiver *is* the Block. A loop
// primitive is dispatched instead, with the condition Block as receiver, so that guard cannot apply
// and something must replace it — otherwise `aLoopPrimitive value: aBlock` would arrive with the
// primitive itself as the condition, which is precisely the bypass the structural rule below closes.
//
// "Kernel-primitive Block" is the existing structural test and nothing else: the Block's CodeArtifact
// has representation `smalltalk-kernel-primitive/v1`. That is already how the dispatcher decides
// frame inheritance for a Block send, so this reuses a definition the system depends on rather than
// adding a second, weaker notion of "is a primitive" that the two could drift apart on.
//
// The Dictionary enumeration primitive shares this guard for its pair Block, for the same reason:
// a Block about to be applied on a primitive's behalf must not itself be a kernel primitive.
async function assertLoopBlock({images, value, primitive, role}) {
  // A direct `invokeBlock` leaves the receiver null, which `assertBlockApplicationReceiver` treats as
  // the legitimate direct-application case. For a loop primitive it is not legitimate at all: there
  // is no condition Block, so say that rather than failing later on an untagged value.
  if (value === null || value === undefined) {
    throw new SmalltalkPrimitiveReceiverError(
      primitive,
      `no ${role}; a loop primitive is reachable only by dispatching whileTrue: or whileFalse:`,
    );
  }
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a ${ref.kind} Value as the ${role}`);
  }
  const block = await images.getBlock(ref.imageId, ref.objectId);
  if (!block) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `${ref.imageId}/${ref.objectId} as the ${role}, which is not a Block`);
  }
  const code = block.code && await images.getCodeArtifact(block.code.imageId, block.code.objectId);
  if (code?.representation === SMALLTALK_KERNEL_PRIMITIVE_V1) {
    throw new SmalltalkPrimitiveReceiverError(primitive, `a kernel-primitive Block as the ${role}`);
  }
  return ref;
}

export {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  SMALLTALK_PRIMITIVE_ARITY,
  SMALLTALK_PRIMITIVE_NAMES,
  SMALLTALK_PRIMITIVE_VARIADIC,
  SmalltalkPrimitiveLocalityError,
  SmalltalkPrimitiveReceiverError,
  assertLocalRef,
  assertLoopBlock,
  parsePrimitiveCode,
  primitiveCodeContent,
  promoted,
  requireInvokeResolvedMethod,
  requireSendMessage,
  signalHostCondition,
};
