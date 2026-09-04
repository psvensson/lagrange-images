import {TupleMap} from '../support/tuple-map.js';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, extname, join, resolve} from 'node:path';
import {bytesValue, textValue} from '../value/index.js';

const CUIS_BUILD_V1 = 'smalltalk/cuis-build-v1';
const CUIS_IMAGE_V1 = 'smalltalk/cuis-image-v1';
const CUIS_CHANGES_V1 = 'smalltalk/cuis-changes-v1';
const CUIS_SOURCES_V1 = 'smalltalk/cuis-sources-v1';
const CUIS_PACKAGE_V1 = 'smalltalk/cuis-package-v1';
const CUIS_SEMANTIC_EXPORT_V1 = 'smalltalk/cuis-semantic-export-v1';
const CUIS_SEMANTIC_EXPORT_V2 = 'smalltalk/cuis-semantic-export-v2';
const CUIS_BUILD_CONTRACT_V0 = 'cuis-build/v0';
const OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID = 'smalltalk/opensmalltalk-cuis-toolchain';
const OPENSMALLTALK_CUIS_TOOLCHAIN_V0 = 'opensmalltalk-cuis-toolchain/v0';
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new TypeError(`unknown ${label} fields: ${extra.join(', ')}`);
  return value;
}

function safeFileName(value, extension, label) {
  const fileName = requiredText(value, label);
  if (basename(fileName) !== fileName || !SAFE_FILE.test(fileName) || fileName.includes('..') || extname(fileName) !== extension) {
    throw new TypeError(`${label} must be a safe ${extension} basename`);
  }
  return fileName;
}

function artifactBytes(artifact, label) {
  if (artifact.content?.kind === 'bytes') return Buffer.from(artifact.content.base64, 'base64');
  if (artifact.content?.kind === 'text') return Buffer.from(artifact.content.value, 'utf8');
  throw new TypeError(`${label} content must be a text or bytes Value`);
}

function bytesArtifact(artifact, label) {
  if (artifact.content?.kind !== 'bytes') throw new TypeError(`${label} content must be a bytes Value`);
  return Buffer.from(artifact.content.base64, 'base64');
}

// A tuple key, not a joined string: image and object ids are arbitrary non-empty text, so
// no separator is safe to join on. See src/support/tuple-map.js.
function artifactKey(ref) {
  return [ref.imageId, ref.objectId];
}

function nodeMap(request) {
  const nodes = new TupleMap(2);
  for (const node of request.artifacts) nodes.set(artifactKey(node.ref), node);
  return nodes;
}

function nodeForDependency(nodes, dependency, label) {
  const node = nodes.get(artifactKey(dependency.artifact));
  if (!node) throw new TypeError(`${label} dependency is not present in the resolved toolchain graph`);
  return node;
}

function rootDependencies(request) {
  if (!Array.isArray(request.roots) || request.roots.length !== 1) {
    throw new TypeError('OpenSmalltalk Cuis toolchain requires exactly one root artifact');
  }
  const root = request.roots[0].artifact;
  if (root.representation !== CUIS_BUILD_V1) throw new TypeError(`OpenSmalltalk Cuis toolchain root must be ${CUIS_BUILD_V1}`);
  if (root.content?.kind !== 'text' || root.content.value !== CUIS_BUILD_CONTRACT_V0) {
    throw new TypeError(`OpenSmalltalk Cuis build root content must be ${CUIS_BUILD_CONTRACT_V0}`);
  }
  return root.dependencies ?? [];
}

function imageStem(fileName) {
  return fileName.slice(0, -'.image'.length);
}

