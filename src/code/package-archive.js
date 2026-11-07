import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {
  VALUE_KIND,
  bytesValue,
  canonicalizeValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {WASM_BINARY_V1} from './wasm-artifacts.js';

const LAGRANGE_PACKAGE_ARCHIVE_V1 = 'lagrange-package-archive/v1';
const PACKAGE_ARCHIVE_IMPORT_RECEIPT_V1 = 'lagrange-package-archive-import-receipt/v1';
const PRECOMPILED_WASM_REUSE_RECEIPT_V1 = 'lagrange-precompiled-wasm-reuse-receipt/v1';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalText(value, label) {
  if (value === undefined || value === null) return null;
  return requiredText(value, label);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function sha256HexText(text) {
  return getDefaultCryptoProvider().sha256Hex(new TextEncoder().encode(text));
}

function sha256HexBytes(bytes) {
  return getDefaultCryptoProvider().sha256Hex(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
}

function normalizeArchiveFileEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`package archive file ${index} must be an object`);
  }
  const logicalPath = requiredText(entry.logicalPath, `package archive file ${index} logicalPath`);
  const representation = requiredText(
    entry.representation,
    `package archive file ${index} representation`,
  );
  const languageId = optionalText(entry.languageId, `package archive file ${index} languageId`);
  const role = optionalText(entry.role, `package archive file ${index} role`)
    ?? `member:${logicalPath}`;

  let contentKind;
  let encodedContent;
  let contentDigest;
  if (typeof entry.text === 'string') {
    contentKind = 'text';
    encodedContent = entry.text;
    contentDigest = sha256HexText(entry.text);
  } else if (entry.bytes instanceof Uint8Array || ArrayBuffer.isView(entry.bytes)) {
    const u8 = new Uint8Array(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    contentKind = 'bytes-base64';
    encodedContent = Buffer.from(u8).toString('base64');
    contentDigest = sha256HexBytes(u8);
  } else if (entry.content?.kind === VALUE_KIND.TEXT) {
    contentKind = 'text';
    encodedContent = entry.content.value;
    contentDigest = sha256HexText(entry.content.value);
  } else if (entry.content?.kind === VALUE_KIND.BYTES) {
    const u8 = entry.content.value;
    contentKind = 'bytes-base64';
    encodedContent = Buffer.from(u8).toString('base64');
    contentDigest = sha256HexBytes(u8);
  } else if (
    (entry.contentKind === 'text' || entry.contentKind === 'bytes-base64')
    && typeof entry.encodedContent === 'string'
  ) {
    contentKind = entry.contentKind;
    encodedContent = entry.encodedContent;
    contentDigest = entry.contentDigest
      ?? (contentKind === 'text'
        ? sha256HexText(encodedContent)
        : sha256HexBytes(Buffer.from(encodedContent, 'base64')));
  } else {
    throw new TypeError(`package archive file ${index} requires text, bytes, or Value content`);
  }

  return deepFreeze({
    logicalPath,
    representation,
    languageId,
    role,
    contentKind,
    encodedContent,
    contentDigest,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? {...entry.metadata} : {},
  });
}

function normalizePrecompiledEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`package archive precompiledArtifact ${index} must be an object`);
  }
  const name = requiredText(entry.name, `precompiledArtifact ${index} name`);
  const representation = optionalText(
    entry.representation,
    `precompiledArtifact ${index} representation`,
  ) ?? WASM_BINARY_V1;
  const logicalPath = optionalText(entry.logicalPath, `precompiledArtifact ${index} logicalPath`);
  const languageId = optionalText(entry.languageId, `precompiledArtifact ${index} languageId`);
  const role = optionalText(entry.role, `precompiledArtifact ${index} role`)
    ?? `precompiled:${name}`;

  let bytes;
  if (entry.bytes instanceof Uint8Array || ArrayBuffer.isView(entry.bytes)) {
    bytes = new Uint8Array(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
  } else if (entry.content?.kind === VALUE_KIND.BYTES) {
    bytes = entry.content.value;
  } else if (typeof entry.encodedBytesBase64 === 'string') {
    bytes = new Uint8Array(Buffer.from(entry.encodedBytesBase64, 'base64'));
  } else {
    throw new TypeError(`precompiledArtifact ${index} requires bytes or bytes Value content`);
  }

  const encodedBytesBase64 = Buffer.from(bytes).toString('base64');
  const contentDigest = sha256HexBytes(bytes);

  return deepFreeze({
    name,
    representation,
    logicalPath,
    languageId,
    role,
    encodedBytesBase64,
    contentDigest,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? {...entry.metadata} : {},
  });
}

function normalizePackageDependencyEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`package archive dependency ${index} must be an object`);
  }
  const name = requiredText(entry.name, `package archive dependency ${index} name`);
  const version = optionalText(entry.version, `package archive dependency ${index} version`);
  const role = optionalText(entry.role, `package archive dependency ${index} role`)
    ?? `dependency:${name}`;
  const artifactRef = entry.artifact !== undefined && entry.artifact !== null
    ? canonicalizeValue(entry.artifact)
    : null;
  if (artifactRef !== null && !isObjectRef(artifactRef)) {
    throw new TypeError(`package archive dependency ${index} artifact must be an object ref`);
  }
  return deepFreeze({
    name,
    version,
    role,
    artifact: artifactRef,
  });
}

function createPackageArchiveManifest({
  name,
  version,
  languageId = null,
  files = [],
  dependencies = [],
  precompiledArtifacts = [],
  metadata = {},
} = {}) {
  const pkgName = requiredText(name, 'package name');
  const pkgVersion = requiredText(version, 'package version');
  const pkgLang = optionalText(languageId, 'package languageId');
  if (!Array.isArray(files)) throw new TypeError('package archive files must be an array');
  if (!Array.isArray(dependencies)) {
    throw new TypeError('package archive dependencies must be an array');
  }
  if (!Array.isArray(precompiledArtifacts)) {
    throw new TypeError('package archive precompiledArtifacts must be an array');
  }

  const normalizedFiles = files
    .map(normalizeArchiveFileEntry)
    .sort((a, b) => (a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0));
  const seenPaths = new Set();
  for (const file of normalizedFiles) {
    if (seenPaths.has(file.logicalPath)) {
      throw new TypeError(`duplicate package archive file logicalPath: ${file.logicalPath}`);
    }
    seenPaths.add(file.logicalPath);
  }

  const normalizedPrecompiled = precompiledArtifacts
    .map(normalizePrecompiledEntry)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seenPrecompiled = new Set();
  for (const item of normalizedPrecompiled) {
    if (seenPrecompiled.has(item.name)) {
      throw new TypeError(`duplicate package archive precompiledArtifact name: ${item.name}`);
    }
    seenPrecompiled.add(item.name);
  }

  const normalizedDeps = dependencies
    .map(normalizePackageDependencyEntry)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const digestPayload = JSON.stringify({
    format: LAGRANGE_PACKAGE_ARCHIVE_V1,
    name: pkgName,
    version: pkgVersion,
    languageId: pkgLang,
    files: normalizedFiles.map((f) => ({
      logicalPath: f.logicalPath,
      representation: f.representation,
      languageId: f.languageId,
      role: f.role,
      contentDigest: f.contentDigest,
    })),
    precompiledArtifacts: normalizedPrecompiled.map((p) => ({
      name: p.name,
      representation: p.representation,
      logicalPath: p.logicalPath,
      contentDigest: p.contentDigest,
    })),
    dependencies: normalizedDeps.map((d) => ({
      name: d.name,
      version: d.version,
      role: d.role,
    })),
  });

  return deepFreeze({
    format: LAGRANGE_PACKAGE_ARCHIVE_V1,
    name: pkgName,
    version: pkgVersion,
    languageId: pkgLang,
    archiveDigest: sha256HexText(digestPayload),
    files: normalizedFiles,
    precompiledArtifacts: normalizedPrecompiled,
    dependencies: normalizedDeps,
    metadata: metadata && typeof metadata === 'object' ? {...metadata} : {},
  });
}

function parsePackageArchiveArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== LAGRANGE_PACKAGE_ARCHIVE_V1) {
    throw new TypeError(`artifact must be ${LAGRANGE_PACKAGE_ARCHIVE_V1}`);
  }
  if (artifact.content?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(`${LAGRANGE_PACKAGE_ARCHIVE_V1} content must be a text Value`);
  }
  let parsed;
  try {
    parsed = JSON.parse(artifact.content.value);
  } catch (err) {
    throw new TypeError(`${LAGRANGE_PACKAGE_ARCHIVE_V1} content must be valid JSON`, {cause: err});
  }
  return createPackageArchiveManifest(parsed);
}

