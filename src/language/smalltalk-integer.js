import {booleanValue, objectRef, textValue} from '../value/index.js';
import {defineMethods, ensureBlock, ensureCodeArtifact} from './smalltalk-class-builder.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0053: Integer ordering and arithmetic, installed as ordinary methods over language-owned
// primitives. `lagrange-code/v0` stays frozen — no comparison op is added — and the compiler learns
// no selector: `<` is found by the same Behavior walk as `+` and `ifTrue:`.
//
// One comparison primitive, three derived methods. Four primitives would be four chances for the set
// to disagree, and a `>=` that parts company with `<` at exactly one boundary is the classic form of
// that bug.
const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN]: 'smalltalk/primitive/integer-less-than',
  [SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT]: 'smalltalk/primitive/integer-subtract',
  [SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY]: 'smalltalk/primitive/integer-multiply',
  [SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE]: 'smalltalk/primitive/integer-floor-divide',
  [SMALLTALK_PRIMITIVE.INTEGER_MODULO]: 'smalltalk/primitive/integer-modulo',
});

const CAPTURE_NAME = Object.freeze({
  [SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN]: 'primitiveIntegerLessThan',
  [SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT]: 'primitiveIntegerSubtract',
  [SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY]: 'primitiveIntegerMultiply',
  [SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE]: 'primitiveIntegerFloorDivide',
  [SMALLTALK_PRIMITIVE.INTEGER_MODULO]: 'primitiveIntegerModulo',
});

const captureFor = (primitive) => Object.freeze({
  id: PRIMITIVE_BLOCK_ID[primitive],
  name: CAPTURE_NAME[primitive],
});

const RECEIVER = Object.freeze({op: 'receiver'});
const ARGUMENT = Object.freeze({op: 'argument', index: 0});

// `aPrimitive value: x value: y` — an ordinary Block send, which ADR 0044 decision 11 answers
// without a class. A method never *is* a primitive; it captures one and sends to it.
const applyPrimitive = (primitive, left, right) => ({
  op: 'send',
  languageId: SYMMETRIC_SMALLTALK_ID,
  receiver: {op: 'binding', id: PRIMITIVE_BLOCK_ID[primitive]},
  message: textValue('value:value:'),
  arguments: [left, right],
});

// ADR 0053 decision 2. `not` does not exist — ADR 0045 deferred it — and inventing it to spell two
// methods would be scope creep, so the negation lives inside these two installed programs using the
// neutral `if`. That is a lower-level semantic producer using the IR directly, which ADR 0045
// permits; what it forbids is Smalltalk *source* conditionals becoming compiler special cases.
const negated = (condition) => ({
  op: 'if',
  condition,
  then: {op: 'literal', value: booleanValue(false)},
  else: {op: 'literal', value: booleanValue(true)},
});

const LESS_THAN = SMALLTALK_PRIMITIVE.INTEGER_LESS_THAN;

// The installed protocol, as it reads in Smalltalk:
//
//   Integer >> <   primitiveIntegerLessThan value: self value: other
//   Integer >> >   primitiveIntegerLessThan value: other value: self
//   Integer >> <=  (primitiveIntegerLessThan value: other value: self) not
//   Integer >> >=  (primitiveIntegerLessThan value: self  value: other) not
const INTEGER_METHODS = [
  {selector: '<', primitive: LESS_THAN, body: applyPrimitive(LESS_THAN, RECEIVER, ARGUMENT)},
  {selector: '>', primitive: LESS_THAN, body: applyPrimitive(LESS_THAN, ARGUMENT, RECEIVER)},
  {selector: '<=', primitive: LESS_THAN, body: negated(applyPrimitive(LESS_THAN, ARGUMENT, RECEIVER))},
  {selector: '>=', primitive: LESS_THAN, body: negated(applyPrimitive(LESS_THAN, RECEIVER, ARGUMENT))},
  {
    selector: '-',
    primitive: SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT,
    body: applyPrimitive(SMALLTALK_PRIMITIVE.INTEGER_SUBTRACT, RECEIVER, ARGUMENT),
  },
  {
    selector: '*',
    primitive: SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY,
    body: applyPrimitive(SMALLTALK_PRIMITIVE.INTEGER_MULTIPLY, RECEIVER, ARGUMENT),
  },
  {
    selector: '//',
    primitive: SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE,
    body: applyPrimitive(SMALLTALK_PRIMITIVE.INTEGER_FLOOR_DIVIDE, RECEIVER, ARGUMENT),
  },
  {
    selector: '\\\\',
    primitive: SMALLTALK_PRIMITIVE.INTEGER_MODULO,
    body: applyPrimitive(SMALLTALK_PRIMITIVE.INTEGER_MODULO, RECEIVER, ARGUMENT),
  },
];

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// Ensure-exact-or-create at both deterministic ids, like every other derived record here.
async function installPrimitiveBlock({images, imageId, primitive}) {
  const id = PRIMITIVE_BLOCK_ID[primitive];
  const code = await ensureCodeArtifact(images, imageId, {
    id: `${id}:code`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SMALLTALK_KERNEL_PRIMITIVE_V1,
    content: textValue(primitiveCodeContent(primitive)),
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  const block = await ensureBlock(images, imageId, {
    id,
    code: objectRef(imageId, code.id),
    environment: null,
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  return objectRef(imageId, block.id);
}

async function installSmalltalkIntegerProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // Primitives first: a method's environment may not point at a Block that does not yet exist.
  const primitives = {};
  for (const primitive of Object.keys(PRIMITIVE_BLOCK_ID)) {
    primitives[primitive] = await installPrimitiveBlock({images, imageId, primitive});
  }

  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef: kernel.integerClass,
    methods: INTEGER_METHODS.map(({selector, primitive, body}) => {
      const capture = captureFor(primitive);
      return {
        selector,
        program: {parameters: [{id: `${selector}:arg`, name: 'other'}], captures: [{...capture}], body},
        captures: [{...capture, value: primitives[primitive]}],
      };
    }),
  });

  return Object.freeze({integerClass: kernel.integerClass, ...primitives});
}

export {
  INTEGER_METHODS,
  PRIMITIVE_BLOCK_ID as SMALLTALK_INTEGER_PRIMITIVE_BLOCK_ID,
  installSmalltalkIntegerProtocol,
};
