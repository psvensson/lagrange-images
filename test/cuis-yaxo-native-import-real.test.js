import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runM4Acceptance} from './support/yaxo-m4-acceptance.js';
import {createHash} from 'node:crypto';
import {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  booleanValue,
  bytesValue,
  createOpenSmalltalkCuisProvider,
  createOpenSmalltalkCuisToolchainProvider,
  createRuntime,
  ensureClassFromDeclaration,
  findSmalltalkKernel,
  globalDeclarations,
  importCuisNativePackage,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  methodBindings,
  objectRef,
  readBehavior,
  reconcileMethodsFromSource,
  textValue,
} from '../src/runtime.js';

// ADR 0085 M4 forcing harness (Bead lagrange-images-xxm).
//
// The pressure source is the pinned upstream Cuis YAXO package that scripts/integration-setup.sh
// downloads — not a fixture written here, and not the JSON package M3 used. It was selected and
// validated by bead lagrange-images-moq, and it is here for ONE property the JSON harness
// structurally cannot supply: YAXO's parse result is a graph of instances of classes THE PACKAGE
// ITSELF DEFINES (XMLDocument -> XMLElement -> XMLStringNode), constructed by the imported code, so
// M4 can eventually restart an APPLICATION object graph rather than a tree of base collections.
//
// UPSTREAM IDENTITY AND LICENSE, recorded the way the M3 harness records its pressure source:
//
//   distribution : Cuis-Smalltalk/Cuis-Smalltalk-Dev @ 6bcee3f38ce037c9714b997ccd3b5b3ff62965c8
//                  — the distribution scripts/integration-setup.sh ALREADY pins for the JSON
//                  harness, so this milestone introduces no new upstream trust anchor.
//   license      : MIT at that exact commit (Xerox 1981-1982, Apple 1985-1996, Squeak contributors
//                  1997-2026, Cuis Smalltalk contributors 2009-2026). YAXO carries no separate or
//                  conflicting notice inside the package text.
//   application  : Packages/Features/YAXO.pck.st,       git blob 67d670ed…, 90,791 bytes
//   its tests    : Packages/Features/Tests-YAXO.pck.st, git blob 8c50cbe6…, 15,785 bytes
//   closure      : Cuis-Base -> YAXO -> Tests-YAXO. YAXO declares no `!requires:` line at all,
//                  which the canonical export below confirms by answering `requires: []`.
//
// WHAT THIS FILE IS FOR, and deliberately not for. It carries the M4 vertical: pin, measured oracle,
// scoped native import, and ONE classified first RED at a time. It implements no YAXO compatibility.
// A refusal it records is never a permanent contract that a real package must be refused — repairing
// that semantic at its owner is meant to make this file go red so the NEXT blocker has to be
// classified deliberately, exactly as the M3 harness works.
//
// It has moved once already. The first RED was a super send (`unbound Symmetric Smalltalk name:
// super`), repaired at the language owner by ADR 0089 / bead lagrange-images-xxm.1; the section
// below now proves the entry point imports and records the next RED in its place. The legacy-arrow
// repair moved that RED once more: the exact same forcing scope stopped at the earlier masked
// `SAXDriver` name in `SAXHandler class>>on:` rather than reaching `XMLDocument` later in the path.
// Publishing the scoped imported classes through the existing native global owner repaired that
// boundary. The oracle-backed `UnicodeString writeStream` construction repair now executes the real
// initializer. Character literals then let the real `XMLTokenizer>>nextEntity` compare its input,
// and the distinct `UnicodeString streamContents:` repair now lets the unchanged nextWhitespace
// method observe native Text. Product `Object>>~~`, Character classification, and now
// WriteStream>>nextPut: carry the execution-earned ordinary protocol steps.
//
// The `next` RED those steps exposed was an APPLICATION-SCOPE gap, not a missing generic native
// Stream protocol (bead lagrange-images-xxm.15): the pinned package itself owns
// `XMLTokenizer>>next`, and the deliberately incremental method closure simply had not imported
// it. The synthetic probe `next` bridge is gone, and with the two-keyword `ifNil:ifNotNil:`
// base nil-checking protocol now installed at its standard-image owner (bead
// lagrange-images-xxm.16), the unchanged separator loop completes through the package's own
// `peek`/`next` pair against an instrumented stream — the run test below observes the exact
// native Text delivered through `handleWhitespace:` and the read discipline of the pair.
const enabled = process.env.LAGRANGE_OPENSMALLTALK_INTEGRATION === '1';

const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const CUIS_COMMIT = '6bcee3f38ce037c9714b997ccd3b5b3ff62965c8';
const CUIS_IMAGE_IDENTITY = `cuis/${CUIS_COMMIT}/Cuis7.9-8090.image/gitblob:523dc5e74b5b550922b56ff2406415c19700ee8e`;
const CUIS_YAXO_IDENTITY = `cuis-package/YAXO/${CUIS_COMMIT}/gitblob:67d670ed38cc136d88afdf7e0df5bf8bc6519087`;
const CUIS_TESTS_YAXO_IDENTITY = `cuis-package/Tests-YAXO/${CUIS_COMMIT}/gitblob:8c50cbe6f29f3f4b25c883511eb905e44120ec5e`;

// The smallest XML document that still forces every relationship M4 needs: a root element, an
// attribute on it, one child element, and text inside that child. Anything smaller drops one of
// the four; anything larger buys compatibility surface this slice has no consumer for.
const M4_DOCUMENT = '<?xml version="1.0" encoding="UTF-8"?><note lang="en"><to>Tove</to></note>';

// The classes the measured parse path actually instantiates and dispatches to. This is the M4
// MINIMUM IMPORT SCOPE's class half: `XMLDOMParser class>>parseDocumentFrom:` builds a SAXDriver
// (an XMLTokenizer subclass) and an XMLDOMParser (a SAXHandler subclass), and the DOM it answers is
// made of XMLDocument/XMLElement/XMLStringNode, which inherit through XMLNodeWithElements/XMLNode.
// Nothing else in the 24-class package is reachable from this document: it declares no DTD, no
// entities and no namespaces, so the DTD*/XMLNamespaceScope/XMLParser/XMLWriter classes and the
// exception classes stay out, and with them their Error/Warning superclass identities.
const M4_SCOPE_CLASSES = Object.freeze([
  'cuis-class/YAXO/SAXDriver',
  'cuis-class/YAXO/SAXHandler',
  'cuis-class/YAXO/XMLDOMParser',
  'cuis-class/YAXO/XMLDocument',
  'cuis-class/YAXO/XMLElement',
  'cuis-class/YAXO/XMLNode',
  'cuis-class/YAXO/XMLNodeWithElements',
  'cuis-class/YAXO/XMLStringNode',
  'cuis-class/YAXO/XMLTokenizer',
]);

// The M4 vertical's public entry point, in the canonical export's own semantic identity. This is
// the smallest useful public parsing operation the package offers, it is the one the package's own
// upstream test uses, and there is no way into the DOM path that does not go through it.
const M4_ENTRY_POINT = 'cuis-method/YAXO/XMLDOMParser/class/parseDocumentFrom:';
const M4_ENTRY_POINT_UPSTREAM_SOURCE = 'parseDocumentFrom: aStream\n\t^(super parseDocumentFrom: aStream) document';
const M4_TOKENIZER_INITIALIZE = 'cuis-method/YAXO/XMLTokenizer/instance/initialize';

// xxm.15: `next` is package-owned application protocol, not a missing generic native Stream
// protocol. The pinned upstream source, asserted verbatim wherever the method is imported:
//
//   peekChar is nil     -> check nested streams when any exist, then answer `stream next`;
//   peekChar is cached  -> answer the cached Character and clear the cache, never touching the
//                          underlying stream.
//
// No compiler special case and no YAXO adaptation is implied or added: the canonical manifest
// already carries the method, and the ordinary importer compiles it unchanged.
const M4_NEXT_METHOD = 'cuis-method/YAXO/XMLTokenizer/instance/next';
const M4_NEXT_UPSTREAM_SOURCE = 'next\n'
  + '\t"Return the next character from the current input stream. If the current stream is at end pop to next nesting level if there is one.\n\tDue to the potential nesting of original document, included documents and replacment texts the streams are held in a stack representing the nested streams. The current stream is the top one."\n'
  + '\t| nextChar |\n'
  + '\tpeekChar\n'
  + '\t\tifNil: [\n'
  + '\t\t\tnestedStreams ifNotNil: [self checkNestedStream].\n'
  + '\t\t\t^nextChar _ stream next]\n'
  + '\t\tifNotNil: [\n'
  + '\t\t\tnextChar _ peekChar.\n'
  + '\t\t\tpeekChar _ nil.\n'
  + '\t\t\t^nextChar].';

// xxm.16: the package's own peek/next pair is the tokenizer's whole input protocol, and `peek`
// opens with the SAME two-keyword conditional as `next` (`peekChar ifNil:ifNotNil:` — nil means
// read one step from `stream` and cache the answer; a cached character is answered untouched).
// The separator-loop fixures therefore supply an instrumented stream and import the real `peek`
// beside the real `next`, rather than a probe-local peek approximation.
const M4_PEEK_METHOD = 'cuis-method/YAXO/XMLTokenizer/instance/peek';
const M4_PEEK_UPSTREAM_SOURCE = 'peek\n'
  + '\t"Return the next character from the current input stream. If the current stream poop to next nesting level if there is one.\n'
  + '\tDue to the potential nesting of original document, included documents and replacment texts the streams are held in a stack representing the nested streams. The current stream is the top one."\n'
  + '\tpeekChar\n'
  + '\t\tifNil: [\n'
  + '\t\t\tnestedStreams ifNotNil: [self checkNestedStream].\n'
  + '\t\t\t^peekChar _ stream next]\n'
  + '\t\tifNotNil: [^peekChar]';

