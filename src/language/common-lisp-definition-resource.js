import {base64urlEncode, utf8Encode} from '../support/portable-bytes.js';

// Public authority vocabulary for reading the CURRENT in-image Common Lisp definition at one
// logical namespace position. The position is stable while immutable Block/CodeArtifact revisions
// or variable bindings change, and is nameable from the public semantic locator alone: imageId,
// namespaceId, definition kind ('function' | 'macro' | 'struct' | 'variable'), and symbol name.
// Naming it reads no graph state and discloses no definition existence.
//
// Every input part is encoded independently with base64url (which excludes `.`), so the four-part
// resource string is injective by construction and cannot alias across images, namespaces, kinds,
// or symbol names (including Lisp-2 function vs variable bindings of the same symbol).
const COMMON_LISP_DEFINITION_RESOURCE_V0 = 'common-lisp-definition-resource/v0';
const COMMON_LISP_DEFINITION_READ_OPERATION = 'common-lisp-definition/read';
const COMMON_LISP_NAMESPACE_ID = 'common-lisp/namespace/v1';
const PART_SEPARATOR = '.';

const COMMON_LISP_DEFINITION_KIND = Object.freeze({
  FUNCTION: 'function',
  MACRO: 'macro',
  STRUCT: 'struct',
  VARIABLE: 'variable',
});

const VALID_DEFINITION_KINDS = new Set(Object.values(COMMON_LISP_DEFINITION_KIND));

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertCommonLispDefinitionKind(kind, label = 'Common Lisp definition kind') {
  if (!VALID_DEFINITION_KINDS.has(kind)) {
    throw new TypeError(
      `${label} must be one of function, macro, struct, variable; got ${String(kind)}`,
    );
  }
  return kind;
}

function encodePart(value) {
  return base64urlEncode(utf8Encode(value));
}

function commonLispDefinitionResource(
  imageId,
  kind,
  name,
  {namespaceId = COMMON_LISP_NAMESPACE_ID} = {},
) {
  const localImageId = requiredText(imageId, 'Common Lisp definition resource imageId');
  const localNamespaceId = requiredText(namespaceId, 'Common Lisp definition resource namespaceId');
  const validKind = assertCommonLispDefinitionKind(kind, 'Common Lisp definition resource kind');
  const canonicalName = requiredText(name, 'Common Lisp definition resource name').toUpperCase();
  return [
    encodePart(localImageId),
    encodePart(localNamespaceId),
    encodePart(validKind),
    encodePart(canonicalName),
  ].join(PART_SEPARATOR);
}

export {
  COMMON_LISP_DEFINITION_KIND,
  COMMON_LISP_DEFINITION_READ_OPERATION,
  COMMON_LISP_DEFINITION_RESOURCE_V0,
  assertCommonLispDefinitionKind,
  commonLispDefinitionResource,
};
