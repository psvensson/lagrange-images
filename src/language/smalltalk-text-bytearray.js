import {objectRef, textValue} from '../value/index.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {defineMethods} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// WS3 Text/ByteArray slice: the Smalltalk protocol over the byte-sequence
// primitive family (smalltalk-primitives-bytes.js).
//
//   Text       >> utf8Bytes        primitiveTextUtf8Bytes value: self
//   ByteArray  >> utf8Text         primitiveByteArrayUtf8Text value: self
//   ByteArray  >> size             primitiveByteArraySize value: self
//   ByteArray  >> at:              primitiveByteArrayAt value: self value: index
//   ByteArray class >> fromArray:  ^ primitiveArrayToByteArray value: anArray
//
// `Text` is a native text Value and `ByteArray` a native bytes Value — both
// dispatch through their kernel classes, so the methods land on those classes
// directly (Pattern B, like Symbol). `fromArray:` is the explicit, narrowly
// named conversion from an integer Array buffer; it validates every element.
//
// ByteArray stays immutable for this slice: no `at:put:`, and no widening of
// the ADR 0047 indexed primitives to bytes Values.

const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.TEXT_UTF8_BYTES]: 'smalltalk/primitive/text-utf8-bytes',
  [SMALLTALK_PRIMITIVE.BYTEARRAY_UTF8_TEXT]: 'smalltalk/primitive/bytearray-utf8-text',
  [SMALLTALK_PRIMITIVE.BYTEARRAY_SIZE]: 'smalltalk/primitive/bytearray-size',
  [SMALLTALK_PRIMITIVE.BYTEARRAY_AT]: 'smalltalk/primitive/bytearray-at',
  [SMALLTALK_PRIMITIVE.ARRAY_TO_BYTEARRAY]: 'smalltalk/primitive/array-to-bytearray',
});

const CAPTURE_NAME = Object.freeze({
  [SMALLTALK_PRIMITIVE.TEXT_UTF8_BYTES]: '$textUtf8Bytes',
  [SMALLTALK_PRIMITIVE.BYTEARRAY_UTF8_TEXT]: '$byteArrayUtf8Text',
  [SMALLTALK_PRIMITIVE.BYTEARRAY_SIZE]: '$byteArraySize',
  [SMALLTALK_PRIMITIVE.BYTEARRAY_AT]: '$byteArrayAt',
  [SMALLTALK_PRIMITIVE.ARRAY_TO_BYTEARRAY]: '$arrayToByteArray',
});

async function installPrimitiveBlock({images, imageId, primitive}) {
  const id = PRIMITIVE_BLOCK_ID[primitive];
  const codeId = `${id}:code`;
  await ensureCodeArtifact(images, imageId, {
    id: codeId,
    representation: SMALLTALK_KERNEL_PRIMITIVE_V1,
    languageId: SYMMETRIC_SMALLTALK_ID,
    content: textValue(primitiveCodeContent(primitive)),
    dependencies: [],
    derivedFrom: [],
    metadata: {},
  });
  await ensureBlock(images, imageId, {
    id,
    code: objectRef(imageId, codeId),
    environment: null,
    metadata: {},
  });
  return objectRef(imageId, id);
}

function capturedMethod({selector, primitive, parameters = [], args, imageId}) {
  const capture = {id: PRIMITIVE_BLOCK_ID[primitive], name: CAPTURE_NAME[primitive]};
  return {
    selector,
    program: {
      parameters: parameters.map((name, index) => ({id: `${selector}:parameter:${index}`, name})),
      captures: [{id: capture.id, name: capture.name}],
      body: {
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: {op: 'binding', id: capture.id},
        message: textValue('value:'.repeat(args.length)),
        arguments: args,
      },
    },
    captures: [{id: capture.id, name: capture.name, value: objectRef(imageId, capture.id)}],
  };
}

const argument = (index) => ({op: 'argument', index});
const receiver = () => ({op: 'receiver'});

async function installSmalltalkTextByteArrayProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('images service is required');
  }
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  for (const primitive of [
    SMALLTALK_PRIMITIVE.TEXT_UTF8_BYTES,
    SMALLTALK_PRIMITIVE.BYTEARRAY_UTF8_TEXT,
    SMALLTALK_PRIMITIVE.BYTEARRAY_SIZE,
    SMALLTALK_PRIMITIVE.BYTEARRAY_AT,
    SMALLTALK_PRIMITIVE.ARRAY_TO_BYTEARRAY,
  ]) {
    await installPrimitiveBlock({images, imageId, primitive});
  }

  // Text >> utf8Bytes
  await defineMethods({
    images, compilation, imageId, lane, classRef: kernel.textClass,
    methods: [capturedMethod({
      selector: 'utf8Bytes', primitive: SMALLTALK_PRIMITIVE.TEXT_UTF8_BYTES, args: [receiver()], imageId,
    })],
  });

  // Text >> asString answers the receiver: a Text's string form is itself. Standard,
  // general protocol (a String answers `asString` with itself in every dialect); it
  // lets a uniform `aString asString` conversion reach both Text and Symbol.
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: kernel.textClass,
    methods: [{selector: 'asString', source: '[ ^ self ]'}],
  });

  // ByteArray >> utf8Text / size / at:
  await defineMethods({
    images, compilation, imageId, lane, classRef: kernel.byteArrayClass,
    methods: [
      capturedMethod({
        selector: 'utf8Text', primitive: SMALLTALK_PRIMITIVE.BYTEARRAY_UTF8_TEXT, args: [receiver()], imageId,
      }),
      capturedMethod({
        selector: 'size', primitive: SMALLTALK_PRIMITIVE.BYTEARRAY_SIZE, args: [receiver()], imageId,
      }),
      capturedMethod({
        selector: 'at:',
        primitive: SMALLTALK_PRIMITIVE.BYTEARRAY_AT,
        parameters: ['index'],
        args: [receiver(), argument(0)],
        imageId,
      }),
    ],
  });

  // ByteArray class >> fromArray: — the explicit, narrowly named conversion from
  // an integer Array buffer; the primitive validates every element 0..255.
  await defineMethods({
    images, compilation, imageId, lane, classRef: objectRef(imageId, 'smalltalk/metaclass/ByteArray'),
    methods: [capturedMethod({
      selector: 'fromArray:',
      primitive: SMALLTALK_PRIMITIVE.ARRAY_TO_BYTEARRAY,
      parameters: ['anArray'],
      args: [argument(0)],
      imageId,
    })],
  });

  return Object.freeze({
    protocol: 'smalltalk-text-bytearray/v1',
    textClass: kernel.textClass,
    byteArrayClass: kernel.byteArrayClass,
  });
}

export {
  installSmalltalkTextByteArrayProtocol,
};