// The pinned identity, re-asserted here rather than trusted from the setup script. The whole claim
// of a forcing harness is that the material is the pinned upstream package and not something this
// repository wrote, so the bytes this file actually reads are hashed the way upstream publishes
// them (a Git blob: sha1 over `blob <len>\0` and the content) and compared with the recorded
// identity. A stale, truncated or hand-edited `.integration/` file cannot reach the assertions.
function gitBlobIdentity(bytes) {
  return `gitblob:${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}`;
}

async function put(runtime, id, representation, content, {logicalPath = null, metadata = {}} = {}) {
  return await runtime.images.putCodeArtifact('build-image', {
    id, languageId: 'smalltalk', representation, content, ...(logicalPath ? {logicalPath} : {}), metadata, dependencies: [],
  });
}

// One real build per test-file run. The build runtime is closed before the text is returned, so
// every consumer below already sits on the native side of the boundary.
let semanticExportText = null;
async function yaxoSemanticExport() {
  if (semanticExportText !== null) return semanticExportText;
  // The focused M4 test must establish the pin itself; it may skip the file-wide pin proof.
  const yaxoBytes = await readFile(process.env.LAGRANGE_CUIS_YAXO_PACKAGE_PATH);
  assert.equal(CUIS_YAXO_IDENTITY, `cuis-package/YAXO/${CUIS_COMMIT}/${gitBlobIdentity(yaxoBytes)}`, 'the exact pinned YAXO bytes before export');
  const buildRuntime = await createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, createOpenSmalltalkCuisToolchainProvider({
      vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 900_000,
    })]],
  });
  try {
    await buildRuntime.images.createImage({id: 'build-image'});
    const baseImage = await put(buildRuntime, 'yaxo-bi', CUIS_IMAGE_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_IMAGE_PATH)), {
      logicalPath: 'Cuis7.9-8090.image', metadata: {identity: CUIS_IMAGE_IDENTITY},
    });
    const baseChanges = await put(buildRuntime, 'yaxo-bc', CUIS_CHANGES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_CHANGES_PATH)), {
      logicalPath: 'Cuis7.9-8090.changes',
    });
    const baseSources = await put(buildRuntime, 'yaxo-bs', CUIS_SOURCES_V1, bytesValue(await readFile(process.env.LAGRANGE_CUIS_SOURCES_PATH)), {
      logicalPath: 'Cuis7.8.sources',
    });
    const yaxoPackage = await put(buildRuntime, 'yaxo-pkg', CUIS_PACKAGE_V1, textValue(yaxoBytes.toString('utf8')), {
      logicalPath: 'YAXO.pck.st', metadata: {identity: CUIS_YAXO_IDENTITY},
    });
    await buildRuntime.images.putCodeArtifact('build-image', {
      id: 'yaxo-buildroot',
      languageId: 'smalltalk',
      representation: CUIS_BUILD_V1,
      content: textValue(CUIS_BUILD_CONTRACT_V0),
      metadata: {},
      dependencies: [
        {role: 'base-image', artifact: objectRef('build-image', baseImage.id)},
        {role: 'base-changes', artifact: objectRef('build-image', baseChanges.id)},
        {role: 'base-sources', artifact: objectRef('build-image', baseSources.id)},
        {role: 'package', artifact: objectRef('build-image', yaxoPackage.id)},
      ],
    });
    await buildRuntime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      imageId: 'build-image',
      roots: [objectRef('build-image', 'yaxo-buildroot')],
      target: {representation: CUIS_IMAGE_V1, fileName: 'YaxoNativeImport.image'},
      options: {semanticExport: CUIS_SEMANTIC_EXPORT_V2},
      outputIds: {image: 'yaxo-derived-image', changes: 'yaxo-derived-changes', 'semantic-export': 'yaxo-derived-export'},
    });
    const artifact = await buildRuntime.images.getCodeArtifact('build-image', 'yaxo-derived-export');
    assert.equal(artifact.representation, CUIS_SEMANTIC_EXPORT_V2);
    semanticExportText = artifact.content.value;
    return semanticExportText;
  } finally {
    // The toolchain process has already exited; closing its owning runtime makes the cut explicit.
    await buildRuntime.close();
  }
}

test('the pinned upstream Cuis YAXO package is a real M4 pressure source, not a fixture', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  assert.equal(manifest.format, CUIS_SEMANTIC_EXPORT_V2);
  // The package really does declare no requirement beyond the base image.
  assert.deepEqual(manifest.packages, [{name: 'YAXO', requires: []}]);
  assert.equal(manifest.classes.length, 24);
  assert.equal(manifest.methods.length, 341);

  // The whole declared class graph, with the superclass identities that leave the package. Three
  // of those identities — Object, Error and Warning — are Cuis base classes, and only the first is
  // mapped today. Recorded so the shape of the pressure is visible; which of them ever becomes work
  // is decided one RED at a time, by the acceptance vertical, not by this list.
  assert.deepEqual(
    manifest.classes.map(({identity, superclass}) => [identity, superclass]),
    [
      ['cuis-class/YAXO/DTDEntityDeclaration', 'cuis-class/Cuis-Base/Object'],
      ['cuis-class/YAXO/DTDExternalEntityDeclaration', 'cuis-class/YAXO/DTDEntityDeclaration'],
      ['cuis-class/YAXO/DTDParameterEntityDeclaration', 'cuis-class/YAXO/DTDEntityDeclaration'],
      ['cuis-class/YAXO/SAXDriver', 'cuis-class/YAXO/XMLTokenizer'],
      ['cuis-class/YAXO/SAXException', 'cuis-class/Cuis-Base/Error'],
      ['cuis-class/YAXO/SAXHandler', 'cuis-class/Cuis-Base/Object'],
      ['cuis-class/YAXO/SAXMalformedException', 'cuis-class/YAXO/SAXException'],
      ['cuis-class/YAXO/SAXParseException', 'cuis-class/YAXO/SAXException'],
      ['cuis-class/YAXO/SAXWarning', 'cuis-class/Cuis-Base/Warning'],
      ['cuis-class/YAXO/XMLDocument', 'cuis-class/YAXO/XMLNodeWithElements'],
      ['cuis-class/YAXO/XMLDOMParser', 'cuis-class/YAXO/SAXHandler'],
      ['cuis-class/YAXO/XMLElement', 'cuis-class/YAXO/XMLNodeWithElements'],
      ['cuis-class/YAXO/XMLException', 'cuis-class/Cuis-Base/Error'],
      ['cuis-class/YAXO/XMLInvalidException', 'cuis-class/YAXO/XMLException'],
      ['cuis-class/YAXO/XMLMalformedException', 'cuis-class/YAXO/XMLException'],
      ['cuis-class/YAXO/XMLNamespaceScope', 'cuis-class/Cuis-Base/Object'],
      ['cuis-class/YAXO/XMLNode', 'cuis-class/Cuis-Base/Object'],
      ['cuis-class/YAXO/XMLNodeWithElements', 'cuis-class/YAXO/XMLNode'],
      ['cuis-class/YAXO/XMLParser', 'cuis-class/YAXO/XMLTokenizer'],
      ['cuis-class/YAXO/XMLPI', 'cuis-class/YAXO/XMLNode'],
      ['cuis-class/YAXO/XMLStringNode', 'cuis-class/YAXO/XMLNode'],
      ['cuis-class/YAXO/XMLTokenizer', 'cuis-class/Cuis-Base/Object'],
      ['cuis-class/YAXO/XMLWarningException', 'cuis-class/YAXO/XMLException'],
      ['cuis-class/YAXO/XMLWriter', 'cuis-class/Cuis-Base/Object'],
    ],
  );

  // The M4 vertical's own material, unmodified: the public entry point and the package's own
  // narrowest mutation. Asserted rather than described, so a substituted fixture or an edited
  // manifest cannot reach the import attempt below.
  const entry = manifest.methods.find(({identity}) => identity === M4_ENTRY_POINT);
  assert.equal(entry.class, 'cuis-class/YAXO/XMLDOMParser');
  assert.equal(entry.side, 'class');
  assert.equal(entry.source, M4_ENTRY_POINT_UPSTREAM_SOURCE, 'the pinned upstream entry point, unedited');
  const attributePut = manifest.methods.find(({identity}) => identity === 'cuis-method/YAXO/XMLElement/instance/attributeAt:put:');
  assert.equal(
    attributePut.source,
    'attributeAt: attributeName put: attributeValue\n\tself attributes at: attributeName asSymbol put: attributeValue',
  );

  // No Spur heap identity leaked into the canonical manifest. The M3 harness asks this as a
  // substring scan over the whole document, and that instrument is WRONG for this package: YAXO's
  // own example methods contain an address book, so `address` appears in upstream SOURCE TEXT and a
  // text scan reports a leak that is not one. The leak would be in the export's OWN vocabulary, so
  // this asks the structure instead — every key the manifest uses, at every depth.
  const keysOf = (value, found = new Set()) => {
    if (Array.isArray(value)) value.forEach((entry) => keysOf(entry, found));
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        found.add(key);
        keysOf(entry, found);
      }
    }
    return found;
  };
  assert.deepEqual(
    [...keysOf(manifest)].sort(),
    ['class', 'classVariables', 'classes', 'format', 'identity', 'instanceVariables', 'methods', 'name', 'package',
      'packages', 'requires', 'selector', 'side', 'source', 'superclass', 'superclassName'],
    'the canonical manifest uses only semantic vocabulary — no oop, offset or address',
  );

  // The pinned bytes, hashed here. Both packages: the application this harness imports, and the
  // upstream TEST package that makes the oracle path below upstream-authored rather than invented
  // — YAXOTest>>test01 already parses through the same public entry point and asserts the same
  // traversal shape.
  const yaxoBytes = await readFile(process.env.LAGRANGE_CUIS_YAXO_PACKAGE_PATH);
  assert.equal(yaxoBytes.length, 90_791);
  assert.equal(CUIS_YAXO_IDENTITY, `cuis-package/YAXO/${CUIS_COMMIT}/${gitBlobIdentity(yaxoBytes)}`, 'the pinned YAXO blob, re-hashed');
  const testsBytes = await readFile(process.env.LAGRANGE_CUIS_TESTS_YAXO_PACKAGE_PATH);
  assert.equal(testsBytes.length, 15_785);
  assert.equal(CUIS_TESTS_YAXO_IDENTITY, `cuis-package/Tests-YAXO/${CUIS_COMMIT}/${gitBlobIdentity(testsBytes)}`, 'the pinned Tests-YAXO blob, re-hashed');

  const upstreamTests = testsBytes.toString('utf8');
  assert.ok(upstreamTests.includes('xmlDocument _ XMLDOMParser parseDocumentFrom: self exampleString01 readStream.'));
  assert.ok(upstreamTests.includes('self assert: element name = #note.'));
  assert.ok(upstreamTests.includes("self assert: heading contents first string = 'Reminder'."));
});

