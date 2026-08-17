// Canonical authority resource names for image objects, per ADR 0039 decision 5.
//
// Concatenating identifiers is unsafe. Neither imageId nor objectId forbids a separator, so
// `imageId + '/' + objectId` is not injective — both of these are accepted today and collide:
//
//   imageId "a/b", objectId "c"    ->  "a/b/c"
//   imageId "a",   objectId "b/c"  ->  "a/b/c"
//
// Two distinct objects in two distinct images would share one authority resource, so a grant
// for one would authorize the other. base64url is used because its alphabet excludes the
// separator, which makes the encoding injective by construction rather than by convention.
//
// This is the only permitted way to name an object resource. A hand-built string is exactly
// how the collision returns.
const OBJECT_RESOURCE_V0 = 'object-resource/v0';
const OBJECT_READ_OPERATION = 'object/read';
const OBJECT_RESOURCE_SEPARATOR = '.';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function encodePart(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function objectResource(imageId, objectId) {
  return encodePart(requiredText(imageId, 'object resource imageId'))
    + OBJECT_RESOURCE_SEPARATOR
    + encodePart(requiredText(objectId, 'object resource objectId'));
}

// Provided so a host or test can confirm what a resource names, never so a caller can build
// one from parts. Decoding is the inverse of an injective function, which is what makes the
// round trip meaningful.
function parseObjectResource(resource) {
  const text = requiredText(resource, 'object resource');
  const index = text.indexOf(OBJECT_RESOURCE_SEPARATOR);
  if (index < 0 || text.indexOf(OBJECT_RESOURCE_SEPARATOR, index + 1) >= 0) {
    throw new TypeError(`invalid ${OBJECT_RESOURCE_V0}: ${resource}`);
  }
  const decode = (part, label) => {
    const decoded = Buffer.from(part, 'base64url');
    if (decoded.toString('base64url') !== part) throw new TypeError(`invalid ${OBJECT_RESOURCE_V0} ${label}`);
    return decoded.toString('utf8');
  };
  return Object.freeze({
    imageId: decode(text.slice(0, index), 'imageId'),
    objectId: decode(text.slice(index + 1), 'objectId'),
  });
}

export {
  OBJECT_READ_OPERATION,
  OBJECT_RESOURCE_V0,
  objectResource,
  parseObjectResource,
};
