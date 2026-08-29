import {SHAPE_INDEXED} from '../object/model.js';
import {objectRef, textValue} from '../value/index.js';
import {
  defineMethods,
  ensureBlock,
  ensureCodeArtifact,
  ensureNamedClass,
  ensureSmalltalkShape,
} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {
  DICTIONARY_SHAPE_ID,
  DICTIONARY_SHAPE_SLOTS,
  DICTIONARY_TABLE_SHAPE_ID,
  DICTIONARY_TABLE_SHAPE_SLOTS,
} from './smalltalk-dictionary-table.js';
import {
  SmalltalkKernelConflictError,
  canonicalJson,
  findSmalltalkKernel,
  readBehavior,
} from './smalltalk-kernel.js';
import {sameRef} from './smalltalk-lookup.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0048 decisions 1 and 9: the `Object >> =` / `Object >> hash` protocol and the first public
// `Dictionary` protocol, installed after kernel identity exists exactly as ADRs 0045-0047 install
// theirs. The compiler and dispatcher learn none of these selectors.
//
// Two installers rather than one, because they are separately useful: equality and hashing are
// ordinary Object protocol that a program may want without any collection at all, and a later
// MethodDictionary fast path needs the built-in helpers rather than the Dictionary class.
const DICTIONARY_CLASS_ID = 'smalltalk/class/Dictionary';
const DICTIONARY_METACLASS_ID = 'smalltalk/metaclass/Dictionary';

const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS]: 'smalltalk/primitive/built-in-equals',
  [SMALLTALK_PRIMITIVE.BUILT_IN_HASH]: 'smalltalk/primitive/built-in-hash',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE]: 'smalltalk/primitive/dictionary-initialize',
  [SMALLTALK_PRIMITIVE.DICTIONARY_SIZE]: 'smalltalk/primitive/dictionary-size',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY]: 'smalltalk/primitive/dictionary-includes-key',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT]: 'smalltalk/primitive/dictionary-at',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT]: 'smalltalk/primitive/dictionary-at-put',
});

const CAPTURE_NAME = Object.freeze({
  [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS]: 'primitiveEquals',
  [SMALLTALK_PRIMITIVE.BUILT_IN_HASH]: 'primitiveHash',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE]: 'primitiveDictionaryInitialize',
  [SMALLTALK_PRIMITIVE.DICTIONARY_SIZE]: 'primitiveDictionarySize',
  [SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY]: 'primitiveDictionaryIncludesKey',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT]: 'primitiveDictionaryAt',
  [SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT]: 'primitiveDictionaryAtPut',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

const captureFor = (primitive) => ({id: PRIMITIVE_BLOCK_ID[primitive], name: CAPTURE_NAME[primitive]});
const argument = (index) => ({op: 'argument', index});
const receiver = () => ({op: 'receiver'});

function primitiveSend(capture, args) {
  return {
    op: 'send',
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver: {op: 'binding', id: capture.id},
    message: textValue('value:'.repeat(args.length)),
    arguments: args,
  };
}

// One method reaching one primitive, with the primitive Block bound as an ordinary captured ref in
// the method's own lexical environment.
function capturedMethod({selector, primitive, parameters = [], args, imageId}) {
  const capture = captureFor(primitive);
  return {
    selector,
    program: {
      parameters: parameters.map((name, index) => ({id: `${selector}:parameter:${index}`, name})),
      captures: [{...capture}],
      body: primitiveSend(capture, args),
    },
    captures: [{...capture, value: objectRef(imageId, capture.id)}],
  };
}

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


// `Object >> =` and `Object >> hash`. Every receiver in the image inherits them, which is what makes
// the default relation of decision 2 the language's default rather than a Dictionary-private helper.
async function installSmalltalkEqualityProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  for (const primitive of [SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS, SMALLTALK_PRIMITIVE.BUILT_IN_HASH]) {
    await installPrimitiveBlock({images, imageId, primitive});
  }

  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef: kernel.objectClass,
    methods: [
      capturedMethod({
        selector: '=',
        primitive: SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS,
        parameters: ['anObject'],
        args: [receiver(), argument(0)],
        imageId,
      }),
      // Workstream 3 (MessagePack pressure: the type-mapper dispatch sends `self class == Dictionary`,
      // and the slice also compares symbols, integers, booleans-across-the-bridge and ordinary refs
      // with `==`). `==` is *identity*, and it must NOT route through `=` — `=` is overridable
      // (Association overrides it for value equality), so `^self = anObject` would be wrong.
      //
      // It reuses the SAME built-in primitive as `=` rather than a new one, because ADR 0048 decision
      // 2's relation is already exactly what identity means here: an ObjectRef has genuine
      // (imageId, objectId) identity, while an immediate Value (Integer/Float/Text/Bytes/Boolean)
      // carries no object identity apart from its value, so its identity collapses to value by
      // construction. Two equal-but-distinct Associations are distinct refs -> `==` is false;
      // `1000 == 1000` is value-true because that is the only identity 1000 has. The primitive also
      // applies the ADR 0045 boolean-singleton normalization, which `aBoolean == true` across the
      // bridge requires — a hand-rolled identity primitive would risk dropping it.
      //
      // Like `=`, `==` is an ordinary (overridable) method; Smalltalk convention is not to override
      // it, and the language deliberately does not seal it.
      capturedMethod({
        selector: '==',
        primitive: SMALLTALK_PRIMITIVE.BUILT_IN_EQUALS,
        parameters: ['anObject'],
        args: [receiver(), argument(0)],
        imageId,
      }),
      capturedMethod({
        selector: 'hash',
        primitive: SMALLTALK_PRIMITIVE.BUILT_IN_HASH,
        args: [receiver()],
        imageId,
      }),
    ],
  });
  return Object.freeze({objectClass: kernel.objectClass});
}


async function installSmalltalkDictionaryProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  // The table Shape carries the indexed declaration ADR 0047 introduced; the Dictionary Shape is an
  // ordinary one-slot layout, so a Dictionary's own identity never moves when its contents change.
  await ensureSmalltalkShape(images, imageId, {id: DICTIONARY_SHAPE_ID, slots: [...DICTIONARY_SHAPE_SLOTS]});
  await ensureSmalltalkShape(images, imageId, {
    id: DICTIONARY_TABLE_SHAPE_ID,
    slots: [...DICTIONARY_TABLE_SHAPE_SLOTS],
    indexed: SHAPE_INDEXED.VALUES,
  });

  for (const primitive of [
    SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE,
    SMALLTALK_PRIMITIVE.DICTIONARY_SIZE,
    SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY,
    SMALLTALK_PRIMITIVE.DICTIONARY_AT,
    SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT,
  ]) {
    await installPrimitiveBlock({images, imageId, primitive});
  }

  const {classRef, metaclassRef} = await ensureNamedClass({
    images,
    imageId,
    name: 'Dictionary',
    superclassRef: kernel.objectClass,
    instanceShapeRef: objectRef(imageId, DICTIONARY_SHAPE_ID),
  });

  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef,
    methods: [
      // Overrides `Object >> initialize`, which ADR 0046 installs as `^self`. `new` therefore stays
      // ordinary composition: basicNew leaves `table` nil, and this fills it in.
      capturedMethod({
        selector: 'initialize',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_INITIALIZE,
        args: [receiver()],
        imageId,
      }),
      capturedMethod({
        selector: 'size',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_SIZE,
        args: [receiver()],
        imageId,
      }),
      capturedMethod({
        selector: 'includesKey:',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_INCLUDES_KEY,
        parameters: ['aKey'],
        args: [receiver(), argument(0)],
        imageId,
      }),
      capturedMethod({
        selector: 'at:',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_AT,
        parameters: ['aKey'],
        args: [receiver(), argument(0)],
        imageId,
      }),
      capturedMethod({
        selector: 'at:put:',
        primitive: SMALLTALK_PRIMITIVE.DICTIONARY_AT_PUT,
        parameters: ['aKey', 'aValue'],
        args: [receiver(), argument(0), argument(1)],
        imageId,
      }),
    ],
  });

  // Workstream 3 (MessagePack pressure). Ordinary-source lookup conveniences composed from the
  // primitives above — `MpSettings` and the type mappers read with `at:ifAbsent:`/`at:ifAbsentPut:`.
  // No new primitive and no table access: a miss is one `at:put:` through the existing protocol.
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef,
    methods: [
      {
        selector: 'at:ifAbsent:',
        source: '[ :key :aBlock | (self includesKey: key) ifTrue: [ ^ self at: key ] ifFalse: [ ^ aBlock value ] ]',
      },
      {
        selector: 'at:ifAbsentPut:',
        source: '[ :key :aBlock | (self includesKey: key) ifTrue: [ ^ self at: key ] ifFalse: [ ^ self at: key put: (aBlock value) ] ]',
      },
    ],
  });

  // Class-side. Upstream `createDictionary:` sends `Dictionary new: size`, where `size` is only a
  // capacity *hint*. This Dictionary grows on demand from a fixed floor and has no capacity-taking
  // allocation primitive, so the honest minimal class method accepts and ignores the hint. It lives
  // on the metaclass — sending `new:` to the class object dispatches through the metaclass chain,
  // exactly like `Array new:`. `self new` resolves to the inherited zero-argument `Class>>new`
  // (basicNew + initialize), so it terminates rather than recursing into `new:`.
  await defineMethodsFromSource({
    images,
    compilation,
    imageId,
    lane,
    classRef: metaclassRef,
    methods: [
      {selector: 'new:', source: '[ :size | ^ self new ]'},
    ],
  });

  return Object.freeze({classRef, dictionaryShape: objectRef(imageId, DICTIONARY_SHAPE_ID)});
}

export {
  DICTIONARY_CLASS_ID,
  PRIMITIVE_BLOCK_ID as SMALLTALK_DICTIONARY_PRIMITIVE_BLOCK_ID,
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
};
