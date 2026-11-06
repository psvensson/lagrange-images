import {textValue} from '../value/index.js';
import {ensureClassFromDeclaration} from './smalltalk-class-builder.js';
import {ensureClassVariableBindings} from './smalltalk-class-variables.js';
import {
  GLOBAL_BINDING_VALUE_SLOT,
  NAMESPACE_OBJECT_ID,
  findSmalltalkGlobalNamespace,
  publishSmalltalkClassGlobals,
  reexportGlobals,
  resolveGlobal,
} from './smalltalk-globals.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {reconcileMethodsFromSource} from './smalltalk-instance-variables.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';
import {
  formatSymmetricSmalltalkMethodBlock,
  parseSymmetricSmalltalkDialect,
} from './symmetric-smalltalk-parser.js';
import {tokenizeSymmetricSmalltalk} from './symmetric-smalltalk-tokenizer.js';

// ADR 0085 M1/M2: this adapter owns translation only. The canonical representation remains owned
// by the OpenSmalltalk/Cuis toolchain provider; native builders/compilers remain the sole owners of
// Class, Metaclass, Shape, slot and method identity and behavior.
const CUIS_SEMANTIC_EXPORT_V2 = 'smalltalk/cuis-semantic-export-v2';

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
//   cuis-class/Cuis-Base/Array2D  `superclass` only. Required by the frozen M5.2 measurement
//                                 (bead lagrange-images-nfv1.1: `LifeArray < Array2D`; the
//                                 witness refused exactly this identity before the entry
//                                 existed). The native Array2D owner is the measured Cuis
//                                 grid protocol the unchanged Life code reaches. Resolved
//                                 through the image's native global namespace (the standard
//                                 image publishes the class as `Array2D`), not a kernel slot:
//                                 it is an ordinary library class, not an immediate-value
//                                 dispatch owner. NOT a method target: the package defines no
//                                 extension selector on Array2D, and no consumer declared one.
//   cuis-class/Cuis-Base/TextModel `superclass` only. Same frozen measurement
//                                 (`LifeModel < TextModel`; `TextModel < ActiveModel` in Cuis
//                                 is flattened into the native base, whose measured surface —
//                                 silent `triggerEvent:` with zero subscribers — is what the
//                                 unchanged `nextState` exercises). Also namespace-resolved
//                                 (`TextModel`), also refused as a method target.
//
// A Map, not an object literal, so a hostile identity such as `__proto__` cannot resolve.
const CUIS_NATIVE_MAPPING_POSITION = Object.freeze({SUPERCLASS: 'superclass', METHOD_TARGET: 'method-target'});
const CUIS_NATIVE_ROOT_OBJECT_IDENTITY = 'cuis-class/Cuis-Base/Object';
const CUIS_NATIVE_INTEGER_IDENTITY = 'cuis-class/Cuis-Base/Integer';
const CUIS_NATIVE_ARRAY2D_IDENTITY = 'cuis-class/Cuis-Base/Array2D';
const CUIS_NATIVE_TEXTMODEL_IDENTITY = 'cuis-class/Cuis-Base/TextModel';
const CUIS_NATIVE_CLASS_MAPPINGS = new Map([
  [CUIS_NATIVE_ROOT_OBJECT_IDENTITY, Object.freeze({
    slot: 'objectClass', className: 'Object', positions: Object.freeze([CUIS_NATIVE_MAPPING_POSITION.SUPERCLASS]),
  })],
  [CUIS_NATIVE_INTEGER_IDENTITY, Object.freeze({
    slot: 'integerClass', className: 'Integer', positions: Object.freeze([CUIS_NATIVE_MAPPING_POSITION.METHOD_TARGET]),
  })],
  // Ordinary library classes resolve through the image's own global namespace — the namespace
  // owner's replay/rebind semantics, never a second lookup implementation and never a name
  // guess: the NAME is part of this sealed entry, matched against the namespace as-is, and a
  // missing native class fails the import explicitly.
  [CUIS_NATIVE_ARRAY2D_IDENTITY, Object.freeze({
    globalName: 'Array2D', className: 'Array2D', positions: Object.freeze([CUIS_NATIVE_MAPPING_POSITION.SUPERCLASS]),
  })],
  [CUIS_NATIVE_TEXTMODEL_IDENTITY, Object.freeze({
    globalName: 'TextModel', className: 'TextModel', positions: Object.freeze([CUIS_NATIVE_MAPPING_POSITION.SUPERCLASS]),
  })],
]);