// THE MEASURED M4 ORACLE. Every fact below was EXECUTED against the pinned real Cuis image with the
// pinned real YAXO package installed, through the provider's `yaxo/measure` operation — it is not
// read off the package source, and it is deliberately narrow: what the public parse operation
// answers, what class the root is, how a child is reached, how text and an attribute are read, and
// what the package's own smallest mutation does. It is an oracle only; native execution never calls
// it. Nothing here claims general XML correctness.
const M4_ORACLE = Object.freeze({
  // the Cuis base-image dependency at the current native-import frontier. This records the class,
  // the species of its empty instance, and the exact stream/result behavior rather than inferring
  // any of them from the spelling `UnicodeString writeStream` in YAXO source.
  unicodeStringClassName: 'UnicodeString',
  unicodeStringSuperclassName: 'CharacterSequence',
  unicodeStringEmptyClass: 'UnicodeString',
  unicodeStringEmptySpecies: 'UnicodeString',
  unicodeStringRespondsToWriteStream: 'true',
  unicodeStringWriteStreamClass: 'Utf8EncodedWriteStream',
  unicodeStringWriteStreamSuperclass: 'WriteStream',
  unicodeStringWriteStreamUnderstandsNextPut: 'true',
  unicodeStringWriteStreamUnderstandsReset: 'true',
  unicodeStringEmptyContentsClass: 'UnicodeString',
  unicodeStringEmptyContentsSize: '0',
  unicodeStringEmptyContentsPrint: "''",
  unicodeStringEmptyContentsFresh: 'true',
  unicodeStringWriteAnswerIsStream: 'true',
  unicodeStringWrittenContentsClass: 'UnicodeString',
  unicodeStringWrittenContentsSize: '1',
  unicodeStringWrittenCodePoint: '955',
  unicodeStringWrittenContentsFresh: 'true',
  unicodeStringResetAnswerIsStream: 'true',
  unicodeStringResetContentsClass: 'UnicodeString',
  unicodeStringResetContentsSize: '0',
  // The distinct `UnicodeString streamContents:` pressure is implemented by UnicodeString class
  // itself in the pinned image. These expected values are deliberately filled from the live oracle
  // rather than inferred from that source: they distinguish block answer, stream protocol,
  // Unicode behavior, empty writes, error propagation, and the relation to writeStream/contents.
  unicodeStringStreamContentsOwnerIsUnicodeStringClass: 'true',
  unicodeStringStreamContentsEmptyClass: 'UnicodeString',
  unicodeStringStreamContentsEmptySize: '0',
  unicodeStringStreamContentsEmptyIsEmpty: 'true',
  unicodeStringStreamContentsAscii: 'A',
  unicodeStringStreamContentsAsciiClass: 'UnicodeString',
  unicodeStringStreamContentsUnicodeCodePoint: '955',
  unicodeStringStreamContentsUnicodeClass: 'UnicodeString',
  unicodeStringStreamContentsSupplementaryCodePoint: '128512',
  unicodeStringStreamContentsSupplementaryClass: 'UnicodeString',
  unicodeStringStreamContentsBlockAnswerIgnored: 'true',
  unicodeStringStreamContentsMultiple: 'abλ😀',
  unicodeStringStreamContentsMultipleIsEmpty: 'false',
  unicodeStringStreamContentsEmptyWriteEqualsNoWrite: 'true',
  unicodeStringStreamContentsEmptyWriteIdenticalToNoWrite: 'false',
  unicodeStringStreamContentsStreamClass: 'Utf8EncodedWriteStream',
  unicodeStringStreamContentsStreamUnderstandsNextPut: 'true',
  unicodeStringStreamContentsStreamUnderstandsNextPutAll: 'true',
  unicodeStringStreamContentsStreamUnderstandsContents: 'true',
  unicodeStringStreamContentsStreamMatchesWriteStreamClass: 'true',
  unicodeStringStreamContentsMatchesWriteStreamContents: 'true',
  unicodeStringStreamContentsMatchesWriteStreamContentsClass: 'true',
  unicodeStringStreamContentsRaisedClass: 'Error',
  unicodeStringStreamContentsRaisedMessage: 'xxm.11-marker',
  // Direct element writes on the exact UnicodeString-backed stream yielded to YAXO. These are
  // deliberately separate from the earlier chunk-write oracle: return identity, scalar handling,
  // mixed ordering and the actual XMLTokenizer-produced Character are all measured here.
  nextPutOwner: 'Utf8EncodedWriteStream',
  nextPutAnswerIsWrittenCharacter: 'false',
  nextPutAnswerIsStream: 'true',
  nextPutAnswerClass: 'Utf8EncodedWriteStream',
  nextPutEmptyBeforeClass: 'UnicodeString',
  nextPutEmptyBeforeSize: '0',
  nextPutAsciiContentsClass: 'UnicodeString',
  nextPutAsciiContents: 'A',
  nextPutUnicodeContentsClass: 'UnicodeString',
  nextPutUnicodeCodePoint: '955',
  nextPutSupplementaryContentsClass: 'UnicodeString',
  nextPutSupplementaryCodePoint: '128512',
  nextPutPairContents: 'Aλ',
  nextPutMixedContents: 'Abcλ',
  nextPutEqualsSingleCharacterNextPutAll: 'true',
  nextPutMatchesSingleCharacterNextPutAllClass: 'true',
  nextPutEmptyAfterClass: 'UnicodeString',
  nextPutEmptyAfterSize: '0',
  nextPutEmptyBeforeEqualsAfter: 'true',
  yaxoNextPutCharacterClass: 'Character',
  yaxoNextPutCharacterIsSeparator: 'true',
  yaxoNextPutContentsClass: 'UnicodeString',
  yaxoNextPutContents: ' ',
  // Character literal semantics at the exact source/consumer boundary. The literal is neither a
  // one-character String nor an Integer code point. String indexing, String streaming and the real
  // XMLTokenizer>>peek path all answer the same canonical Character identity as `$<`.
  characterLiteralClass: 'Character',
  characterLiteralCodePoint: '60',
  characterLiteralEqualsOneCharacterString: 'false',
  characterLiteralEqualsIntegerCodePoint: 'false',
  characterLiteralAsStringClass: 'String',
  characterLiteralAsStringEqualsString: 'true',
  indexedCharacterClass: 'Character',
  indexedCharacterEqualsLiteral: 'true',
  indexedCharacterIdenticalToLiteral: 'true',
  streamCharacterClass: 'Character',
  streamCharacterEqualsLiteral: 'true',
  streamCharacterIdenticalToLiteral: 'true',
  tokenizerPeekClass: 'Character',
  tokenizerPeekCodePoint: '60',
  tokenizerPeekEqualsLiteral: 'true',
  tokenizerPeekIdenticalToLiteral: 'true',
  // The scanner is not ASCII-specialized: direct BMP and supplementary literals agree with the
  // corresponding UnicodeString stream results.
  unicodeCharacterLiteralClass: 'Character',
  unicodeCharacterLiteralCodePoint: '955',
  unicodeStreamCharacterClass: 'Character',
  unicodeStreamCharacterEqualsLiteral: 'true',
  unicodeStreamCharacterIdenticalToLiteral: 'true',
  supplementaryCharacterLiteralCodePoint: '128512',
  supplementaryStreamCharacterEqualsLiteral: 'true',
  supplementaryStreamCharacterIdenticalToLiteral: 'true',
  // Character>>isSeparator is exactly the pinned seven-member classification, not Unicode
  // White_Space and not a control-character range. These values are produced by the same
  // Character class that XMLTokenizer>>peek supplies to nextWhitespace.
  separatorSpace: 'true',
  separatorTab: 'true',
  separatorLineFeed: 'true',
  separatorCarriageReturn: 'true',
  separatorFormFeed: 'true',
  separatorNoBreakSpace: 'true',
  separatorZeroWidthSpace: 'true',
  separatorNull: 'false',
  separatorVerticalTab: 'false',
  separatorEscape: 'false',
  separatorLatinA: 'false',
  separatorNextLine: 'false',
  separatorEnSpace: 'false',
  separatorZeroWidthNonJoiner: 'false',
  separatorSupplementary: 'false',
  // Lexically `$` consumes exactly one following Unicode code point, including whitespace and
  // punctuation, with no escape convention. At physical EOF Cuis exposes its U+001A scanner end
  // marker as the consumed Character. Strings/comments retain their ordinary boundaries.
  characterLiteralConsumesOneSourceCharacter: 'true',
  characterLiteralSpaceCodePoint: '32',
  characterLiteralDollarCodePoint: '36',
  characterLiteralApostropheCodePoint: '39',
  characterLiteralQuoteCodePoint: '34',
  characterLiteralNCodePoint: '110',
  characterLiteralLineFeedCodePoint: '10',
  bareDollarAtEndClass: 'Character',
  bareDollarAtEndPrint: 'Character value: 26',
  bareDollarAtEndIsCharacter: 'true',
  bareDollarAtEndCodePoint: '26',
  dollarInCommentLeavesLiteral: 'true',
  dollarInStringStaysText: '$<',
  // Pinned Cuis ProtoObject>>~~ is ordinary source composition: it sends `==` and answers the
  // Boolean complement. Cuis marks its primitive `==` "No Lookup", so the transient override is
  // deliberately ignored by that VM. The native image differs at exactly that already-decided
  // boundary: its `==` is an ordinary overridable method, and native `~~` must compose with it.
  identityInequalityOwner: 'ProtoObject',
  identityInequalitySameObject: 'false',
  identityInequalityDistinctObjects: 'true',
  identityInequalitySameInteger: 'false',
  identityInequalityDifferentIntegers: 'true',
  identityInequalitySameCharacter: 'false',
  identityInequalityDifferentCharacters: 'true',
  identityInequalitySameUnicodeCharacter: 'false',
  identityInequalityNil: 'false',
  identityInequalityEqualDistinctTextEquality: 'true',
  identityInequalityEqualDistinctTextIdentity: 'false',
  identityInequalityEqualDistinctText: 'true',
  identityInequalityDispatchOverrideEquals: 'false',
  identityInequalityDispatchOverrideComplement: 'true',
  // the public parse operation and what it answers
  parseAnswerClass: 'XMLDocument',
  documentElementsClass: 'OrderedCollection',
  documentElementsSize: '1',
  // the root element, named by an interned Symbol rather than by text
  rootClass: 'XMLElement',
  rootName: '#note',
  rootNameClass: 'Symbol',
  rootElementsSize: '1',
  // how a child relationship is traversed, and that traversal answers the SAME object
  childByNameClass: 'XMLElement',
  childName: '#to',
  childIsSameObjectAsFirstChild: 'true',
  // how text is read: a child node, not a slot on the element
  childContentsClass: 'OrderedCollection',
  childContentsSize: '1',
  childContentsFirstClass: 'XMLStringNode',
  childContentString: 'Tove',
  childContentStringClass: 'UnicodeString',
  // how an attribute is read. The PARSED key is a UnicodeString, yet both a String and a Symbol
  // key find it — measured, and worth knowing before any native Dictionary/Symbol claim is made.
  rootAttributesClass: 'Dictionary',
  rootAttributesSize: '1',
  rootAttributeKeyClass: 'UnicodeString',
  rootAttributeReadByString: "'en'",
  rootAttributeReadBySymbol: "'en'",
  // the smallest ordinary mutation the package's own object semantics offer. `attributeAt:put:`
  // interns the key, so writing #lang REPLACES the parsed entry rather than adding a second one,
  // the element keeps its identity, and the rest of the graph does not move.
  mutatedAttributesSize: '1',
  mutatedReadBySymbol: "'sv'",
  mutatedReadByString: "'sv'",
  mutatedRootIsSameObject: 'true',
  mutatedChildContentString: 'Tove',
  // and the package's own serialisation of the mutated document
  canonicalAfterMutation: '<note lang="sv"><to>Tove</to></note>',
});

