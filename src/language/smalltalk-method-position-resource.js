import {base64urlEncode, utf8Encode} from '../support/portable-bytes.js';
import {isObjectRef} from '../value/index.js';

// Public authority vocabulary for reading the CURRENT native Smalltalk method at one logical
// position. The position is stable while immutable Block revisions change, and is nameable from
// the public semantic locator alone: image, declaring Class/Metaclass and selector. Naming it reads
// no graph state and discloses no method existence.
//
// Every input is arbitrary text. Encoding each part independently is mandatory: joining raw text
// would let separators in one part collide with separators between parts. base64url excludes `.`,
// so the three-part encoding is injective by construction.
const SMALLTALK_METHOD_POSITION_RESOURCE_V0 = 'smalltalk-method-position-resource/v0';
const SMALLTALK_METHOD_READ_OPERATION = 'smalltalk-method/read';
const PART_SEPARATOR = '.';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function encodePart(value) {
  return base64urlEncode(utf8Encode(value));
}

function smalltalkMethodPositionResource(imageId, classRef, selector) {
  const localImageId = requiredText(imageId, 'method position resource imageId');
  if (!isObjectRef(classRef) || classRef.imageId !== localImageId) {
    throw new TypeError(`method position resource classRef must be an unpinned object ref in ${localImageId}`);
  }
  return [
    encodePart(localImageId),
    encodePart(requiredText(classRef.objectId, 'method position resource class objectId')),
    encodePart(requiredText(selector, 'method position resource selector')),
  ].join(PART_SEPARATOR);
}

export {
  SMALLTALK_METHOD_POSITION_RESOURCE_V0,
  SMALLTALK_METHOD_READ_OPERATION,
  smalltalkMethodPositionResource,
};
