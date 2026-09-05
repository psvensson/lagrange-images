import {objectResource} from '../authority/object-resource.js';
import {isObjectRef, objectRef} from '../value/index.js';
import {base64urlDecode, base64urlEncode, utf8DecodeLossy, utf8Encode} from '../support/portable-bytes.js';

// Opaque optimistic-concurrency token for a native Smalltalk METHOD POSITION (bead
// lagrange-images-qax, Object Environment E3).
//
// ADR 0086 already decided what a method position is: `{Class/Metaclass, selector}` is the logical
// position, and the Block currently bound there is that position's immutable current revision. So
// this token represents the observed state of THAT position and nothing wider.
//
// NOT WHOLE-DICTIONARY. A MethodDictionary-scoped token would make an unrelated actor editing `bar`
// invalidate a token read for `foo`, which publishes storage transaction granularity as semantic
// concurrency granularity. The dictionary CAS remains the persistence mechanism underneath; that is
// an implementation fact and deliberately not what this token means.
//
// NOT THE BLOCK REF. A token that WAS the ref would be indistinguishable from something the browse
// seam already hands out, so it could not express an assumption ABOUT that ref — which is the whole
// job. The observed binding is one of the things this token is scoped to, not the token itself, and
// the token is useless as a ref: it names a position as well as a revision, and a caller cannot
// pass it anywhere a ref is expected.
//
// Opacity here is a CONTRACT, not a secret. This module is internal to the language owner and is
// not published through the public roots, so a caller receives tokens and returns them; it is not
// claimed that the format is underivable by someone who reimplements it.
//
//   token scoped to a position + its observed revision  !=  token is either of those
//
// The caller still supplies the class and selector separately; the token confirms an assumption
// rather than naming a target. A token minted for another class or another selector is REFUSED
// rather than reinterpreted, and the refusal discloses nothing about that other position.
//
// Callers may compare and round-trip a token. They must not interpret, order or do arithmetic on
// one. No MethodDictionary version, no backend `_version` and no storage identity appears in it —
// the only revision-bearing thing inside is the immutable revision identity ADR 0086 already made
// public through the browse seam.
const SMALLTALK_METHOD_POSITION_TOKEN_V0 = 'smalltalk-method-position/v0';
// `objectResource`'s own separator; base64url excludes it, which is what keeps the pair recoverable.
const OBSERVED_SEPARATOR = '.';

class SmalltalkMethodPositionTokenError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'SmalltalkMethodPositionTokenError';
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SmalltalkMethodPositionTokenError(`${label} must be a non-empty string`);
  }
  return value;
}

// The value owner decides what an unpinned object ref is; hand-rolling the check would admit a
// ref-shaped object carrying extra keys.
function assertRef(ref, label) {
  if (!isObjectRef(ref)) {
    throw new SmalltalkMethodPositionTokenError(`${label} must be an unpinned object ref`);
  }
  requiredText(ref.imageId, `${label} imageId`);
  requiredText(ref.objectId, `${label} objectId`);
  return ref;
}

// The position half: which image, which Behavior, which selector.
//
// The class ref must be LOCAL to the image, exactly as the browse seam requires of a class ref, so
// that `classRef.imageId` is part of the identity rather than an ignored field. Without this a
// token minted for `{app, C}` would be accepted against `{app, elsewhere/C}` — a position the seam
// itself would refuse as malformed — because only the objectId would have been compared.
//
// Every part goes through `objectResource`, never string concatenation. `object-resource.js` says
// why in terms: neither an imageId nor an objectId forbids a separator, so a hand-built name is not
// injective, and base64url is used precisely because its alphabet excludes the separator. That rule
// applies to a selector and to a method ref just as much as to an object resource, so nothing here
// is joined by hand.
function positionScope(imageId, classRef, selector) {
  requiredText(imageId, 'method position imageId');
  assertRef(classRef, 'method position class');
  if (classRef.imageId !== imageId) {
    throw new SmalltalkMethodPositionTokenError(
      `method position class ${classRef.imageId}/${classRef.objectId} is not local to ${imageId}`,
    );
  }
  return `${objectResource(imageId, classRef.objectId)}`
    + `.${base64urlEncode(utf8Encode(requiredText(selector, 'method position selector')))}`;
}

// The observed half: the immutable current revision the caller read, named the same injective way.
// Encoded rather than embedded as a ref, so the token cannot be mistaken for one or used as one.
function observedRevision(method) {
  assertRef(method, 'method position binding');
  return objectResource(method.imageId, method.objectId);
}

function smalltalkMethodPositionToken({imageId, classRef, selector, method} = {}) {
  return `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:${positionScope(imageId, classRef, selector)}`
    + `:${observedRevision(method)}`;
}

// Answers the observed binding ONLY when the token was issued for exactly this position. A token
// for another class or selector is rejected rather than reinterpreted, and the caller learns
// nothing about that other position from the failure.
function parseSmalltalkMethodPositionToken(token, {imageId, classRef, selector} = {}) {
  const text = requiredText(token, 'method position token');
  const parts = text.split(':');
  if (parts.length !== 3 || parts[0] !== SMALLTALK_METHOD_POSITION_TOKEN_V0) {
    throw new SmalltalkMethodPositionTokenError(`malformed ${SMALLTALK_METHOD_POSITION_TOKEN_V0} token`);
  }
  if (parts[1] !== positionScope(imageId, classRef, selector)) {
    throw new SmalltalkMethodPositionTokenError(
      `${SMALLTALK_METHOD_POSITION_TOKEN_V0} token was issued for a different method position`,
    );
  }
  // A crafted token can carry text that is not base64url at all, and the decoder raises a plain
  // TypeError for it. That must not cross this seam: a malformed token is a malformed TOKEN, an
  // Images-native semantic outcome, not a foreign error from a byte helper.
  //
  // The re-encode is the same canonicality guard `version-token.js` and `object-resource.js` apply,
  // and for the same reason: base64 decoding silently drops leftover bits, so several distinct
  // texts decode alike and a mutated token would otherwise parse as a valid one.
  let observed;
  try {
    const [image, object] = parts[2].split(OBSERVED_SEPARATOR);
    const decodedImage = utf8DecodeLossy(base64urlDecode(image));
    const decodedObject = utf8DecodeLossy(base64urlDecode(object));
    observed = Object.freeze({imageId: decodedImage, objectId: decodedObject});
  } catch {
    throw new SmalltalkMethodPositionTokenError(`malformed ${SMALLTALK_METHOD_POSITION_TOKEN_V0} token`);
  }
  if (observed.imageId.length === 0 || observed.objectId.length === 0
    || observedRevision(objectRef(observed.imageId, observed.objectId)) !== parts[2]) {
    throw new SmalltalkMethodPositionTokenError(`malformed ${SMALLTALK_METHOD_POSITION_TOKEN_V0} token`);
  }
  return observed;
}

export {
  SMALLTALK_METHOD_POSITION_TOKEN_V0,
  SmalltalkMethodPositionTokenError,
  parseSmalltalkMethodPositionToken,
  smalltalkMethodPositionToken,
};
