import {ensureClassFromDeclaration} from './smalltalk-class-builder.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {reconcileMethodsFromSource} from './smalltalk-instance-variables.js';
import {tokenizeSymmetricSmalltalk} from './symmetric-smalltalk-tokenizer.js';

// ADR 0085 M1/M2: this adapter owns translation only. The canonical representation remains owned
// by the OpenSmalltalk/Cuis toolchain provider; native builders/compilers remain the sole owners of
// Class, Metaclass, Shape, slot and method identity and behavior.
const CUIS_SEMANTIC_EXPORT_V2 = 'smalltalk/cuis-semantic-export-v2';
const CUIS_NATIVE_ROOT_OBJECT_IDENTITY = 'cuis-class/Cuis-Base/Object';

class CuisNativeImportError extends TypeError {
  constructor(message, semanticIdentity = null) {
    super(`Cuis native import refused: ${message}`);
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

function classNameFromIdentity(identity) {
  return identity.slice(identity.lastIndexOf('/') + 1);
}

function canonicalMethodIdentity(packageName, classIdentity, side, selector) {
  return `cuis-method/${packageName}/${classNameFromIdentity(classIdentity)}/${side}/${selector}`;
}

// Cuis sourceCodeAt: answers a complete method definition. The native class-scoped compiler takes
// the same method's body as a Block because selector/arity arrive separately. Standard/Cuis
// methods implicitly answer their receiver when control reaches the end, whereas a native Block
// answers its last expression, so make the method return rule explicit at this dialect boundary.
// Parsing/lowering the body and binding native state remain the existing Symmetric Smalltalk
// compiler's responsibility.
function nativeMethodSource({identity, selector, source}) {
  let tokens;
  try {
    tokens = tokenizeSymmetricSmalltalk(source);
  } catch (error) {
    fail(`method ${identity} source is not in the supported native Smalltalk subset: ${error.message}`, identity);
  }
  const parameters = [];
  let parsedSelector = '';
  let index = 0;
  if (tokens[index].type === 'identifier') {
    parsedSelector = tokens[index].value;
    index += 1;
  } else if (tokens[index].type === 'binary') {
    parsedSelector = tokens[index].value;
    index += 1;
    if (tokens[index].type !== 'identifier') {
      fail(`method ${identity} binary header must declare one parameter`, identity);
    }
    parameters.push(tokens[index].value);
    index += 1;
  } else if (tokens[index].type === 'keyword') {
    while (tokens[index].type === 'keyword') {
      parsedSelector += tokens[index].value;
      index += 1;
      if (tokens[index].type !== 'identifier') {
        fail(`method ${identity} keyword part must declare a parameter`, identity);
      }
      parameters.push(tokens[index].value);
      index += 1;
    }
  } else {
    fail(`method ${identity} has an unsupported method header`, identity);
  }
  if (parsedSelector !== selector) {
    fail(`method ${identity} source header declares ${parsedSelector}, not ${selector}`, identity);
  }
  const body = source.slice(tokens[index - 1].end).trim();
  if (body.length === 0) fail(`method ${identity} has no body`, identity);
  const parameterSource = parameters.length === 0 ? '' : ` ${parameters.map((name) => `:${name}`).join(' ')} |`;
  const bodyTokens = tokens.slice(index, -1);
  const statementSeparator = bodyTokens.length === 0 || bodyTokens.at(-1).type === '.' ? '' : '.';
  return `[${parameterSource}\n${body}${statementSeparator}\nself\n]`;
}

// M3 (bead lagrange-images-nv1.2): a real package is imported progressively, so the caller names
// which canonical declarations this import covers. The canonical manifest is never edited — the
// scope selects from the unmodified artifact, so the export owner remains the only authority on
// what the package contains. Everything the adapter guarantees for a whole manifest holds
// unchanged for the selected subset, and an unsupported semantic INSIDE the scope is still an
// explicit refusal: nothing is silently skipped as though it had succeeded. Omitting the scope
// imports the whole manifest, which is what M1/M2 proved.
function normalizeScope(scope) {
  if (scope === undefined || scope === null) return null;
  exactKeys(scope, ['classes', 'methods'], 'import scope');
  const classes = textArray(scope.classes, 'import scope classes');
  const methods = textArray(scope.methods, 'import scope methods');
  // A method can only be installed on an in-scope class, so a scope naming no class imports
  // nothing. That is a caller mistake, not a successful empty import.
  if (classes.length === 0) fail('import scope must name at least one class');
  return Object.freeze({classes: new Set(classes), methods: new Set(methods)});
}

// Validate every adapter-owned schema, identity and dependency-graph rule before the first native
// owner call. Native declaration semantics (for example inherited-name legality) stay exclusively
// in the class builder; this adapter does not duplicate them to promise a batch transaction it does
// not own. An owner rejection may therefore leave already-valid immutable ancestors, and an exact
// retry converges through their ordinary admission rules.
function importPlan(manifest, scope) {
  const requested = normalizeScope(scope);
  exactKeys(manifest, ['format', 'packages', 'classes', 'methods'], 'manifest');
  if (manifest.format !== CUIS_SEMANTIC_EXPORT_V2) {
    fail(`manifest format must be ${CUIS_SEMANTIC_EXPORT_V2}, got ${manifest.format ?? 'missing'}`);
  }
  if (!Array.isArray(manifest.packages)) fail('manifest packages must be an array');
  if (!Array.isArray(manifest.classes)) fail('manifest classes must be an array');
  if (!Array.isArray(manifest.methods)) fail('manifest methods must be an array');

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
  // Package attribution is a property of the manifest as a whole, so it is checked for every
  // declaration whether or not this import covers it.
  for (const declaration of classes) {
    if (!packageNames.has(declaration.package)) {
      fail(`class ${declaration.identity} names undeclared package ${declaration.package}`, declaration.identity);
    }
  }
  if (requested) {
    for (const identity of requested.classes) {
      if (!byIdentity.has(identity)) {
        fail(`import scope names class ${identity}, which this manifest does not declare`, identity);
      }
    }
  }
  const scopedClasses = requested === null
    ? classes
    : classes.filter((declaration) => requested.classes.has(declaration.identity));
  for (const declaration of scopedClasses) {
    if (declaration.superclass === CUIS_NATIVE_ROOT_OBJECT_IDENTITY) continue;
    const parent = byIdentity.get(declaration.superclass);
    if (!parent) {
      fail(
        `unsupported superclass semantic identity ${declaration.superclass}; `
        + `M1 maps only ${CUIS_NATIVE_ROOT_OBJECT_IDENTITY} outside the imported graph`,
        declaration.identity,
      );
    }
    // A superclass the scope omits is refused rather than pulled in: the caller decides what this
    // import covers, and the adapter never widens it silently.
    if (requested && !requested.classes.has(parent.identity)) {
      fail(
        `class ${declaration.identity} requires superclass ${declaration.superclass}, `
        + 'which the requested import scope omits',
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
  for (const declaration of scopedClasses) visit(declaration);

  // Schema, canonical identity and uniqueness are properties of the manifest as a whole and are
  // checked for every method declaration. Native target legality and source translation are
  // properties of THIS import, so they apply to the covered methods: a Cuis package's source can
  // reach semantics this image does not support yet, and an import that does not cover such a
  // method must not be blocked by it.
  const methods = [];
  const methodIdentities = new Set();
  const nativeBindings = new Set();
  for (const item of manifest.methods) {
    exactKeys(item, ['identity', 'package', 'class', 'side', 'selector', 'source'], 'method declaration');
    const packageName = text(item.package, 'method package');
    if (!packageNames.has(packageName)) fail(`method names undeclared package ${packageName}`);
    const classIdentity = text(item.class, 'method target class semantic identity');
    if (item.side !== 'instance' && item.side !== 'class') {
      fail(`method side must be instance or class, got ${item.side ?? 'missing'}`, item.identity ?? null);
    }
    const selector = text(item.selector, 'method selector');
    const identity = text(item.identity, 'method semantic identity');
    const expectedIdentity = canonicalMethodIdentity(packageName, classIdentity, item.side, selector);
    if (identity !== expectedIdentity) {
      fail(`method semantic identity ${identity} does not match its canonical declaration`, identity);
    }
    if (methodIdentities.has(identity)) fail(`method semantic identity ${identity} appears more than once`, identity);
    methodIdentities.add(identity);
    const binding = `${classIdentity}\u0000${item.side}\u0000${selector}`;
    if (nativeBindings.has(binding)) {
      fail(`native ${item.side} method ${classIdentity}>>${selector} appears more than once`, identity);
    }
    nativeBindings.add(binding);
    const source = text(item.source, `method ${identity} source`);
    if (requested && !requested.methods.has(identity)) continue;
    if (!byIdentity.has(classIdentity)) {
      fail(`method target ${classIdentity} is outside the imported native class graph`, identity);
    }
    if (requested && !requested.classes.has(classIdentity)) {
      fail(`method target ${classIdentity} is outside the requested import scope`, identity);
    }
    methods.push(Object.freeze({
      identity,
      classIdentity,
      side: item.side,
      selector,
      source: nativeMethodSource({identity, selector, source}),
    }));
  }
  if (requested) {
    for (const identity of requested.methods) {
      if (!methodIdentities.has(identity)) {
        fail(`import scope names method ${identity}, which this manifest does not declare`, identity);
      }
    }
  }
  return {classes: scopedClasses, ordered, methods};
}

async function importCuisNativePackage({images, compilation, imageId, manifest, scope = null} = {}) {
  text(imageId, 'image id');
  if (!images || typeof images !== 'object') fail('images must be an image service');
  const plan = importPlan(manifest, scope);
  if (plan.methods.length > 0 && (!compilation || typeof compilation.compileArtifact !== 'function')) {
    fail('compilation must be a compilation service when methods are present');
  }
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

  const methodGroups = new Map();
  for (const method of plan.methods) {
    const target = resolved.get(method.classIdentity);
    const classRef = method.side === 'class' ? target.metaclassRef : target.classRef;
    const key = `${classRef.imageId}\u0000${classRef.objectId}`;
    const group = methodGroups.get(key) ?? {classRef, methods: []};
    group.methods.push({selector: method.selector, source: method.source});
    methodGroups.set(key, group);
  }
  for (const {classRef, methods} of methodGroups.values()) {
    await reconcileMethodsFromSource({
      images,
      compilation,
      imageId,
      classRef,
      methods,
      lane: 'wasm',
    });
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
  importCuisNativePackage,
};
