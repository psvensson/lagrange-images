import {objectResource} from '../authority/object-resource.js';

// Opaque optimistic-concurrency tokens for image objects, per ADR 0042 decision 5.
//
// The token is scoped to the object it was issued for. An unscoped token carrying only a
// backend version would silently succeed against a different object that happens to sit at the
// same version: authority would still prevent an escalation, but the compare-and-set would have
// failed to represent the caller's assumption about *this* object, which is the entire point of
// supplying one.
//
//   token scoped to object identity  !=  token is object identity
//
// The caller still supplies the object id separately; the token confirms the assumption rather
// than naming the target. And the scope is object-wide rather than per binding or per field
// mapping, so a future version-aware projection can issue a token usable by any legitimate
// mutation binding over that object.
//
// Callers may compare and round-trip a token. They must not interpret, order or do arithmetic
// on one — which is why the backend's numeric version never appears in it verbatim.
const OBJECT_VERSION_TOKEN_V0 = 'object-version/v0';

class ObjectVersionTokenError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ObjectVersionTokenError';
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ObjectVersionTokenError(`${label} must be a non-empty string`);
  }
  return value;
}

// The faithful domain of the current backends: the mock computes `actualVersion + 1` in
// JavaScript Numbers and the Lagrange adapter converts SQL versions with `Number(...)`. Signed
// 64-bit would advertise more exactness than exists.
function assertBackendVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ObjectVersionTokenError('object version must be a non-negative safe integer');
  }
  return value;
}

function objectVersionToken(imageId, objectId, backendVersion) {
  const scope = objectResource(
    requiredText(imageId, 'object version imageId'),
    requiredText(objectId, 'object version objectId'),
  );
  const version = Buffer.from(String(assertBackendVersion(backendVersion)), 'utf8').toString('base64url');
  // `objectResource` is base64url plus '.', so ':' is an unambiguous separator.
  return `${OBJECT_VERSION_TOKEN_V0}:${scope}:${version}`;
}

// Returns the backend version only when the token was issued for exactly this object. A token
// for another object is rejected rather than reinterpreted, and the caller learns nothing about
// the other object from the failure.
function parseObjectVersionToken(token, imageId, objectId) {
  const text = requiredText(token, 'object version token');
  const parts = text.split(':');
  if (parts.length !== 3 || parts[0] !== OBJECT_VERSION_TOKEN_V0) {
    throw new ObjectVersionTokenError(`malformed ${OBJECT_VERSION_TOKEN_V0} token`);
  }
  const expectedScope = objectResource(
    requiredText(imageId, 'object version imageId'),
    requiredText(objectId, 'object version objectId'),
  );
  if (parts[1] !== expectedScope) {
    throw new ObjectVersionTokenError('object version token was issued for a different object');
  }
  const decoded = Buffer.from(parts[2], 'base64url');
  if (decoded.toString('base64url') !== parts[2]) {
    throw new ObjectVersionTokenError(`malformed ${OBJECT_VERSION_TOKEN_V0} token`);
  }
  const version = Number(decoded.toString('utf8'));
  if (!/^\d+$/.test(decoded.toString('utf8'))) {
    throw new ObjectVersionTokenError(`malformed ${OBJECT_VERSION_TOKEN_V0} token`);
  }
  return assertBackendVersion(version);
}

export {
  OBJECT_VERSION_TOKEN_V0,
  ObjectVersionTokenError,
  objectVersionToken,
  parseObjectVersionToken,
};