// The native class NAME a sealed entry denotes, answered purely (no graph read). The authorized
// import seam names its authority demands from it BEFORE any read, through the class builder's
// deterministic `smalltalk/class/<name>` identity; resolution of the actual class ref stays lazy and
// graph-backed below.
function mappedCuisClassName(identity) {
  return CUIS_NATIVE_CLASS_MAPPINGS.get(identity)?.className ?? null;
}

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
// an identity is mapped at the position it appears in. Kernel-slot entries answer the kernel's own
// class ref; namespace entries resolve through the durable global namespace (the same owner the
// import publishes application classes through). The kernel/namespace own the ref — this never
// creates, rewrites or names a class.
async function resolveMappedCuisClass(identity, kernel, {images, imageId}) {
  const entry = CUIS_NATIVE_CLASS_MAPPINGS.get(identity);
  if (entry === undefined) return null;
  if (entry.slot) return kernel[entry.slot];
  return await namespaceMappedClass(images, imageId, entry.globalName);
}

// One namespace read per required mapping, through the namespace owner. The binding's value is
// the native Class object; a missing name refuses the import exactly like a missing kernel slot.
async function namespaceMappedClass(images, imageId, name) {
  const binding = await resolveGlobal({images, imageId, name});
  if (!binding) return null;
  const record = await images.getObject(imageId, binding.objectId);
  return record?.slots?.[GLOBAL_BINDING_VALUE_SLOT] ?? null;
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
// Narrow Cuis dialect/base-image idioms, translated at the boundary that already owns dialect
// translation (the method header and the implicit-receiver return rule are translated here too).
// These are NOT class mappings and make no claim that `String` or `UnicodeString` is `Text`.
//
// The first idiom is the unary send `String new`, and the claim is only about the role that
// expression plays. Measured against the pinned Cuis VM and image and recorded on bead
// lagrange-images-nv1.5:
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
//   every other String use is untouched. The closed table has no name fallback.
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
// The second idiom is `UnicodeString writeStream`, forced by the real pinned YAXO
// `XMLTokenizer>>initialize` and measured by that vertical's real-Cuis oracle (bead
// lagrange-images-xxm.9):
//
//   UnicodeString superclass/species             CharacterSequence / UnicodeString
//   UnicodeString writeStream class              Utf8EncodedWriteStream (a WriteStream subclass)
//   empty/written/reset contents class            UnicodeString
//   empty/written contents are fresh              true
//   nextPutAll: answers the stream                 true
//   U+03BB survives in contents                   code point 955
//
// YAXO uses the two buffers only through stream protocol (`reset`, `nextPut:`, `contents`) and
// never observes their physical class. This native image has one textual representation, `Text`,
// and already has one ordinary native text-backed stream construction. The exact native semantic
// counterpart for CONSTRUCTING that buffer is therefore `(WriteStream on: '')`. Parentheses are
// part of the translation so a following unary send remains on the resulting stream rather than
// becoming part of the keyword argument. This does not claim that the two concrete Cuis stream
// classes are identical, and it does not pre-implement the later
// `reset`/`nextPut:` protocol: the executable vertical must force that breadth in its own order.
//
// DELIBERATELY NARROW in the same way as `String new`: `UnicodeString` as a value, any other send,
// a cascade, a locally bound name or a manifest-declared class remains untouched. No
// `UnicodeString` global is published, and direct native source still refuses the name.
//
// HOW THE REST OF THE PATH REALISES THESE, since the substitutions' justification depends on it:
// the seed's contribution is the result's REPRESENTATION, and the native stream owner is what
// supplies it. `WriteStream >> contents` builds its answer preserving the backing's class, so a
// text seed yields a text result. It does NOT go through `species` — measurement showed upstream's
// own `contents` is a class-preserving copy that never sends it, and that a native text Value is
// not allocatable — so nothing here depends on a Text ever answering `species`.
//
// The third idiom is the distinct `UnicodeString streamContents: [ ... ]`, forced by unchanged
// pinned YAXO `XMLTokenizer>>nextWhitespace` and measured independently (bead
// lagrange-images-xxm.11). In the pinned image UnicodeString class itself creates a
// Utf8EncodedWriteStream, evaluates the block once, ignores its answer, and returns stream
// contents. Empty, ASCII, U+03BB and supplementary U+1F600 writes all answer UnicodeString;
// multiple writes preserve order; an Error escapes unchanged; and the result is equal and has the
// same class as the corresponding `UnicodeString writeStream ... contents` result.
//
// The native image's honest counterpart is ordinary `Text class >> streamContents:` protocol,
// installed by the native Text/WriteStream owner and answering the one canonical native Text
// representation. The adapter therefore changes ONLY the foreign receiver name and selector to
// `Text streamContents:`. It does not expand the call, evaluate the block, construct the stream or
// take contents. Those semantics stay native and direct native source can call them with no Cuis
// material present. This remains no claim that UnicodeString is generally Text and publishes no
// UnicodeString global.
const CUIS_DIALECT_IDIOMS = Object.freeze([
  Object.freeze({
    receiverName: 'String',
    selector: 'new',
    arity: 0,
    lower() {
      return Object.freeze({kind: 'string', value: ''});
    },
  }),
  Object.freeze({
    receiverName: 'UnicodeString',
    selector: 'writeStream',
    arity: 0,
    lower() {
      return Object.freeze({
        kind: 'send',
        receiver: Object.freeze({kind: 'name', name: 'WriteStream'}),
        selector: 'on:',
        arguments: Object.freeze([Object.freeze({kind: 'string', value: ''})]),
      });
    },
  }),
  Object.freeze({
    receiverName: 'UnicodeString',
    selector: 'streamContents:',
    arity: 1,
    exactBlockArgument: true,
    lower([blockArg]) {
      return Object.freeze({
        kind: 'send',
        receiver: Object.freeze({kind: 'name', name: 'Text'}),
        selector: 'streamContents:',
        arguments: Object.freeze([blockArg]),
      });
    },
  }),
]);

// A dialect idiom is about a GLOBAL name. If the method binds that name itself — as a parameter,
// a temporary, a block parameter or an assignment target — then the source means something else
// entirely and needs no translation at all, so the idiom must not fire. Walking the parsed AST
// directly (ADR 0097) collects every declared temporary, block parameter and assignment target
// structurally without token-level bar heuristics.
function collectAstBoundNames(ast, parameters) {
  const bound = new Set(parameters);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    switch (node.kind) {
      case 'sequence':
        for (const temp of node.temporaries) bound.add(temp);
        for (const statement of node.statements) visit(statement);
        break;
      case 'block':
        for (const param of node.parameters) bound.add(param);
        visit(node.body);
        break;
      case 'assign':
        bound.add(node.name);
        visit(node.value);
        break;
      case 'return':
        visit(node.value);
        break;
      case 'send':
        visit(node.receiver);
        for (const arg of node.arguments) visit(arg);
        break;
      case 'cascade':
        visit(node.receiver);
        for (const msg of node.messages) {
          for (const arg of msg.arguments) visit(arg);
        }
        break;
      default:
        break;
    }
  };
  visit(ast);
  return bound;
}

