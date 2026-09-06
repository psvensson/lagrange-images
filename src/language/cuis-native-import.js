import {ensureClassFromDeclaration} from './smalltalk-class-builder.js';
import {findSmalltalkGlobalNamespace, publishSmalltalkClassGlobals} from './smalltalk-globals.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {reconcileMethodsFromSource} from './smalltalk-instance-variables.js';
import {isAssignmentToken, tokenizeSymmetricSmalltalk} from './symmetric-smalltalk-tokenizer.js';

// ADR 0085 M1/M2: this adapter owns translation only. The canonical representation remains owned
// by the OpenSmalltalk/Cuis toolchain provider; native builders/compilers remain the sole owners of
// Class, Metaclass, Shape, slot and method identity and behavior.
const CUIS_SEMANTIC_EXPORT_V2 = 'smalltalk/cuis-semantic-export-v2';
const CUIS_NATIVE_ROOT_OBJECT_IDENTITY = 'cuis-class/Cuis-Base/Object';
const CUIS_NATIVE_INTEGER_IDENTITY = 'cuis-class/Cuis-Base/Integer';

// The ONE seam where a Cuis semantic class identity corresponds to an already-proven native class.
// Keyed by the export owner's COMPLETE semantic identity and never by class name: a Cuis class
// merely spelled `Integer` in some other package is not this image's Integer, exactly as the M1
// root rule already said about `Object`. Nothing outside this table resolves to a native class, so
// there is no name fallback and no caller-supplied alias.
//
// Each entry also declares the POSITIONS it is proved for, because "this identity denotes that
// native class" is not one claim but two, and the two are independently justified:
//
//   cuis-class/Cuis-Base/Object   `superclass` only. The structural root for native class
//                                 construction/allocation (ADR 0085 M1) — a declared superclass
//                                 position. It is deliberately NOT a method target: installing a
//                                 package's extension selector on the root of the whole native
//                                 image is a far larger claim than M1 made, and no consumer has
//                                 demanded it.
//   cuis-class/Cuis-Base/Integer  `method-target` only. The class an ordinary native integer's
//                                 Behavior resolves to, so a Cuis package's extension method
//                                 installed here is reached by real native integer receivers.
//                                 Required by the pinned upstream JSON package:
//                                 `Integer>>jsonWriteOn:` is an extension on a class that package
//                                 does not define. This is NOT a claim that native Integer
//                                 implements every Cuis Integer protocol — that method's own
//                                 `printOn:base:` receiver requirement is a separate, unproven
//                                 native-library semantic, and a missing one stays a visible
//                                 failure rather than something this table papers over. Nor is it
//                                 a claim that Integer is a sound SUPERCLASS: native integers are
//                                 Values whose dispatch class is fixed by their kind, so a Cuis
//                                 class declaring Integer as its parent would get an inert class
//                                 no integer ever dispatches to. Refused until something proves
//                                 otherwise.
//
// A Map, not an object literal, so a hostile identity such as `__proto__` cannot resolve.
const CUIS_NATIVE_MAPPING_POSITION = Object.freeze({SUPERCLASS: 'superclass', METHOD_TARGET: 'method-target'});
const CUIS_NATIVE_CLASS_MAPPINGS = new Map([
  [CUIS_NATIVE_ROOT_OBJECT_IDENTITY, Object.freeze({
    slot: 'objectClass', positions: Object.freeze([CUIS_NATIVE_MAPPING_POSITION.SUPERCLASS]),
  })],
  [CUIS_NATIVE_INTEGER_IDENTITY, Object.freeze({
    slot: 'integerClass', positions: Object.freeze([CUIS_NATIVE_MAPPING_POSITION.METHOD_TARGET]),
  })],
]);

function isMappedCuisClass(identity) {
  return CUIS_NATIVE_CLASS_MAPPINGS.has(identity);
}

function mappedCuisIdentities(position) {
  return [...CUIS_NATIVE_CLASS_MAPPINGS]
    .filter(([, entry]) => entry.positions.includes(position))
    .map(([identity]) => identity);
}

function isMappedCuisClassAt(identity, position) {
  const entry = CUIS_NATIVE_CLASS_MAPPINGS.get(identity);
  return entry !== undefined && entry.positions.includes(position);
}

