import {objectResource} from '../authority/object-resource.js';
import {base64urlDecode, base64urlEncode, utf8DecodeLossy, utf8Encode} from '../support/portable-bytes.js';

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
  const version = base64urlEncode(utf8Encode(String(assertBackendVersion(backendVersion))));
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
  const decoded = base64urlDecode(parts[2]);
  if (base64urlEncode(decoded) !== parts[2]) {
    throw new ObjectVersionTokenError(`malformed ${OBJECT_VERSION_TOKEN_V0} token`);
  }
  const version = Number(utf8DecodeLossy(decoded));
  if (!/^\d+$/.test(utf8DecodeLossy(decoded))) {
    throw new ObjectVersionTokenError(`malformed ${OBJECT_VERSION_TOKEN_V0} token`);
  }
  return assertBackendVersion(version);
}

// THE ONE conditional persistence seam for a token holder (ADR 0042 decision 5,
// ADR 0080). The backend's VersionConflictError carries collection, key,
// expectedVersion and actualVersion, and puts both numbers in its message.
// Propagating it — even as a `cause`, which would leave actualVersion reachable —
// would defeat the opaque token outright. Every lane that persists under a
// caller-supplied token therefore writes through here, and a conflict says only
// that the caller's assumption was stale: no actual version, no replacement
// token, no cause. The put itself is the image service's put (CAS + history in
// one backend transaction); this owner adds nothing but the translation.
class ObjectMutationConflictError extends Error {
  constructor(imageId, objectId) {
    super(`object mutation conflict: the supplied version token is stale for ${imageId}/${objectId}`);
    this.name = 'ObjectMutationConflictError';
    this.imageId = imageId;
    this.objectId = objectId;
  }
}

async function putObjectAtExpectedVersion(images, imageId, input, expectedVersion) {
  assertBackendVersion(expectedVersion);
  try {
    return await images.putObject(imageId, input, {expectedVersion});
  } catch (error) {
    if (error?.name === 'VersionConflictError') {
      // Deliberately no cause: attaching it would leave actualVersion reachable.
      throw new ObjectMutationConflictError(imageId, input.id);
    }
    throw error;
  }
}

export {
  OBJECT_VERSION_TOKEN_V0,
  ObjectMutationConflictError,
  ObjectVersionTokenError,
  objectVersionToken,
  parseObjectVersionToken,
  putObjectAtExpectedVersion,
};
