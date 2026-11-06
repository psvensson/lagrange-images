import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {objectRef} from '../value/index.js';
import {
  COMMON_LISP_NAMESPACE_ID,
  listCommonLispNamespaceBindings,
  readCommonLispFunctionDefinition,
  readCommonLispMacroDefinition,
  readCommonLispStructDefinition,
  readCommonLispVariableDefinition,
} from './common-lisp.js';
import {
  COMMON_LISP_DEFINITION_KIND,
  COMMON_LISP_DEFINITION_READ_OPERATION,
  assertCommonLispDefinitionKind,
  commonLispDefinitionResource,
} from './common-lisp-definition-resource.js';

// The AUTHORIZED in-image Common Lisp browsing seam (ADR 0087, ADR 0099, bead lagrange-images-gn41).
//
// This is an IMAGES semantic API. It answers ordinary in-image Common Lisp facts about namespaces,
// functions, macros, structs, and special variables — useful to the Object Environment and any
// headless client — without exposing storage layouts.
//
// COMPOSITION, NOT DECODING. Every fact here comes from the owner that already decides it:
//
//   namespace definition index                               listCommonLispNamespaceBindings (common-lisp.js)
//   function Block, arity/lambda-list signature, source      readCommonLispFunctionDefinition (common-lisp.js)
//   macro lambda-list and source                             readCommonLispMacroDefinition    (common-lisp.js)
//   defstruct layout, accessors, and backing Class ref       readCommonLispStructDefinition   (common-lisp.js)
//   special variable current Value                           readCommonLispVariableDefinition (common-lisp.js)
//   object authority operation + resource naming             object-resource.js               (authority)
//   logical definition-position authority vocabulary         common-lisp-definition-resource.js (language)
//
// WHAT DELIBERATELY DOES NOT ESCAPE. GlobalBinding object ids or `global-binding-value` slot ids;
// `%MACRO:`, `%STRUCT:`, `%SIG:`, `%MAKE-STRUCT-*`, or `%SET-*` internal namespace keys; backend
// `_version`; semantic/syntax/WASM CodeArtifact ids; or Smalltalk camelCase slot ids underneath a
// `defstruct`.
//
// AUTHORITY. Two operations, two checks, no transitive authority (ADR 0037, ADR 0039 §2):
//
//   namespace browsing   ONE `object/read` on the namespace OBJECT (`common-lisp/namespace/v1`).
//   definition browsing  that SAME namespace check, AND an independent `common-lisp-definition/read`
//                        on the exact logical {imageId, namespaceId, kind, name} position.
//
// AUTHORIZATION BEFORE EXISTENCE. Every entry point validates its caller-supplied inputs (which
// discloses nothing), then requires, then reads. A denied caller cannot tell an existing namespace
// or definition from a missing one: both fail with AuthorityError.

const COMMON_LISP_NAMESPACE_DESCRIPTION_V1 = 'common-lisp-namespace-description/v1';
const COMMON_LISP_DEFINITION_DESCRIPTION_V1 = 'common-lisp-definition-description/v1';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertRequire(require, label) {
  if (typeof require !== 'function') {
    throw new TypeError(`${label} requires a require(demand) authority-check function`);
  }
  return require;
}

const readDemand = (imageId, objectId) => ({
  operation: OBJECT_READ_OPERATION,
  resource: objectResource(imageId, objectId),
});

