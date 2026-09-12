import {
  CHARACTER_CLASS_NAME,
  CHARACTER_CODE_POINT_SLOT,
  CHARACTER_SHAPE_ID,
} from './smalltalk-primitives-character.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {defineMethods, ensureNamedClass, ensureSmalltalkShape, methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {resolveGlobal} from './smalltalk-globals.js';
import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {objectRef, textValue} from '../value/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// The native Character personality: canonical identity for a Unicode scalar, Text>>at: production
// through the same interner, and the smallest ordinary protocol forced by pinned YAXO. Character
// owns the scalar and its measured classification protocols; there is deliberately no case
// or printing protocol.

const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.CHARACTER_INTERN]: 'smalltalk/primitive/character-intern',
  [SMALLTALK_PRIMITIVE.TEXT_AT_CHARACTER]: 'smalltalk/primitive/text-at-character',
  [SMALLTALK_PRIMITIVE.TEXT_SIZE]: 'smalltalk/primitive/text-size',
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

async function installSmalltalkCharacterProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('images service is required');
  }
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  const shapeRef = await ensureSmalltalkShape(images, imageId, {
    id: CHARACTER_SHAPE_ID,
    slots: [{id: CHARACTER_CODE_POINT_SLOT, name: 'codePoint'}],
  });
  const {classRef, metaclassRef} = await ensureNamedClass({
    images,
    imageId,
    name: CHARACTER_CLASS_NAME,
    superclassRef: kernel.objectClass,
    instanceShapeRef: shapeRef,
  });
  for (const primitive of Object.keys(PRIMITIVE_BLOCK_ID)) {
    await installPrimitiveBlock({images, imageId, primitive});
  }

  // Public construction delegates identity and scalar validation to the same literal/Text interner.
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: metaclassRef,
    methods: [{
      selector: 'codePoint:', source: '[ :aScalar | ^ primitiveCharacterIntern value: aScalar ]',
      captures: [{
        id: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.CHARACTER_INTERN], name: 'primitiveCharacterIntern',
        value: objectRef(imageId, PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.CHARACTER_INTERN]),
      }],
    }],
  });

  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef: kernel.textClass,
    methods: [{
      selector: 'at:',
      program: {
        parameters: [{id: 'at::parameter:0', name: 'index'}],
        captures: [{id: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.TEXT_AT_CHARACTER], name: '$textAtCharacter'}],
        body: {
          op: 'send',
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: {op: 'binding', id: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.TEXT_AT_CHARACTER]},
          message: textValue('value:value:'),
          arguments: [{op: 'receiver'}, {op: 'argument', index: 0}],
        },
      },
      captures: [{
        id: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.TEXT_AT_CHARACTER],
        name: '$textAtCharacter',
        value: objectRef(imageId, PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.TEXT_AT_CHARACTER]),
      }],
    }],
  });

  // Scalar cardinality shares Text indexing's interpretation. Enumeration itself stays in
  // ordinary Smalltalk, so Integer/Block own callback sequencing and exception propagation.
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: kernel.textClass,
    methods: [
      {
        selector: 'size', source: '[ ^ primitiveTextSize value: self ]',
        captures: [{
          id: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.TEXT_SIZE], name: 'primitiveTextSize',
          value: objectRef(imageId, PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.TEXT_SIZE]),
        }],
      },
      {
        selector: 'do:',
        source: '[ :aBlock | 1 to: self size do: [:index | aBlock value: (self at: index)]. ^ self ]',
      },
    ],
  });

  // Character already durably owns this scalar in its one named slot. Expose it through ordinary
  // instance-variable protocol rather than introducing a second field, host lookup or primitive.
  // The exact seven-member separator relation is the pinned Cuis semantic claim. Although Cuis
  // happens to express membership through Array>>statePointsTo:, generic collection membership is
  // not part of the forcing contract; keep the classification at its Character owner and compose
  // only the existing Integer equality and lazy Boolean protocol.
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef,
    methods: [
      {selector: 'codePoint', source: '[ ^ codePoint ]'},
      {selector: 'isAscii', source: '[ ^ self codePoint < 128 ]'},
      // Pinned asciiValue is partial: non-ASCII scalars answer the canonical nil.
      {selector: 'asciiValue', source: '[ ^ self codePoint < 128 ifTrue: [self codePoint] ifFalse: [nil] ]'},
      {selector: 'isDigit', source: '[ ^ self codePoint between: 48 and: 57 ]'},
      {
        selector: 'isLetter',
        source: `[ | scalar |
          scalar := self codePoint.
          255 < scalar ifTrue: [ ^ self isLetterOutsideLatin1 ].
          ^ (scalar between: 65 and: 90) or: [
            (scalar between: 97 and: 122) or: [
              scalar = 170 or: [ scalar = 181 or: [ scalar = 186 or: [
                (scalar between: 192 and: 255) and: [
                  (scalar = 215 or: [ scalar = 247 ]) not ] ] ] ] ] ]
        ]`,
      },
      {
        selector: 'digitValue',
        source: `[ | scalar |
          scalar := self codePoint.
          (scalar between: 48 and: 57) ifTrue: [ ^ scalar - 48 ].
          (scalar between: 65 and: 90) ifTrue: [ ^ scalar - 55 ].
          ^ -1 ]`,
      },
      {
        selector: 'isSeparator',
        source: `[ | scalar |
          scalar := self codePoint.
          ^ scalar = 32 or: [
            scalar = 9 or: [
              scalar = 10 or: [
                scalar = 13 or: [
                  scalar = 12 or: [
                    scalar = 160 or: [ scalar = 8203 ] ] ] ] ] ]
        ]`,
      },
    ],
  });

  return Object.freeze({classRef, shapeRef});
}

