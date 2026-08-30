import {
  SYMBOL_CLASS_NAME,
  SYMBOL_SHAPE_ID,
  SYMBOL_SPELLING_SLOT,
} from './smalltalk-primitives-symbol.js';
import {
  SMALLTALK_PRIMITIVE,
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  primitiveCodeContent,
} from './smalltalk-primitive-support.js';
import {defineMethods, ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {ensureBlock, ensureCodeArtifact} from '../graph/ensure-records.js';
import {objectRef, textValue} from '../value/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// Symbol protocol installation: the Symbol class, its Shape, the interner primitive,
// and Object>>perform: / perform:with:.
//
// This is a primitive-backed protocol (Pattern B): primitive Blocks installed first,
// then methods that capture refs to them and send value:/value:value:.

const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.SYMBOL_INTERN]: 'smalltalk/primitive/symbol-intern',
  [SMALLTALK_PRIMITIVE.PERFORM_SEND]: 'smalltalk/primitive/perform-send',
  [SMALLTALK_PRIMITIVE.PERFORM_SEND_WITH]: 'smalltalk/primitive/perform-send-with',
});

const CAPTURE_NAME = Object.freeze({
  [SMALLTALK_PRIMITIVE.SYMBOL_INTERN]: '$symbol',
  [SMALLTALK_PRIMITIVE.PERFORM_SEND]: '$performSend',
  [SMALLTALK_PRIMITIVE.PERFORM_SEND_WITH]: '$performSendWith',
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
  const capture = {
    id: PRIMITIVE_BLOCK_ID[primitive],
    name: CAPTURE_NAME[primitive],
  };
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

async function installSmalltalkSymbolProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') {
    throw new TypeError('images service is required');
  }
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // 1. Install the Shape
  await ensureSmalltalkShape(images, imageId, {
    id: SYMBOL_SHAPE_ID,
    slots: [{id: SYMBOL_SPELLING_SLOT, name: 'spelling'}],
  });

  // 2. Install primitive Blocks
  await installPrimitiveBlock({images, imageId, primitive: SMALLTALK_PRIMITIVE.SYMBOL_INTERN});
  await installPrimitiveBlock({images, imageId, primitive: SMALLTALK_PRIMITIVE.PERFORM_SEND});
  await installPrimitiveBlock({images, imageId, primitive: SMALLTALK_PRIMITIVE.PERFORM_SEND_WITH});

  // 3. Create the Symbol class
  const {classRef: symbolClassRef} = await ensureNamedClass({
    images,
    imageId,
    name: SYMBOL_CLASS_NAME,
    superclassRef: kernel.objectClass,
    instanceShapeRef: objectRef(imageId, SYMBOL_SHAPE_ID),
  });

  // 4. Install Symbol>>asString — answers the spelling slot. Uses the class-scoped
  //    compiler so the instance variable read goes through the ordinary slot primitive.
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: symbolClassRef,
    methods: [{selector: 'asString', source: '[ spelling ]'}],
  });

  // 5. Install Object>>perform: and Object>>perform:with: on the Object class
  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef: kernel.objectClass,
    methods: [
      capturedMethod({
        selector: 'perform:',
        primitive: SMALLTALK_PRIMITIVE.PERFORM_SEND,
        parameters: ['aSymbol'],
        args: [{op: 'receiver'}, {op: 'argument', index: 0}],
        imageId,
      }),
      capturedMethod({
        selector: 'perform:with:',
        primitive: SMALLTALK_PRIMITIVE.PERFORM_SEND_WITH,
        parameters: ['aSymbol', 'anObject'],
        args: [{op: 'receiver'}, {op: 'argument', index: 0}, {op: 'argument', index: 1}],
        imageId,
      }),
    ],
  });

  return Object.freeze({symbolClass: symbolClassRef});
}

export {
  installSmalltalkSymbolProtocol,
};
