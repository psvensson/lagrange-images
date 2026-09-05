import {objectResource} from '../authority/object-resource.js';
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
// NOT THE BLOCK REF. A caller can already learn the bound Block ref through the independently
// authorized browse seam, so a token that WAS the ref would be locally derivable and would prove
// nothing about having read this position through this owner. The observed binding is one of the
// things this token is scoped to, not the token itself, and the token is useless as a ref.
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

function assertLocalRef(ref, label) {
  if (!ref || typeof ref !== 'object' || ref.kind !== 'ref') {
    throw new SmalltalkMethodPositionTokenError(`${label} must be an unpinned object ref`);
  }
  requiredText(ref.imageId, `${label} imageId`);
  requiredText(ref.objectId, `${label} objectId`);
  return ref;
}

// The position half: which image, which Behavior, which selector. `objectResource` is base64url
// plus '.', and the selector is base64url, so ':' stays an unambiguous separator.
function positionScope(imageId, classRef, selector) {
  const classObjectId = assertLocalRef(classRef, 'method position class').objectId;
  return `${objectResource(requiredText(imageId, 'method position imageId'), classObjectId)}`
    + `.${base64urlEncode(utf8Encode(requiredText(selector, 'method position selector')))}`;
}

// The observed half: the immutable current revision the caller read. Encoded, not embedded as a
// ref, so the token cannot be mistaken for one or used as one.
function observedRevision(method) {
  const {imageId, objectId} = assertLocalRef(method, 'method position binding');
  return base64urlEncode(utf8Encode(`${imageId} ${objectId}`));
}

function smalltalkMethodPositionToken({imageId, classRef, selector, method}) {
  return `${SMALLTALK_METHOD_POSITION_TOKEN_V0}:${positionScope(imageId, classRef, selector)}`
    + `:${observedRevision(method)}`;
}

// Answers the observed binding ONLY when the token was issued for exactly this position. A token
// for another class or selector is rejected rather than reinterpreted, and the caller learns
// nothing about that other position from the failure.
function parseSmalltalkMethodPositionToken(token, {imageId, classRef, selector}) {
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
  const observed = utf8DecodeLossy(base64urlDecode(parts[2])).split(' ');
  if (observed.length !== 2 || observed[0].length === 0 || observed[1].length === 0) {
    throw new SmalltalkMethodPositionTokenError(`malformed ${SMALLTALK_METHOD_POSITION_TOKEN_V0} token`);
  }
  return Object.freeze({imageId: observed[0], objectId: observed[1]});
}

export {
  SMALLTALK_METHOD_POSITION_TOKEN_V0,
  SmalltalkMethodPositionTokenError,
  parseSmalltalkMethodPositionToken,
  smalltalkMethodPositionToken,
};
