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
import {defineMethods, ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {objectRef, textValue} from '../value/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// The smallest native Character personality proved by YAXO pressure: canonical identity for a
// Unicode scalar and Text>>at: production through the same interner. There is deliberately no
// classification, case, digit, printing or conversion protocol in this slice.

const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.CHARACTER_INTERN]: 'smalltalk/primitive/character-intern',
  [SMALLTALK_PRIMITIVE.TEXT_AT_CHARACTER]: 'smalltalk/primitive/text-at-character',
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
  const {classRef} = await ensureNamedClass({
    images,
    imageId,
    name: CHARACTER_CLASS_NAME,
    superclassRef: kernel.objectClass,
    instanceShapeRef: shapeRef,
  });
  for (const primitive of Object.keys(PRIMITIVE_BLOCK_ID)) {
    await installPrimitiveBlock({images, imageId, primitive});
  }

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

  return Object.freeze({classRef, shapeRef});
}

export {
  installSmalltalkCharacterProtocol,
};
