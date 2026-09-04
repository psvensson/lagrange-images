import {ensureClassFromDeclaration} from './smalltalk-class-builder.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';

// ADR 0085 M1: this adapter owns translation only. The canonical representation remains owned by
// the OpenSmalltalk/Cuis toolchain provider; the native builder remains the sole owner of Class,
// Metaclass, Shape and slot identity.
const CUIS_SEMANTIC_EXPORT_V2 = 'smalltalk/cuis-semantic-export-v2';
const CUIS_NATIVE_ROOT_OBJECT_IDENTITY = 'cuis-class/Cuis-Base/Object';

class CuisNativeImportError extends TypeError {
  constructor(message, semanticIdentity = null) {
    super(`Cuis native class import refused: ${message}`);
    this.name = 'CuisNativeImportError';
    if (semanticIdentity !== null) this.semanticIdentity = semanticIdentity;
  }
}

function fail(message, semanticIdentity = null) {
  throw new CuisNativeImportError(message, semanticIdentity);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(record(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
    fail(`${label} must have exactly fields ${wanted.join(', ')}`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be non-empty text`);
  return value;
}

function textArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const seen = new Set();
  return value.map((item) => {
    const normalized = text(item, `${label} entry`);
    if (seen.has(normalized)) fail(`${label} must not contain duplicates`);
    seen.add(normalized);
    return normalized;
  });
}

function canonicalClassIdentity(packageName, className) {
  return `cuis-class/${packageName}/${className}`;
}

// Validate every adapter-owned schema, identity and dependency-graph rule before the first native
// owner call. Native declaration semantics (for example inherited-name legality) stay exclusively
// in the class builder; this adapter does not duplicate them to promise a batch transaction it does
// not own. An owner rejection may therefore leave already-valid immutable ancestors, and an exact
// retry converges through their ordinary admission rules.
function importPlan(manifest) {
  exactKeys(manifest, ['format', 'packages', 'classes', 'methods'], 'manifest');
  if (manifest.format !== CUIS_SEMANTIC_EXPORT_V2) {
    fail(`manifest format must be ${CUIS_SEMANTIC_EXPORT_V2}, got ${manifest.format ?? 'missing'}`);
  }
  if (!Array.isArray(manifest.packages)) fail('manifest packages must be an array');
  if (!Array.isArray(manifest.classes)) fail('manifest classes must be an array');
  if (!Array.isArray(manifest.methods)) fail('manifest methods must be an array');
  if (manifest.methods.length !== 0) {
    fail('M1 does not import methods; native method compilation belongs to M2');
  }

  const packageNames = new Set();
  for (const item of manifest.packages) {
    exactKeys(item, ['name', 'requires'], 'package declaration');
    const name = text(item.name, 'package name');
    if (packageNames.has(name)) fail(`package ${name} appears more than once`);
    packageNames.add(name);
    textArray(item.requires, `package ${name} requirements`);
  }

  const classes = [];
  const byIdentity = new Map();
  const nativeNames = new Set();
  for (const item of manifest.classes) {
    exactKeys(
      item,
      ['identity', 'package', 'name', 'superclassName', 'superclass', 'instanceVariables'],
      'class declaration',
    );
    const packageName = text(item.package, 'class package');
    const name = text(item.name, 'class name');
    const identity = text(item.identity, 'class semantic identity');
    if (identity !== canonicalClassIdentity(packageName, name)) {
      fail(`class semantic identity ${identity} does not match its canonical package/name`, identity);
    }
    if (byIdentity.has(identity)) fail(`class semantic identity ${identity} appears more than once`, identity);
    if (nativeNames.has(name)) fail(`native class name ${name} appears more than once`, identity);
    nativeNames.add(name);
    const superclassName = text(item.superclassName, `class ${identity} superclassName`);
    const superclass = text(item.superclass, `class ${identity} superclass semantic identity`);
    if (superclass.slice(superclass.lastIndexOf('/') + 1) !== superclassName) {
      fail(`class ${identity} superclass name does not match ${superclass}`, identity);
    }
    const instanceVariables = textArray(item.instanceVariables, `class ${identity} instanceVariables`);
    const normalized = Object.freeze({identity, package: packageName, name, superclass, instanceVariables});
    classes.push(normalized);
    byIdentity.set(identity, normalized);
  }
  for (const declaration of classes) {
    if (!packageNames.has(declaration.package)) {
      fail(`class ${declaration.identity} names undeclared package ${declaration.package}`, declaration.identity);
    }
    if (declaration.superclass !== CUIS_NATIVE_ROOT_OBJECT_IDENTITY && !byIdentity.has(declaration.superclass)) {
      fail(
        `unsupported superclass semantic identity ${declaration.superclass}; `
        + `M1 maps only ${CUIS_NATIVE_ROOT_OBJECT_IDENTITY} outside the imported graph`,
        declaration.identity,
      );
    }
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (declaration) => {
    if (visited.has(declaration.identity)) return;
    if (visiting.has(declaration.identity)) fail(`class dependency cycle reaches ${declaration.identity}`, declaration.identity);
    visiting.add(declaration.identity);
    const parent = byIdentity.get(declaration.superclass);
    if (parent) visit(parent);
    visiting.delete(declaration.identity);
    visited.add(declaration.identity);
    ordered.push(declaration);
  };
  for (const declaration of classes) visit(declaration);
  return {classes, ordered};
}

async function importCuisNativeClasses({images, imageId, manifest} = {}) {
  text(imageId, 'image id');
  if (!images || typeof images !== 'object') fail('images must be an image service');
  const plan = importPlan(manifest);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) fail(`image ${imageId} has no Smalltalk kernel`);

  // The one M1 compatibility fact is keyed by the export owner's complete semantic identity, not
  // by the spelling "Object". It establishes only the structural root required for native class
  // construction/allocation; broader Cuis base protocol compatibility remains M3 pressure.
  const resolved = new Map([
    [CUIS_NATIVE_ROOT_OBJECT_IDENTITY, Object.freeze({classRef: kernel.objectClass})],
  ]);
  for (const declaration of plan.ordered) {
    const superclass = resolved.get(declaration.superclass);
    if (!superclass) fail(`superclass ${declaration.superclass} was not resolved`, declaration.identity);
    resolved.set(declaration.identity, await ensureClassFromDeclaration({
      images,
      imageId,
      name: declaration.name,
      superclassRef: superclass.classRef,
      instanceVariables: declaration.instanceVariables,
    }));
  }

  // Semantic identity is useful to the caller, but this is deliberately transient output: the
  // adapter creates no durable side table or alternate native representation.
  return Object.freeze({
    classes: Object.freeze(plan.classes.map((declaration) => Object.freeze({
      identity: declaration.identity,
      ...resolved.get(declaration.identity),
    }))),
  });
}

export {
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  CuisNativeImportError,
  importCuisNativeClasses,
};