test('real Cuis is the M4 oracle for the smallest useful YAXO parsing path, and never the executor', {skip: !enabled, timeout: 300_000}, async () => {
  const provider = createOpenSmalltalkCuisProvider({
    vmPath: process.env.LAGRANGE_OPENSMALLTALK_VM_PATH,
    imagePath: process.env.LAGRANGE_CUIS_IMAGE_PATH,
    vmIdentity: VM_IDENTITY,
    imageIdentity: CUIS_IMAGE_IDENTITY,
    startupTimeoutMs: 120_000,
    callTimeoutMs: 60_000,
    stopTimeoutMs: 10_000,
  });
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [[OPENSMALLTALK_CUIS_PROVIDER_ID, provider]],
  });
  try {
    const instance = await runtime.foreignRuntimes.start({
      providerId: OPENSMALLTALK_CUIS_PROVIDER_ID,
      spec: {packages: [{path: process.env.LAGRANGE_CUIS_YAXO_PACKAGE_PATH, identity: CUIS_YAXO_IDENTITY}]},
    });
    const answer = await runtime.foreignRuntimes.call({
      runtimeId: instance.runtimeId,
      interface: {service: 'yaxo', operation: 'measure'},
      arguments: [textValue(M4_DOCUMENT)],
    });
    assert.equal(answer.kind, 'text');
    const measured = Object.fromEntries(
      answer.value.split('\n').filter((line) => line.length > 0).map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
    );
    assert.deepEqual(measured, {...M4_ORACLE}, 'the recorded M4 oracle, measured against real Cuis');
  } finally {
    await runtime.close();
  }
});

async function nativeRuntime() {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  assert.deepEqual(runtime.toolchainProviders.list(), [], 'the native runtime has no Cuis toolchain provider');
  assert.deepEqual(runtime.foreignRuntimeProviders.list(), [], 'the native runtime has no foreign runtime fallback');
  await runtime.images.createImage({id: 'native-image'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', lane: 'wasm',
  });
  return runtime;
}

test('the real pinned XMLTokenizer initializer executes with ordinary native text-backed streams', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const initialize = manifest.methods.find(({identity}) => identity === M4_TOKENIZER_INITIALIZE);
  assert.equal(
    initialize.source,
    'initialize\n\tparsingMarkup _ false.\n\tvalidating _ false.\n\tattributeBuffer _ UnicodeString writeStream.\n\tnameBuffer _ UnicodeString writeStream.',
    'the executable proof uses the unedited canonical upstream method',
  );

  const runtime = await nativeRuntime();
  try {
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [M4_TOKENIZER_INITIALIZE]},
    });
    const tokenizer = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');

    // A native probe method reads the state the REAL initializer assigned. It uses only the
    // ordinary stream protocol already owned by the native standard image; neither the adapter nor
    // the test reaches into the compiled method or the instance's graph slots.
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: tokenizer.classRef,
      lane: 'wasm',
      methods: [{
        selector: 'lagrangeBufferProbe',
        source: `[
          attributeBuffer nextPutAll: 'λ'.
          nameBuffer nextPutAll: 'name'.
          ^ (attributeBuffer contents = 'λ') and: [ nameBuffer contents = 'name' ]
        ]`,
      }],
    });
    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-real-tokenizer-initialize-probe',
      source: '[ XMLTokenizer new lagrangeBufferProbe ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', block.id), [],
      )),
      booleanValue(true),
      'both buffers were assigned, accepted Unicode text and read it back through native behavior',
    );
    const globals = await globalDeclarations({images: runtime.images, imageId: 'native-image'});
    assert.equal(Object.hasOwn(globals, 'UnicodeString'), false, 'execution required no class alias');
  } finally {
    await runtime.close();
  }
});

// Step one of the vertical, and the instrument that keeps the RED below honest: if the DOM class
// graph itself could not be constructed, a refusal on the entry-point method would say nothing
// about the method. It can be, so it does.
test('the M4 minimum import scope constructs the real DOM class graph natively with Cuis gone', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());

  const runtime = await nativeRuntime();
  try {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    const scope = {classes: [...M4_SCOPE_CLASSES], methods: []};
    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });
    assert.deepEqual(imported.classes.map(({identity}) => identity).sort(), [...M4_SCOPE_CLASSES]);

    // The real inheritance the package declares, as ordinary native Behavior edges: three levels
    // down to the DOM leaf classes, rooted in the one mapped structural identity.
    const behaviorOf = async (identity) => await readBehavior(
      runtime.images, imported.classes.find((entry) => entry.identity === identity).classRef,
    );
    const classRefOf = (identity) => imported.classes.find((entry) => entry.identity === identity).classRef;
    assert.deepEqual((await behaviorOf('cuis-class/YAXO/XMLNode')).superclass, kernel.objectClass);
    assert.deepEqual(
      (await behaviorOf('cuis-class/YAXO/XMLNodeWithElements')).superclass,
      classRefOf('cuis-class/YAXO/XMLNode'),
    );
    assert.deepEqual(
      (await behaviorOf('cuis-class/YAXO/XMLElement')).superclass,
      classRefOf('cuis-class/YAXO/XMLNodeWithElements'),
    );
    assert.deepEqual(
      (await behaviorOf('cuis-class/YAXO/XMLDOMParser')).superclass,
      classRefOf('cuis-class/YAXO/SAXHandler'),
    );

    // The upstream declared layouts, by name and in order, on the classes whose instances ARE the
    // M4 application graph.
    const layoutOf = async (identity) => {
      const {instanceShape} = await behaviorOf(identity);
      const shape = await runtime.images.getShape(instanceShape.imageId, instanceShape.objectId);
      return shape.slots.map(({name}) => name);
    };
    assert.deepEqual(await layoutOf('cuis-class/YAXO/XMLElement'), ['elements', 'uri', 'namespace', 'name', 'contents', 'attributes']);
    assert.deepEqual(await layoutOf('cuis-class/YAXO/XMLDocument'), ['elements', 'uri', 'namespace', 'dtd', 'version', 'encoding', 'requiredMarkup']);
    assert.deepEqual(await layoutOf('cuis-class/YAXO/XMLStringNode'), ['string']);

    // A declaration the scope omits is not constructed: the DTD, namespace, writer and exception
    // classes are in the same canonical manifest and stay absent, and with them the unmapped
    // Error/Warning superclass identities this slice does not need.
    for (const name of ['XMLWriter', 'XMLNamespaceScope', 'XMLParser', 'DTDEntityDeclaration', 'XMLException', 'SAXWarning']) {
      assert.equal(await runtime.images.getObject('native-image', `smalltalk/class/${name}`), null, `${name} stays absent`);
    }

    const frontierBeforeReplay = await runtime.images.frontier('native-image');
    const replayed = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });
    assert.deepEqual(replayed, imported);
    assert.equal(
      await runtime.images.frontier('native-image'),
      frontierBeforeReplay,
      'exact replay of the M4 class scope is write-free',
    );
  } finally {
    await runtime.close();
  }
});

