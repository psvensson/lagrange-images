import {randomUUID} from 'node:crypto';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {VALUE_KIND, isObjectRef, objectRef} from '../value/index.js';
import {findSmalltalkKernel, readBehavior} from './smalltalk-kernel.js';
import {
  SmalltalkDanglingEdgeError,
  SmalltalkMalformedBehaviorError,
  behaviorRefFor,
  sameRef,
} from './smalltalk-lookup.js';

// ADR 0046 decision 2: the two Smalltalk primitives that need image semantics the shared IR cannot
// express. They are ordinary Blocks for invocation — a method reaches one through an explicit
// captured ref and sends it `value:` — but their code carries this representation, and a
// Symmetric-Smalltalk-owned executor runs it.
//
// That keeps the common `lagrange-code` grammar free of Smalltalk's Behavior layout, and it keeps
// both lanes on the existing send/resumption machinery: neither lane learns a new ABI, because from
// their side this is just a send.
//
// Decision 2a: this executor is registered by the composition root, never by
// `createDefaultCodeExecutorRegistry`. `src/language` already imports `src/execution`, so registering
// it there would close a dependency cycle that the `export *` barrel turns into an import-time
// failure naming neither file.
const SMALLTALK_KERNEL_PRIMITIVE_V1 = 'smalltalk-kernel-primitive/v1';

const SMALLTALK_PRIMITIVE = Object.freeze({
  CLASS_OF: 'class-of',
  BASIC_NEW: 'basic-new',
});

const SMALLTALK_PRIMITIVE_NAMES = Object.freeze(Object.values(SMALLTALK_PRIMITIVE));

// Decision 11: one locality rule for both primitives, and one definition of the image it is measured
// against. A foreign primitive Block must fail rather than answer a foreign kernel's `Integer` or
// allocate into somebody else's image.
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