function validateGraph(request) {
  const dependencies = rootDependencies(request);
  const nodes = nodeMap(request);
  const baseImages = [];
  const baseChanges = [];
  const baseSources = [];
  const packages = [];

  for (const dependency of dependencies) {
    const node = nodeForDependency(nodes, dependency, `OpenSmalltalk Cuis ${dependency.role}`);
    switch (dependency.role) {
      case 'base-image': baseImages.push(node); break;
      case 'base-changes': baseChanges.push(node); break;
      case 'base-sources': baseSources.push(node); break;
      case 'package': packages.push(node); break;
      default: throw new TypeError(`unsupported OpenSmalltalk Cuis build dependency role: ${dependency.role}`);
    }
  }

  if (baseImages.length !== 1) throw new TypeError('OpenSmalltalk Cuis build requires exactly one base-image dependency');
  if (baseChanges.length !== 1) throw new TypeError('OpenSmalltalk Cuis build requires exactly one base-changes dependency');
  if (baseSources.length > 1) throw new TypeError('OpenSmalltalk Cuis build may contain at most one base-sources dependency');

  const baseImageNode = baseImages[0];
  const baseImage = baseImageNode.artifact;
  if (baseImage.representation !== CUIS_IMAGE_V1) throw new TypeError(`base-image must be ${CUIS_IMAGE_V1}`);
  bytesArtifact(baseImage, 'OpenSmalltalk Cuis base image');
  const baseImageFileName = safeFileName(baseImage.logicalPath, '.image', 'OpenSmalltalk Cuis base image logicalPath');

  const changesNode = baseChanges[0];
  const changes = changesNode.artifact;
  if (changes.representation !== CUIS_CHANGES_V1) throw new TypeError(`base-changes must be ${CUIS_CHANGES_V1}`);
  const changesFileName = safeFileName(changes.logicalPath, '.changes', 'OpenSmalltalk Cuis base changes logicalPath');
  const expectedChangesFileName = `${imageStem(baseImageFileName)}.changes`;
  if (changesFileName !== expectedChangesFileName) {
    throw new TypeError(`OpenSmalltalk Cuis base changes filename must be ${expectedChangesFileName}`);
  }

  const sourcesNode = baseSources.length === 1 ? baseSources[0] : null;
  const sources = sourcesNode?.artifact ?? null;
  if (sources && sources.representation !== CUIS_SOURCES_V1) throw new TypeError(`base-sources must be ${CUIS_SOURCES_V1}`);
  const sourcesFileName = sources ? safeFileName(sources.logicalPath, '.sources', 'OpenSmalltalk Cuis base sources logicalPath') : null;

  const packageRecords = [];
  const packageNames = new Set();
  for (const node of packages) {
    const {artifact} = node;
    if (artifact.representation !== CUIS_PACKAGE_V1) throw new TypeError(`package dependency must be ${CUIS_PACKAGE_V1}`);
    const fileName = safeFileName(artifact.logicalPath, '.st', `OpenSmalltalk Cuis package ${artifact.id} logicalPath`);
    if (!fileName.endsWith('.pck.st')) throw new TypeError(`OpenSmalltalk Cuis package ${artifact.id} filename must end in .pck.st`);
    if (packageNames.has(fileName)) throw new TypeError(`duplicate OpenSmalltalk Cuis package filename: ${fileName}`);
    packageNames.add(fileName);
    packageRecords.push(Object.freeze({ref: node.ref, artifact, fileName}));
  }

  const supported = new Set([CUIS_BUILD_V1, CUIS_IMAGE_V1, CUIS_CHANGES_V1, CUIS_SOURCES_V1, CUIS_PACKAGE_V1]);
  for (const {artifact} of request.artifacts) {
    if (!supported.has(artifact.representation)) {
      throw new TypeError(`OpenSmalltalk Cuis toolchain does not support input representation: ${artifact.representation}`);
    }
  }

  return Object.freeze({
    baseImageRef: baseImageNode.ref,
    baseImage,
    baseImageFileName,
    changesRef: changesNode.ref,
    changes,
    changesFileName,
    sourcesRef: sourcesNode?.ref ?? null,
    sources,
    sourcesFileName,
    packages: Object.freeze(packageRecords),
  });
}

function normalizeTarget(target) {
  exactKeys(target, new Set(['representation', 'fileName']), 'OpenSmalltalk Cuis target');
  if (target.representation !== CUIS_IMAGE_V1) throw new TypeError(`OpenSmalltalk Cuis target representation must be ${CUIS_IMAGE_V1}`);
  const fileName = safeFileName(target.fileName, '.image', 'OpenSmalltalk Cuis target fileName');
  return Object.freeze({representation: CUIS_IMAGE_V1, fileName});
}