// ==================================================================================================
// THE FIRST RED IS REPAIRED, AND THE VERTICAL MOVED ON. (ADR 0089, bead lagrange-images-xxm.1)
//
// The vertical's first RED was `unbound Symmetric Smalltalk name: super`, recorded here by the
// previous slice: the package's own public entry point opens with a real super send, and native
// Symmetric Smalltalk had none. ADR 0006 had deferred it explicitly ("inheritance and `super`").
// ADR 0089 implements it at the language owner — `super` is a reserved pseudo-variable, `self` is
// unchanged, and lookup starts above the running method's DEFINING Behavior — with nothing added to
// the Cuis adapter, nothing changed in the canonical export, and no YAXO-shaped case anywhere.
//
// This file's job is unchanged: carry the vertical to its FIRST unsupported native semantic and stop
// there. So the section below proves the entry point imports, and records the NEXT first RED.
const M4_INHERITED_ENTRY_POINT = 'cuis-method/YAXO/SAXHandler/class/parseDocumentFrom:';

test('the M4 entry point and the implementation its super send names now import natively', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());

  // The unedited upstream material, re-asserted here so the import below cannot be passing on
  // something this repository wrote.
  const entry = manifest.methods.find(({identity}) => identity === M4_ENTRY_POINT);
  assert.equal(entry.source, M4_ENTRY_POINT_UPSTREAM_SOURCE);
  assert.ok(entry.source.includes('^(super parseDocumentFrom: aStream) document'));
  const inherited = manifest.methods.find(({identity}) => identity === M4_INHERITED_ENTRY_POINT);
  assert.equal(inherited.class, 'cuis-class/YAXO/SAXHandler');
  assert.equal(inherited.side, 'class');

  const runtime = await nativeRuntime();
  try {
    // The MINIMUM import scope for the one measured path: the DOM/parse class graph, the public
    // entry point, and the class-side implementation its super send actually resolves to. A super
    // send is only meaningful when the overridden implementation exists, and it does — in the same
    // canonical manifest, on a class already in this scope.
    const scope = {
      classes: [...M4_SCOPE_CLASSES],
      methods: [M4_ENTRY_POINT, M4_INHERITED_ENTRY_POINT],
    };
    await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });

    // Both are installed as ordinary native methods, and exact replay stays write-free — the import
    // rule ADR 0085 keeps for everything else holds for a method containing a super send too.
    const frontier = await runtime.images.frontier('native-image');
    await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'native-image', manifest, scope,
    });
    assert.equal(await runtime.images.frontier('native-image'), frontier, 'exact replay is write-free');
  } finally {
    await runtime.close();
  }
});

// THE SECOND INSTRUMENT, at the seam the gap actually belonged to, and now green.
//
// The E3 lesson is that a spy on the wrong seam can look convincing for rounds: watching the IMPORT
// is watching the messenger, and an implementation that "fixed" the first RED by rewriting `super`
// to `self` inside the adapter would make the import test above pass while silently changing which
// method the package calls. So this leg names no Cuis material at all. It declares an ordinary
// native class, hands the ORDINARY native method compiler bodies written here, and proves the
// SEMANTIC rather than the compile: the super send must answer the SUPERCLASS implementation.
//
// Deliberately NOT gated on the integration environment. It needs no Cuis image, no VM and no
// package — gating it would mean the owner-level claim only ran in the lane that cannot make it.
test('super works at the native language owner, not by anything at the Cuis import boundary', async () => {
  const runtime = await nativeRuntime();
  try {
    const parent = await ensureClassFromDeclaration({
      images: runtime.images, imageId: 'native-image', name: 'M4SuperSendProbeParent', instanceVariables: [],
    });
    const child = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4SuperSendProbe',
      superclassRef: parent.classRef,
      instanceVariables: [],
    });
    const defineMethod = async (classRef, selector, body) => await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef,
      lane: 'wasm',
      methods: [{selector, source: `[\n${body}\nself\n]`}],
    });

    await defineMethod(parent.classRef, 'probe', '^ 41.');
    // The identical body with `self` still compiles, so nothing below is an accident of body shape.
    await defineMethod(child.classRef, 'probeSelf', '^ self probe.');
    // ... and the one that used to be refused with `unbound Symmetric Smalltalk name: super`.
    await defineMethod(child.classRef, 'probeSuper', '^ super probe.');

    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'native-image', id: 'm4-super-probe', source: '[ :k | k basicNew probeSuper ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(
        await runtime.invocations.invokeBlock(objectRef('native-image', block.id), [child.classRef]),
      ),
      integerValue(41),
      'the super send answered the SUPERCLASS implementation, which a rewrite to `self` could not',
    );
  } finally {
    await runtime.close();
  }
});

// ==================================================================================================
// xxm.11: the distinct class-side `UnicodeString streamContents:` pressure has now been measured
// rather than folded into xxm.9. Only that foreign receiver name is normalized; the generic
// evaluate-Block-and-answer-contents protocol is native Text/WriteStream behavior. The real method
// below must both import and execute before this slice can classify the next unsupported semantic.

// The measured parse path in causal order, from the public entry point. Every entry is upstream
// material in the canonical manifest; `XMLTokenizer>>saxHandler:` is deliberately absent from the
// list because the package does not declare it.
const M4_PARSE_PATH = Object.freeze([
  M4_ENTRY_POINT,
  M4_INHERITED_ENTRY_POINT,
  'cuis-method/YAXO/SAXHandler/class/on:',
  'cuis-method/YAXO/XMLTokenizer/class/on:',
  'cuis-method/YAXO/SAXDriver/instance/initialize',
  M4_TOKENIZER_INITIALIZE,
  'cuis-method/YAXO/XMLTokenizer/instance/parseStream:',
  'cuis-method/YAXO/XMLTokenizer/instance/stream:',
  'cuis-method/YAXO/XMLTokenizer/instance/validating:',
  'cuis-method/YAXO/XMLDOMParser/instance/initialize',
  'cuis-method/YAXO/SAXHandler/instance/initialize',
  'cuis-method/YAXO/SAXHandler/instance/driver:',
  'cuis-method/YAXO/SAXDriver/instance/saxHandler:',
  'cuis-method/YAXO/XMLDOMParser/instance/startDocument',
  'cuis-method/YAXO/SAXHandler/instance/document:',
  'cuis-method/YAXO/SAXHandler/instance/document',
  'cuis-method/YAXO/XMLDOMParser/instance/push:',
  'cuis-method/YAXO/SAXHandler/instance/parseDocument',
  'cuis-method/YAXO/SAXHandler/instance/driver',
  'cuis-method/YAXO/XMLTokenizer/instance/nextEntity',
  'cuis-method/YAXO/XMLTokenizer/instance/nextWhitespace',
  // Causal order, not source order: `nextWhitespace` is reached first and its separator loop is
  // what sends `self next`. The package owns both methods; with
  // `ifNil:ifNotNil:` installed (xxm.16) the loop completes through the pair.
  M4_NEXT_METHOD,
  M4_PEEK_METHOD,
]);
const M4_NEXT_RED_METHOD = 'cuis-method/YAXO/XMLTokenizer/instance/nextWhitespace';

// The complete M4 acceptance is the scheduler. Keep the restart/identity/behavior tail intact
// when an earlier import or execution step exposes the next owner-local RED.
const M4_APPLICATION_METHODS = Object.freeze([...new Set([
  ...M4_PARSE_PATH,
  'cuis-method/YAXO/XMLTokenizer/class/initialize',
  'cuis-method/YAXO/XMLDOMParser/instance/stack',
  'cuis-method/YAXO/XMLNodeWithElements/instance/elements',
  'cuis-method/YAXO/XMLElement/instance/contents',
  'cuis-method/YAXO/XMLElement/instance/attributes',
  'cuis-method/YAXO/XMLElement/instance/attributeAt:',
  'cuis-method/YAXO/XMLElement/instance/attributeAt:ifAbsent:',
  'cuis-method/YAXO/XMLElement/instance/attributeAt:put:',
  'cuis-method/YAXO/XMLStringNode/instance/string',
])]);