// Resolution needs the kernel, so it happens in the import phase; the plan phase asks only whether
// an identity is mapped at the position it appears in. The kernel owns the ref — this never
// creates, rewrites or names a class.
function resolveMappedCuisClass(identity, kernel) {
  const entry = CUIS_NATIVE_CLASS_MAPPINGS.get(identity);
  return entry === undefined ? null : kernel[entry.slot];
}

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
// ONE Cuis dialect idiom, translated at the boundary that already owns dialect translation (the
// method header and the implicit-receiver return rule are translated here too). It is NOT a
// `String` mapping and NOT a claim that `String` is `Text`.
//
// The idiom is the unary send `String new`, and the claim is only about the role that expression
// plays. Measured against the pinned Cuis VM and image and recorded on bead lagrange-images-nv1.5:
//
//   seedSize=0, seedPrint=''                  `String new` is an EMPTY textual seed
//   seedSizeAfterWrite=0, seedAfterWrite=''   writing through the stream does NOT mutate it: the
//                                             seed is empty, so the first write grows the stream
//                                             onto a NEW collection and the original is discarded
//   contentsIdenticalToSeed=false             the answer is not the seed either
//   thatCanBeModifiedIdentical=true           the only message `on:` sends it answers with itself,
//                                             so no identity is established and nothing is copied
//   unicodeSeedContentsClass=UnicodeString    swapping the seed for an empty UnicodeString changes
//   unicodeSeedContents='3'                   the result's SPECIES and not its textual VALUE
//
// So in this idiom the seed contributes no content, no behavior and no observable identity — only
// the species of the eventual result. The smallest truthful native counterpart is therefore an
// empty native Text value, and the substitution is exact for the covered expression, because the
// milestone's own acceptance oracle already treats a Cuis String result as a native Text value.
//
// DELIBERATELY NARROW, and each of these is a separate unproven question that stays refused:
//   `String new: 16`   a SIZED buffer. A different expression (keyword `new:`), not covered by the
//                      oracle above, and left to fail as an unbound name.
//   `String` anywhere else — as a receiver of any other message, as an argument, as a superclass,
//                      as a method target — is untouched and remains `unbound Symmetric Smalltalk
//                      name: String`. Nothing publishes a `String` global.
//   any other class name is untouched. This table has exactly one entry and no name fallback.
//
// The match is on the TOKEN stream, not on text, so `'String new'` inside a string literal and
// `"String new"` inside a comment are not rewritten. An idiom is also about a GLOBAL name that the
// package does NOT define, so it does not fire when the name is bound or declared: a parameter, a
// temporary or a block parameter named `String`, or a class named `String` declared by the
// manifest itself, all mean their own thing and need no translation. A cascade is excluded too,
// because its later messages go to the receiver rather than to what `new` answered.
//
// HONEST ASYMMETRY with the class-mapping table above, which is keyed by COMPLETE semantic
// identity precisely so that a class merely SPELLED `Integer` elsewhere is not this image's
// Integer. This table cannot be keyed that way: a name inside a method body carries no package
// attribution — the export records the source text, not a resolved binding for each name in it —
// so the key is unavoidably the source token. What replaces identity keying is the narrowness of
// the claim (one expression, not a class), the exclusions above (the package's own bindings and
// declarations win), and the requirement that each entry be justified by a recorded measurement
// that the expression's object contributes nothing observable to the covered path.
//
// HOW THE REST OF THE PATH REALISES THIS, since the substitution's justification depends on it:
// the seed's contribution is the result's REPRESENTATION, and the native stream owner is what
// supplies it. `WriteStream >> contents` builds its answer preserving the backing's class, so a
// text seed yields a text result. It does NOT go through `species` — measurement showed upstream's
// own `contents` is a class-preserving copy that never sends it, and that a native text Value is
// not allocatable — so nothing here depends on a Text ever answering `species`.
const CUIS_DIALECT_IDIOMS = Object.freeze([Object.freeze({
  tokens: Object.freeze([
    Object.freeze({type: 'identifier', value: 'String'}),
    Object.freeze({type: 'identifier', value: 'new'}),
  ]),
  native: "''",
})]);