async function authorizedDescribeCommonLispNamespace({
  images,
  imageId,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
  require,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(namespaceId, 'namespaceId');
  assertRequire(require, 'authorizedDescribeCommonLispNamespace');

  require(readDemand(imageId, namespaceId));

  const bindings = await listCommonLispNamespaceBindings({images, imageId, namespaceId});
  return Object.freeze({
    format: COMMON_LISP_NAMESPACE_DESCRIPTION_V1,
    namespace: objectRef(imageId, namespaceId),
    functions: bindings.functions,
    macros: bindings.macros,
    structs: bindings.structs,
    variables: bindings.variables,
  });
}

async function authorizedDescribeCommonLispDefinition({
  images,
  imageId,
  kind,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
  require,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(namespaceId, 'namespaceId');
  const validKind = assertCommonLispDefinitionKind(
    kind,
    'authorizedDescribeCommonLispDefinition kind',
  );
  const canonicalName = requiredText(
    name,
    'authorizedDescribeCommonLispDefinition name',
  ).toUpperCase();
  assertRequire(require, 'authorizedDescribeCommonLispDefinition');

  require(readDemand(imageId, namespaceId));
  require({
    operation: COMMON_LISP_DEFINITION_READ_OPERATION,
    resource: commonLispDefinitionResource(imageId, validKind, canonicalName, {namespaceId}),
  });

  const namespaceRef = objectRef(imageId, namespaceId);

  switch (validKind) {
    case COMMON_LISP_DEFINITION_KIND.FUNCTION: {
      const def = await readCommonLispFunctionDefinition({
        images,
        imageId,
        name: canonicalName,
        namespaceId,
      });
      if (!def) {
        throw new TypeError(
          `Common Lisp namespace ${imageId}/${namespaceId} does not define function ${canonicalName}`,
        );
      }
      return Object.freeze({
        format: COMMON_LISP_DEFINITION_DESCRIPTION_V1,
        namespace: namespaceRef,
        kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
        name: def.name,
        function: def.blockRef,
        signature: def.signature,
        source: def.source,
      });
    }
    case COMMON_LISP_DEFINITION_KIND.MACRO: {
      const def = await readCommonLispMacroDefinition({
        images,
        imageId,
        name: canonicalName,
        namespaceId,
      });
      if (!def) {
        throw new TypeError(
          `Common Lisp namespace ${imageId}/${namespaceId} does not define macro ${canonicalName}`,
        );
      }
      return Object.freeze({
        format: COMMON_LISP_DEFINITION_DESCRIPTION_V1,
        namespace: namespaceRef,
        kind: COMMON_LISP_DEFINITION_KIND.MACRO,
        name: def.name,
        lambdaList: def.lambdaList,
        source: def.source,
      });
    }
    case COMMON_LISP_DEFINITION_KIND.STRUCT: {
      const def = await readCommonLispStructDefinition({
        images,
        imageId,
        name: canonicalName,
        namespaceId,
      });
      if (!def) {
        throw new TypeError(
          `Common Lisp namespace ${imageId}/${namespaceId} does not define struct ${canonicalName}`,
        );
      }
      return Object.freeze({
        format: COMMON_LISP_DEFINITION_DESCRIPTION_V1,
        namespace: namespaceRef,
        kind: COMMON_LISP_DEFINITION_KIND.STRUCT,
        name: def.name,
        class: def.classRef,
        className: def.className,
        include: def.include,
        concName: def.concName,
        constructor: def.constructor,
        predicate: def.predicate,
        copier: def.copier,
        slots: def.slots,
        localSlots: def.localSlots,
      });
    }
    case COMMON_LISP_DEFINITION_KIND.VARIABLE: {
      const def = await readCommonLispVariableDefinition({
        images,
        imageId,
        name: canonicalName,
        namespaceId,
      });
      if (!def) {
        throw new TypeError(
          `Common Lisp namespace ${imageId}/${namespaceId} does not define variable ${canonicalName}`,
        );
      }
      return Object.freeze({
        format: COMMON_LISP_DEFINITION_DESCRIPTION_V1,
        namespace: namespaceRef,
        kind: COMMON_LISP_DEFINITION_KIND.VARIABLE,
        name: def.name,
        value: def.value,
      });
    }
    default:
      throw new TypeError(`unsupported Common Lisp definition kind: ${validKind}`);
  }
}

export {
  COMMON_LISP_DEFINITION_DESCRIPTION_V1,
  COMMON_LISP_NAMESPACE_DESCRIPTION_V1,
  authorizedDescribeCommonLispDefinition,
  authorizedDescribeCommonLispNamespace,
};