async function putPackageArchiveArtifact({
  images,
  imageId,
  id = null,
  manifest,
  dependencies = [],
} = {}) {
  requiredText(imageId, 'imageId');
  const normalized = manifest?.format === LAGRANGE_PACKAGE_ARCHIVE_V1
    ? manifest
    : createPackageArchiveManifest(manifest);
  const artifactId = optionalText(id, 'id')
    ?? `pkg-archive/${normalized.name}@${normalized.version}/${normalized.archiveDigest.slice(0, 16)}`;
  const existing = await images.getCodeArtifact(imageId, artifactId);
  if (existing) return existing;

  return images.putCodeArtifact(imageId, {
    id: artifactId,
    languageId: normalized.languageId,
    representation: LAGRANGE_PACKAGE_ARCHIVE_V1,
    content: textValue(JSON.stringify(normalized)),
    dependencies,
    metadata: {
      ...normalized.metadata,
      packageName: normalized.name,
      packageVersion: normalized.version,
      archiveDigest: normalized.archiveDigest,
    },
  });
}

function bytesEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function reusePrecompiledWasmArtifact({
  images,
  imageId,
  representation = WASM_BINARY_V1,
  content,
  logicalPath = null,
  languageId = null,
  preferredId = null,
  metadata = {},
  dependencies = [],
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(representation, 'representation');
  let rawBytes;
  if (content instanceof Uint8Array || ArrayBuffer.isView(content)) {
    rawBytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  } else if (content?.kind === VALUE_KIND.BYTES) {
    rawBytes = content.value;
  } else {
    throw new TypeError('precompiled WASM content must be bytes or a bytes Value');
  }
  const digest = sha256HexBytes(rawBytes);
  const deterministicId = optionalText(preferredId, 'preferredId')
    ?? `wasm-precompiled/${representation.replace(/[^a-zA-Z0-9_-]/g, '-')}/${digest.slice(0, 24)}`;

  // 1. Check deterministic ID first (O(1) lookup)
  const direct = await images.getCodeArtifact(imageId, deterministicId);
  if (
    direct
    && direct.representation === representation
    && direct.content?.kind === VALUE_KIND.BYTES
    && bytesEqual(direct.content.value, rawBytes)
  ) {
    return deepFreeze({
      format: PRECOMPILED_WASM_REUSE_RECEIPT_V1,
      imageId,
      artifactId: direct.id,
      artifactRef: objectRef(imageId, direct.id),
      artifact: direct,
      contentDigest: digest,
      reused: true,
    });
  }

  // 2. Scan existing CodeArtifacts in imageId for identical representation + byte payload
  if (typeof images.listCodeArtifacts === 'function') {
    const allArtifacts = await images.listCodeArtifacts(imageId);
    for (const candidate of allArtifacts) {
      if (
        candidate.representation === representation
        && (candidate.logicalPath ?? null) === (logicalPath ?? null)
        && candidate.content?.kind === VALUE_KIND.BYTES
        && bytesEqual(candidate.content.value, rawBytes)
      ) {
        return deepFreeze({
          format: PRECOMPILED_WASM_REUSE_RECEIPT_V1,
          imageId,
          artifactId: candidate.id,
          artifactRef: objectRef(imageId, candidate.id),
          artifact: candidate,
          contentDigest: digest,
          reused: true,
        });
      }
    }
  }

  const stored = await images.putCodeArtifact(imageId, {
    id: deterministicId,
    languageId: optionalText(languageId, 'languageId'),
    representation,
    content: bytesValue(rawBytes),
    logicalPath: optionalText(logicalPath, 'logicalPath'),
    dependencies,
    metadata: {
      ...metadata,
      precompiledDigest: digest,
    },
  });

  return deepFreeze({
    format: PRECOMPILED_WASM_REUSE_RECEIPT_V1,
    imageId,
    artifactId: stored.id,
    artifactRef: objectRef(imageId, stored.id),
    artifact: stored,
    contentDigest: digest,
    reused: false,
  });
}

async function importPackageArchive({
  images,
  imageId,
  archive,
  idPrefix = null,
  reusePrecompiledWasm = true,
  dependencyArtifactRefs = {},
} = {}) {
  requiredText(imageId, 'imageId');
  const manifest = archive?.kind === 'code-artifact'
    ? parsePackageArchiveArtifact(archive)
    : archive?.format === LAGRANGE_PACKAGE_ARCHIVE_V1
      ? archive
      : createPackageArchiveManifest(archive);

  const prefix = optionalText(idPrefix, 'idPrefix')
    ?? `pkg/${manifest.name}@${manifest.version}/${manifest.archiveDigest.slice(0, 12)}`;

  const memberArtifacts = [];
  const precompiledArtifacts = [];
  const archiveDependencies = [];
  let reusedWasmCount = 0;

  for (const file of manifest.files) {
    const fileArtifactId = `${prefix}/file/${file.logicalPath}`;
    // eslint-disable-next-line no-await-in-loop
    let fileArtifact = await images.getCodeArtifact(imageId, fileArtifactId);
    if (!fileArtifact) {
      const contentValue = file.contentKind === 'text'
        ? textValue(file.encodedContent)
        : bytesValue(new Uint8Array(Buffer.from(file.encodedContent, 'base64')));
      // eslint-disable-next-line no-await-in-loop
      fileArtifact = await images.putCodeArtifact(imageId, {
        id: fileArtifactId,
        languageId: file.languageId ?? manifest.languageId,
        representation: file.representation,
        content: contentValue,
        logicalPath: file.logicalPath,
        metadata: {
          ...file.metadata,
          packageName: manifest.name,
          packageVersion: manifest.version,
          contentDigest: file.contentDigest,
        },
      });
    }
    const ref = objectRef(imageId, fileArtifact.id);
    memberArtifacts.push(
      deepFreeze({
        logicalPath: file.logicalPath,
        role: file.role,
        artifactId: fileArtifact.id,
        artifactRef: ref,
        artifact: fileArtifact,
      }),
    );
    archiveDependencies.push({
      role: file.role,
      artifact: ref,
    });
  }

  for (const precompiled of manifest.precompiledArtifacts) {
    const rawBytes = new Uint8Array(Buffer.from(precompiled.encodedBytesBase64, 'base64'));
    let precompiledArtifact;
    let reused = false;
    if (reusePrecompiledWasm) {
      // eslint-disable-next-line no-await-in-loop
      const receipt = await reusePrecompiledWasmArtifact({
        images,
        imageId,
        representation: precompiled.representation,
        content: rawBytes,
        logicalPath: precompiled.logicalPath,
        languageId: precompiled.languageId ?? manifest.languageId,
        metadata: {
          ...precompiled.metadata,
          packageName: manifest.name,
          packageVersion: manifest.version,
        },
      });
      precompiledArtifact = receipt.artifact;
      reused = receipt.reused;
      if (reused) reusedWasmCount += 1;
    } else {
      const precompiledId = `${prefix}/precompiled/${precompiled.name}`;
      // eslint-disable-next-line no-await-in-loop
      precompiledArtifact = await images.putCodeArtifact(imageId, {
        id: precompiledId,
        languageId: precompiled.languageId ?? manifest.languageId,
        representation: precompiled.representation,
        content: bytesValue(rawBytes),
        logicalPath: precompiled.logicalPath,
        metadata: {
          ...precompiled.metadata,
          packageName: manifest.name,
          packageVersion: manifest.version,
          precompiledDigest: precompiled.contentDigest,
        },
      });
    }
    const ref = objectRef(imageId, precompiledArtifact.id);
    precompiledArtifacts.push(
      deepFreeze({
        name: precompiled.name,
        role: precompiled.role,
        artifactId: precompiledArtifact.id,
        artifactRef: ref,
        artifact: precompiledArtifact,
        reused,
      }),
    );
    archiveDependencies.push({
      role: precompiled.role,
      artifact: ref,
    });
  }

  for (const dep of manifest.dependencies) {
    const resolvedRef = dep.artifact ?? dependencyArtifactRefs?.[dep.name] ?? null;
    if (!resolvedRef) {
      throw new TypeError(`missing dependency artifact reference for package dependency: ${dep.name}`);
    }
    const normalizedRef = canonicalizeValue(resolvedRef);
    if (!isObjectRef(normalizedRef)) {
      throw new TypeError(`dependency artifact reference for ${dep.name} must be an object ref`);
    }
    archiveDependencies.push({
      role: dep.role,
      artifact: normalizedRef,
    });
  }

  const archiveArtifact = await putPackageArchiveArtifact({
    images,
    imageId,
    id: `${prefix}/archive`,
    manifest,
    dependencies: archiveDependencies,
  });

  return deepFreeze({
    format: PACKAGE_ARCHIVE_IMPORT_RECEIPT_V1,
    imageId,
    packageName: manifest.name,
    packageVersion: manifest.version,
    archiveDigest: manifest.archiveDigest,
    archiveArtifactId: archiveArtifact.id,
    archiveArtifactRef: objectRef(imageId, archiveArtifact.id),
    archiveArtifact,
    memberArtifacts,
    precompiledArtifacts,
    reusedWasmCount,
  });
}

export {
  LAGRANGE_PACKAGE_ARCHIVE_V1,
  PACKAGE_ARCHIVE_IMPORT_RECEIPT_V1,
  PRECOMPILED_WASM_REUSE_RECEIPT_V1,
  createPackageArchiveManifest,
  importPackageArchive,
  parsePackageArchiveArtifact,
  putPackageArchiveArtifact,
  reusePrecompiledWasmArtifact,
};