function normalizeSemanticExportOption(value) {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) return CUIS_SEMANTIC_EXPORT_V1;
  if (value === CUIS_SEMANTIC_EXPORT_V1 || value === CUIS_SEMANTIC_EXPORT_V2) return value;
  throw new TypeError(
    `OpenSmalltalk Cuis option semanticExport must be a boolean, ${CUIS_SEMANTIC_EXPORT_V1}, or ${CUIS_SEMANTIC_EXPORT_V2}`,
  );
}

function normalizeOptions(options) {
  exactKeys(options, new Set(['semanticExport']), 'OpenSmalltalk Cuis options');
  return Object.freeze({semanticExport: normalizeSemanticExportOption(options.semanticExport)});
}

// The semantic-export extraction script (ADR 0072). Runs toolchain-stage in the build,
// BEFORE saveAndQuitAs:, walking the derived image's class/method structure INSIDE the
// guest and emitting a canonical JSON manifest as TEXT to <stem>.semantic-export.json.
// It carries ONLY semantic identities (package/class/method names, selectors, source) —
// never a Spur oop. Extension methods are attributed by CodePackage packageOfMethod:ifNone:
// (method-category prefix match) and carry their target class ref (possibly a base class);
// base classes use the reserved cuis-class/Cuis-Base/<Name> identity. The host parses the
// JSON and canonicalizes (sort + normalize); the script sorts class iteration itself and
// does NOT sort methods (left to the host). No perform:/generic-eval — this is a fixed,
// provider-owned build script, same trust level as buildScript.
function semanticExportScript(packages, exportFileName, representation) {
  const packageNames = packages.map(({fileName}) => fileName.replace(/\.pck\.st$/, ''));
  // AVOID the brace array literal { 'a' 'b' ... }: the Cuis compiler hangs on it
  // (infinite loop or extreme slowdown during parsing). Use Array with:with:... instead.
  const nameArray = packageNames.length === 0
    ? 'Array new'
    : `Array ${packageNames.map((n) => `with: '${n}'`).join(' ')}`;
  // PERFORMANCE: iterate PER PACKAGE (CodePackage classesDo: visits only the classes that
  // package defines) rather than Smalltalk allClassesDo: over the whole image with a linear
  // packageOfClass: detect: per class (O(N^2) over thousands of classes — too slow). Owning
  // package of a method is derived from its method category: a '*<pkg>...' category names
  // the owning package (extension method, possibly on a foreign/base class); any other
  // category means the method belongs to the package that defines the class. This matches
  // CodePackage's own category-prefix attribution (isYourClassExtension:/category:matches:)
  // without a per-method packageOfMethod: detect: scan.
  const classDeclarationFields = representation === CUIS_SEMANTIC_EXPORT_V2
    ? `,
    ',"instanceVariables":[', (',' join: (cls instVarNames collect: [ :name | jsonString value: name asString ])), ']'`
    : '';
  return `
"=== Lagrange Cuis semantic export (ADR 0072) ==="
nl := String with: (Character codePoint: 10).
jsonEscape := [ :s | | r |
  r := s copyReplaceAll: '\\' with: '\\\\'.
  r := r copyReplaceAll: '"' with: '\\"'.
  r := r copyReplaceAll: (String with: (Character codePoint: 13)) with: '\\n'.
  r := r copyReplaceAll: nl with: '\\n'.
  r := r copyReplaceAll: (String with: (Character codePoint: 9)) with: '\\t'.
  r ].
jsonString := [ :s | '"', (jsonEscape value: s), '"' ].
"installedPackages select: answers a DICTIONARY; SortedCollection class>>withAll: (a Heap) HANGS on a Dictionary (it does setCollection:asArray copy tally: reSort). Use asArray sort: like Cuis's own CodePackageList>>packages — it returns a sorted Array, which is all pkgObjects needs (only do:/detect:/collect: are sent afterward)."
nameArray := ${nameArray}.
pkgObjects := ((CodePackage installedPackages select: [ :cp | nameArray includes: cp packageName ]) asArray sort: [ :a :b | a packageName < b packageName ]).
classEntry := [ :cls :pkg | | sup supPkg |
  sup := cls superclass.
  supPkg := sup isNil
    ifTrue: [ 'Cuis-Base' ]
    ifFalse: [ (CodePackage packageOfClass: sup ifNone: [ nil ])
        ifNil: [ 'Cuis-Base' ] ifNotNil: [ :p | p packageName ] ].
  '{"package":', (jsonString value: pkg),
    ',"name":', (jsonString value: cls name asString),
    ',"superclassName":', (jsonString value: (sup isNil ifTrue: [ '' ] ifFalse: [ sup name asString ])),
    ',"superclassPackage":', (jsonString value: supPkg)${classDeclarationFields},
    '}' ].
"ownerOfSel: derive the owning package of a method from its category. '*<rest>' -> the package whose name prefixes <rest> (case-insensitive, up to the first '-' or end); otherwise the package that defines the class."
ownerOfSel := [ :cls :sel :defPkg | | cat rest owner |
  cat := (cls organization categoryOfElement: sel) asString.
  (cat size > 0 and: [ cat first = $* ])
    ifTrue: [
      rest := (cat copyFrom: 2 to: cat size) asLowercase.
      owner := pkgObjects detect: [ :cp | | pn |
        pn := cp packageName asLowercase.
        (rest = pn) or: [ (rest copyFrom: 1 to: (pn size min: rest size)) = pn
          and: [ rest size > pn size and: [ (rest at: pn size + 1) = $- ] ] ] ]
        ifNone: [ nil ].
      owner isNil ifTrue: [ defPkg ] ifFalse: [ owner packageName ] ]
    ifFalse: [ defPkg ] ].
methodEntry := [ :cls :side :selector :pkg |
  '{"package":', (jsonString value: (ownerOfSel value: cls value: selector value: pkg)),
    ',"className":', (jsonString value: cls theNonMetaClass name asString),
    ',"classPackage":', (jsonString value: pkg),
    ',"side":', (jsonString value: side),
    ',"selector":', (jsonString value: selector asString),
    ',"source":', (jsonString value: (cls sourceCodeAt: selector) asString),
    '}' ].
packagesJson := pkgObjects collect: [ :cp | | reqs |
  reqs := cp featureSpec requires collect: [ :r | r name ].
  '{"name":', (jsonString value: cp packageName),
    ',"requires":[', (',' join: ((reqs asArray sort: [ :a :b | a < b ]) collect: [ :r | jsonString value: r ])), ']}' ].
classesJson := OrderedCollection new.
methodsJson := OrderedCollection new.
pkgObjects do: [ :cp |
  output nextPutAll: 'EXPORT'; nextPut: Character tab; nextPutAll: 'PKG'; nextPut: Character tab; nextPutAll: cp packageName; newLine; flush.
  "Classes this package DEFINES (their methods are owned by this package by default)."
  cp classesDo: [ :cls |
    classesJson add: (classEntry value: cls value: cp packageName).
    cls theNonMetaClass selectorsDo: [ :sel |
      methodsJson add: (methodEntry value: cls theNonMetaClass value: 'instance' value: sel value: cp packageName) ].
    cls theMetaClass selectorsDo: [ :sel |
      methodsJson add: (methodEntry value: cls theMetaClass value: 'class' value: sel value: cp packageName) ] ].
  "EXTENSION methods this package OWNS on classes it does NOT define (foreign/base classes)."
  cp extensionMethodsDo: [ :mr | | target side |
    target := mr actualClass.
    side := mr classIsMeta ifTrue: [ 'class' ] ifFalse: [ 'instance' ].
    methodsJson add:
      ('{"package":', (jsonString value: cp packageName),
        ',"className":', (jsonString value: target theNonMetaClass name asString),
        ',"classPackage":', (jsonString value: ((CodePackage packageOfClass: target theNonMetaClass ifNone: [ nil ]) ifNil: [ 'Cuis-Base' ] ifNotNil: [ :p | p packageName ])),
        ',"side":', (jsonString value: side),
        ',"selector":', (jsonString value: mr methodSymbol asString),
        ',"source":', (jsonString value: (target sourceCodeAt: mr methodSymbol) asString),
        '}') ] ].
(DirectoryEntry currentDirectory // '${exportFileName}') writeStreamDo: [ :out |
  out nextPutAll: '{"format":"${representation}","packages":['.
  out nextPutAll: (',' join: packagesJson asArray).
  out nextPutAll: '],"classes":['.
  out nextPutAll: (',' join: classesJson asArray).
  out nextPutAll: '],"methods":['.
  out nextPutAll: (',' join: methodsJson asArray).
  out nextPutAll: ']}' ].
output nextPutAll: 'EXPORT'; nextPut: Character tab; nextPutAll: 'SEMANTIC'; nextPut: Character tab; nextPutAll: '${exportFileName}'; newLine; flush.
`;
}