// This result constructor names public Array/Character bindings. Its stage runs after global
// publication; basic Character identity and Text production retain their smaller prerequisites.
const CHARACTER_RANGE_METHODS = Object.freeze([Object.freeze({
  selector: 'to:',
  source: `[ :endCharacter | | start stop result index |
    start := self codePoint. stop := endCharacter codePoint.
    result := Array new: (stop - start + 1).
    index := 1.
    start to: stop do: [:scalar |
      result at: index put: (Character codePoint: scalar).
      index := index + 1 ].
    ^ result ]`,
})]);

async function installSmalltalkCharacterRangeProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') throw new TypeError('images service is required');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  if (!await findSmalltalkKernel({images, imageId})) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  for (const name of ['Array', CHARACTER_CLASS_NAME]) {
    if (!await resolveGlobal({images, imageId, name})) {
      throw new TypeError(`image ${imageId} has not published the global ${name}; publish it first`);
    }
  }
  // Publication alone does not establish protocol in a partially installed image.
  for (const [objectId, selector] of [
    ['smalltalk/metaclass/Array', 'new:'], ['smalltalk/class/Array', 'at:put:'],
    ['smalltalk/metaclass/Character', 'codePoint:'], ['smalltalk/class/Character', 'codePoint'],
    ['smalltalk/class/Integer', 'to:do:'], ['smalltalk/class/Integer', '+'], ['smalltalk/class/Integer', '-'],
  ]) {
    const classRef = objectRef(imageId, objectId);
    if (!await images.getObject(imageId, objectId)
      || !await methodBlockRef({images, imageId, classRef, selector})) {
      throw new TypeError(`image ${imageId} has no ${objectId} ${selector} method; install its protocol first`);
    }
  }
  const classRef = objectRef(imageId, `smalltalk/class/${CHARACTER_CLASS_NAME}`);
  await defineMethodsFromSource({images, compilation, imageId, lane, classRef, methods: CHARACTER_RANGE_METHODS});
  return Object.freeze({classRef});
}

export {
  installSmalltalkCharacterProtocol,
  installSmalltalkCharacterRangeProtocol,
};