test('M4 acceptance: complete durable restart vertical currently stops at the omitted YAXO atEnd method', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const directory = await mkdtemp(join(tmpdir(), 'yaxo-m4-'));
  try {
    // Temporary exact RED assertion, not an M4 success claim. Importing the reached YAXO atEnd must move this
    // assertion; the complete intended flow lives in runM4Acceptance and is never shortened.
    await assert.rejects(runM4Acceptance(join(directory, 'application.sqlite'), manifest, {
      classes: [...M4_SCOPE_CLASSES], methods: [...M4_APPLICATION_METHODS],
    }), {
      name: 'SmalltalkMessageNotUnderstoodError', selector: 'atEnd',
      message: /^Symmetric Smalltalk message not understood: atEnd sent to yaxo-m4\/~runtime\/transient\/object\//,
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('the repaired M4 forcing scope imports unchanged UnicodeString streamContents: without an alias', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());

  const runtime = await nativeRuntime();
  try {
    await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [...M4_PARSE_PATH]},
    });

    // The real newly reached consumer, named, and unedited upstream source.
    const nextWhitespace = manifest.methods.find(({identity}) => identity === M4_NEXT_RED_METHOD);
    assert.equal(
      nextWhitespace.source,
      'nextWhitespace\n\t| nextChar resultString|\n\tresultString _ UnicodeString streamContents: [ :strm |\n\t\t[ ((nextChar _ self peek) ~~ nil) and: [nextChar isSeparator] ]\n\t\t\twhileTrue: [strm nextPut: nextChar. self next].\n\t\t(nestedStreams == nil or: [self atEnd not])\n\t\t\tifFalse: [self checkNestedStream.\n\t\t\t\t\tself nextWhitespace].\n\t].\n\tresultString isEmpty ifFalse: [self handleWhitespace: resultString].',
    );

    // Package classes really are imported and now published through the ordinary root namespace.
    assert.ok(M4_SCOPE_CLASSES.includes('cuis-class/YAXO/SAXDriver'));
    assert.ok(
      await runtime.images.getObject('native-image', 'smalltalk/class/SAXDriver'),
      'SAXDriver is an ordinary native class in this image',
    );
    const globals = await globalDeclarations({images: runtime.images, imageId: 'native-image'});
    assert.ok(Object.hasOwn(globals, 'OrderedCollection'), 'base classes are published globals');
    assert.ok(Object.hasOwn(globals, 'SAXDriver'), 'an imported class is published before methods compile');
    assert.equal(Object.hasOwn(globals, 'UnicodeString'), false, 'the repaired idiom created no class alias');
  } finally {
    await runtime.close();
  }
});

test('unchanged pinned XMLTokenizer nextWhitespace observes the empty Text result natively', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const nextWhitespace = manifest.methods.find(({identity}) => identity === M4_NEXT_RED_METHOD);
  assert.equal(
    nextWhitespace.source,
    'nextWhitespace\n\t| nextChar resultString|\n\tresultString _ UnicodeString streamContents: [ :strm |\n\t\t[ ((nextChar _ self peek) ~~ nil) and: [nextChar isSeparator] ]\n\t\t\twhileTrue: [strm nextPut: nextChar. self next].\n\t\t(nestedStreams == nil or: [self atEnd not])\n\t\t\tifFalse: [self checkNestedStream.\n\t\t\t\t\tself nextWhitespace].\n\t].\n\tresultString isEmpty ifFalse: [self handleWhitespace: resultString].',
    'the executed method is the unchanged pinned source',
  );

  const runtime = await nativeRuntime();
  try {
    const productBinding = (await methodBindings({
      images: runtime.images,
      imageId: 'native-image',
      classRef: objectRef('native-image', 'smalltalk/class/Object'),
    })).find(({selector}) => selector === '~~');
    assert.ok(productBinding, 'the standard image installs the product Object>>~~ protocol');
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [M4_NEXT_RED_METHOD]},
    });
    const tokenizer = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');
    const bindingAfterImport = (await methodBindings({
      images: runtime.images,
      imageId: 'native-image',
      classRef: objectRef('native-image', 'smalltalk/class/Object'),
    })).find(({selector}) => selector === '~~');
    assert.deepEqual(
      bindingAfterImport,
      productBinding,
      'the YAXO fixture neither replaces nor supplies its own identity-inequality method',
    );
    const probe = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4EmptyWhitespaceProbe',
      superclassRef: tokenizer.classRef,
      instanceVariables: ['lagrangeHandledWhitespace'],
    });
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: probe.classRef,
      lane: 'wasm',
      methods: [
        {selector: 'peek', source: '[ ^ nil ]'},
        {selector: 'handleWhitespace:', source: '[ :text | lagrangeHandledWhitespace := true. ^ self ]'},
        {selector: 'exercise', source: '[ lagrangeHandledWhitespace := false. self nextWhitespace. ^ lagrangeHandledWhitespace ]'},
      ],
    });
    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-empty-whitespace-execution',
      source: '[ :class | class basicNew exercise ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', block.id), [probe.classRef],
      )),
      booleanValue(false),
      'the empty native Text result is observed through isEmpty and never delivered as whitespace',
    );
  } finally {
    await runtime.close();
  }
});

// xxm.15/xxm.16: this acceptance previously defined a synthetic probe `next` (advance a position,
// answer self) — legitimate while `nextPut:` was the target, and the wrong implementation once the
// claim is the package's own `XMLTokenizer>>next`. The bridge is deleted and the canonical
// identities `cuis-method/YAXO/XMLTokenizer/instance/next` and `.../peek` are imported. Structural
// assertions prove which binding `self next` resolves to: the imported package method on
// XMLTokenizer, never a probe-local override and never a generic/native `next` (none exists — no
// `Object>>next`, no `WriteStream>>next`; with the imported method present the run test below
// completes, and the control test still shows the unscoped image raising MNU `next`).
test('unchanged nextWhitespace delivers separator accumulation through the imported package tokenizing pair', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const pinnedNext = manifest.methods.find(({identity}) => identity === M4_NEXT_METHOD);
  assert.equal(pinnedNext.source, M4_NEXT_UPSTREAM_SOURCE, 'the imported next is the unchanged pinned source');
  const pinnedPeek = manifest.methods.find(({identity}) => identity === M4_PEEK_METHOD);
  assert.equal(pinnedPeek.source, M4_PEEK_UPSTREAM_SOURCE, 'the imported peek is the unchanged pinned source');

  const runtime = await nativeRuntime();
  try {
    const characterClass = objectRef('native-image', 'smalltalk/class/Character');
    const productBinding = (await methodBindings({
      images: runtime.images,
      imageId: 'native-image',
      classRef: characterClass,
    })).find(({selector}) => selector === 'isSeparator');
    assert.ok(productBinding, 'the standard image installs product Character>>isSeparator');
    const writeStreamClass = objectRef('native-image', 'smalltalk/class/WriteStream');
    const nextPutBinding = (await methodBindings({
      images: runtime.images, imageId: 'native-image', classRef: writeStreamClass,
    })).find(({selector}) => selector === 'nextPut:');
    assert.ok(nextPutBinding, 'the standard image installs product WriteStream>>nextPut:');
    // No generic or stream-library `next` is added to make the MNU disappear (xxm.15 W1/W2).
    for (const classRef of [objectRef('native-image', 'smalltalk/class/Object'), writeStreamClass]) {
      assert.equal(
        (await methodBindings({images: runtime.images, imageId: 'native-image', classRef}))
          .find(({selector}) => selector === 'next'),
        undefined,
        `no native next binding exists on ${classRef.objectId}`,
      );
    }
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [M4_NEXT_RED_METHOD, M4_NEXT_METHOD, M4_PEEK_METHOD]},
    });
    assert.deepEqual(
      (await methodBindings({images: runtime.images, imageId: 'native-image', classRef: characterClass}))
        .find(({selector}) => selector === 'isSeparator'),
      productBinding,
      'the YAXO fixture neither replaces nor supplies Character classification',
    );
    assert.deepEqual(
      (await methodBindings({images: runtime.images, imageId: 'native-image', classRef: writeStreamClass}))
        .find(({selector}) => selector === 'nextPut:'),
      nextPutBinding,
      'the acceptance carries no test-local WriteStream bridge',
    );

    // The claimed bindings are the imported package methods: XMLTokenizer's own method dictionary
    // binds `next` and `peek` at the deterministic method identities the native class builder
    // derives for them.
    const tokenizer = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');
    for (const selector of ['next', 'peek']) {
      const binding = (await methodBindings({
        images: runtime.images, imageId: 'native-image', classRef: tokenizer.classRef,
      })).find(({selector: boundSelector}) => boundSelector === selector);
      assert.ok(binding, `the imported XMLTokenizer carries its own package ${selector} method`);
      assert.equal(
        binding.method.objectId,
        `smalltalk/class/XMLTokenizer/method/${Buffer.from(selector, 'utf8').toString('base64url')}`,
        `the ${selector} binding is the deterministic imported package method identity`,
      );
    }

    const probe = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4SeparatorBranchProbe',
      superclassRef: tokenizer.classRef,
      instanceVariables: ['lagrangeHandledWhitespace'],
    });
    const instrumentClass = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4StreamInstrument',
      superclassRef: objectRef('native-image', 'smalltalk/class/Object'),
      instanceVariables: ['lagrangeInput', 'lagrangePosition'],
    });
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: probe.classRef,
      lane: 'wasm',
      methods: [
        // The probe supplies OBSERVATION only: it wires the inherited `stream` slot to the
        // instrument and records what `handleWhitespace:` receives. The tokenizer's external
        // input is the instrument; the package's own `peek`/`next` read it.
        {selector: 'lagrangeStream:', source: '[ :aStream | stream := aStream. ^ self ]'},
        {
          selector: 'handleWhitespace:',
          source: '[ :text | lagrangeHandledWhitespace := text. ^ self ]',
        },
        {
          selector: 'exercise:',
          source: "[ :input | lagrangeHandledWhitespace := ''. self nextWhitespace. ^ lagrangeHandledWhitespace ]",
        },
      ],
    });
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: instrumentClass.classRef,
      lane: 'wasm',
      methods: [
        // A minimal position-advancing stand-in for the external input stream. `next` answers
        // the item at the current position and advances exactly one step; `lagrangeConsumed`
        // observes how many steps were taken.
        {
          selector: 'lagrangeInput:',
          source: '[ :input | lagrangeInput := input. lagrangePosition := 1. ^ self ]',
        },
        {
          selector: 'next',
          source: '[ | item | item := lagrangeInput at: lagrangePosition. lagrangePosition := lagrangePosition + 1. ^ item ]',
        },
        {selector: 'lagrangeConsumed', source: '[ ^ lagrangePosition - 1 ]'},
      ],
    });
    assert.equal(
      (await methodBindings({images: runtime.images, imageId: 'native-image', classRef: probe.classRef}))
        .find(({selector}) => selector === 'next'),
      undefined,
      'the probe subclass has no next binding of its own; self next resolves to the imported method',
    );

    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-separator-branch',
      source: `[ :tokenizerClass :instrumentClass :input | | tokenizer stream |
  stream := instrumentClass basicNew. stream lagrangeInput: input.
  tokenizer := tokenizerClass basicNew. tokenizer lagrangeStream: stream.
  tokenizer exercise: input ]`,
    });
    const run = async (input) => await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('native-image', block.id), [probe.classRef, instrumentClass.classRef, textValue(input)],
    ));
    assert.deepEqual(
      await run('AZ'),
      textValue(''),
      'a non-separator Character leaves the loop without delivering whitespace',
    );
    assert.deepEqual(
      await run(' A'),
      textValue(' '),
      'an ASCII separator is delivered as the exact accumulated native Text',
    );
    assert.deepEqual(
      await run('\u00a0A'),
      textValue('\u00a0'),
      'the pinned non-ASCII NBSP separator survives Character codePoint and UTF-8 reconstruction',
    );
    // The separator path wrote through product WriteStream>>nextPut:, then delegated through the
    // imported package `next` (cache answered, stream untouched) and re-peeked through the
    // imported package `peek` until a non-separator stopped the loop: exactly one stream read per
    // consumed character (peek) — the loop never consumed through both paths.
    const {block: consumedBlock} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-separator-consumption',
      source: `[ :tokenizerClass :instrumentClass :input | | tokenizer stream |
  stream := instrumentClass basicNew. stream lagrangeInput: input.
  tokenizer := tokenizerClass basicNew. tokenizer lagrangeStream: stream.
  tokenizer exercise: input.
  stream lagrangeConsumed ]`,
    });
    const consumed = async (input) => await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('native-image', consumedBlock.id), [probe.classRef, instrumentClass.classRef, textValue(input)],
    ));
    for (const [input, expected] of [['AZ', 1], [' A', 2], ['\u00a0A', 2]]) {
      assert.deepEqual(
        await consumed(input),
        integerValue(expected),
        `the unchanged loop reads the instrumented stream once per consumed character for ${JSON.stringify(input)}`,
      );
    }
  } finally {
    await runtime.close();
  }
});