// Structured AST-to-AST lowering of the closed three-entry `CUIS_DIALECT_IDIOMS` table (ADR 0097).
// Because matching operates on parsed `send` nodes:
//   * a cascade (`String new; yourself`) is a `cascade` node, never a `send`, so it is untouched;
//   * a unary chain (`self UnicodeString writeStream`) has a `send` receiver rather than `{kind: 'name'}`;
//   * `UnicodeString streamContents: [ ... ] yourself` parses `yourself` onto the block argument,
//     making `node.arguments[0]` a `send` node rather than `{kind: 'block'}`.
function lowerCuisDialectAst(node, context) {
  if (!node || typeof node !== 'object') return node;
  switch (node.kind) {
    case 'sequence':
      return Object.freeze({
        kind: 'sequence',
        temporaries: node.temporaries,
        statements: Object.freeze(node.statements.map((stmt) => lowerCuisDialectAst(stmt, context))),
      });
    case 'block':
      return Object.freeze({
        ...node,
        body: lowerCuisDialectAst(node.body, context),
      });
    case 'assign':
      return Object.freeze({
        kind: 'assign',
        name: node.name,
        value: lowerCuisDialectAst(node.value, context),
      });
    case 'return':
      return Object.freeze({
        ...node,
        value: lowerCuisDialectAst(node.value, context),
      });
    case 'cascade':
      return Object.freeze({
        kind: 'cascade',
        receiver: lowerCuisDialectAst(node.receiver, context),
        messages: Object.freeze(node.messages.map((msg) => Object.freeze({
          selector: msg.selector,
          arguments: Object.freeze(msg.arguments.map((arg) => lowerCuisDialectAst(arg, context))),
        }))),
      });
    case 'send': {
      const loweredArgs = Object.freeze(node.arguments.map((arg) => lowerCuisDialectAst(arg, context)));
      if (node.receiver.kind === 'name') {
        const receiverName = node.receiver.name;
        if (!context.bound.has(receiverName) && !context.declaredNames.has(receiverName)) {
          for (const idiom of CUIS_DIALECT_IDIOMS) {
            if (idiom.receiverName !== receiverName) continue;
            if (idiom.selector !== node.selector) continue;
            if (idiom.arity !== node.arguments.length) continue;
            if (idiom.exactBlockArgument && node.arguments[0]?.kind !== 'block') continue;
            return idiom.lower(loweredArgs);
          }
        }
      }
      return Object.freeze({
        kind: 'send',
        receiver: lowerCuisDialectAst(node.receiver, context),
        selector: node.selector,
        arguments: loweredArgs,
      });
    }
    default:
      return node;
  }
}