function buildScript(packages, targetFileName, {semanticExport = false} = {}) {
  // Install each package through FeatureRequirement satisfyRequirementsAndInstall
  // DIRECTLY (not CodePackageFile installPackage:). Cuis resolves the transitive
  // !requires: closure and installs requirements in dependency order itself, so
  // the substrate does NOT order packages and does NOT parse !requires: headers.
  // Crucially, CodePackageFile installPackage: CATCHES FeatureRequirementUnsatisfied
  // and merely shows a popup (PopUpMenu inform:), returning normally — so a missing
  // dependency would otherwise produce a FALSELY-successful build (saveAndQuitAs:
  // always exits 0) with a broken image. Driving satisfyRequirementsAndInstall and
  // catching the error here makes a missing/unsatisfiable dependency FATAL: it logs
  // BUILD\tPACKAGE\t<file>\tFAILED\t<reason> and quits with a non-zero exit code so
  // the runner surfaces OpenSmalltalkToolchainRunError (real failure diagnostics).
  // satisfyRequirementsAndInstall is idempotent (already-satisfied requirements are
  // skipped), so emitting one install per declared package is safe and preserves the
  // per-package BUILD markers + derived-image package metadata/provenance.
  // Emit BUILD markers as real TAB-delimited fields (Smalltalk does not interpret \t in a
  // single-quoted string literal, so we build each line with Character tab, matching the
  // bridge's own TAB convention). This keeps the FAILED diagnostic machine-parseable.
  const tab = `nextPut: Character tab; `;
  const installs = packages.map(({fileName}) => [
    `output nextPutAll: 'BUILD'; ${tab}nextPutAll: 'PACKAGE'; ${tab}nextPutAll: '${fileName}'; ${tab}nextPutAll: 'START'; newLine; flush.`,
    `[ | fullName pkName |`,
    `  fullName := (DirectoryEntry currentDirectory // '${fileName}') pathName.`,
    `  pkName := CodePackageFile packageNameFrom: fullName.`,
    `  (FeatureRequirement name: pkName) pathName: fullName; satisfyRequirementsAndInstall ]`,
    `    on: FeatureRequirementUnsatisfied`,
    `    do: [ :ex | output nextPutAll: 'BUILD'; ${tab}nextPutAll: 'PACKAGE'; ${tab}nextPutAll: '${fileName}'; ${tab}nextPutAll: 'FAILED'; ${tab}nextPutAll: ex messageText; newLine; flush. Smalltalk quitPrimitive: 1 ].`,
    `output nextPutAll: 'BUILD'; ${tab}nextPutAll: 'PACKAGE'; ${tab}nextPutAll: '${fileName}'; ${tab}nextPutAll: 'DONE'; newLine; flush.`,
  ].join('\n')).join('\n');
  const stem = imageStem(targetFileName);
  const semanticExportRepresentation = normalizeSemanticExportOption(semanticExport);
  // The semantic export (ADR 0072) runs AFTER install (structure complete) and BEFORE
  // saveAndQuitAs: (which quits the process). It does not mutate the image.
  const exportBlock = semanticExportRepresentation
    ? `\n${semanticExportScript(packages, `${stem}.semantic-export.json`, semanticExportRepresentation)}\n`
    : '';
  // A Smalltalk script allows exactly ONE top-level temp declaration, so the export temps
  // are declared here alongside `output` (semanticExportScript itself declares none).
  const temps = semanticExportRepresentation ? ' output jsonEscape jsonString nl pkgObjects classEntry methodEntry ownerOfSel packagesJson classesJson methodsJson nameArray ' : ' output ';
  return `|${temps}|\noutput := StdIOWriteStream stdout.\noutput nextPutAll: 'BUILD'; ${tab}nextPutAll: 'START'; newLine; flush.\n${installs}\n${exportBlock}\noutput nextPutAll: 'BUILD'; ${tab}nextPutAll: 'SAVE-AND-QUIT'; ${tab}nextPutAll: 'START'; newLine; flush.\nSmalltalk saveAndQuitAs: '${stem}' clearAllClassState: false.\n`;
}