// FALSIFICATION CONTROL for the dispatch proof above: the same probe shape, the same input, the
// same unchanged `nextWhitespace` — but with `cuis-method/YAXO/XMLTokenizer/instance/next` left
// OUT of the method scope. Only then is `next` missing and the run stops at it; with the package
// method imported, the same loop instead runs to completion (asserted above). If the separator
// proof ever passed through a bridge instead of the imported method, this pair could not disagree.
test('the unchanged nextWhitespace causal path exposes its next unsupported selector', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const runtime = await nativeRuntime();
  try {
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [M4_NEXT_RED_METHOD]},
    });
    const tokenizer = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');
    const probe = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4WhitespaceNextRedProbe',
      superclassRef: tokenizer.classRef,
      instanceVariables: ['lagrangeInput'],
    });
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: probe.classRef,
      lane: 'wasm',
      methods: [
        {selector: 'lagrangeInput:', source: '[ :input | lagrangeInput := input. ^ self ]'},
        {selector: 'peek', source: '[ ^ lagrangeInput at: 1 ]'},
      ],
    });
    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-whitespace-next-red',
      source: '[ :class :input | | tokenizer | tokenizer := class basicNew. tokenizer lagrangeInput: input. tokenizer nextWhitespace ]',
    });
    const error = await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('native-image', block.id), [probe.classRef, textValue(' ')],
    )).then(
      () => assert.fail('the unchanged causal path executed past its first unsupported post-classification selector'),
      (thrown) => thrown,
    );
    assert.equal(error.name, 'SmalltalkMessageNotUnderstoodError');
    assert.equal(error.selector, 'next');
    assert.match(error.message, /message not understood: next/);
  } finally {
    await runtime.close();
  }
});

// The imported method's OWN semantics, entered on BOTH of its materially different paths
// (xxm.15 classified the missing protocol; xxm.16 repaired `ifNil:ifNotNil:` at the
// standard-image owner and this test now proves the pinned behavior through ordinary native
// execution). The probe subclass exists only for setup/observation — it seeds the inherited
// `peekChar` slot, wires `stream`, and captures results — because the claim is the unchanged
// package method's behavior:
//
//   A. cached-peek entry   peekChar holds $A — the method answers the cache, clears it, and the
//                          instrumented stream is never touched (consumed stays 0);
//   B. uncached entry      peekChar is nil — the method delegates ONE step to the instrumented
//                          `stream next` and answers its value (consumed is exactly 1).
//
// Both entries run through the same two-keyword `peekChar ifNil: [...] ifNotNil: [...]` send the
// earlier slice saw fail; the zero-argument blocks observe exactly the pinned Cuis answers.
test('the imported XMLTokenizer next answers its cache without consuming and delegates one uncached step', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const pinnedNext = manifest.methods.find(({identity}) => identity === M4_NEXT_METHOD);
  assert.equal(pinnedNext.source, M4_NEXT_UPSTREAM_SOURCE, 'the executed method is the unchanged pinned source');

  const runtime = await nativeRuntime();
  try {
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [M4_NEXT_METHOD]},
    });
    const tokenizer = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');
    const probe = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4NextSemanticsProbe',
      superclassRef: tokenizer.classRef,
      instanceVariables: ['lagrangeAnswer', 'lagrangeStoredPeek', 'lagrangeStoredConsumed'],
    });
    const instrumentClass = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4NextStreamInstrument',
      superclassRef: objectRef('native-image', 'smalltalk/class/Object'),
      instanceVariables: ['lagrangeInput', 'lagrangePosition'],
    });
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: probe.classRef,
      lane: 'wasm',
      methods: [
        // Setup/observation only. The captured run stores the method's answer, the cache slot's
        // state afterwards and the instrument's read count, so each observable can be asserted
        // from one identical scenario without rebuilding hidden state.
        {selector: 'lagrangePeekChar:', source: '[ :character | peekChar := character. ^ self ]'},
        {selector: 'lagrangeStream:', source: '[ :aStream | stream := aStream. ^ self ]'},
        {selector: 'lagrangeAnswer', source: '[ ^ lagrangeAnswer ]'},
        {selector: 'lagrangeStoredPeek', source: '[ ^ lagrangeStoredPeek ]'},
        {selector: 'lagrangeStoredConsumed', source: '[ ^ lagrangeStoredConsumed ]'},
        {selector: 'nextCaptured',
          source: `[ | answer |
  answer := self next.
  lagrangeAnswer := answer.
  lagrangeStoredPeek := peekChar.
  lagrangeStoredConsumed := stream lagrangeConsumed.
  ^ self ]`},
      ],
    });
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: instrumentClass.classRef,
      lane: 'wasm',
      methods: [
        {
          selector: 'lagrangeInput:',
          source: '[ :input | lagrangeInput := input. lagrangePosition := 1. ^ self ]',
        },
        {
          selector: 'next',
          source: '[ | item | item := lagrangeInput at: lagrangePosition. lagrangePosition := lagrangePosition + 1. ^ item ]',
        },
        {selector: 'lagrangeConsumed', source: '[ ^ lagrangePosition - 1 ]'},
      ],
    });
    assert.equal(
      (await methodBindings({images: runtime.images, imageId: 'native-image', classRef: probe.classRef}))
        .find(({selector}) => selector === 'next'),
      undefined,
      'the observation subclass carries no next binding of its own',
    );

    // A. Cached-peek entry: the cache answers, then nothing else — stream consumes 0.
    const {block: cachedRunner} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-next-semantics-cached',
      source: `[ :tokenizerClass :instrumentClass | | tokenizer stream |
  stream := instrumentClass basicNew. stream lagrangeInput: \'ZZ\'.
  tokenizer := tokenizerClass basicNew. tokenizer lagrangeStream: stream.
  tokenizer lagrangePeekChar: $A.
  tokenizer nextCaptured.
  tokenizer lagrangeAnswer ]`,
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', cachedRunner.id), [probe.classRef, instrumentClass.classRef],
      )),
      objectRef('native-image', 'smalltalk/character/41'),
      'the cached-peek entry answers the cached Character',
    );
    const {block: cachedPeek} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-next-semantics-cached-peek',
      source: `[ :tokenizerClass :instrumentClass | | tokenizer stream |
  stream := instrumentClass basicNew. stream lagrangeInput: \'ZZ\'.
  tokenizer := tokenizerClass basicNew. tokenizer lagrangeStream: stream.
  tokenizer lagrangePeekChar: $A.
  tokenizer nextCaptured.
  tokenizer lagrangeStoredPeek ]`,
    });
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'native-image'});
    const cachedPeekAfter = await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('native-image', cachedPeek.id), [probe.classRef, instrumentClass.classRef],
    ));
    assert.deepEqual(cachedPeekAfter, kernel.nil, 'the cached entry leaves the cache cleared');
    const {block: cachedConsumed} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-next-semantics-cached-consumed',
      source: `[ :tokenizerClass :instrumentClass | | tokenizer stream |
  stream := instrumentClass basicNew. stream lagrangeInput: \'ZZ\'.
  tokenizer := tokenizerClass basicNew. tokenizer lagrangeStream: stream.
  tokenizer lagrangePeekChar: $A.
  tokenizer nextCaptured.
  tokenizer lagrangeStoredConsumed ]`,
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', cachedConsumed.id), [probe.classRef, instrumentClass.classRef],
      )),
      integerValue(0),
      'the cached-peek entry never touches the stream',
    );

    // B. Uncached entry: exactly one delegated stream read, answered as-is.
    const {block: uncachedRunner} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-next-semantics-uncached',
      source: `[ :tokenizerClass :instrumentClass | | tokenizer stream |
  stream := instrumentClass basicNew. stream lagrangeInput: \'AB\'.
  tokenizer := tokenizerClass basicNew. tokenizer lagrangeStream: stream.
  tokenizer nextCaptured.
  tokenizer lagrangeAnswer ]`,
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', uncachedRunner.id), [probe.classRef, instrumentClass.classRef],
      )),
      objectRef('native-image', 'smalltalk/character/41'),
      'the uncached entry answers the stream value',
    );
    const {block: uncachedConsumed} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-next-semantics-uncached-consumed',
      source: `[ :tokenizerClass :instrumentClass | | tokenizer stream |
  stream := instrumentClass basicNew. stream lagrangeInput: \'AB\'.
  tokenizer := tokenizerClass basicNew. tokenizer lagrangeStream: stream.
  tokenizer nextCaptured.
  tokenizer lagrangeStoredConsumed ]`,
    });
    assert.deepEqual(
      await runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('native-image', uncachedConsumed.id), [probe.classRef, instrumentClass.classRef],
      )),
      integerValue(1),
      'the uncached entry advances the instrumented stream exactly once',
    );
  } finally {
    await runtime.close();
  }
});

