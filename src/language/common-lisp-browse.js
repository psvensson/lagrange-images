import {
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  objectResource,
} from '../authority/object-resource.js';
import {VALUE_KIND, isObjectRef, objectRef} from '../value/index.js';
import {
  COMMON_LISP_NAMESPACE_ID,
  COMMON_LISP_SYSTEM_V0,
  installCommonLispProgram,
  installCommonLispSystem,
  installCommonLispSystemFromArtifact,
  listCommonLispNamespaceBindings,
  parseCommonLispDefsystem,
  readCommonLispClassDefinition,
  readCommonLispFunctionDefinition,
  readCommonLispGenericDefinition,
  readCommonLispMacroDefinition,
  readCommonLispSource,
  readCommonLispStructDefinition,
  readCommonLispSystemDefinition,
  readCommonLispVariableDefinition,
} from './common-lisp.js';
import {
  COMMON_LISP_DEFINITION_KIND,
  COMMON_LISP_DEFINITION_READ_OPERATION,
  COMMON_LISP_DEFINITION_WRITE_OPERATION,
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

const writeDemand = (imageId, objectId) => ({
  operation: OBJECT_WRITE_OPERATION,
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
    case COMMON_LISP_DEFINITION_KIND.CLASS: {
      const def = await readCommonLispClassDefinition({
        images,
        imageId,
        name: canonicalName,
        namespaceId,
      });
      if (!def) {
        throw new TypeError(
          `Common Lisp namespace ${imageId}/${namespaceId} does not define class ${canonicalName}`,
        );
      }
      return Object.freeze({
        format: COMMON_LISP_DEFINITION_DESCRIPTION_V1,
        namespace: namespaceRef,
        kind: COMMON_LISP_DEFINITION_KIND.CLASS,
        name: def.name,
        class: def.classRef,
        className: def.className,
        superclasses: def.superclasses,
        cpl: def.cpl,
        slots: def.slots,
        localSlots: def.localSlots,
      });
    }
    case COMMON_LISP_DEFINITION_KIND.GENERIC: {
      const def = await readCommonLispGenericDefinition({
        images,
        imageId,
        name: canonicalName,
        namespaceId,
      });
      if (!def) {
        throw new TypeError(
          `Common Lisp namespace ${imageId}/${namespaceId} does not define generic ${canonicalName}`,
        );
      }
      return Object.freeze({
        format: COMMON_LISP_DEFINITION_DESCRIPTION_V1,
        namespace: namespaceRef,
        kind: COMMON_LISP_DEFINITION_KIND.GENERIC,
        name: def.name,
        parameters: def.parameters,
        methods: def.methods,
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
    case COMMON_LISP_DEFINITION_KIND.SYSTEM: {
      const def = await readCommonLispSystemDefinition({
        images,
        imageId,
        name: canonicalName,
        namespaceId,
      });
      if (!def) {
        throw new TypeError(
          `Common Lisp namespace ${imageId}/${namespaceId} does not define system ${canonicalName}`,
        );
      }
      return Object.freeze({
        format: COMMON_LISP_DEFINITION_DESCRIPTION_V1,
        namespace: namespaceRef,
        kind: COMMON_LISP_DEFINITION_KIND.SYSTEM,
        name: def.name,
        description: def.description,
        version: def.version,
        serial: def.serial,
        dependsOn: def.dependsOn,
        loadOrder: def.loadOrder,
      });
    }
    default:
      throw new TypeError(`unsupported Common Lisp definition kind: ${validKind}`);
  }
}

function validateReplacementForm(forms, validKind, canonicalName) {
  if (!Array.isArray(forms) || forms.length !== 1 || forms[0]?.kind !== 'list' || forms[0].elements.length < 2) {
    throw new SyntaxError(
      `authorizedReplaceCommonLispDefinition requires a single top-level ${validKind} definition form for ${canonicalName}`,
    );
  }
  const form = forms[0];
  const headSym = form.elements[0];
  if (headSym?.kind !== 'symbol') {
    throw new SyntaxError(`invalid Common Lisp definition form head for ${canonicalName}`);
  }
  const head = headSym.name;
  let targetSym = form.elements[1];
  if (validKind === COMMON_LISP_DEFINITION_KIND.STRUCT && targetSym?.kind === 'list') {
    targetSym = targetSym.elements[0];
  }
  const expectedHeads = {
    [COMMON_LISP_DEFINITION_KIND.FUNCTION]: ['DEFUN'],
    [COMMON_LISP_DEFINITION_KIND.MACRO]: ['DEFMACRO'],
    [COMMON_LISP_DEFINITION_KIND.STRUCT]: ['DEFSTRUCT'],
    [COMMON_LISP_DEFINITION_KIND.CLASS]: ['DEFCLASS'],
    [COMMON_LISP_DEFINITION_KIND.GENERIC]: ['DEFGENERIC', 'DEFMETHOD'],
    [COMMON_LISP_DEFINITION_KIND.VARIABLE]: ['DEFPARAMETER', 'DEFVAR'],
  }[validKind];
  if (!expectedHeads || !expectedHeads.includes(head)) {
    throw new SyntaxError(
      `Common Lisp ${validKind} replacement for ${canonicalName} must use ${expectedHeads?.join(' or ') ?? validKind}, got ${head}`,
    );
  }
  if (targetSym?.kind !== 'symbol') {
    throw new SyntaxError(`Common Lisp ${validKind} replacement target must be a symbol`);
  }
  const formName = targetSym.name.toUpperCase();
  const bareFormName = formName.includes('::') ? formName.split('::')[1] : formName;
  const bareTarget = canonicalName.includes('::') ? canonicalName.split('::')[1] : canonicalName;
  if (formName !== canonicalName && bareFormName !== bareTarget) {
    throw new SyntaxError(
      `Common Lisp ${validKind} replacement form defines ${formName}, expected ${canonicalName}`,
    );
  }
}

async function readExistingDefinitionByKind({images, imageId, namespaceId, kind, name}) {
  switch (kind) {
    case COMMON_LISP_DEFINITION_KIND.FUNCTION:
      return await readCommonLispFunctionDefinition({images, imageId, name, namespaceId});
    case COMMON_LISP_DEFINITION_KIND.MACRO:
      return await readCommonLispMacroDefinition({images, imageId, name, namespaceId});
    case COMMON_LISP_DEFINITION_KIND.STRUCT:
      return await readCommonLispStructDefinition({images, imageId, name, namespaceId});
    case COMMON_LISP_DEFINITION_KIND.CLASS:
      return await readCommonLispClassDefinition({images, imageId, name, namespaceId});
    case COMMON_LISP_DEFINITION_KIND.GENERIC:
      return await readCommonLispGenericDefinition({images, imageId, name, namespaceId});
    case COMMON_LISP_DEFINITION_KIND.VARIABLE:
      return await readCommonLispVariableDefinition({images, imageId, name, namespaceId});
    case COMMON_LISP_DEFINITION_KIND.SYSTEM:
      return await readCommonLispSystemDefinition({images, imageId, name, namespaceId});
    default:
      return null;
  }
}

async function authorizedInstallCommonLispProgram({
  images,
  compilation = null,
  runtime = null,
  imageId,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
  source,
  lane = 'neutral',
  require,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(namespaceId, 'namespaceId');
  assertRequire(require, 'authorizedInstallCommonLispProgram');
  const parsedForms = typeof source === 'string'
    ? readCommonLispSource(requiredText(source, 'authorizedInstallCommonLispProgram source'))
    : Array.isArray(source) && source.length > 0
      ? source
      : null;
  if (!parsedForms || parsedForms.length === 0) {
    throw new TypeError('authorizedInstallCommonLispProgram source must contain at least one Common Lisp form');
  }

  require(writeDemand(imageId, namespaceId));

  const result = await installCommonLispProgram({
    images: images ?? runtime?.images,
    compilation: compilation ?? runtime?.compilation ?? null,
    runtime,
    imageId,
    source: parsedForms,
    lane,
  });

  return Object.freeze({
    installed: true,
    namespace: objectRef(imageId, namespaceId),
    functions: Object.freeze(Object.keys(result.functions).sort((a, b) => a.localeCompare(b))),
    variables: Object.freeze(Object.keys(result.variables).sort((a, b) => a.localeCompare(b))),
    macros: Object.freeze(Object.keys(result.macros).sort((a, b) => a.localeCompare(b))),
    structs: Object.freeze(Object.keys(result.structs).sort((a, b) => a.localeCompare(b))),
    classes: Object.freeze(Object.keys(result.classes).sort((a, b) => a.localeCompare(b))),
    generics: Object.freeze(Object.keys(result.generics).sort((a, b) => a.localeCompare(b))),
    packages: Object.freeze(Object.keys(result.packages).sort((a, b) => a.localeCompare(b))),
  });
}

async function authorizedInstallCommonLispSystem({
  images,
  compilation = null,
  runtime = null,
  imageId,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
  asdSource,
  files = {},
  systems = {},
  systemName = null,
  lane = 'neutral',
  require,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(namespaceId, 'namespaceId');
  requiredText(asdSource, 'authorizedInstallCommonLispSystem asdSource');
  assertRequire(require, 'authorizedInstallCommonLispSystem');

  const sysDef = parseCommonLispDefsystem(asdSource, {systemName});

  require(writeDemand(imageId, namespaceId));
  require({
    operation: COMMON_LISP_DEFINITION_WRITE_OPERATION,
    resource: commonLispDefinitionResource(imageId, COMMON_LISP_DEFINITION_KIND.SYSTEM, sysDef.name, {namespaceId}),
  });

  const installed = await installCommonLispSystem({
    images: images ?? runtime?.images,
    compilation: compilation ?? runtime?.compilation ?? null,
    runtime,
    imageId,
    asdSource,
    files,
    systems,
    systemName: sysDef.name,
    lane,
  });

  return Object.freeze({
    installed: true,
    namespace: objectRef(imageId, namespaceId),
    system: installed.system.name,
    version: installed.system.version,
    dependsOn: installed.system.dependsOn,
    loadOrder: installed.loadOrder,
  });
}

async function authorizeSystemArtifactGraph({
  images,
  imageId,
  namespaceId,
  artifactId,
  require,
  visited = new Set(),
}) {
  if (visited.has(artifactId)) return;
  visited.add(artifactId);

  require(readDemand(imageId, artifactId));

  const artifact = await images.getCodeArtifact(imageId, artifactId);
  if (!artifact || artifact.representation !== COMMON_LISP_SYSTEM_V0 || artifact.content?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(`CodeArtifact ${imageId}/${artifactId} is not a ${COMMON_LISP_SYSTEM_V0} artifact`);
  }
  const rawSysDef = JSON.parse(artifact.content.value);
  const sysName = requiredText(rawSysDef?.name, 'Common Lisp system name').toUpperCase();
  require({
    operation: COMMON_LISP_DEFINITION_WRITE_OPERATION,
    resource: commonLispDefinitionResource(imageId, COMMON_LISP_DEFINITION_KIND.SYSTEM, sysName, {namespaceId}),
  });

  for (const dep of artifact.dependencies ?? []) {
    const role = typeof dep?.role === 'string' ? dep.role : '';
    const depRef = dep?.artifact;
    if (!isObjectRef(depRef) || depRef.imageId !== imageId) continue;
    if (role.startsWith('system:')) {
      await authorizeSystemArtifactGraph({
        images,
        imageId,
        namespaceId,
        artifactId: depRef.objectId,
        require,
        visited,
      });
    } else if (role.startsWith('component:')) {
      require(readDemand(imageId, depRef.objectId));
    }
  }
}

async function authorizedInstallCommonLispSystemFromArtifact({
  images,
  compilation = null,
  runtime = null,
  imageId,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
  systemArtifact,
  lane = 'neutral',
  require,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(namespaceId, 'namespaceId');
  const artifactId = typeof systemArtifact === 'string'
    ? systemArtifact
    : isObjectRef(systemArtifact)
      ? systemArtifact.objectId
      : '';
  requiredText(artifactId, 'authorizedInstallCommonLispSystemFromArtifact systemArtifact');
  if (isObjectRef(systemArtifact) && systemArtifact.imageId !== imageId) {
    throw new TypeError(
      `Common Lisp system artifact ${systemArtifact.imageId}/${artifactId} does not belong to image ${imageId}`,
    );
  }
  assertRequire(require, 'authorizedInstallCommonLispSystemFromArtifact');

  require(writeDemand(imageId, namespaceId));

  const effectiveImages = images ?? runtime?.images;
  await authorizeSystemArtifactGraph({
    images: effectiveImages,
    imageId,
    namespaceId,
    artifactId,
    require,
  });

  const installed = await installCommonLispSystemFromArtifact({
    images: effectiveImages,
    compilation: compilation ?? runtime?.compilation ?? null,
    runtime,
    imageId,
    systemArtifact: objectRef(imageId, artifactId),
    lane,
  });

  return Object.freeze({
    installed: true,
    namespace: objectRef(imageId, namespaceId),
    system: installed.system.name,
    version: installed.system.version,
    dependsOn: installed.system.dependsOn,
    loadOrder: installed.loadOrder,
  });
}

async function authorizedReplaceCommonLispDefinition({
  images,
  compilation = null,
  runtime = null,
  imageId,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
  kind,
  name,
  source,
  lane = 'neutral',
  require,
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(namespaceId, 'namespaceId');
  const validKind = assertCommonLispDefinitionKind(
    kind,
    'authorizedReplaceCommonLispDefinition kind',
  );
  const canonicalName = requiredText(
    name,
    'authorizedReplaceCommonLispDefinition name',
  ).toUpperCase();
  const sourceText = requiredText(source, 'authorizedReplaceCommonLispDefinition source');
  assertRequire(require, 'authorizedReplaceCommonLispDefinition');

  const forms = readCommonLispSource(sourceText);
  validateReplacementForm(forms, validKind, canonicalName);

  require(writeDemand(imageId, namespaceId));
  require({
    operation: COMMON_LISP_DEFINITION_WRITE_OPERATION,
    resource: commonLispDefinitionResource(imageId, validKind, canonicalName, {namespaceId}),
  });

  const effectiveImages = images ?? runtime?.images;
  const existing = await readExistingDefinitionByKind({
    images: effectiveImages,
    imageId,
    namespaceId,
    kind: validKind,
    name: canonicalName,
  });
  if (!existing) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} does not define ${validKind} ${canonicalName}`,
    );
  }

  await installCommonLispProgram({
    images: effectiveImages,
    compilation: compilation ?? runtime?.compilation ?? null,
    runtime,
    imageId,
    source: forms,
    lane,
  });

  return Object.freeze({
    replaced: true,
    namespace: objectRef(imageId, namespaceId),
    kind: validKind,
    name: canonicalName,
  });
}

export {
  COMMON_LISP_DEFINITION_DESCRIPTION_V1,
  COMMON_LISP_NAMESPACE_DESCRIPTION_V1,
  authorizedDescribeCommonLispDefinition,
  authorizedDescribeCommonLispNamespace,
  authorizedInstallCommonLispProgram,
  authorizedInstallCommonLispSystem,
  authorizedInstallCommonLispSystemFromArtifact,
  authorizedReplaceCommonLispDefinition,
};