async function materializeBuild(graph, workspace, target, options) {
  await writeFile(join(workspace, graph.baseImageFileName), bytesArtifact(graph.baseImage, 'OpenSmalltalk Cuis base image'));
  await writeFile(join(workspace, graph.changesFileName), artifactBytes(graph.changes, 'OpenSmalltalk Cuis base changes'));
  if (graph.sources) await writeFile(join(workspace, graph.sourcesFileName), artifactBytes(graph.sources, 'OpenSmalltalk Cuis base sources'));
  for (const {artifact, fileName} of graph.packages) {
    await writeFile(join(workspace, fileName), artifactBytes(artifact, `OpenSmalltalk Cuis package ${artifact.id}`));
  }
  const scriptPath = join(workspace, 'lagrange-build.st');
  await writeFile(scriptPath, buildScript(graph.packages, target.fileName, options), 'utf8');
  return scriptPath;
}

// Canonicalize raw guest manifests into deterministic semantic-export artifacts (ADR 0072
// §3/§5). V1 remains frozen; v2 adds only ordered, locally declared instance-variable names.
// Recompute cuis-class/cuis-method identities from manifest fields, resolve superclass refs,
// sort canonical collections, and normalize method source. The serialized artifact is a pure
// function of semantic content, so two equivalent builds are byte-identical (tested, not assumed).
function canonicalizeSemanticExport(raw) {
  if (!raw || (raw.format !== CUIS_SEMANTIC_EXPORT_V1 && raw.format !== CUIS_SEMANTIC_EXPORT_V2)) {
    throw new OpenSmalltalkToolchainRunError(
      `Cuis semantic export manifest must declare format ${CUIS_SEMANTIC_EXPORT_V1} or ${CUIS_SEMANTIC_EXPORT_V2}, got ${raw?.format ?? 'missing'}`,
      {stderr: JSON.stringify(raw?.format ?? null), exitCode: null},
    );
  }
  const normalizeSource = (s) => String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  const classIdentity = (pkg, name) => `cuis-class/${pkg}/${name}`;
  const methodIdentity = (m) => `cuis-method/${m.package}/${m.className}/${m.side}/${m.selector}`;
  const packages = [...raw.packages]
    .map((p) => ({name: p.name, requires: [...p.requires].sort()}))
    .sort((a, b) => a.name.localeCompare(b.name));
  const classes = [...raw.classes]
    .map((c) => {
      const normalized = {
        identity: classIdentity(c.package, c.name),
        package: c.package,
        name: c.name,
        superclassName: c.superclassName,
        superclass: c.superclassName === '' ? null : classIdentity(c.superclassPackage, c.superclassName),
      };
      if (raw.format === CUIS_SEMANTIC_EXPORT_V2) {
        if (!Array.isArray(c.instanceVariables) || c.instanceVariables.some((name) => typeof name !== 'string' || name.length === 0)) {
          throw new OpenSmalltalkToolchainRunError(
            'Cuis semantic export v2 class instanceVariables must be an array of strings',
            {stderr: JSON.stringify(c.instanceVariables ?? null), exitCode: null},
          );
        }
        if (new Set(c.instanceVariables).size !== c.instanceVariables.length) {
          throw new OpenSmalltalkToolchainRunError(
            'Cuis semantic export v2 class instanceVariables must not contain duplicate names',
            {stderr: JSON.stringify(c.instanceVariables), exitCode: null},
          );
        }
        normalized.instanceVariables = [...c.instanceVariables];
      }
      return normalized;
    })
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const methods = [...raw.methods]
    .map((m) => ({
      identity: methodIdentity(m),
      package: m.package,
      class: classIdentity(m.classPackage, m.className),
      side: m.side,
      selector: m.selector,
      source: normalizeSource(m.source),
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
  return Object.freeze({format: raw.format, packages, classes, methods});
}

class OpenSmalltalkToolchainRunError extends Error {
  constructor(message, {exitCode = null, signal = null, stdout = '', stderr = '', cause = null} = {}) {
    super(message, cause ? {cause} : undefined);
    this.name = 'OpenSmalltalkToolchainRunError';
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

class OpenSmalltalkToolchainRunner {
  constructor({execFileProcess = execFile, maxBuffer = 8 * 1024 * 1024} = {}) {
    if (typeof execFileProcess !== 'function') throw new TypeError('OpenSmalltalk toolchain execFileProcess must be a function');
    positiveInteger(maxBuffer, 'OpenSmalltalk toolchain maxBuffer');
    this.execFileProcess = execFileProcess;
    this.maxBuffer = maxBuffer;
  }

  async run({command, args, cwd, timeoutMs}) {
    requiredText(command, 'OpenSmalltalk toolchain command');
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('OpenSmalltalk toolchain args must be strings');
    requiredText(cwd, 'OpenSmalltalk toolchain cwd');
    positiveInteger(timeoutMs, 'OpenSmalltalk toolchain timeoutMs');
    return await new Promise((resolve, reject) => {
      this.execFileProcess(command, [...args], {
        cwd,
        env: {...process.env},
        shell: false,
        timeout: timeoutMs,
        maxBuffer: this.maxBuffer,
        encoding: 'utf8',
      }, (error, stdout = '', stderr = '') => {
        if (!error) {
          resolve(Object.freeze({exitCode: 0, signal: null, stdout, stderr}));
          return;
        }
        if (error.code === 'ENOENT') {
          reject(new OpenSmalltalkToolchainRunError('OpenSmalltalk VM executable is unavailable', {stdout, stderr, cause: error}));
          return;
        }
        const exitCode = Number.isInteger(error.code) ? error.code : null;
        reject(new OpenSmalltalkToolchainRunError('OpenSmalltalk Cuis toolchain process failed', {
          exitCode,
          signal: error.signal ?? null,
          stdout,
          stderr,
          cause: error,
        }));
      });
    });
  }
}

function diagnosticsFromRun(run) {
  const diagnostics = [];
  if (run.stdout.length > 0) diagnostics.push(Object.freeze({severity: 'note', source: 'opensmalltalk-cuis', stream: 'stdout', message: run.stdout}));
  if (run.stderr.length > 0) diagnostics.push(Object.freeze({severity: 'note', source: 'opensmalltalk-cuis', stream: 'stderr', message: run.stderr}));
  return Object.freeze(diagnostics);
}

function createOpenSmalltalkCuisToolchainProvider({
  vmPath,
  vmIdentity,
  runner = new OpenSmalltalkToolchainRunner(),
  workspaceRoot = tmpdir(),
  timeoutMs = 60_000,
} = {}) {
  const executable = resolve(requiredText(vmPath, 'OpenSmalltalk VM path'));
  const stableVmIdentity = requiredText(vmIdentity, 'OpenSmalltalk VM identity');
  if (!runner || typeof runner.run !== 'function') throw new TypeError('OpenSmalltalk toolchain runner must implement run(request)');
  const root = resolve(requiredText(workspaceRoot, 'OpenSmalltalk toolchain workspaceRoot'));
  positiveInteger(timeoutMs, 'OpenSmalltalk toolchain timeoutMs');
  const identityDigest = createHash('sha256').update(stableVmIdentity).digest('hex');
  const identity = `${OPENSMALLTALK_CUIS_TOOLCHAIN_V0}/${identityDigest}`;

  return Object.freeze({
    identity,
    vmIdentity: stableVmIdentity,
    async run(request) {
      const graph = validateGraph(request);
      const target = normalizeTarget(request.target);
      const options = normalizeOptions(request.options);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cuis-toolchain-'));
      try {
        const scriptPath = await materializeBuild(graph, workspace, target, options);
        const run = await runner.run({
          command: executable,
          args: ['-vm-sound-null', '-vm-display-null', graph.baseImageFileName, '-s', scriptPath],
          cwd: workspace,
          timeoutMs,
        });
        if (!run || run.exitCode !== 0) {
          throw new OpenSmalltalkToolchainRunError('OpenSmalltalk Cuis toolchain process did not exit successfully', run ?? {});
        }
        const imagePath = join(workspace, target.fileName);
        const changesFileName = `${imageStem(target.fileName)}.changes`;
        const changesPath = join(workspace, changesFileName);
        let imageBytes;
        let changesBytes;
        try {
          imageBytes = await readFile(imagePath);
          changesBytes = await readFile(changesPath);
        } catch (cause) {
          throw new OpenSmalltalkToolchainRunError(`OpenSmalltalk Cuis toolchain did not produce ${target.fileName} and ${changesFileName}`, {
            stdout: run.stdout,
            stderr: run.stderr,
            cause,
          });
        }
        if (imageBytes.length === 0) throw new OpenSmalltalkToolchainRunError('OpenSmalltalk Cuis derived image is empty');

        // Read + canonicalize the semantic-export manifest when the option is enabled (ADR 0072).
        let semanticExportText = null;
        let semanticExportFileName = null;
        if (options.semanticExport) {
          semanticExportFileName = `${imageStem(target.fileName)}.semantic-export.json`;
          let rawExport;
          try {
            rawExport = JSON.parse(await readFile(join(workspace, semanticExportFileName), 'utf8'));
          } catch (cause) {
            throw new OpenSmalltalkToolchainRunError(`OpenSmalltalk Cuis toolchain did not produce a valid ${semanticExportFileName}`, {
              stdout: run.stdout,
              stderr: run.stderr,
              cause,
            });
          }
          if (rawExport?.format !== options.semanticExport) {
            throw new OpenSmalltalkToolchainRunError(
              `Cuis semantic export manifest format must match requested ${options.semanticExport}, got ${rawExport?.format ?? 'missing'}`,
              {stdout: run.stdout, stderr: JSON.stringify(rawExport?.format ?? null), exitCode: null},
            );
          }
          semanticExportText = JSON.stringify(canonicalizeSemanticExport(rawExport));
        }

        const sourceDependencies = graph.sourcesRef ? [{role: 'sources', artifact: graph.sourcesRef}] : [];
        const packageFileNames = graph.packages.map(({fileName}) => fileName);
        const packageArtifactIds = graph.packages.map(({artifact}) => artifact.id);
        const commonMetadata = {
          vmIdentity: stableVmIdentity,
          baseImageArtifactId: graph.baseImage.id,
          packageArtifactIds,
          packageFileNames,
          sourcesFileName: graph.sourcesFileName,
          snapshotMethod: 'saveAndQuitAs/v0',
        };
        const outputs = [
          Object.freeze({
            name: 'image',
            languageId: 'smalltalk',
            representation: CUIS_IMAGE_V1,
            content: bytesValue(imageBytes),
            logicalPath: target.fileName,
            dependencies: sourceDependencies,
            metadata: {...commonMetadata, companionChangesFileName: changesFileName},
          }),
          Object.freeze({
            name: 'changes',
            languageId: 'smalltalk',
            representation: CUIS_CHANGES_V1,
            content: bytesValue(changesBytes),
            logicalPath: changesFileName,
            dependencies: [],
            metadata: {...commonMetadata, companionImageFileName: target.fileName},
          }),
        ];
        if (semanticExportText !== null) {
          outputs.push(Object.freeze({
            name: 'semantic-export',
            languageId: 'smalltalk',
            representation: options.semanticExport,
            content: textValue(semanticExportText),
            logicalPath: semanticExportFileName,
            dependencies: [],
            metadata: {...commonMetadata},
          }));
        }
        return Object.freeze({
          outputs: Object.freeze(outputs),
          diagnostics: diagnosticsFromRun(run),
        });
      } finally {
        await rm(workspace, {recursive: true, force: true});
      }
    },
  });
}

export {
  CUIS_BUILD_CONTRACT_V0,
  CUIS_BUILD_V1,
  CUIS_CHANGES_V1,
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_SEMANTIC_EXPORT_V1,
  CUIS_SEMANTIC_EXPORT_V2,
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  OPENSMALLTALK_CUIS_TOOLCHAIN_V0,
  OpenSmalltalkToolchainRunError,
  OpenSmalltalkToolchainRunner,
  buildScript as createCuisToolchainBuildScript,
  canonicalizeSemanticExport,
  createOpenSmalltalkCuisToolchainProvider,
  materializeBuild as materializeCuisToolchainBuild,
  validateGraph as validateCuisToolchainGraph,
};
