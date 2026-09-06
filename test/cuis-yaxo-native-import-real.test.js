import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
// boundary and the unchanged scope now stops at `UnicodeString` in `XMLTokenizer>>initialize`.
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
    const yaxoPackage = await put(buildRuntime, 'yaxo-pkg', CUIS_PACKAGE_V1, textValue(await readFile(process.env.LAGRANGE_CUIS_YAXO_PACKAGE_PATH, 'utf8')), {
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
    ['class', 'classes', 'format', 'identity', 'instanceVariables', 'methods', 'name', 'package',
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
// THE NEXT FIRST RED OF THE M4 VERTICAL, classified afresh after imported class publication and
// deliberately NOT repaired here.
//
// The exact forcing scope now compiles `SAXHandler class>>on:` through its ordinary `SAXDriver`
// global and reaches `XMLTokenizer>>initialize`, where upstream names a Cuis base-image class that
// this native image does not publish:
//
//     unbound Symmetric Smalltalk name: UnicodeString
//
// Unlike SAXDriver, UnicodeString is NOT declared by YAXO and therefore is not in the nine-class
// scope. It is a Cuis base-image dependency. Whether the right repair is a native library class,
// an exact adapter idiom, or something else requires its own oracle and owner decision; this test
// records only the newly measured pressure and does not prejudge that work.
//
// Not this slice's work. It is recorded so the next child starts from this repaired instrument's
// measurement rather than a prediction.
const M4_NEXT_RED = /unbound Symmetric Smalltalk name: UnicodeString/;

// The measured parse path in causal order, from the public entry point. Every entry is upstream
// material in the canonical manifest; `XMLTokenizer>>saxHandler:` is deliberately absent from the
// list because the package does not declare it.
const M4_PARSE_PATH = Object.freeze([
  M4_ENTRY_POINT,
  M4_INHERITED_ENTRY_POINT,
  'cuis-method/YAXO/SAXHandler/class/on:',
  'cuis-method/YAXO/XMLTokenizer/class/on:',
  'cuis-method/YAXO/XMLTokenizer/instance/initialize',
  'cuis-method/YAXO/XMLTokenizer/instance/parseStream:',
  'cuis-method/YAXO/XMLTokenizer/instance/validating:',
  'cuis-method/YAXO/SAXHandler/instance/initialize',
  'cuis-method/YAXO/XMLDOMParser/instance/initialize',
  'cuis-method/YAXO/SAXHandler/instance/driver:',
  'cuis-method/YAXO/SAXHandler/instance/startDocument',
]);
const M4_NEXT_RED_METHOD = 'cuis-method/YAXO/XMLTokenizer/instance/initialize';
const M4_PATH_BEFORE_NEXT_RED = Object.freeze(
  M4_PARSE_PATH.slice(0, M4_PARSE_PATH.indexOf(M4_NEXT_RED_METHOD)),
);

test('the repaired M4 forcing scope exposes its next RED afresh: UnicodeString is unbound', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());

  const runtime = await nativeRuntime();
  try {
    // Everything the measured path reaches BEFORE the refusal imports natively.
    await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [...M4_PATH_BEFORE_NEXT_RED]},
    });

    // Re-run the SAME forcing scope. It now passes the package-owned class names and refuses the
    // first base-image dependency the native namespace does not provide.
    const error = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'native-image',
      manifest,
      scope: {classes: [...M4_SCOPE_CLASSES], methods: [...M4_PARSE_PATH]},
    }).then(
      () => assert.fail('the repaired M4 forcing scope compiled past its first unresolved dependency'),
      (thrown) => thrown,
    );
    assert.match(error.message, M4_NEXT_RED);

    // The real consumer, named, and unedited upstream source.
    const initialize = manifest.methods.find(({identity}) => identity === M4_NEXT_RED_METHOD);
    assert.equal(
      initialize.source,
      'initialize\n\tparsingMarkup _ false.\n\tvalidating _ false.\n\tattributeBuffer _ UnicodeString writeStream.\n\tnameBuffer _ UnicodeString writeStream.',
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
    assert.equal(Object.hasOwn(globals, 'UnicodeString'), false, 'the newly exposed dependency is not');
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

// DIAGNOSTIC, not a work queue. The epic recorded one open question — whether the canonical v2
// export carries package load-time expressions at all — and it is answered here by measurement
// rather than left as a prediction. It does not, and it carries no class-variable facts either.
// YAXO needs both: `XMLTokenizer class>>initialize` BUILDS four class variables the tokenizer
// cannot scan without, and the package file ends with five top-level chunks that run it and its
// siblings at load time. Nothing about that is a YAXO problem — those are semantic facts of the
// Cuis package that never leave Cuis, so they belong to the EXPORT owner
// (src/toolchain/opensmalltalk-cuis-toolchain-provider.js, which owns the canonical manifest
// schema). The native side already HAS the concept: src/language/smalltalk-class-variables.js owns
// hierarchy-scoped class variables and the semantic compiler resolves them. This slice schedules
// none of it — it sits behind the first RED on the executable vertical.
test('the canonical v2 export carries no class-variable and no load-time-expression facts', {skip: !enabled, timeout: 900_000}, async () => {
  const manifest = JSON.parse(await yaxoSemanticExport());

  assert.deepEqual(Object.keys(manifest).sort(), ['classes', 'format', 'methods', 'packages']);
  for (const declaration of manifest.classes) {
    assert.deepEqual(
      Object.keys(declaration).sort(),
      ['identity', 'instanceVariables', 'name', 'package', 'superclass', 'superclassName'],
      `${declaration.identity} declaration carries no class-variable field`,
    );
  }
  // XMLTokenizer really does declare four class variables upstream, and the export answers none of
  // them: its declaration reports only instance variables.
  const tokenizer = manifest.classes.find(({identity}) => identity === 'cuis-class/YAXO/XMLTokenizer');
  assert.equal(tokenizer.instanceVariables.includes('CharEscapes'), false);
  const tokenizerInit = manifest.methods.find(({identity}) => identity === 'cuis-method/YAXO/XMLTokenizer/class/initialize');
  for (const name of ['CharEscapes', 'LiteralChars', 'NameDelimiters', 'DigitTable']) {
    assert.ok(tokenizerInit.source.includes(`${name} _ `), `${name} is assigned by the upstream class-side initialize`);
  }
  // ... and nothing in the manifest represents the five top-level `initialize!` chunks that run it.
  assert.equal(JSON.stringify(manifest).includes('"expressions"'), false);
  assert.equal(JSON.stringify(manifest).includes('"loadTime"'), false);
});
