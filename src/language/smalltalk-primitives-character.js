import {
  VALUE_KIND,
  canonicalizeValue,
  integerValue,
  objectRef,
} from '../value/index.js';
import {ensureObject} from '../graph/ensure-records.js';
import {SmalltalkPrimitiveReceiverError} from './smalltalk-primitive-support.js';

// Character identity is language-owned, not a generic Value kind. The pinned Cuis oracle proves
// Characters distinct from both Integer and one-character String, while literal, indexed and
// streamed production of one code point answer equal and identical Characters. Deterministic
// image-local objects preserve precisely that contract and compose with ordinary Object identity.
const CHARACTER_CLASS_NAME = 'Character';
const CHARACTER_SHAPE_ID = 'smalltalk/character-shape/v1';
const CHARACTER_CODE_POINT_SLOT = 'character-code-point';

function scalarCodePoint(value, primitive) {
  const normalized = canonicalizeValue(value);
  if (normalized.kind !== VALUE_KIND.INTEGER) {
    throw new SmalltalkPrimitiveReceiverError(
      primitive, `a ${normalized.kind} Value; the Character code point must be an Integer Value`,
    );
  }
  const codePoint = BigInt(normalized.value);
  if (codePoint < 0n || codePoint > 0x10ffffn || (codePoint >= 0xd800n && codePoint <= 0xdfffn)) {
    throw new RangeError(`Symmetric Smalltalk ${primitive} code point ${codePoint} is not a Unicode scalar value`);
  }
  return Number(codePoint);
}

function characterObjectId(codePoint) {
  const scalar = scalarCodePoint(integerValue(codePoint), 'character-identity');
  return `smalltalk/character/${scalar.toString(16)}`;
}

async function characterIntern({images, primitiveImage, value}) {
  const codePoint = scalarCodePoint(value, 'character-intern');
  const id = characterObjectId(codePoint);
  await ensureObject(images, primitiveImage, {
    id,
    shape: objectRef(primitiveImage, CHARACTER_SHAPE_ID),
    behavior: objectRef(primitiveImage, `smalltalk/class/${CHARACTER_CLASS_NAME}`),
    slots: {[CHARACTER_CODE_POINT_SLOT]: integerValue(codePoint)},
    metadata: {},
  });
  return objectRef(primitiveImage, id);
}

function textCodePoints(text, primitive) {
  const points = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new SmalltalkPrimitiveReceiverError(
        primitive, 'a Text Value containing a lone surrogate rather than Unicode scalar text',
      );
    }
    points.push(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return points;
}

function textSize({value}) {
  const text = canonicalizeValue(value);
  if (text.kind !== VALUE_KIND.TEXT) {
    throw new SmalltalkPrimitiveReceiverError(
      'text-size', `a ${text.kind} Value; the receiver must be a Text Value`,
    );
  }
  return integerValue(textCodePoints(text.value, 'text-size').length);
}

async function textAtCharacter({images, primitiveImage, value, indexValue}) {
  const text = canonicalizeValue(value);
  if (text.kind !== VALUE_KIND.TEXT) {
    throw new SmalltalkPrimitiveReceiverError(
      'text-at-character', `a ${text.kind} Value; the receiver must be a Text Value`,
    );
  }
  const index = canonicalizeValue(indexValue);
  if (index.kind !== VALUE_KIND.INTEGER) {
    throw new SmalltalkPrimitiveReceiverError(
      'text-at-character', `a ${index.kind} index; index must be an Integer Value`,
    );
  }
  const points = textCodePoints(text.value, 'text-at-character');
  const oneBased = BigInt(index.value);
  if (oneBased < 1n || oneBased > BigInt(points.length)) {
    throw new RangeError(
      `Symmetric Smalltalk text-at-character index ${oneBased} is outside the 1..${points.length} range`,
    );
  }
  return await characterIntern({
    images,
    primitiveImage,
    value: integerValue(points[Number(oneBased) - 1]),
  });
}

export {
  CHARACTER_CLASS_NAME,
  CHARACTER_CODE_POINT_SLOT,
  CHARACTER_SHAPE_ID,
  characterIntern,
  characterObjectId,
  textAtCharacter,
  textSize,
};