// A dialect idiom is about a GLOBAL name. If the method binds that name itself — as a parameter,
// a temporary or a block parameter — then the source means something else entirely and needs no
// translation at all, so the idiom must not fire. This scan deliberately OVER-detects: `|` is also
// an ordinary binary selector, so an expression like `a | String | b` marks `String` bound and the
// adaptation is skipped. Erring that way is safe — a skipped adaptation leaves an unbound name and
// a visible refusal, while a missed binding would silently rewrite a legitimate variable.
function boundNames(tokens, bodyTokenIndex, parameters) {
  const bound = new Set(parameters);
  let inTemporaries = false;
  for (let at = bodyTokenIndex; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token.type === '|') {
      inTemporaries = !inTemporaries;
      continue;
    }
    if (token.type !== 'identifier') continue;
    // `| a b |` temporaries, `[ :each | ... ]` block parameters, and assignment targets — under
    // EITHER assignment spelling the dialect token stream can carry, through the tokenizer owner's
    // one shared predicate, so a name bound by the legacy arrow suppresses the idiom exactly as a
    // name bound by `:=` does.
    if (inTemporaries || tokens[at - 1]?.type === ':' || isAssignmentToken(tokens[at + 1])) {
      bound.add(token.value);
    }
  }
  return bound;
}

function matchesIdiom(tokens, at, pattern) {
  if (!pattern.every((expected, offset) => {
    const token = tokens[at + offset];
    return token !== undefined && token.type === expected.type && token.value === expected.value;
  })) return false;
  // A cascade continues to the RECEIVER of the last message, so in `String new; yourself` the
  // later messages go to the class, not to what `new` answered. Substituting a literal there would
  // silently change which object the rest of the cascade talks to, so the idiom does not fire.
  return tokens[at + pattern.length]?.type !== ';';
}

// ONE immutable replacement plan, collected against the SAME original token stream and applied
// right-to-left in a single pass. Two translation kinds share the plan:
//
//   * the measured legacy assignment arrow — the tokenizer's distinct `legacyAssign` token,
//     translated to canonical native `:=`. This is dialect SYNTAX, not a name, so none of the
//     idiom exclusions apply: every arrow token in the body translates. The adapter translates the
//     token and NOTHING more — whether the assignment is then legal (a bindable target, a
//     resolvable right-hand side, an ordinary refusal such as an unbound name) is decided by the
//     ordinary native parser and compiler after translation, never here. In particular a masked
//     name such as `driver _ SAXDriver on: aStream` becomes `driver := SAXDriver on: aStream` and
//     then undergoes ordinary native name resolution, which is the refusal the un-translated
//     arrow hid (bead lagrange-images-xxm.3).
//   * the closed dialect-idiom table above (`String new`), with its bound/declared exclusions.
//
// Collecting both against the same token stream and splicing in start-descending order is what
// makes offset drift impossible by construction: no splice is ever applied at offsets an earlier
// splice invalidated. The two kinds cannot overlap (an arrow token is never part of an idiom
// match), so one pass over the tokens suffices.
function adaptDialect(bodySource, tokens, bodyTokenIndex, bodyStart, parameters, declaredNames) {
  const bound = boundNames(tokens, bodyTokenIndex, parameters);
  const replacements = [];
  for (let at = bodyTokenIndex; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token.type === 'legacyAssign') {
      replacements.push({start: token.start - bodyStart, end: token.end - bodyStart, native: ':='});
      continue;
    }
    for (const idiom of CUIS_DIALECT_IDIOMS) {
      if (!matchesIdiom(tokens, at, idiom.tokens)) continue;
      // The method binds the name itself, or the package declares a class of that name, so the
      // source means its own thing and this is not the dialect idiom at all.
      if (bound.has(token.value) || declaredNames.has(token.value)) continue;
      const last = tokens[at + idiom.tokens.length - 1];
      replacements.push({start: token.start - bodyStart, end: last.end - bodyStart, native: idiom.native});
      break;
    }
  }
  let adapted = bodySource;
  for (const {start, end, native} of [...replacements].sort((a, b) => b.start - a.start)) {
    adapted = `${adapted.slice(0, start)}${native}${adapted.slice(end)}`;
  }
  return adapted;
}