test('the real pinned XMLTokenizer nextEntity compares native indexed text with `$<` and takes the observable branch', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const nextEntityId = 'cuis-method/YAXO/XMLTokenizer/instance/nextEntity';
  const nextEntity = manifest.methods.find(({identity}) => identity === nextEntityId);
  assert.equal(
    nextEntity.source,
    'nextEntity\n\t"return the next XMLnode, or nil if there are no more"\n\n\t"branch, depending on what the first character is"\n\tself nextWhitespace.\n\tself atEnd ifTrue: [self handleEndDocument. ^ nil].\n\tself checkAndExpandReference: (self parsingMarkup ifTrue: [#dtd] ifFalse: [#content]).\n\t^self peek = $<\n\t\tifTrue: [self nextNode]\n\t\tifFalse: [self nextPCData]',
    'the executed method is the unchanged pinned YAXO consumer',
  );

  const runtime = await nativeRuntime();
  try {
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [nextEntityId]},
    });
    const tokenizer = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');
    const probe = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'native-image',
      name: 'M4CharacterBranchProbe',
      superclassRef: tokenizer.classRef,
      instanceVariables: ['lagrangeInput'],
    });
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      classRef: probe.classRef,
      lane: 'wasm',
      methods: [
        {selector: 'lagrangeInput:', source: '[ :input | lagrangeInput := input. self ]'},
        // This is the load-bearing producer: the compared value comes through ordinary native
        // Text indexing and therefore through the same Character interner as the literal.
        {selector: 'peek', source: '[ ^ lagrangeInput at: 1 ]'},
        {selector: 'nextWhitespace', source: '[ ^ self ]'},
        {selector: 'atEnd', source: '[ ^ false ]'},
        {selector: 'parsingMarkup', source: '[ ^ false ]'},
        {selector: 'checkAndExpandReference:', source: '[ :context | ^ self ]'},
        // Two different answers make the comparison branch observable.
        {selector: 'nextNode', source: '[ ^ true ]'},
        {selector: 'nextPCData', source: '[ ^ false ]'},
      ],
    });
    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-real-character-branch-probe',
      source: '[ :class :input | | tokenizer | tokenizer := class basicNew. tokenizer lagrangeInput: input. tokenizer nextEntity ]',
    });
    const run = async (input) => await runtime.executor.execute(await runtime.invocations.invokeBlock(
      objectRef('native-image', block.id), [probe.classRef, textValue(input)],
    ));
    assert.deepEqual(await run('<node'), booleanValue(true), '`$<` equals the Character read from indexed Text');
    assert.deepEqual(await run('plain text'), booleanValue(false), 'a different indexed Character takes the other branch');
  } finally {
    await runtime.close();
  }
});

// The strongest assignment proof uses the unchanged pinned application, not only a fixture.
// `SAXHandler>>document:` is the smallest real YAXO arrow method whose remaining semantics already
// work: it assigns one instance variable and sends nothing else. Import its ordinary getter beside
// it, execute the setter, and read through native behavior. This proves the translated arrow did
// not merely disappear or compile — it changed the intended native state.
test('a real pinned YAXO arrow method executes a native assignment and reads it back', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());
  const arrowMethods = manifest.methods.filter(({source}) => / _ /.test(source));
  assert.ok(arrowMethods.length > 50, `${arrowMethods.length} upstream methods assign with the legacy arrow`);
  const setterId = 'cuis-method/YAXO/SAXHandler/instance/document:';
  const getterId = 'cuis-method/YAXO/SAXHandler/instance/document';
  assert.equal(manifest.methods.find(({identity}) => identity === setterId).source, 'document: aDocument\n\tdocument _ aDocument');
  assert.equal(manifest.methods.find(({identity}) => identity === getterId).source, 'document\n\t^document');

  const runtime = await nativeRuntime();
  try {
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [setterId, getterId]},
    });
    const saxHandler = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/SAXHandler');
    const {block} = await installSymmetricSmalltalkBlock({
      images: runtime.images,
      imageId: 'native-image',
      id: 'm4-real-arrow-assignment-probe',
      source: '[ :class | | instance | instance := class basicNew. instance document: 41. instance document ]',
    });
    assert.deepEqual(
      await runtime.executor.execute(
        await runtime.invocations.invokeBlock(objectRef('native-image', block.id), [saxHandler.classRef]),
      ),
      integerValue(41),
      'the translated real YAXO arrow changed native state observed through ordinary native behavior',
    );
  } finally {
    await runtime.close();
  }
});

// The durable-restart vertical measured (bead lagrange-images-xg3) that the real parse path needs
// XMLTokenizer's four declared class variables, and that the canonical v2 export carried none. The
// export owner now carries classVariableNames (bead lagrange-images-9qf): the DECLARED NAMES cross
// the boundary as definition facts and are declared natively at import, while the class
// variables' VALUES never do — the package's own class-side initialize (imported as ordinary
// class-side code) populates them when the vertical executes it. No load-time-expression channel
// exists or is being added: the five top-level `initialize!` chunks stay outside the manifest.
test('the canonical v2 export carries class-variable names but no values and no load-time expressions', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());

  assert.deepEqual(Object.keys(manifest).sort(), ['classes', 'format', 'methods', 'packages']);
  for (const declaration of manifest.classes) {
    assert.deepEqual(
      Object.keys(declaration).sort(),
      ['classVariables', 'identity', 'instanceVariables', 'name', 'package', 'superclass', 'superclassName'],
      `${declaration.identity} declaration carries its class-variable definition`,
    );
  }
  // XMLTokenizer really does declare four class variables upstream, and the export now answers
  // exactly those names.
  const tokenizer = manifest.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');
  assert.deepEqual(
    [...tokenizer.classVariables].sort(),
    ['CharEscapes', 'DigitTable', 'LiteralChars', 'NameDelimiters'],
  );
  assert.equal(JSON.stringify(tokenizer.classVariables).includes('Set'), false, 'values never cross the export boundary');
  const tokenizerInit = manifest.methods.find(({identity}) => identity === 'cuis-method/YAXO/XMLTokenizer/class/initialize');
  for (const name of ['CharEscapes', 'LiteralChars', 'NameDelimiters', 'DigitTable']) {
    assert.ok(tokenizerInit.source.includes(`${name} _ `), `${name} is assigned by the upstream class-side initialize`);
  }
  // ... and nothing in the manifest represents the five top-level `initialize!` chunks that run it.
  assert.equal(JSON.stringify(manifest).includes('"expressions"'), false);
  assert.equal(JSON.stringify(manifest).includes('"loadTime"'), false);
});
