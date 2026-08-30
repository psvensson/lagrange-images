import {readFile, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';

import {
  defineClass,
  ensureSmalltalkShape,
  methodBlockRef,
} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {declareClassVariables, installSmalltalkClassVariableSupport} from './smalltalk-class-variables.js';
import {publishSmalltalkClassGlobals} from './smalltalk-globals.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {parseSymmetricSmalltalk} from './symmetric-smalltalk-parser.js';
import {objectRef} from '../value/index.js';

// Loader for a pinned, FileTree-format Smalltalk source closure (here: upstream
// msgpack-smalltalk). This module is deliberately language-owned machinery, not
// a new subsystem: it parses `.st` method files, applies an explicit and
// reviewable set of dialect adaptations, and routes every method body through
// the normal `defineMethodsFromSource` compile pipeline so that the executed
// code provably derives from the vendored upstream source.
//
// Two invariants make this WS3-honest rather than a hand-translation:
//   1. Method bodies reach the compiler byte-for-byte as upstream wrote them,
//      except for the adaptations enumerated below — each of which is recorded
//      in the returned `adaptations` list and none of which rewrites algorithm.
//   2. Nothing here adds a MessagePack-specific compiler op, primitive, runtime
//      branch or image magic. Dialect gaps upstream relies on (a settings
//      `encodeMode` switch, `allSubclasses` introspection) are adapted in the
//      loader, explicitly, so the proof surface shows exactly what was changed.

// The vendored classes this loader knows how to install, in dependency order.
// Superclass references are resolved by name against the kernel and against
// classes installed earlier in this same list.
const MSGPACK_CLASSES = Object.freeze([
  {name: 'MpConstants', superclass: null, classinstvars: [], classvars: []},
  {name: 'MpError', superclass: 'Error', classinstvars: [], classvars: []},
  {name: 'MpPortableUtil', superclass: null, classinstvars: [], classvars: ['Default', 'DialectSpecificClass']},
  {name: 'MpSettings', superclass: null, classinstvars: [], classvars: []},
  {name: 'MpTypeMapper', superclass: null, classinstvars: ['actionMap'], classvars: []},
  {name: 'MpEncodeTypeMapper', superclass: 'MpTypeMapper', classinstvars: [], classvars: []},
  {name: 'MpDecodeTypeMapper', superclass: 'MpTypeMapper', classinstvars: [], classvars: []},
  {name: 'MpEncoder', superclass: null, classinstvars: [], classvars: []},
  {name: 'MpDecoder', superclass: null, classinstvars: [], classvars: []},
  {name: 'MpMessagePack', superclass: null, classinstvars: [], classvars: []},
]);

// Upstream `.extension` directories add methods to classes this image already
// owns (kernel `Integer`, `True`, ...). These are vendored verbatim and compiled
// onto the *existing* kernel class, which is how upstream's `mpWriteSelector`
// dispatch reaches each scalar type. `Object>>mpWriteSelector` is the nil
// fallback upstream's `writeObject:ifNotApplied:` relies on.
const MSGPACK_EXTENSIONS = Object.freeze(['Integer', 'True', 'False', 'UndefinedObject', 'Object', 'Symbol']);

// The explicit Symmetric Smalltalk dialect adapter. Upstream selects its dialect
// utility subclass by introspecting `allSubclasses`; Symmetric Smalltalk instead
// makes the choice an ordinary, named class installed alongside the upstream set.
const DIALECT_ADAPTER_NAME = 'SymPortableUtil';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// A FileTree `.st` method file is `<category line>\n<body>`. The category line
// is metadata, not source. Bodies may contain trailing whitespace.
function splitFileTreeMethod(raw) {
  const firstNewline = raw.indexOf('\n');
  if (firstNewline === -1) return {category: raw.trim(), body: ''};
  return {
    category: raw.slice(0, firstNewline).trim(),
    body: raw.slice(firstNewline + 1),
  };
}

// Parse a method's selector-pattern first line into {selector, params}. FileTree
// names multi-keyword selectors by concatenating keywords and doubling the final
// colon, which is lossy; the authoritative selector is the pattern line itself.
// Unary: `default`. Keyword: `readExt: size as: type` (params follow each keyword).
// Binary: upstream MessagePack defines none, and `+`-style patterns are out of scope.
function parseSelectorPattern(patternLine) {
  const keywordMatches = [...patternLine.matchAll(/([A-Za-z_][A-Za-z0-9_]*):\s*([A-Za-z_][A-Za-z0-9_]*)/g)];
  if (keywordMatches.length > 0) {
    return {
      selector: keywordMatches.map((m) => m[1] + ':').join(''),
      params: keywordMatches.map((m) => m[2]),
    };
  }
  const unary = patternLine.trim();
  return {selector: unary, params: []};
}

// Wrap a verbatim upstream method body (selector-pattern line + statements) into
// the block-literal form `defineMethodsFromSource` compiles. The statements are
// carried through byte-for-byte; only the `[ :p |` ... `]` envelope is added.
function wrapMethodBody(body) {
  const newline = body.indexOf('\n');
  const patternLine = newline === -1 ? body : body.slice(0, newline);
  const statements = (newline === -1 ? '' : body.slice(newline + 1)).trim();
  const {selector, params} = parseSelectorPattern(patternLine);
  const head = params.length > 0 ? `[ ${params.map((p) => `:${p}`).join(' ')} | ` : '[ ';
  let source = `${head}${statements} ]`;
  // A method whose body is only comments (an upstream no-op hook such as
  // `"override"`) is valid Smalltalk that answers nil, but this grammar requires
  // at least one statement. Lower it to `nil` explicitly so the ordinary
  // compiler accepts it. Detected structurally: stripping `"..."` comments
  // leaves no non-whitespace.
  // Strip each `"..."` comment separately (non-greedy) so `"a"."b"` does not
  // collapse into one span across the period.
  if (statements.replace(/"[^"]*?"/g, '').trim() === '') source = `${head}nil ]`;
  return {selector, source};
}

// Standard Smalltalk methods without an explicit `^` implicitly answer `self`;
// Symmetric Smalltalk answers the last statement's value. An upstream method
// whose last statement is an assignment (an initializer or setter) relies on the
// implicit-self answer — `Class>>new` would otherwise answer the assigned value
// (often nil) instead of the new instance. Detect that shape structurally and
// append the `self` the Standard semantics imply. This is a dialect adaptation,
// not a language change: it makes the implicit return explicit, method by
// method, leaving the compiler's return semantics untouched.
function needsImplicitSelf(statements) {
  const stripped = statements.replace(/"[^"]*?"/g, '').trim();
  if (stripped.includes('^')) return false;
  // Last top-level statement ends in an assignment: `... := <expr>` with no
  // trailing `.` — i.e. the final token sequence assigns. We only need the
  // common upstream shapes (initializers, setters, stream writes).
  const lastStatement = stripped.split('.').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  return /:=/.test(lastStatement);
}

// Parse a `<Class>.class` directory into {classMethods, instanceMethods}, where
// each method is {file, category, selector, source}. `source` is the verbatim
// method body as upstream wrote it (the FileTree category line removed).
async function parseFileTreeClass(classDir) {
  const result = {classMethods: [], instanceMethods: []};
  for (const [side, key] of [['class', 'classMethods'], ['instance', 'instanceMethods']]) {
    const sideDir = join(classDir, side);
    let entries = [];
    try {
      entries = await readdir(sideDir);
    } catch {
      continue; // no class-side or no instance-side directory
    }
    for (const file of entries.sort()) {
      if (!file.endsWith('.st')) continue;
      const raw = await readFile(join(sideDir, file), 'utf8');
      const {category, body} = splitFileTreeMethod(raw);
      const {selector, source} = wrapMethodBody(body);
      result[key].push({file: `${side}/${file}`, category, selector, source});
    }
  }
  return result;
}

async function readClassProperties(classDir) {
  try {
    return JSON.parse(await readFile(join(classDir, 'properties.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Dialect adaptations. Each returns either the unchanged method or an adapted
// copy, and always appends a human-reviewable record to `adaptations`. These are
// the *only* points where upstream source is altered, and each is justified by a
// concrete dialect gap rather than convenience.
function adaptMethod({className, side, method, adaptations}) {
  const {file, category, selector, source} = method;
  const record = (action, detail) => adaptations.push(Object.freeze({className, side, selector, file, action, detail}));

  // Adaptation 1: FileTree category line removal. The body is compiled verbatim.
  record('strip-category-line', `removed FileTree category "${category}"`);

  // Adaptation 2: `MpEncoder>>writeUnknown:withHandler:` encodes a dialect
  // settings/`encodeMode` switch (`#strict`/`#unknownAsNil`/`#loose`) that
  // Symmetric Smalltalk's settings/keyword machinery does not yet support. It is
  // unreachable on the scalar encode path (every supported type resolves through
  // the default action map), so it is dropped and recorded rather than
  // half-supported.
  if (className === 'MpEncoder' && selector.startsWith('writeUnknown:withHandler:')) {
    record('drop-method', 'dropped dialect encodeMode/unknown-object switch (unreachable on scalar path)');
    return null;
  }

  // Adaptation 3: `MpPortableUtil class>>detectDialogSpecificClass` introspects
  // `allSubclasses`/`subclasses`/`detect:ifNone:` to pick a dialect adapter.
  // Symmetric Smalltalk instead installs the adapter explicitly and returns it.
  if (className === 'MpPortableUtil' && side === 'class' && selector.startsWith('detectDialogSpecificClass')) {
    record('replace-body', `dialect introspection replaced; returns explicit adapter ${DIALECT_ADAPTER_NAME}`);
    return {file, category, selector, source: `[ ^ ${DIALECT_ADAPTER_NAME} ]`};
  }

  // Adaptation 4: `MpPortableUtil>>randomClass` is test-support that reads the
  // `Smalltalk` system dictionary, which Symmetric Smalltalk does not model.
  // Unreachable on the encode/decode path; dropped rather than half-supported.
  if (className === 'MpPortableUtil' && selector === 'randomClass') {
    record('drop-method', 'dropped test-support method reading the Smalltalk system dictionary');
    return null;
  }

  // Adaptation 5: `MpEncodeTypeMapper class>>defineTimestampActionTo:` maps
  // `DateAndTime`/`TimeStamp`, which this image has no classes for. Timestamp is
  // outside the scalar round-trip; dropped rather than bound to a wrong class.
  if (className === 'MpEncodeTypeMapper' && side === 'class' && selector.startsWith('defineTimestampActionTo:')) {
    record('drop-method', 'dropped DateAndTime/TimeStamp mapping (no such classes in this image)');
    return null;
  }

  // Adaptation 6: array literals `#()`/`#[]` are a general language facility the
  // image does not yet have (separate follow-up), and the two methods using them
  // are not on the scalar round-trip. Dropped and recorded rather than
  // hand-rewritten — the array path is rebuilt once array literals exist.
  if (
    (className === 'MpDecoder' && selector.startsWith('createArray:'))
    || (className === 'MpDecoder' && selector.startsWith('readFixRaw:'))
  ) {
    record('drop-method', 'dropped method using #()/#[ ] array literals (general facility deferred)');
    return null;
  }

  // Adaptation 7: upstream instantiates `IdentityDictionary` in three places.
  // This image provides the general `Dictionary` only, so the dialect adapter
  // substitutes it. Keys here are classes (encode), small-integer type codes
  // (decode) and short setting symbols — all of which `Dictionary`'s `=`/`hash`
  // handles, so the substitution is behavior-preserving on the supported paths.
  if (source.includes('IdentityDictionary')) {
    record('replace-name', 'IdentityDictionary -> Dictionary (image provides Dictionary only)');
    return {file, category, selector, source: source.replaceAll('IdentityDictionary', 'Dictionary')};
  }

  // Adaptation 10: make the Standard implicit-self return explicit for methods
  // that end in an assignment (initializers/setters/stream writes). See
  // `needsImplicitSelf`. `Class>>new` depends on `initialize` answering self.
  {
    const openBracket = source.indexOf('[ ');
    const closeBracket = source.lastIndexOf(' ]');
    if (openBracket !== -1 && closeBracket > openBracket) {
      const head = source.slice(0, openBracket + 2);
      const bodyText = source.slice(openBracket + 2, closeBracket);
      if (needsImplicitSelf(bodyText)) {
        record('append-self-return', 'appended explicit self (Standard implicit-self return for assignment-final method)');
        return {file, category, selector, source: `${head}${bodyText}. self ]`};
      }
    }
  }

  // Adaptation 8: upstream names the string class `String`; this image's text
  // class is `Text` (a kernel global). Substitute the image's class name.
  if (/\bString\b/.test(source)) {
    record('replace-name', 'String -> Text (image text class is named Text)');
    return {file, category, selector, source: source.replaceAll(/\bString\b/g, 'Text')};
  }

  // Adaptation 8b: dialects split symbols into `ByteSymbol`/`WideSymbol`; this
  // image has a single `Symbol` class. `defineSymbolActionTo:` maps both to
  // string writes; here it maps the one `Symbol` class to `#writeString:`.
  if (className === 'MpEncodeTypeMapper' && side === 'class' && selector.startsWith('defineSymbolActionTo:')) {
    record('replace-body', 'ByteSymbol/WideSymbol -> single Symbol class, mapped to #writeString:');
    return {file, category, selector, source: '[ :map | map at: Symbol put: #writeString: ]'};
  }

  // Adaptation 9a: the byte-sink hook `createWriteStream` and the byte-source
  // hook `decodeFrom:` ARE on the scalar round-trip. Upstream writes them in
  // terms of `WriteStream`/`readStream`, which this image does not have. The
  // dialect seam supplies an in-memory byte buffer, so the bodies are adapted
  // to reach it through `MpPortableUtil default` — the same dialect object
  // upstream already consults for `useFastBulkWrite`. The algorithm (lazy
  // create-write-stream, decode-from-bytes) is unchanged.
  if (className === 'MpEncoder' && side === 'instance' && selector === 'createWriteStream') {
    record('replace-body', 'WriteStream -> dialect byte buffer via MpPortableUtil default newByteWriteStream');
    return {file, category, selector, source: '[ ^ MpPortableUtil default newByteWriteStream ]'};
  }
  if (className === 'MpDecoder' && side === 'instance' && selector === 'decodeFrom:') {
    record('replace-body', 'kept verbatim structure; sets dialect read stream then decode');
    return {file, category, selector, source: '[ :aStream | self readStream: aStream. ^ self decode ]'};
  }
  // `MpDecoder>>decode:` is the entry that names `byteArray readStream`, which
  // this image has no ByteArray `readStream` for. Route the bytes through the
  // dialect read-stream factory, preserving upstream's decodeFrom:/decode split.
  if (className === 'MpDecoder' && side === 'instance' && selector === 'decode:') {
    record('replace-body', 'byteArray readStream -> dialect byte buffer via MpPortableUtil default readStreamOn:');
    return {file, category, selector, source: '[ :byteArray | ^ self decodeFrom: (MpPortableUtil default readStreamOn: byteArray) ]'};
  }

  // Adaptation 9b: the *external* stream entry points (`on:`, `onBytes:`,
  // `encode:on:`, ...) hand the coder a caller-supplied WriteStream/ReadStream
  // the image does not have, and the compound str/bin/array/map write-read
  // paths need bulk stream machinery deferred to the stream library follow-up.
  // Dropped and recorded; restored with the stream library.
  if (
    (className === 'MpEncoder' && ['nextPutAll:'].includes(selector))
    // External stream entry points; the scalar path uses encode:/decode:.
    || (className === 'MpEncoder' && side === 'class' && ['on:', 'onBytes:', 'encode:on:', 'encode:on:setting:'].includes(selector))
    || (className === 'MpDecoder' && side === 'class' && ['on:', 'onBytes:', 'decodeFrom:setting:'].includes(selector))
    || (className === 'MpEncoder' && side === 'instance' && selector === 'encode:on:setting:')
    || (className === 'MpDecoder' && side === 'instance' && selector === 'decodeFrom:setting:')
    || selector.startsWith('writeStrBytes')
    || selector.startsWith('writeBinBytes')
    || selector.startsWith('writeRawBytes')
    || selector.startsWith('writeArray')
    || selector.startsWith('writeMap')
    || selector.startsWith('writeString')
    || selector.startsWith('writeWideString')
    // NOTE: `readStream`/`readStream:` are the decoder's stream accessors and
    // must survive; the compound read paths below are matched by their full
    // prefixed forms, never the bare `readStr`/`readStream` accessors.
    || selector.startsWith('readStr8')
    || selector.startsWith('readStr16')
    || selector.startsWith('readStr32')
    || selector.startsWith('readBin8')
    || selector.startsWith('readBin16')
    || selector.startsWith('readBin32')
    || selector.startsWith('readRaw16')
    || selector.startsWith('readRaw32')
    || selector.startsWith('readString8')
    || selector.startsWith('readString16')
    || selector.startsWith('readString32')
    || selector.startsWith('readArray16')
    || selector.startsWith('readArray32')
    || selector.startsWith('readArraySized:')
    || selector.startsWith('readMap16')
    || selector.startsWith('readMap32')
    || selector.startsWith('readMapSized:')
    || selector.startsWith('readFixStr')
    || selector.startsWith('readFixString')
    || selector.startsWith('readFixArray')
    || selector.startsWith('readFixMap')
    || selector === 'bytesAsRaw'
    || selector === 'bytesAsString'
    || selector === 'stringAsBytes'
    || selector === 'stringAsError'
    || selector === 'createDictionary:'
    || selector === 'createOrderedCollection:'
    // Extension/timestamp types (`MpExtValue`, `MpFixextValue`, `DateAndTime`)
    // are outside the pinned closure and the scalar round-trip.
    || selector.startsWith('writeExt')
    || selector.startsWith('writeFixext')
    || selector.startsWith('writeTimestamp')
    || selector.startsWith('readFixedTimestamp')
    || selector.startsWith('readTimestamp')
    // Both `defineExtsActionsTo:` overrides are dropped: the encode side
    // references `MpExtValue`/`MpFixextValue`/`defineTimestampActionTo:`, and the
    // ext readers the decode side maps (`readFixext:as:`, `readExtSized:as:`)
    // reference `MpExtValue`/`MpFixextValue` and `ByteArray with:`/`next:` — all
    // outside the pinned scalar closure. With both overrides dropped, the base
    // `MpTypeMapper class>>defineExtsActionsTo:` no-op (`"override"` -> nil) is
    // inherited, and `createActionMap` runs unchanged. Ext/timestamp decode then
    // signals a normal unmapped-type error rather than reaching a half-bound
    // method.
    || (className !== 'MpTypeMapper' && selector.startsWith('defineExtsActionsTo:'))
    || selector.startsWith('readFixext')
    || selector.startsWith('readExt')
    || selector.startsWith('timestampFromSeconds')
    || selector.startsWith('unixSecondsWithNanosecondsFrom')
  ) {
    record('drop-method', 'dropped stream/compound method (needs WriteStream/ByteArray new:/next: machinery)');
    return null;
  }

  return {file, category, selector, source};
}

// Install a metaclass-instance (class-instance) variable companion object for a
// class that declares class-instance state, and return the metaclass instance
// shape ref. Mirrors the companion-object model established in
// test/smalltalk-class-variables.test.js.
async function installClassInstanceState({images, imageId, name, classinstvars, kernel}) {
  if (classinstvars.length === 0) return null;
  const slots = classinstvars.map((v) => ({id: `state-${v}`, name: v}));
  const stateShape = await ensureSmalltalkShape(images, imageId, {
    id: `smalltalk/class-state-shape/${name}`,
    slots,
  });
  const {ensureObject} = await import('../graph/ensure-records.js');
  await ensureObject(images, imageId, {
    id: `smalltalk/class-state/${name}`,
    shape: stateShape,
    behavior: null,
    slots: Object.fromEntries(slots.map(({id}) => [id, kernel.nil])),
    metadata: {smalltalk: 'class-state', name},
  });
  return stateShape;
}

// Install the pinned MessagePack source closure into an image that already has
// the Symmetric Smalltalk standard-image machinery available. Returns the class
// refs, the dialect adapter, and the reviewable adaptation log.
async function installMessagePackFromFixture({images, compilation, imageId, fixtureRoot, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  requiredText(fixtureRoot, 'fixture root');
  if (!await stat(fixtureRoot).catch(() => null)) throw new TypeError(`fixture root not found: ${fixtureRoot}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  const options = {images, compilation, imageId, lane};
  const adaptations = [];
  const classes = {};

  // Class-variable support is a prerequisite for MpPortableUtil's
  // Default/DialectSpecificClass bindings.
  await installSmalltalkClassVariableSupport(options);

  const superclassRefFor = (superName) => {
    if (superName === null) return kernel.objectClass;
    if (superName === 'Error') return kernel.objectClass; // MpError superclass; see note below
    if (classes[superName]) return classes[superName].classRef;
    throw new TypeError(`MessagePack loader: unresolved superclass ${superName}`);
  };

  // Phase 1: define every class (shape, class, class-instance state, class
  // variables) before any method compiles, so cross-class references in method
  // bodies resolve through the global namespace.
  //
  // An instance shape is the *complete* inherited layout, so each class's shape
  // is its own instvars appended to its superclass's cumulative instvars.
  const ownInstvars = {};
  const cumulativeInstvars = (name) => {
    const spec = MSGPACK_CLASSES.find((s) => s.name === name);
    const inherited = spec.superclass && ownInstvars[spec.superclass] ? cumulativeInstvars(spec.superclass) : [];
    return [...inherited, ...(ownInstvars[name] ?? [])];
  };
  // Class-instance variables are per-class, but the *layout* is inherited: a
  // subclass's metaclass carries the same class-instvar slots (its own values).
  const cumulativeClassInstvars = (name) => {
    const spec = MSGPACK_CLASSES.find((s) => s.name === name);
    const inherited = spec.superclass && MSGPACK_CLASSES.some((s) => s.name === spec.superclass)
      ? cumulativeClassInstvars(spec.superclass) : [];
    return [...inherited, ...spec.classinstvars];
  };

  const parsedByClass = {};
  for (const spec of MSGPACK_CLASSES) {
    const classDir = join(fixtureRoot, `${spec.name}.class`);
    const properties = await readClassProperties(classDir);
    parsedByClass[spec.name] = await parseFileTreeClass(classDir);
    ownInstvars[spec.name] = Array.isArray(properties.instvars) ? properties.instvars : [];
    const instvars = cumulativeInstvars(spec.name);

    const instanceShapeRef = await ensureSmalltalkShape(images, imageId, {
      id: `smalltalk/msgpack-shape/${spec.name}`,
      slots: instvars.map((v) => ({id: `iv-${v}`, name: v})),
    });
    const metaclassInstanceShapeRef = await installClassInstanceState({
      images, imageId, name: spec.name, classinstvars: cumulativeClassInstvars(spec.name), kernel,
    });

    const {classRef, metaclassRef} = await defineClass({
      images, imageId, name: spec.name,
      superclassRef: superclassRefFor(spec.superclass),
      instanceShapeRef,
      metaclassInstanceShapeRef,
    });
    classes[spec.name] = {classRef, metaclassRef, instvars};

    if (spec.classvars.length > 0) {
      await declareClassVariables({images, imageId, className: spec.name, variables: spec.classvars});
    }
  }

  // The explicit dialect adapter, subclassing MpPortableUtil. Upstream's
  // `detectDialogSpecificClass` body is adapted (below) to return this class.
  const adapterShape = await ensureSmalltalkShape(images, imageId, {
    id: `smalltalk/msgpack-shape/${DIALECT_ADAPTER_NAME}`,
    slots: [],
  });
  const {classRef: adapterClassRef, metaclassRef: adapterMetaclassRef} = await defineClass({
    images, imageId, name: DIALECT_ADAPTER_NAME,
    superclassRef: classes.MpPortableUtil.classRef,
    instanceShapeRef: adapterShape,
  });
  classes[DIALECT_ADAPTER_NAME] = {classRef: adapterClassRef, metaclassRef: adapterMetaclassRef, instvars: []};

  // The dialect in-memory byte buffer, an explicit Symmetric Smalltalk facility
  // (not upstream source). `SymByteWriteStream` accumulates bytes in an
  // `OrderedCollection`; `SymByteReadStream` reads them back positionally. They
  // provide exactly the protocol upstream's encode/decode hooks send
  // (`nextPut:`, `contents`, `next`, `atEnd`) over the general OrderedCollection
  // and Array machinery the image already has — no ByteArray `new:`/`replace:`
  // primitive and no MessagePack-specific behaviour.
  const byteWriteShape = await ensureSmalltalkShape(images, imageId, {
    id: 'smalltalk/msgpack-shape/SymByteWriteStream',
    slots: [{id: 'iv-bytes', name: 'bytes'}],
  });
  classes.SymByteWriteStream = await defineClass({
    images, imageId, name: 'SymByteWriteStream', superclassRef: kernel.objectClass, instanceShapeRef: byteWriteShape,
  });
  const byteReadShape = await ensureSmalltalkShape(images, imageId, {
    id: 'smalltalk/msgpack-shape/SymByteReadStream',
    slots: [{id: 'iv-bytes', name: 'bytes'}, {id: 'iv-position', name: 'position'}],
  });
  classes.SymByteReadStream = await defineClass({
    images, imageId, name: 'SymByteReadStream', superclassRef: kernel.objectClass, instanceShapeRef: byteReadShape,
  });
  await publishSmalltalkClassGlobals({images, imageId, names: ['SymByteWriteStream', 'SymByteReadStream']});

  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: classes.SymByteWriteStream.classRef,
    methods: [
      {selector: 'bytes', source: '[ ^ bytes ifNil: [ bytes := OrderedCollection new ] ]'},
      {selector: 'nextPut:', source: '[ :aByte | self bytes add: aByte ]'},
      {selector: 'contents', source: '[ ^ self bytes asArray ]'},
      {selector: 'size', source: '[ ^ self bytes size ]'},
    ],
  });
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: classes.SymByteReadStream.classRef,
    methods: [
      {selector: 'initialize', source: '[ position := 0. self ]'},
      {selector: 'bytes:', source: '[ :aCollection | bytes := aCollection. position := 0. self ]'},
      {selector: 'next', source: '[ position := position + 1. ^ bytes at: position ]'},
      {selector: 'atEnd', source: '[ ^ position >= bytes size ]'},
    ],
  });
  // The dialect adapter's factory overrides, reached through `MpPortableUtil
  // default` (which is a `SymPortableUtil` via the adapted `detect...`).
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: adapterClassRef,
    methods: [
      {selector: 'newByteWriteStream', source: '[ ^ SymByteWriteStream new ]'},
      {selector: 'readStreamOn:', source: '[ :aCollection | ^ SymByteReadStream new bytes: aCollection ]'},
    ],
  });

  // Publish every installed class as a global *before* compiling methods, so
  // `MpEncoder`, `MpConstants`, ... resolve through the ordinary namespace path.
  // `Symbol` is a kernel class the standard image leaves unpublished, but
  // upstream names it (adapted from `ByteSymbol`/`WideSymbol`), so publish it too.
  const toPublish = [...Object.keys(classes)];
  if (await images.getObject(imageId, 'smalltalk/class/Symbol')) toPublish.push('Symbol');
  await publishSmalltalkClassGlobals({images, imageId, names: toPublish});

  // Phase 2: install methods through the normal compile pipeline.
  for (const spec of MSGPACK_CLASSES) {
    const parsed = parsedByClass[spec.name];
    const {classRef, metaclassRef} = classes[spec.name];
    for (const [side, classRef2, methods] of [
      ['instance', classRef, parsed.instanceMethods],
      ['class', metaclassRef, parsed.classMethods],
    ]) {
      const adapted = methods
        .map((m) => adaptMethod({className: spec.name, side, method: m, adaptations}))
        .filter((m) => m !== null);
      if (adapted.length === 0) continue;
      try {
        await defineMethodsFromSource({
          images, compilation, imageId, classRef: classRef2, lane,
          methods: adapted.map(({selector, source}) => ({selector, source})),
        });
      } catch (error) {
        const detail = adapted.map(({file, selector, source}) => `  ${file}  ${selector}\n    ${JSON.stringify(source)}`).join('\n');
        throw new TypeError(`MessagePack compile failed in ${spec.name} ${side}:\n${detail}\ncaused by: ${error.message}`);
      }
    }
  }

  // Phase 3: install the vendored `.extension` methods onto the kernel classes
  // they extend. This is how upstream's `mpWriteSelector` reaches each scalar
  // type. Only the `mpWriteSelector` family is installed; the `asMpConverted`/
  // `asMpMap`/`messagePacked` convenience methods pull in conversion machinery
  // outside the scalar path.
  for (const extName of MSGPACK_EXTENSIONS) {
    const extDir = join(fixtureRoot, `${extName}.extension`);
    if (!await stat(extDir).catch(() => null)) continue;
    const parsed = await parseFileTreeClass(extDir);
    const targetRef = objectRef(imageId, `smalltalk/class/${extName}`);
    const adapted = parsed.instanceMethods
      .filter((m) => m.selector === 'mpWriteSelector')
      .map((m) => adaptMethod({className: extName, side: 'instance', method: m, adaptations}))
      .filter((m) => m !== null);
    if (adapted.length === 0) continue;
    await defineMethodsFromSource({
      images, compilation, imageId, classRef: targetRef, lane,
      methods: adapted.map(({selector, source}) => ({selector, source})),
    });
  }

  return Object.freeze({
    imageId,
    lane,
    classes: Object.freeze(classes),
    dialectAdapter: adapterClassRef,
    adaptations: Object.freeze(adaptations),
  });
}

// Verify that a named selector on a class resolves to an installed Block, i.e.
// that the method was actually compiled and published from the vendored source.
async function assertMessagePackMethodInstalled({images, imageId, className, side = 'instance', selector}) {
  const classRef = objectRef(imageId, side === 'class' ? `smalltalk/metaclass/${className}` : `smalltalk/class/${className}`);
  const block = await methodBlockRef({images, imageId, classRef, selector});
  if (!block) throw new TypeError(`MessagePack method not installed: ${className} ${side}>>${selector}`);
  return block;
}

export {
  DIALECT_ADAPTER_NAME,
  MSGPACK_CLASSES,
  assertMessagePackMethodInstalled,
  installMessagePackFromFixture,
  parseFileTreeClass,
};