function nativeMethodSource({identity, selector, source, declaredNames}) {
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
  const bodyStart = tokens[index - 1].end;
  const body = adaptDialect(source.slice(bodyStart), tokens, index, bodyStart, parameters, declaredNames).trim();
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
  // A scope is a positive statement about what this import covers, and the covering unit is a
  // class. Note that this is now a deliberate constraint rather than a consequence: since a
  // mapped method target needs no class-scope entry, a methods-only scope WOULD describe a real
  // import (an extension on an existing native class). No consumer has asked for one, so it stays
  // refused rather than silently proven by the classes-plus-methods path.
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
    // A mapped identity ALREADY denotes an existing native class. If a manifest also declared it,
    // the same semantic identity would mean the mapped kernel class in one position and a freshly
    // constructed class in another, and the table would no longer be the single answer to "what
    // native class is this identity". One authority per identity: refused, not silently preferred.
    if (isMappedCuisClass(identity)) {
      fail(
        `class ${identity} is already mapped to an existing native class; `
        + 'a manifest may not also declare it',
        identity,
      );
    }
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
    if (isMappedCuisClassAt(declaration.superclass, CUIS_NATIVE_MAPPING_POSITION.SUPERCLASS)) continue;
    const parent = byIdentity.get(declaration.superclass);
    if (!parent) {
      fail(
        `unsupported superclass semantic identity ${declaration.superclass}; `
        + `outside the imported graph only these map to a native superclass: `
        + `${mappedCuisIdentities(CUIS_NATIVE_MAPPING_POSITION.SUPERCLASS).join(', ')}`,
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
    if (isMappedCuisClassAt(classIdentity, CUIS_NATIVE_MAPPING_POSITION.METHOD_TARGET)) {
      // An extension method on a class the package does not define is ordinary Smalltalk. The
      // target is an existing native class, so it needs no manifest declaration and no scope
      // entry: the covered METHOD is what this import requested. The native MethodDictionary
      // owner installs it exactly as it does for an imported class.
      if (item.side === 'class') {
        fail(
          `class-side method ${identity} targets mapped native class ${classIdentity}; `
          + 'only instance-side extension of a mapped native class is proven',
          identity,
        );
      }
    } else if (!byIdentity.has(classIdentity)) {
      fail(`method target ${classIdentity} is outside the imported native class graph`, identity);
    } else if (requested && !requested.classes.has(classIdentity)) {
      fail(`method target ${classIdentity} is outside the requested import scope`, identity);
    }
    methods.push(Object.freeze({
      identity,
      classIdentity,
      side: item.side,
      selector,
      source: nativeMethodSource({identity, selector, source, declaredNames: nativeNames}),
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

  // The compatibility facts, resolved through the one seam. Each answers an EXISTING native class
  // ref owned by the kernel; none is created, rewritten or renamed here.
  const resolved = new Map();
  for (const identity of CUIS_NATIVE_CLASS_MAPPINGS.keys()) {
    const classRef = resolveMappedCuisClass(identity, kernel);
    if (!classRef) fail(`image ${imageId} has no native class for ${identity}`, identity);
    resolved.set(identity, Object.freeze({classRef}));
  }
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

  // Cuis class names live in its image-wide SystemDictionary. When the native image has installed
  // the corresponding namespace protocol, publish every scoped declaration through that existing
  // owner before compiling any method: source order must not decide whether one package class can
  // name another. A kernel-only image can still admit unnameable class structures (the M1 seam),
  // just as it could before this step; without a namespace it has no native name-resolution
  // contract for the adapter to target. Collision identity, replay and rebind preservation remain
  // wholly owned by publishSmalltalkClassGlobals/publishGlobal (ADR 0057), never duplicated here.
  const globalNamespace = await findSmalltalkGlobalNamespace({images, imageId});
  if (globalNamespace && plan.classes.length > 0) {
    await publishSmalltalkClassGlobals({
      images,
      imageId,
      names: plan.classes.map(({name}) => name),
    });
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
  CUIS_NATIVE_INTEGER_IDENTITY,
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  CuisNativeImportError,
  importCuisNativePackage,
};