function parseCuisMethodHeader({identity, selector, source}) {
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
  return Object.freeze({
    parameters: Object.freeze(parameters),
    bodySource: source.slice(bodyStart),
  });
}

function lowerCuisMethodToNativeSource({parameters, bodySource, declaredNames}) {
  const dialectAst = parseSymmetricSmalltalkDialect(bodySource, {allowEmpty: true});
  const bound = collectAstBoundNames(dialectAst, parameters);
  const loweredAst = lowerCuisDialectAst(dialectAst, {bound, declaredNames});
  return formatSymmetricSmalltalkMethodBlock(parameters, loweredAst);
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

const CLASS_DEFINITION_KEYWORD = new Set([
  'subclass:',
  'variableSubclass:',
  'variableByteSubclass:',
  'variableWordSubclass:',
]);

function splitCuisChunks(pckSource) {
  const chunks = [];
  let index = 0;
  let inMethodSection = false;
  let skipNextChunk = false;

  while (index < pckSource.length) {
    while (index < pckSource.length && /\s/.test(pckSource[index])) {
      index += 1;
    }
    if (index >= pckSource.length) break;

    let isDirective = false;
    if (!inMethodSection && pckSource[index] === '!') {
      isDirective = true;
      index += 1;
    } else if (inMethodSection && pckSource[index] === '!') {
      inMethodSection = false;
      index += 1;
      continue;
    }

    let current = '';
    let inString = false;
    while (index < pckSource.length) {
      const ch = pckSource[index];
      if (ch === '\'') {
        if (inString && pckSource[index + 1] === '\'') {
          current += '\'\'';
          index += 2;
          continue;
        }
        inString = !inString;
        current += ch;
        index += 1;
        continue;
      }
      if (!inString && ch === '!') {
        if (pckSource[index + 1] === '!') {
          current += '!';
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      current += ch;
      index += 1;
    }

    const trimmed = current.trim();
    if (skipNextChunk) {
      skipNextChunk = false;
      continue;
    }
    if (isDirective) {
      if (/^[A-Za-z_][A-Za-z0-9_]*(\s+class)?\s+methodsFor:/m.test(trimmed)) {
        inMethodSection = true;
      } else if (/^commentStamp:/m.test(trimmed)) {
        skipNextChunk = true;
      }
      continue;
    }
    if (!inMethodSection && trimmed.length > 0) {
      chunks.push(trimmed);
    }
  }
  return chunks;
}

function canonicalInitializerIdentity(packageName, className, selector = 'initialize') {
  return `cuis-initializer/${packageName}/${className}/${selector}`;
}

// Parse top-level chunks of a Cuis .pck.st source string and extract explicit post-load
// `<ClassName> initialize!` chunks into canonical initializer descriptors, while refusing
// arbitrary top-level DoIt expressions (ADR 0096).
function extractCuisPackagePostLoadInitializers(packageName, pckSource) {
  const pkg = text(packageName, 'packageName');
  const source = text(pckSource, 'pckSource');
  const initializers = [];
  const seen = new Set();
  for (const trimmed of splitCuisChunks(source)) {
    let tokens;
    try {
      tokens = tokenizeSymmetricSmalltalk(trimmed);
    } catch (error) {
      fail(`Cuis package ${pkg} contains unparseable top-level chunk: ${error.message}`);
    }
    const bodyTokens = tokens.filter((token) => token.type !== 'eof');
    if (bodyTokens.length === 0) continue;
    if (bodyTokens.length === 1 && bodyTokens[0].type === 'string') continue;
    if (bodyTokens[0].type === 'identifier' && bodyTokens[1]?.type === 'keyword' && CLASS_DEFINITION_KEYWORD.has(bodyTokens[1].value)) {
      continue;
    }
    if (
      bodyTokens.length === 2
      && bodyTokens[0].type === 'identifier'
      && bodyTokens[1].type === 'identifier'
      && bodyTokens[1].value === 'initialize'
    ) {
      const className = bodyTokens[0].value;
      const classIdentity = canonicalClassIdentity(pkg, className);
      if (!seen.has(classIdentity)) {
        seen.add(classIdentity);
        initializers.push(Object.freeze({
          identity: canonicalInitializerIdentity(pkg, className, 'initialize'),
          package: pkg,
          class: classIdentity,
          selector: 'initialize',
        }));
      }
      continue;
    }
    fail(`unsupported Cuis post-load DoIt chunk in ${pkg}: ${trimmed}`);
  }
  return Object.freeze(initializers);
}

function normalizePostLoadInitializerEntry(entry, byIdentity, byClassName) {
  if (typeof entry === 'string') {
    const trimmed = text(entry, 'postLoadInitializers entry').trim();
    if (trimmed.startsWith('cuis-class/')) {
      const declaration = byIdentity.get(trimmed);
      if (!declaration) {
        fail(`postLoadInitializers names class ${trimmed}, which this manifest does not declare`, trimmed);
      }
      return Object.freeze({
        identity: canonicalInitializerIdentity(declaration.package, declaration.name, 'initialize'),
        package: declaration.package,
        class: declaration.identity,
        selector: 'initialize',
      });
    }
    let tokens;
    try {
      tokens = tokenizeSymmetricSmalltalk(trimmed);
    } catch (error) {
      fail(`postLoadInitializers entry ${trimmed} is not a valid class initializer: ${error.message}`);
    }
    const bodyTokens = tokens.filter((token) => token.type !== 'eof');
    if (
      bodyTokens.length !== 2
      || bodyTokens[0].type !== 'identifier'
      || bodyTokens[1].type !== 'identifier'
      || bodyTokens[1].value !== 'initialize'
    ) {
      fail(`postLoadInitializers only supports <ClassName> initialize, got: ${trimmed}`);
    }
    const declaration = byClassName.get(bodyTokens[0].value);
    if (!declaration) {
      fail(`postLoadInitializers names undeclared class ${bodyTokens[0].value}`);
    }
    return Object.freeze({
      identity: canonicalInitializerIdentity(declaration.package, declaration.name, 'initialize'),
      package: declaration.package,
      class: declaration.identity,
      selector: 'initialize',
    });
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('postLoadInitializers entry must be an object or string');
  }
  const keys = Object.keys(entry).sort().join(',');
  if (keys !== 'class,selector' && keys !== 'class,identity,package,selector') {
    fail('postLoadInitializers entry must have fields {class, selector} or {identity, package, class, selector}');
  }
  const classIdentity = text(entry.class, 'postLoadInitializers entry class');
  const selector = text(entry.selector, 'postLoadInitializers entry selector');
  if (selector !== 'initialize') {
    fail(`postLoadInitializers selector must be initialize, got ${selector}`, classIdentity);
  }
  const declaration = byIdentity.get(classIdentity);
  if (!declaration) {
    fail(`postLoadInitializers names class ${classIdentity}, which this manifest does not declare`, classIdentity);
  }
  const expectedIdentity = canonicalInitializerIdentity(declaration.package, declaration.name, 'initialize');
  if (entry.package !== undefined && text(entry.package, 'postLoadInitializers entry package') !== declaration.package) {
    fail(`postLoadInitializers entry package ${entry.package} does not match ${declaration.package}`, classIdentity);
  }
  if (entry.identity !== undefined && text(entry.identity, 'postLoadInitializers entry identity') !== expectedIdentity) {
    fail(`postLoadInitializers entry identity ${entry.identity} does not match ${expectedIdentity}`, classIdentity);
  }
  return Object.freeze({
    identity: expectedIdentity,
    package: declaration.package,
    class: declaration.identity,
    selector: 'initialize',
  });
}

function orderPackagesByRequires(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const rank = new Map();
  const visiting = new Set();
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) fail(`package dependency cycle reaches ${name}`);
    const pkg = byName.get(name);
    if (!pkg) return;
    visiting.add(name);
    for (const req of pkg.requires) {
      if (byName.has(req)) visit(req);
    }
    visiting.delete(name);
    visited.add(name);
    rank.set(name, rank.size);
  };
  for (const pkg of packages) visit(pkg.name);
  return rank;
}

// Validate every adapter-owned schema, identity and dependency-graph rule before the first native
// owner call. Native declaration semantics (for example inherited-name legality) stay exclusively
// in the class builder; this adapter does not duplicate them to promise a batch transaction it does
// not own. An owner rejection may therefore leave already-valid immutable ancestors, and an exact
// retry converges through their ordinary admission rules.
function importPlan(manifest, scope, {postLoadInitializers: optionInitializers = null} = {}) {
  const requested = normalizeScope(scope);
  const manifestRecord = record(manifest, 'manifest');
  const expectedManifestKeys = Object.hasOwn(manifestRecord, 'postLoadInitializers')
    ? ['format', 'packages', 'classes', 'methods', 'postLoadInitializers']
    : ['format', 'packages', 'classes', 'methods'];
  exactKeys(manifestRecord, expectedManifestKeys, 'manifest');
  if (optionInitializers !== null && optionInitializers !== undefined && Object.hasOwn(manifestRecord, 'postLoadInitializers')) {
    fail('postLoadInitializers may be supplied on manifest or options, not both');
  }
  if (manifest.format !== CUIS_SEMANTIC_EXPORT_V2) {
    fail(`manifest format must be ${CUIS_SEMANTIC_EXPORT_V2}, got ${manifest.format ?? 'missing'}`);
  }
  if (!Array.isArray(manifest.packages)) fail('manifest packages must be an array');
  if (!Array.isArray(manifest.classes)) fail('manifest classes must be an array');
  if (!Array.isArray(manifest.methods)) fail('manifest methods must be an array');

  const packageNames = new Set();
  const normalizedPackages = [];
  for (const item of manifest.packages) {
    exactKeys(item, ['name', 'requires'], 'package declaration');
    const name = text(item.name, 'package name');
    if (packageNames.has(name)) fail(`package ${name} appears more than once`);
    packageNames.add(name);
    const requires = textArray(item.requires, `package ${name} requirements`);
    normalizedPackages.push(Object.freeze({name, requires}));
  }
  const packageRank = orderPackagesByRequires(normalizedPackages);

  const classes = [];
  const byIdentity = new Map();
  const byClassName = new Map();
  const nativeNames = new Set();
  for (const item of manifest.classes) {
    exactKeys(
      item,
      ['identity', 'package', 'name', 'superclassName', 'superclass', 'instanceVariables', 'classVariables'],
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
    // Declared class-variable NAMES are definition facts the canonical export now carries; their
    // values do not cross the boundary and are never normalized here.
    const classVariables = textArray(item.classVariables, `class ${identity} classVariables`);
    if (new Set(classVariables).size !== classVariables.length) {
      fail(`class ${identity} declares duplicate class variable names`, identity);
    }
    const normalized = Object.freeze({identity, package: packageName, name, superclass, instanceVariables, classVariables});
    classes.push(normalized);
    byIdentity.set(identity, normalized);
    byClassName.set(name, normalized);
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
    const header = parseCuisMethodHeader({identity, selector, source});
    methods.push(Object.freeze({
      identity,
      classIdentity,
      side: item.side,
      selector,
      parameters: header.parameters,
      bodySource: header.bodySource,
      declaredNames: nativeNames,
    }));
  }
  if (requested) {
    for (const identity of requested.methods) {
      if (!methodIdentities.has(identity)) {
        fail(`import scope names method ${identity}, which this manifest does not declare`, identity);
      }
    }
  }

  const rawInitializers = optionInitializers ?? manifestRecord.postLoadInitializers ?? null;
  const postLoadInitializers = [];
  if (rawInitializers !== null && rawInitializers !== undefined) {
    if (!Array.isArray(rawInitializers)) fail('postLoadInitializers must be an array');
    const scopedSet = new Set(scopedClasses.map((declaration) => declaration.identity));
    const coveredClassInitSet = new Set(
      methods
        .filter((method) => method.side === 'class' && method.selector === 'initialize')
        .map((method) => method.classIdentity),
    );
    const seenInitializers = new Set();
    for (const entry of rawInitializers) {
      const normalized = normalizePostLoadInitializerEntry(entry, byIdentity, byClassName);
      const classIdentity = normalized.class;
      if (seenInitializers.has(classIdentity)) {
        fail(`postLoadInitializers must not contain duplicate class ${classIdentity}`, classIdentity);
      }
      seenInitializers.add(classIdentity);
      if (!scopedSet.has(classIdentity)) {
        fail(`postLoadInitializers target ${classIdentity} is outside the requested import scope`, classIdentity);
      }
      if (!coveredClassInitSet.has(classIdentity)) {
        fail(
          `postLoadInitializers target ${classIdentity} does not declare a covered class-side initialize method`,
          classIdentity,
        );
      }
      postLoadInitializers.push(normalized);
    }
    const orderedIndex = new Map(ordered.map((declaration, index) => [declaration.identity, index]));
    const isAncestor = (candidateAncestor, candidateDescendant) => {
      let current = byIdentity.get(candidateDescendant);
      while (current) {
        if (current.superclass === candidateAncestor) return true;
        current = byIdentity.get(current.superclass);
      }
      return false;
    };
    postLoadInitializers.sort((left, right) => {
      if (isAncestor(left.class, right.class)) return -1;
      if (isAncestor(right.class, left.class)) return 1;
      const pkgDiff = (packageRank.get(left.package) ?? 0) - (packageRank.get(right.package) ?? 0);
      if (pkgDiff !== 0) return pkgDiff;
      return (orderedIndex.get(left.class) ?? 0) - (orderedIndex.get(right.class) ?? 0);
    });
  }

  return {classes: scopedClasses, ordered, methods, postLoadInitializers: Object.freeze(postLoadInitializers)};
}

// Cancellation between declarations. The adapter checks the caller's `signal` before each class
// declaration, before namespace publication and before each class's method group — never inside
// an owner's write, so what has been admitted is complete and a retry converges through the owners'
// own admission rules (exact replay is write-free). `admitted` lists the canonical identities that
// landed before the check; nothing else about the import is retained.
class CuisNativeImportAbortedError extends Error {
  constructor({admitted, reason = null}) {
    super(`Cuis native import aborted after ${admitted.classes.length} class(es) and ${admitted.methods.length} method(s)`);
    this.name = 'CuisNativeImportAbortedError';
    this.admitted = Object.freeze({classes: Object.freeze([...admitted.classes]), methods: Object.freeze([...admitted.methods])});
    this.reason = reason;
  }
}

function assertProgressOptions(signal, onProgress) {
  if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
    fail('signal must be null or an AbortSignal-like object with a boolean aborted');
  }
  if (onProgress !== null && typeof onProgress !== 'function') fail('onProgress must be null or a function');
}

async function importCuisNativePackage({
  images,
  compilation,
  invocations = null,
  executor = null,
  imageId,
  manifest,
  scope = null,
  postLoadInitializers = null,
  targetNamespaceId = null,
  retainSource = false,
  signal = null,
  onProgress = null,
} = {}) {
  text(imageId, 'image id');
  if (!images || typeof images !== 'object') fail('images must be an image service');
  if (typeof retainSource !== 'boolean') fail('retainSource must be a boolean');
  if (targetNamespaceId !== null) text(targetNamespaceId, 'targetNamespaceId');
  assertProgressOptions(signal, onProgress);
  const plan = importPlan(manifest, scope, {postLoadInitializers});
  const admitted = {classes: [], methods: []};
  const checkpoint = (reason) => {
    if (signal?.aborted) throw new CuisNativeImportAbortedError({admitted, reason: signal.reason ?? reason ?? null});
  };
  const progress = (event) => { if (onProgress) onProgress(Object.freeze(event)); };
  const totals = Object.freeze({classes: plan.ordered.length, methods: plan.methods.length});
  if (plan.methods.length > 0 && (!compilation || typeof compilation.compileArtifact !== 'function')) {
    fail('compilation must be a compilation service when methods are present');
  }
  if (plan.postLoadInitializers.length > 0) {
    if (!invocations || typeof invocations.sendMessage !== 'function') {
      fail('invocations must be an invocation service when postLoadInitializers are present');
    }
    if (!executor || typeof executor.execute !== 'function') {
      fail('executor must be an execution service when postLoadInitializers are present');
    }
  }
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) fail(`image ${imageId} has no Smalltalk kernel`);

  // The compatibility facts, resolved through the one seam. Each answers an EXISTING native class
  // ref owned by the kernel or the native global namespace; none is created, rewritten or renamed
  // here. Resolution is LAZY by necessity, not preference: the M1 seam deliberately supports
  // kernel-only images where namespace-backed entries (Array2D, TextModel) could not resolve at
  // all, and those imports never reference those superclasses — so only the mapped identities
  // THIS plan references are resolved, and each must resolve for the import to proceed.
  const resolved = new Map();
  const requiredMappedIdentities = new Set();
  for (const declaration of plan.ordered) {
    if (isMappedCuisClass(declaration.superclass)) requiredMappedIdentities.add(declaration.superclass);
  }
  for (const method of plan.methods) {
    if (isMappedCuisClass(method.classIdentity)) requiredMappedIdentities.add(method.classIdentity);
  }
  for (const identity of requiredMappedIdentities) {
    const classRef = await resolveMappedCuisClass(identity, kernel, {images, imageId});
    if (!classRef) fail(`image ${imageId} has no native class for ${identity}`, identity);
    resolved.set(identity, Object.freeze({classRef}));
  }
  for (const declaration of plan.ordered) {
    checkpoint(`before class ${declaration.identity}`);
    progress({event: 'begin', phase: 'class', identity: declaration.identity, totals});
    const superclass = resolved.get(declaration.superclass);
    if (!superclass) fail(`superclass ${declaration.superclass} was not resolved`, declaration.identity);
    resolved.set(declaration.identity, await ensureClassFromDeclaration({
      images,
      imageId,
      name: declaration.name,
      superclassRef: superclass.classRef,
      instanceVariables: declaration.instanceVariables,
      classVariables: declaration.classVariables,
    }));
    // The declared NAMES became definition metadata at creation; the executable shared state is
    // the ClassVariableBinding object each name denotes, created here at its deterministic id so
    // the package's own class-side methods can write them. Values stay the image's nil until the
    // imported package code itself initializes them.
    if (declaration.classVariables.length > 0) {
      await ensureClassVariableBindings({images, imageId, className: declaration.name, variables: declaration.classVariables});
    }
    admitted.classes.push(declaration.identity);
    progress({event: 'admitted', phase: 'class', identity: declaration.identity, totals});
  }

  // Cuis class names live in its image-wide SystemDictionary. When the native image has installed
  // the corresponding namespace protocol, publish every scoped declaration through that existing
  // owner before compiling any method: source order must not decide whether one package class can
  // name another. A kernel-only image can still admit unnameable class structures (the M1 seam),
  // just as it could before this step; without a namespace it has no native name-resolution
  // contract for the adapter to target. Collision identity, replay and rebind preservation remain
  // wholly owned by publishSmalltalkClassGlobals/publishGlobal (ADR 0057), never duplicated here.
  checkpoint('before namespace publication');
  const globalNamespace = await findSmalltalkGlobalNamespace({images, imageId});
  if (globalNamespace && plan.classes.length > 0) {
    progress({event: 'begin', phase: 'globals', identity: null, totals});
    const classNames = plan.classes.map(({name}) => name);
    await publishSmalltalkClassGlobals({
      images,
      imageId,
      names: classNames,
    });
    if (targetNamespaceId !== null && targetNamespaceId !== NAMESPACE_OBJECT_ID) {
      await reexportGlobals({
        images,
        imageId,
        names: classNames,
        fromNamespaceId: NAMESPACE_OBJECT_ID,
        toNamespaceId: targetNamespaceId,
      });
    }
    progress({event: 'admitted', phase: 'globals', identity: null, totals});
  }

  const methodGroups = new Map();
  for (const method of plan.methods) {
    const target = resolved.get(method.classIdentity);
    const classRef = method.side === 'class' ? target.metaclassRef : target.classRef;
    const key = `${classRef.imageId}\u0000${classRef.objectId}`;
    const group = methodGroups.get(key) ?? {classRef, classIdentity: method.classIdentity, methods: [], identities: []};
    group.methods.push(method);
    group.identities.push(method.identity);
    methodGroups.set(key, group);
  }
  for (const {classRef, classIdentity, methods, identities} of methodGroups.values()) {
    // One class's methods are one reconciliation (one MethodDictionary publication), so the unit of
    // progress and of cancellation is the group: a group is admitted whole or not at all.
    checkpoint(`before the methods of ${classIdentity}`);
    progress({event: 'begin', phase: 'methods', identity: classIdentity, methods: Object.freeze([...identities]), totals});
    const loweredMethods = methods.map((method) => ({
      selector: method.selector,
      source: lowerCuisMethodToNativeSource(method),
    }));
    await reconcileMethodsFromSource({
      images,
      compilation,
      imageId,
      classRef,
      methods: loweredMethods,
      retainSource,
      ...(targetNamespaceId !== null ? {namespaceId: targetNamespaceId} : {}),
      lane: 'wasm',
    });
    admitted.methods.push(...identities);
    progress({event: 'admitted', phase: 'methods', identity: classIdentity, methods: Object.freeze([...identities]), totals});
  }

  for (const initializer of plan.postLoadInitializers) {
    checkpoint(`before post-load initializer ${initializer.identity}`);
    progress({event: 'begin', phase: 'initializer', identity: initializer.identity, totals});
    const target = resolved.get(initializer.class);
    const activation = await invocations.sendMessage({
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: target.classRef,
      message: textValue(initializer.selector),
      arguments: [],
    }, {dispatchImage: imageId});
    await executor.execute(activation);
    progress({event: 'admitted', phase: 'initializer', identity: initializer.identity, totals});
  }

  // Semantic identity is useful to the caller, but this is deliberately transient output: the
  // adapter creates no durable side table or alternate native representation.
  return Object.freeze({
    classes: Object.freeze(plan.classes.map((declaration) => Object.freeze({
      identity: declaration.identity,
      ...resolved.get(declaration.identity),
    }))),
    ...(plan.postLoadInitializers.length === 0
      ? {}
      : {initializers: plan.postLoadInitializers}),
  });
}

// The pure import plan (schema, canonical identities, scope, dependency topology), answered with no
// graph read, so the authorized import seam can name its authority demands from the caller's own
// manifest before anything is read. Same function the import itself runs first.
const planCuisNativeImport = importPlan;

export {
  CUIS_NATIVE_INTEGER_IDENTITY,
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  CuisNativeImportAbortedError,
  CuisNativeImportError,
  extractCuisPackagePostLoadInitializers,
  importCuisNativePackage,
  isMappedCuisClass,
  mappedCuisClassName,
  planCuisNativeImport,
};