// Decision 3: `instanceShape == nil` means "not instantiable", never "empty instance". Kept distinct
// from a malformed Behavior and from a dangling Shape edge, because the three mean different things
// to whoever has to fix them.
class SmalltalkNotInstantiableError extends TypeError {
  constructor(classRef) {
    super(
      `${classRef.imageId}/${classRef.objectId} has no instance shape, so it cannot be instantiated; `
      + 'an instantiable class points at a Shape, and an empty Shape is not nil',
    );
    this.name = 'SmalltalkNotInstantiableError';
    this.classRef = classRef;
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

// Decision 9. Deliberately routed through the same `behaviorRefFor` the dispatcher uses, so `class`
// cannot drift from what a send would actually dispatch through: an object answers its `behavior`
// edge, an immediate Value answers its kind's kernel class, and a boolean answers True or False
// under ADR 0045 rather than resurrecting the superseded boolean -> Boolean rule.
async function classOf({images, primitiveImage, value}) {
  if (isObjectRef(value) && value.imageId !== primitiveImage) {
    throw new SmalltalkPrimitiveLocalityError(SMALLTALK_PRIMITIVE.CLASS_OF, primitiveImage, value);
  }
  const {behavior} = await behaviorRefFor({images, receiver: value, dispatchImage: primitiveImage});
  if (!isObjectRef(behavior)) {
    throw new SmalltalkPrimitiveReceiverError(
      SMALLTALK_PRIMITIVE.CLASS_OF,
      isObjectRef(value)
        ? `${value.imageId}/${value.objectId}, which has no behavior`
        : `a ${value.kind} Value`,
    );
  }
  return behavior;
}

// Decision 5, and decision 6's identity rule.
//
// Every slot of the instance Shape is filled, which is not this primitive's choice to make:
// `assertObjectMatchesShape` rejects an object whose slot set differs from its Shape in either
// direction, so a partially populated instance is not a representable record. What this ADR decides
// is only which Value fills them, and that is the image's `nil`.
async function basicNew({images, primitiveImage, classValue, newObjectId, maxIdentityAttempts}) {
  if (!isObjectRef(classValue)) {
    throw new SmalltalkPrimitiveReceiverError(
      SMALLTALK_PRIMITIVE.BASIC_NEW,
      classValue?.kind ? `a ${classValue.kind} Value; only an unpinned class ref allocates` : 'a non-ref',
    );
  }
  if (classValue.imageId !== primitiveImage) {
    throw new SmalltalkPrimitiveLocalityError(SMALLTALK_PRIMITIVE.BASIC_NEW, primitiveImage, classValue);
  }

  const kernel = await findSmalltalkKernel({images, imageId: primitiveImage});
  if (!kernel) throw new TypeError(`image ${primitiveImage} has no Smalltalk kernel to allocate against`);

  // The three graph failures stay apart, so an absent record is not reported as a structural defect
  // in a record that is not there. This mirrors how `loadBehavior` separates them during lookup.
  const record = await images.getObject(classValue.imageId, classValue.objectId);
  if (!record) throw new SmalltalkDanglingEdgeError('class', classValue, classValue);
  let behavior;
  try {
    behavior = await readBehavior(images, classValue);
  } catch (error) {
    throw new SmalltalkMalformedBehaviorError(classValue, error);
  }

  // Decision 3. `nil` is compared as a full ref against this image's kernel `nil`, never by object
  // id, for the same reason superclass lookup terminates that way.
  if (sameRef(behavior.instanceShape, kernel.nil)) throw new SmalltalkNotInstantiableError(classValue);

  const shapeRef = behavior.instanceShape;
  const shape = await images.getShape(shapeRef.imageId, shapeRef.objectId);
  if (!shape) throw new SmalltalkDanglingEdgeError('instanceShape', behavior.record, shapeRef);

  const slots = Object.fromEntries(shape.slots.map(({id}) => [id, kernel.nil]));

  // Decision 6. The primitive owns the candidate id: it mints one and writes create-once with it.
  // Letting `putObject` generate an id internally would make decision 7's "retry the same candidate"
  // unimplementable, because the caller would never have seen the id it should reuse.
  //
  //   known collision before creation succeeded  -> choose a fresh candidate  (the loop below)
  //   unknown outcome, retry of the same host op -> reuse the same candidate  (never re-mints here)
  //   a new Smalltalk basicNew send              -> always a fresh candidate  (a new invocation)
  for (let attempt = 0; attempt < maxIdentityAttempts; attempt += 1) {
    const candidate = newObjectId();
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new TypeError('Smalltalk object identity generator must answer non-empty text');
    }
    try {
      const stored = await images.putObject(primitiveImage, {
        id: candidate,
        shape: shapeRef,
        behavior: classValue,
        slots,
        metadata: {},
      }, {expectedVersion: 0});
      return objectRef(primitiveImage, stored.id);
    } catch (error) {
      // A collision is the one failure that justifies another candidate. Anything else — a malformed
      // record, a backend fault — must surface, not be retried behind a fresh identity.
      //
      // Matched by name rather than by class, as the image-mutation binding already does: an
      // embedder may supply its own backend through `lagrangeFactory`, and a conflict raised by a
      // different module's error class would otherwise escape this loop and fail the whole send.
      if (error?.name !== 'VersionConflictError') throw error;
    }
  }
  throw new TypeError(
    `Symmetric Smalltalk basicNew could not find a free object identity in ${primitiveImage} `
    + `after ${maxIdentityAttempts} attempts`,
  );
}

// `newObjectId` is runtime machinery, not durable class semantics, so it is injectable: the identity
// of an ordinary instance must not be derived from its class, call site or slot values, and a test
// still needs to be able to force a collision.
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
      // Every other callable-Block executor demands direct invocation, and this one has a sharper
      // reason to: a primitive Block ref written into a method-dictionary slot by a raw graph write
      // would otherwise run as a method, allocating from its first *argument* while `self` is
      // silently discarded. ADR 0046 decision 3 puts that validation on the primitive itself.
      assertBlockApplicationReceiver(activation, `${SMALLTALK_KERNEL_PRIMITIVE_V1} ${primitive}`);
      if (activation.arguments.length !== 1) {
        throw new TypeError(
          `Symmetric Smalltalk ${primitive} primitive expects exactly one argument, `
          + `received ${activation.arguments.length}`,
        );
      }
      // Decision 11: the primitive's image is its own Block's image. It is also the only image
      // identity an executor has — the dispatch image is deliberately not in the executor context —
      // and using it is what makes a foreign primitive Block fail instead of quietly answering some
      // other image's kernel.
      const primitiveImage = activation.block.imageId;
      const images = context?.images;
      if (!images || typeof images.getObject !== 'function') {
        throw new TypeError('Symmetric Smalltalk primitives require an images service');
      }
      const [value] = activation.arguments;

      if (primitive === SMALLTALK_PRIMITIVE.CLASS_OF) {
        return await classOf({images, primitiveImage, value});
      }
      return await basicNew({
        images,
        primitiveImage,
        classValue: value,
        newObjectId,
        maxIdentityAttempts,
      });
    },
  });
}

export {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  SMALLTALK_PRIMITIVE_NAMES,
  SmalltalkNotInstantiableError,
  SmalltalkPrimitiveLocalityError,
  SmalltalkPrimitiveReceiverError,
  createSmalltalkKernelPrimitiveV1Executor,
  parsePrimitiveCode,
  primitiveCodeContent,
};
