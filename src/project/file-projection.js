import {OBJECT_READ_OPERATION, OBJECT_WRITE_OPERATION, objectResource} from '../authority/object-resource.js';
import {
  assertGraphBundleV1,
  contentIdentityForBundle,
  exportGraphBundleWithSourceMap,
  prepareGraphBundleImport,
} from '../graph/bundle.js';
import {ensureShape} from '../graph/ensure-records.js';
import {referencesOfRecord} from '../graph/references.js';
import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {utf8Encode} from '../support/portable-bytes.js';
import {
  canonicalizeValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {normalizeProjectDescriptor} from './model.js';
import {
  PROJECT_SHAPE_ID,
  addProjectMember,
  createProject,
  projectMemberObjectId,
  projectObjectId,
  readProjectDescriptor,
} from './working-state.js';

const PROJECT_NONE_ID = 'lagrange-project/none/v1';
const PROJECT_FILE_PROJECTION_V1 = 'lagrange-project-file-projection/v1';
const PROJECT_FILE_PROJECTION_MANIFEST_V1 = 'lagrange-project-file-manifest/v1';
const PROJECT_FILE_PROJECTION_DIFF_V1 = 'lagrange-project-file-projection-diff/v1';
const GIT_DEPENDENCY_SPEC_V1 = 'lagrange-git-dependency/v1';
const DEFAULT_PROJECT_MANIFEST_PATH = 'lagrange-project.json';

class ProjectFileProjectionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProjectFileProjectionError';
    Object.assign(this, details);
  }
}

function fail(message, details = {}) {
  throw new ProjectFileProjectionError(message, details);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Validate a relative POSIX projection path: no leading/trailing slash, no empty
// segments, no `.` or `..`, no backslashes, and no NUL characters.
function normalizeRelativeProjectionPath(pathText, label = 'projection file path') {
  requiredText(pathText, label);
  if (pathText.includes('\0') || pathText.includes('\\')) {
    fail(`${label} must be a normalized POSIX relative path without backslashes or NUL: ${JSON.stringify(pathText)}`);
  }
  if (pathText.startsWith('/') || pathText.endsWith('/')) {
    fail(`${label} must not start or end with '/': ${JSON.stringify(pathText)}`);
  }
  const segments = pathText.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      fail(`${label} contains an invalid path segment ${JSON.stringify(segment)} in ${JSON.stringify(pathText)}`);
    }
  }
  return pathText;
}

function sanitizePathSegment(text) {
  return String(text)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item';
}

function memberKeyToSafeSubpath(memberKey) {
  const rawSegments = String(memberKey).split('/').filter((s) => s.length > 0);
  if (rawSegments.length === 0) return 'member';
  return rawSegments.map((seg) => sanitizePathSegment(seg)).join('/');
}

function computeFilesContentIdentity(files, {crypto} = {}) {
  const provider = crypto ?? getDefaultCryptoProvider();
  const sortedPaths = Object.keys(files).sort(compareText);
  const canonicalEntries = sortedPaths.map((p) => [p, files[p]]);
  const bytes = utf8Encode(JSON.stringify(canonicalEntries));
  return `sha256:${provider.sha256(bytes)}`;
}

// --- Git / Private-Registry Dependency Conventions (Roadmap §5) ---

const PINNED_REVISION_RE = /^(?:[0-9a-f]{7,64}|sha256:[0-9a-f]{64}|tag:[A-Za-z0-9._/-]+)$/;

function normalizeGitDependencySpec(spec, {requirePinnedRevision = true} = {}) {
  if (!isPlainObject(spec)) {
    fail('Git dependency specification must be a plain object');
  }
  const name = requiredText(spec.name, 'Git dependency name');
  const repository = requiredText(spec.repository, 'Git dependency repository');
  const revision = requiredText(spec.revision, 'Git dependency revision');
  if (requirePinnedRevision && !PINNED_REVISION_RE.test(revision)) {
    fail(
      `Git dependency ${name} revision ${JSON.stringify(revision)} must be an immutable commit hash, tag:<name>, or sha256:<hex>`,
      {dependencyName: name, revision},
    );
  }
  const subdir = spec.subdir === undefined || spec.subdir === null || spec.subdir === ''
    ? null
    : normalizeRelativeProjectionPath(spec.subdir, `Git dependency ${name} subdir`);
  const role = spec.role === undefined || spec.role === null
    ? 'dependency'
    : requiredText(spec.role, `Git dependency ${name} role`);
  const registry = spec.registry === undefined || spec.registry === null
    ? null
    : requiredText(spec.registry, `Git dependency ${name} registry`);
  const targetProjectId = spec.targetProjectId === undefined || spec.targetProjectId === null
    ? null
    : requiredText(spec.targetProjectId, `Git dependency ${name} targetProjectId`);

  return deepFreeze({
    format: GIT_DEPENDENCY_SPEC_V1,
    name,
    repository,
    revision,
    subdir,
    role,
    registry,
    targetProjectId,
  });
}

function normalizeGitDependencyList(list = [], options = {}) {
  if (!Array.isArray(list)) {
    fail('gitDependencies must be an array');
  }
  const seen = new Set();
  const normalized = list.map((item) => {
    const entry = normalizeGitDependencySpec(item, options);
    if (seen.has(entry.name)) {
      fail(`duplicate Git dependency name: ${entry.name}`);
    }
    seen.add(entry.name);
    return entry;
  });
  normalized.sort((a, b) => compareText(a.name, b.name));
  return Object.freeze(normalized);
}

// --- CodeArtifact Closure Inspection ---

async function collectCodeArtifactClosure(images, rootRef) {
  const visited = new Map(); // objectId -> record
  const order = [];
  const queue = [rootRef];

  while (queue.length > 0) {
    const ref = queue.shift();
    if (!isObjectRef(ref)) return null;
    if (ref.imageId !== rootRef.imageId) return null;
    if (visited.has(ref.objectId)) continue;

    // eslint-disable-next-line no-await-in-loop
    const record = await images.getRecord(ref.imageId, ref.objectId);
    if (!record || record.kind !== 'code-artifact') {
      return null;
    }
    // Check that content itself does not embed raw object references that require
    // non-CodeArtifact graph records.
    const allRefs = referencesOfRecord(record);
    const depSet = new Set([
      ...(record.dependencies ?? []).map((d) => d.artifact.objectId),
      ...(record.derivedFrom ?? []).map((d) => d.objectId),
    ]);
    for (const edgeRef of allRefs) {
      if (edgeRef.imageId !== rootRef.imageId || !depSet.has(edgeRef.objectId)) {
        return null;
      }
    }

    visited.set(ref.objectId, record);
    order.push(record);

    for (const dep of record.dependencies ?? []) {
      queue.push(dep.artifact);
    }
    for (const origin of record.derivedFrom ?? []) {
      queue.push(origin);
    }
  }

  // Post-order topological sort (leaves/dependencies first, root last) so
  // importing in array order always satisfies dependencies before dependents.
  const emitted = new Set();
  const topo = [];
  function visit(id) {
    if (emitted.has(id)) return;
    emitted.add(id);
    const rec = visited.get(id);
    if (!rec) return;
    for (const dep of rec.dependencies ?? []) visit(dep.artifact.objectId);
    for (const origin of rec.derivedFrom ?? []) visit(origin.objectId);
    topo.push(rec);
  }
  for (const rec of order) visit(rec.id);
  return topo;
}

// --- Export Project File Projection ---

async function exportProjectFileProjection({
  images,
  imageId,
  projectId,
  gitDependencies = [],
  manifestPath = DEFAULT_PROJECT_MANIFEST_PATH,
  crypto,
} = {}) {
  if (!images || typeof images.getRecord !== 'function' || typeof images.getObject !== 'function') {
    fail('exportProjectFileProjection requires images with getRecord and getObject');
  }
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  const normalizedManifestPath = normalizeRelativeProjectionPath(manifestPath, 'manifestPath');
  const normalizedGitDeps = normalizeGitDependencyList(gitDependencies);

  const descriptor = await readProjectDescriptor({images, imageId, projectId});
  const files = {};
  const usedPaths = new Set([normalizedManifestPath]);
  // Track artifactId -> assigned filePath so shared CodeArtifacts across members
  // map to one canonical file in the projected tree.
  const artifactIdToFilePath = new Map();
  const memberEntries = [];

  for (const member of descriptor.members) {
    // eslint-disable-next-line no-await-in-loop
    const artifactClosure = await collectCodeArtifactClosure(images, member.target);
    if (artifactClosure !== null) {
      const artifactSpecs = [];
      for (const artifact of artifactClosure) {
        let filePath = artifactIdToFilePath.get(artifact.id);
        const isTextContent = artifact.content?.kind === 'text' && typeof artifact.content.value === 'string';
        const serializedContent = isTextContent
          ? artifact.content.value
          : `${JSON.stringify(artifact.content, null, 2)}\n`;

        if (!filePath) {
          let candidatePath = null;
          if (typeof artifact.logicalPath === 'string' && artifact.logicalPath.length > 0) {
            try {
              const normLogical = normalizeRelativeProjectionPath(artifact.logicalPath, 'logicalPath');
              if (!usedPaths.has(normLogical)) {
                candidatePath = normLogical;
              }
            } catch {
              candidatePath = null;
            }
          }
          if (!candidatePath) {
            const ext = isTextContent ? 'src' : 'json';
            const baseCandidate = `artifacts/${memberKeyToSafeSubpath(member.key)}/${sanitizePathSegment(artifact.id)}.${ext}`;
            candidatePath = baseCandidate;
            let suffix = 1;
            while (usedPaths.has(candidatePath)) {
              candidatePath = `artifacts/${memberKeyToSafeSubpath(member.key)}/${sanitizePathSegment(artifact.id)}_${suffix}.${ext}`;
              suffix += 1;
            }
          }
          filePath = candidatePath;
          usedPaths.add(filePath);
          artifactIdToFilePath.set(artifact.id, filePath);
          files[filePath] = serializedContent;
        }

        artifactSpecs.push({
          id: artifact.id,
          filePath,
          languageId: artifact.languageId ?? null,
          representation: artifact.representation,
          logicalPath: artifact.logicalPath ?? null,
          contentKind: isTextContent ? 'text' : 'value',
          dependencies: (artifact.dependencies ?? []).map((d) => ({
            role: d.role,
            artifactId: d.artifact.objectId,
          })),
          derivedFrom: (artifact.derivedFrom ?? []).map((ref) => ref.objectId),
          metadata: artifact.metadata ?? {},
        });
      }

      const rootSpec = artifactSpecs[artifactSpecs.length - 1];
      memberEntries.push({
        key: member.key,
        role: member.role,
        projectionKind: 'code-artifact-closure',
        targetObjectId: member.target.objectId,
        entryPath: rootSpec.filePath,
        artifacts: artifactSpecs,
      });
    } else {
      // General graph closure (objects, shapes, blocks, mixed records): project as a
      // canonical, readable graph bundle JSON file with source-id mapping.
      // eslint-disable-next-line no-await-in-loop
      const exported = await exportGraphBundleWithSourceMap({
        images,
        roots: {root: member.target},
        referencePolicy: {classify: () => 'internal'},
        crypto,
      });
      let bundlePath = `objects/${memberKeyToSafeSubpath(member.key)}.bundle.json`;
      let suffix = 1;
      while (usedPaths.has(bundlePath)) {
        bundlePath = `objects/${memberKeyToSafeSubpath(member.key)}_${suffix}.bundle.json`;
        suffix += 1;
      }
      usedPaths.add(bundlePath);

      const localIdToObjectId = {};
      for (const [localId, ref] of Object.entries(exported.localToSourceRef)) {
        localIdToObjectId[localId] = ref.objectId;
      }
      const bundlePayload = {
        format: exported.bundle.format,
        contentIdentity: exported.contentIdentity,
        bundle: exported.bundle,
        localIdToObjectId,
      };
      files[bundlePath] = `${JSON.stringify(bundlePayload, null, 2)}\n`;

      memberEntries.push({
        key: member.key,
        role: member.role,
        projectionKind: 'graph-bundle',
        targetObjectId: member.target.objectId,
        entryPath: bundlePath,
        contentIdentity: exported.contentIdentity,
      });
    }
  }

  const manifest = {
    format: PROJECT_FILE_PROJECTION_MANIFEST_V1,
    projectId: descriptor.projectId,
    name: descriptor.name,
    namespaceObjectId: descriptor.namespace ? descriptor.namespace.objectId : null,
    gitDependencies: normalizedGitDeps,
    members: memberEntries,
  };
  files[normalizedManifestPath] = `${JSON.stringify(manifest, null, 2)}\n`;

  const orderedFiles = {};
  for (const pathKey of Object.keys(files).sort(compareText)) {
    orderedFiles[pathKey] = files[pathKey];
  }
  const contentIdentity = computeFilesContentIdentity(orderedFiles, {crypto});

  return deepFreeze({
    format: PROJECT_FILE_PROJECTION_V1,
    projectId: descriptor.projectId,
    imageId,
    manifestPath: normalizedManifestPath,
    manifest,
    files: orderedFiles,
    contentIdentity,
  });
}

// --- Manifest Validation ---

function normalizeProjectFileProjectionManifest(rawManifest) {
  if (!isPlainObject(rawManifest)) {
    fail('Project file projection manifest must be a plain object');
  }
  if (rawManifest.format !== PROJECT_FILE_PROJECTION_MANIFEST_V1) {
    fail(`unsupported Project file projection manifest format: ${JSON.stringify(rawManifest.format)}`);
  }
  const projectId = requiredText(rawManifest.projectId, 'manifest projectId');
  const name = requiredText(rawManifest.name, 'manifest name');
  const namespaceObjectId =
    rawManifest.namespaceObjectId === null || rawManifest.namespaceObjectId === undefined
      ? null
      : requiredText(rawManifest.namespaceObjectId, 'manifest namespaceObjectId');
  const gitDependencies = normalizeGitDependencyList(rawManifest.gitDependencies ?? []);
  if (!Array.isArray(rawManifest.members)) {
    fail('manifest members must be an array');
  }
  const seenKeys = new Set();
  const members = rawManifest.members.map((m, index) => {
    if (!isPlainObject(m)) fail(`manifest member ${index} must be a plain object`);
    const key = requiredText(m.key, `manifest member ${index} key`);
    if (seenKeys.has(key)) fail(`duplicate manifest member key: ${key}`);
    seenKeys.add(key);
    const role = requiredText(m.role, `manifest member ${key} role`);
    const projectionKind = requiredText(m.projectionKind, `manifest member ${key} projectionKind`);
    const targetObjectId = requiredText(m.targetObjectId, `manifest member ${key} targetObjectId`);
    const entryPath = normalizeRelativeProjectionPath(m.entryPath, `manifest member ${key} entryPath`);

    if (projectionKind === 'code-artifact-closure') {
      if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) {
        fail(`manifest member ${key} artifacts must be a non-empty array`);
      }
      const artifacts = m.artifacts.map((a, aIdx) => {
        if (!isPlainObject(a)) fail(`manifest member ${key} artifact ${aIdx} must be an object`);
        return {
          id: requiredText(a.id, `member ${key} artifact ${aIdx} id`),
          filePath: normalizeRelativeProjectionPath(a.filePath, `member ${key} artifact ${aIdx} filePath`),
          languageId: a.languageId === null || a.languageId === undefined ? null : requiredText(a.languageId, 'languageId'),
          representation: requiredText(a.representation, `member ${key} artifact ${aIdx} representation`),
          logicalPath: a.logicalPath === null || a.logicalPath === undefined ? null : requiredText(a.logicalPath, 'logicalPath'),
          contentKind: a.contentKind === 'value' ? 'value' : 'text',
          dependencies: Array.isArray(a.dependencies)
            ? a.dependencies.map((d) => ({
                role: requiredText(d.role, 'dependency role'),
                artifactId: requiredText(d.artifactId, 'dependency artifactId'),
              }))
            : [],
          derivedFrom: Array.isArray(a.derivedFrom)
            ? a.derivedFrom.map((id) => requiredText(id, 'derivedFrom id'))
            : [],
          metadata: isPlainObject(a.metadata) ? structuredClone(a.metadata) : {},
        };
      });
      return {
        key,
        role,
        projectionKind,
        targetObjectId,
        entryPath,
        artifacts,
      };
    }
    if (projectionKind === 'graph-bundle') {
      return {
        key,
        role,
        projectionKind,
        targetObjectId,
        entryPath,
        contentIdentity:
          typeof m.contentIdentity === 'string' && m.contentIdentity.length > 0
            ? m.contentIdentity
            : null,
      };
    }
    fail(`unsupported member projectionKind ${JSON.stringify(projectionKind)} for member ${key}`);
  });
  members.sort((a, b) => compareText(a.key, b.key));

  return deepFreeze({
    format: PROJECT_FILE_PROJECTION_MANIFEST_V1,
    projectId,
    name,
    namespaceObjectId,
    gitDependencies,
    members,
  });
}

function parseManifestFromFiles(files, manifestPath = DEFAULT_PROJECT_MANIFEST_PATH) {
  if (!isPlainObject(files)) {
    fail('projection files must be a plain object mapping relative paths to UTF-8 strings');
  }
  const normalizedManifestPath = normalizeRelativeProjectionPath(manifestPath, 'manifestPath');
  for (const [filePath, content] of Object.entries(files)) {
    normalizeRelativeProjectionPath(filePath, 'projection file path');
    if (typeof content !== 'string') {
      fail(`projection file ${filePath} content must be a UTF-8 string`);
    }
  }
  if (!Object.hasOwn(files, normalizedManifestPath)) {
    fail(`projection is missing manifest file ${normalizedManifestPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(files[normalizedManifestPath]);
  } catch (error) {
    fail(`invalid JSON in ${normalizedManifestPath}: ${error.message}`, {cause: error});
  }
  return {
    manifestPath: normalizedManifestPath,
    manifest: normalizeProjectFileProjectionManifest(parsed),
  };
}

// --- Import / Reconcile Project File Projection into an Image ---

function valueEquals(a, b) {
  return JSON.stringify(canonicalizeValue(a)) === JSON.stringify(canonicalizeValue(b));
}

function codeArtifactEqualsSpec(existing, candidate) {
  if (!existing || existing.kind !== 'code-artifact') return false;
  if ((existing.languageId ?? null) !== (candidate.languageId ?? null)) return false;
  if (existing.representation !== candidate.representation) return false;
  if ((existing.logicalPath ?? null) !== (candidate.logicalPath ?? null)) return false;
  if (!valueEquals(existing.content, candidate.content)) return false;
  const existingDeps = existing.dependencies ?? [];
  const candidateDeps = candidate.dependencies ?? [];
  if (existingDeps.length !== candidateDeps.length) return false;
  for (let i = 0; i < existingDeps.length; i += 1) {
    if (
      existingDeps[i].role !== candidateDeps[i].role
      || existingDeps[i].artifact.imageId !== candidateDeps[i].artifact.imageId
      || existingDeps[i].artifact.objectId !== candidateDeps[i].artifact.objectId
    ) {
      return false;
    }
  }
  const existingDerived = existing.derivedFrom ?? [];
  const candidateDerived = candidate.derivedFrom ?? [];
  if (existingDerived.length !== candidateDerived.length) return false;
  for (let i = 0; i < existingDerived.length; i += 1) {
    if (
      existingDerived[i].imageId !== candidateDerived[i].imageId
      || existingDerived[i].objectId !== candidateDerived[i].objectId
    ) {
      return false;
    }
  }
  return true;
}

async function importCodeArtifactMemberClosure({
  images,
  imageId,
  memberSpec,
  files,
  artifactIdRemap,
  reusedArtifactIds,
  createdArtifactIds,
  crypto,
}) {
  const provider = crypto ?? getDefaultCryptoProvider();
  for (const spec of memberSpec.artifacts) {
    if (!Object.hasOwn(files, spec.filePath)) {
      fail(`missing projected source file ${spec.filePath} for member ${memberSpec.key}`);
    }
    const rawText = files[spec.filePath];
    let contentValue;
    if (spec.contentKind === 'text') {
      contentValue = textValue(rawText);
    } else {
      try {
        contentValue = canonicalizeValue(JSON.parse(rawText));
      } catch (error) {
        fail(`invalid Value JSON in ${spec.filePath}: ${error.message}`, {cause: error});
      }
    }

    const dependencies = spec.dependencies.map((d) => ({
      role: d.role,
      artifact: objectRef(imageId, artifactIdRemap.get(d.artifactId) ?? d.artifactId),
    }));
    const derivedFrom = spec.derivedFrom.map((originId) =>
      objectRef(imageId, artifactIdRemap.get(originId) ?? originId),
    );

    const candidateInput = {
      languageId: spec.languageId,
      representation: spec.representation,
      logicalPath: spec.logicalPath,
      content: contentValue,
      dependencies,
      derivedFrom,
      metadata: spec.metadata,
    };

    // Check if an artifact already exists at spec.id (or a previously remapped id in this import)
    const alreadyMappedId = artifactIdRemap.get(spec.id);
    if (alreadyMappedId) {
      // eslint-disable-next-line no-await-in-loop
      const mappedExisting = await images.getRecord(imageId, alreadyMappedId);
      if (codeArtifactEqualsSpec(mappedExisting, candidateInput)) {
        reusedArtifactIds.add(alreadyMappedId);
        continue;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    const existingAtOriginalId = await images.getRecord(imageId, spec.id);
    if (!existingAtOriginalId) {
      // Create at the original id!
      // eslint-disable-next-line no-await-in-loop
      await images.putCodeArtifact(imageId, {
        id: spec.id,
        ...candidateInput,
      });
      artifactIdRemap.set(spec.id, spec.id);
      createdArtifactIds.add(spec.id);
    } else if (codeArtifactEqualsSpec(existingAtOriginalId, candidateInput)) {
      // Unchanged: reuse existing CodeArtifact at spec.id with zero writes!
      artifactIdRemap.set(spec.id, spec.id);
      reusedArtifactIds.add(spec.id);
    } else {
      // Content or dependency changed on an existing immutable CodeArtifact id:
      // mint a deterministic revision id from content hash (or reuse if that revision id already exists).
      const hashHex = provider.sha256(utf8Encode(JSON.stringify(candidateInput))).slice(0, 12);
      let newId = `${spec.id}@${hashHex}`;
      // eslint-disable-next-line no-await-in-loop
      const existingAtRevisionId = await images.getRecord(imageId, newId);
      if (existingAtRevisionId) {
        if (codeArtifactEqualsSpec(existingAtRevisionId, candidateInput)) {
          artifactIdRemap.set(spec.id, newId);
          reusedArtifactIds.add(newId);
          continue;
        }
        newId = `${spec.id}@${provider.uuid()}`;
      }
      // eslint-disable-next-line no-await-in-loop
      await images.putCodeArtifact(imageId, {
        id: newId,
        ...candidateInput,
      });
      artifactIdRemap.set(spec.id, newId);
      createdArtifactIds.add(newId);
    }
  }

  const rootOriginalId = memberSpec.artifacts[memberSpec.artifacts.length - 1].id;
  const resolvedRootId = artifactIdRemap.get(rootOriginalId) ?? rootOriginalId;
  return objectRef(imageId, resolvedRootId);
}

async function importGraphBundleMemberClosure({
  images,
  imageId,
  memberSpec,
  files,
  existingMemberTarget,
  strictBundleContentIdentity = false,
  crypto,
}) {
  if (!Object.hasOwn(files, memberSpec.entryPath)) {
    fail(`missing projected bundle file ${memberSpec.entryPath} for member ${memberSpec.key}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(files[memberSpec.entryPath]);
  } catch (error) {
    fail(`invalid JSON in projected bundle ${memberSpec.entryPath}: ${error.message}`, {cause: error});
  }
  const bundle = parsed?.bundle ?? parsed;
  assertGraphBundleV1(bundle);
  const actualIdentity = contentIdentityForBundle(bundle, {crypto});
  if (strictBundleContentIdentity && parsed?.contentIdentity && parsed.contentIdentity !== actualIdentity) {
    fail(
      `projected bundle ${memberSpec.entryPath} contentIdentity mismatch: declared ${parsed.contentIdentity}, actual ${actualIdentity}`,
    );
  }

  // Check if the currently linked member target in `imageId` already has the exact same bundle contentIdentity!
  if (existingMemberTarget && existingMemberTarget.imageId === imageId) {
    const existingRecord = await images.getRecord(imageId, existingMemberTarget.objectId);
    if (existingRecord) {
      const currentExport = await exportGraphBundleWithSourceMap({
        images,
        roots: {root: existingMemberTarget},
        referencePolicy: {classify: () => 'internal'},
        crypto,
      });
      if (currentExport.contentIdentity === actualIdentity) {
        return {
          targetRef: existingMemberTarget,
          reused: true,
        };
      }
    }
  }

  // If `localIdToObjectId` is present and all records are shapes/objects that can be
  // created or updated at their stable objectIds in `imageId`, reconcile in place!
  const localIdToObjectId = isPlainObject(parsed?.localIdToObjectId) ? parsed.localIdToObjectId : null;
  const canReconcileInPlace =
    localIdToObjectId !== null
    && Object.keys(bundle.externals ?? {}).length === 0
    && Object.entries(bundle.records).every(
      ([localId, rec]) =>
        typeof localIdToObjectId[localId] === 'string'
        && localIdToObjectId[localId].length > 0
        && (rec.kind === 'shape' || rec.kind === 'object'),
    );

  if (canReconcileInPlace) {
    function rewritePortableValue(val) {
      if (!val || typeof val !== 'object') return val;
      if (val.kind === 'local-ref') {
        return objectRef(imageId, localIdToObjectId[val.localId]);
      }
      if (Array.isArray(val)) return val.map(rewritePortableValue);
      if (val.kind === 'array' && Array.isArray(val.elements)) {
        return {kind: 'array', elements: val.elements.map(rewritePortableValue)};
      }
      if (val.kind === 'map' && Array.isArray(val.entries)) {
        return {
          kind: 'map',
          entries: val.entries.map(([k, v]) => [rewritePortableValue(k), rewritePortableValue(v)]),
        };
      }
      return val;
    }

    // 1. Ensure all Shapes first
    for (const [localId, rec] of Object.entries(bundle.records)) {
      if (rec.kind !== 'shape') continue;
      const shapeId = localIdToObjectId[localId];
      // eslint-disable-next-line no-await-in-loop
      await ensureShape(images, imageId, {
        id: shapeId,
        slots: rec.slots,
        ...(rec.indexed !== undefined ? {indexed: rec.indexed} : {}),
      });
    }

    // 2. Partition Objects into missing (create atomically via createRecords) and existing (update via putObject)
    const missingObjectInputs = [];
    const existingObjectUpdates = [];
    for (const [localId, rec] of Object.entries(bundle.records)) {
      if (rec.kind !== 'object') continue;
      const objId = localIdToObjectId[localId];
      // eslint-disable-next-line no-await-in-loop
      const existingObj = await images.getObject(imageId, objId);
      const shapeRef = rewritePortableValue(rec.shape);
      const behaviorRef = rec.behavior ? rewritePortableValue(rec.behavior) : null;
      const slots = {};
      for (const [slotId, slotVal] of Object.entries(rec.slots ?? {})) {
        slots[slotId] = rewritePortableValue(slotVal);
      }
      const indexed = Array.isArray(rec.indexed) ? rec.indexed.map(rewritePortableValue) : undefined;
      const candidateObj = {
        kind: 'object',
        id: objId,
        shape: shapeRef,
        behavior: behaviorRef,
        slots,
        ...(indexed !== undefined ? {indexed} : {}),
        metadata: existingObj?.metadata ?? {},
      };
      if (!existingObj) {
        missingObjectInputs.push(candidateObj);
      } else {
        existingObjectUpdates.push({existingObj, candidateObj});
      }
    }

    if (missingObjectInputs.length > 0) {
      await images.createRecords(imageId, missingObjectInputs);
    }
    for (const {existingObj, candidateObj} of existingObjectUpdates) {
      const {kind: _kind, ...putPayload} = candidateObj;
      // eslint-disable-next-line no-await-in-loop
      await images.putObject(imageId, putPayload, {expectedVersion: existingObj._version});
    }

    const rootLocalId = bundle.roots.root ?? Object.values(bundle.roots)[0];
    return {
      targetRef: objectRef(imageId, localIdToObjectId[rootLocalId]),
      reused: false,
    };
  }

  // General heterogeneous graph bundle import via prepareGraphBundleImport + createRecords
  const plan = await prepareGraphBundleImport({
    images,
    targetImageId: imageId,
    bundle,
    expectedContentIdentity: actualIdentity,
    crypto,
  });
  await images.createRecords(imageId, plan.recordInputs);
  const rootKey = Object.hasOwn(plan.roots, 'root') ? 'root' : Object.keys(plan.roots)[0];
  return {
    targetRef: plan.roots[rootKey],
    reused: false,
  };
}

async function importProjectFileProjection({
  images,
  imageId,
  files,
  manifestPath = DEFAULT_PROJECT_MANIFEST_PATH,
  crypto,
} = {}) {
  if (
    !images
    || typeof images.getRecord !== 'function'
    || typeof images.getObject !== 'function'
    || typeof images.putObject !== 'function'
    || typeof images.putCodeArtifact !== 'function'
  ) {
    fail('importProjectFileProjection requires an ImageService with getRecord, getObject, putObject, and putCodeArtifact');
  }
  requiredText(imageId, 'imageId');
  const {manifest} = parseManifestFromFiles(files, manifestPath);

  const namespaceRef = manifest.namespaceObjectId
    ? objectRef(imageId, manifest.namespaceObjectId)
    : null;

  // Ensure Project exists
  const projectRef = await createProject({
    images,
    imageId,
    projectId: manifest.projectId,
    name: manifest.name,
    namespace: namespaceRef,
  });

  // Read current Project state so we can reconcile name/namespace/removed members and detect unchanged members
  const existingDescriptor = await readProjectDescriptor({
    images,
    imageId,
    projectId: manifest.projectId,
  });
  const existingMemberByKey = new Map(existingDescriptor.members.map((m) => [m.key, m]));

  const artifactIdRemap = new Map();
  const reusedArtifactIds = new Set();
  const createdArtifactIds = new Set();
  const unchangedMemberKeys = [];
  const updatedMemberKeys = [];
  const addedMemberKeys = [];

  for (const memberSpec of manifest.members) {
    const prevMember = existingMemberByKey.get(memberSpec.key) ?? null;
    let targetRef;
    let bundleWasReused = false;
    if (memberSpec.projectionKind === 'code-artifact-closure') {
      // eslint-disable-next-line no-await-in-loop
      targetRef = await importCodeArtifactMemberClosure({
        images,
        imageId,
        memberSpec,
        files,
        artifactIdRemap,
        reusedArtifactIds,
        createdArtifactIds,
        crypto,
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      const bundleResult = await importGraphBundleMemberClosure({
        images,
        imageId,
        memberSpec,
        files,
        existingMemberTarget: prevMember?.target ?? null,
        crypto,
      });
      targetRef = bundleResult.targetRef;
      bundleWasReused = bundleResult.reused;
    }

    if (!prevMember) {
      addedMemberKeys.push(memberSpec.key);
      // eslint-disable-next-line no-await-in-loop
      await addProjectMember({
        images,
        imageId,
        projectId: manifest.projectId,
        key: memberSpec.key,
        role: memberSpec.role,
        target: targetRef,
      });
    } else if (
      prevMember.role === memberSpec.role
      && prevMember.target.imageId === targetRef.imageId
      && prevMember.target.objectId === targetRef.objectId
      && (memberSpec.projectionKind === 'code-artifact-closure' || bundleWasReused)
    ) {
      unchangedMemberKeys.push(memberSpec.key);
    } else if (
      prevMember.role === memberSpec.role
      && prevMember.target.imageId === targetRef.imageId
      && prevMember.target.objectId === targetRef.objectId
      && memberSpec.projectionKind === 'graph-bundle'
    ) {
      updatedMemberKeys.push(memberSpec.key);
    } else {
      updatedMemberKeys.push(memberSpec.key);
      if (prevMember.role !== memberSpec.role) {
        // Update member object's role and target directly
        const memId = projectMemberObjectId(manifest.projectId, memberSpec.key);
        // eslint-disable-next-line no-await-in-loop
        const memObj = await images.getObject(imageId, memId);
        // eslint-disable-next-line no-await-in-loop
        await images.putObject(
          imageId,
          {
            id: memId,
            shape: memObj.shape,
            behavior: null,
            slots: {
              ...memObj.slots,
              'project-member-role': textValue(memberSpec.role),
              'project-member-target': targetRef,
            },
            metadata: memObj.metadata ?? {project: 'member'},
          },
          {expectedVersion: memObj._version},
        );
      } else {
        // eslint-disable-next-line no-await-in-loop
        await addProjectMember({
          images,
          imageId,
          projectId: manifest.projectId,
          key: memberSpec.key,
          role: memberSpec.role,
          target: targetRef,
        });
      }
    }
  }

  // Reconcile Project name, namespace, and removed members on the Project object if needed
  const desiredMemberKeys = new Set(manifest.members.map((m) => m.key));
  const removedMemberKeys = existingDescriptor.members
    .map((m) => m.key)
    .filter((k) => !desiredMemberKeys.has(k));

  const projectObj = await images.getObject(imageId, projectRef.objectId);
  const currentName = projectObj.slots['project-name']?.value;
  const currentNamespaceRef = projectObj.slots['project-namespace'];
  const desiredNamespaceSlotRef = namespaceRef ?? objectRef(imageId, PROJECT_NONE_ID);
  const namespaceChanged =
    !isObjectRef(currentNamespaceRef)
    || currentNamespaceRef.imageId !== desiredNamespaceSlotRef.imageId
    || currentNamespaceRef.objectId !== desiredNamespaceSlotRef.objectId;

  if (
    currentName !== manifest.name
    || namespaceChanged
    || removedMemberKeys.length > 0
    || manifest.gitDependencies.length > 0
  ) {
    const removedMemberObjectIds = new Set(
      removedMemberKeys.map((k) => projectMemberObjectId(manifest.projectId, k)),
    );
    const updatedIndexed = (projectObj.indexed ?? []).filter(
      (ref) => !(isObjectRef(ref) && removedMemberObjectIds.has(ref.objectId)),
    );
    await images.putObject(
      imageId,
      {
        id: projectObj.id,
        shape: projectObj.shape,
        behavior: null,
        slots: {
          ...projectObj.slots,
          'project-name': textValue(manifest.name),
          'project-namespace': desiredNamespaceSlotRef,
        },
        indexed: updatedIndexed,
        metadata: {
          ...(projectObj.metadata ?? {project: 'working-state'}),
          ...(manifest.gitDependencies.length > 0 ? {gitDependencies: manifest.gitDependencies} : {}),
        },
      },
      {expectedVersion: projectObj._version},
    );
  }

  const descriptor = await readProjectDescriptor({
    images,
    imageId,
    projectId: manifest.projectId,
  });

  return deepFreeze({
    projectId: manifest.projectId,
    imageId,
    projectRef,
    descriptor,
    gitDependencies: manifest.gitDependencies,
    addedMemberKeys: addedMemberKeys.sort(compareText),
    updatedMemberKeys: updatedMemberKeys.sort(compareText),
    removedMemberKeys: removedMemberKeys.sort(compareText),
    unchangedMemberKeys: unchangedMemberKeys.sort(compareText),
    reusedArtifactIds: [...reusedArtifactIds].sort(compareText),
    createdArtifactIds: [...createdArtifactIds].sort(compareText),
  });
}

// --- Diff Project File Projections ---

function diffProjectFileProjection({
  leftFiles,
  rightFiles,
  manifestPath = DEFAULT_PROJECT_MANIFEST_PATH,
} = {}) {
  const leftParsed = parseManifestFromFiles(leftFiles, manifestPath);
  const rightParsed = parseManifestFromFiles(rightFiles, manifestPath);

  const allPaths = [...new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)])].sort(compareText);
  const addedFiles = [];
  const removedFiles = [];
  const modifiedFiles = [];
  const unchangedFiles = [];

  for (const filePath of allPaths) {
    const inLeft = Object.hasOwn(leftFiles, filePath);
    const inRight = Object.hasOwn(rightFiles, filePath);
    if (!inLeft && inRight) {
      addedFiles.push(filePath);
    } else if (inLeft && !inRight) {
      removedFiles.push(filePath);
    } else if (leftFiles[filePath] !== rightFiles[filePath]) {
      modifiedFiles.push(filePath);
    } else {
      unchangedFiles.push(filePath);
    }
  }

  const leftMembers = new Map(leftParsed.manifest.members.map((m) => [m.key, m]));
  const rightMembers = new Map(rightParsed.manifest.members.map((m) => [m.key, m]));
  const allMemberKeys = [...new Set([...leftMembers.keys(), ...rightMembers.keys()])].sort(compareText);
  const modifiedFileSet = new Set([...addedFiles, ...removedFiles, ...modifiedFiles]);

  const addedMembers = [];
  const removedMembers = [];
  const modifiedMembers = [];
  const unchangedMembers = [];

  for (const key of allMemberKeys) {
    const l = leftMembers.get(key);
    const r = rightMembers.get(key);
    if (!l && r) {
      addedMembers.push(key);
    } else if (l && !r) {
      removedMembers.push(key);
    } else {
      const lPaths = l.projectionKind === 'code-artifact-closure'
        ? l.artifacts.map((a) => a.filePath)
        : [l.entryPath];
      const rPaths = r.projectionKind === 'code-artifact-closure'
        ? r.artifacts.map((a) => a.filePath)
        : [r.entryPath];
      const anyFileChanged =
        l.role !== r.role
        || l.projectionKind !== r.projectionKind
        || lPaths.length !== rPaths.length
        || lPaths.some((p, idx) => p !== rPaths[idx] || modifiedFileSet.has(p));
      if (anyFileChanged) {
        modifiedMembers.push(key);
      } else {
        unchangedMembers.push(key);
      }
    }
  }

  const nameChanged = leftParsed.manifest.name !== rightParsed.manifest.name;
  const namespaceChanged = leftParsed.manifest.namespaceObjectId !== rightParsed.manifest.namespaceObjectId;
  const gitDependenciesChanged =
    JSON.stringify(leftParsed.manifest.gitDependencies) !== JSON.stringify(rightParsed.manifest.gitDependencies);

  const identical =
    addedFiles.length === 0
    && removedFiles.length === 0
    && modifiedFiles.length === 0;

  return deepFreeze({
    format: PROJECT_FILE_PROJECTION_DIFF_V1,
    identical,
    manifestChanges: {
      nameChanged,
      namespaceChanged,
      gitDependenciesChanged,
    },
    fileChanges: {
      added: addedFiles,
      removed: removedFiles,
      modified: modifiedFiles,
      unchanged: unchangedFiles,
    },
    memberChanges: {
      added: addedMembers,
      removed: removedMembers,
      modified: modifiedMembers,
      unchanged: unchangedMembers,
    },
  });
}

async function diffProjectAgainstFileProjection({
  images,
  imageId,
  projectId,
  files,
  manifestPath = DEFAULT_PROJECT_MANIFEST_PATH,
  crypto,
} = {}) {
  const {manifest} = parseManifestFromFiles(files, manifestPath);
  const currentProjection = await exportProjectFileProjection({
    images,
    imageId,
    projectId: projectId ?? manifest.projectId,
    gitDependencies: manifest.gitDependencies,
    manifestPath,
    crypto,
  });
  return diffProjectFileProjection({
    leftFiles: currentProjection.files,
    rightFiles: files,
    manifestPath,
  });
}

// --- Filesystem Directory Adapter (Dynamic node:fs/promises + node:path) ---

async function writeProjectFileProjectionToDirectory({
  directory,
  projection,
  cleanStaleFiles = false,
} = {}) {
  requiredText(directory, 'directory');
  const files = isPlainObject(projection?.files) ? projection.files : projection;
  const {manifestPath} = parseManifestFromFiles(files, projection?.manifestPath ?? DEFAULT_PROJECT_MANIFEST_PATH);

  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const rootDir = pathMod.resolve(directory);
  await fs.mkdir(rootDir, {recursive: true});

  const writtenPaths = [];
  for (const [relPath, content] of Object.entries(files)) {
    const normalizedRel = normalizeRelativeProjectionPath(relPath);
    const targetFullPath = pathMod.resolve(rootDir, normalizedRel);
    const relativeCheck = pathMod.relative(rootDir, targetFullPath);
    if (relativeCheck.startsWith('..') || pathMod.isAbsolute(relativeCheck)) {
      fail(`projection path escapes target directory: ${relPath}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(pathMod.dirname(targetFullPath), {recursive: true});
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(targetFullPath, content, 'utf8');
    writtenPaths.push(normalizedRel);
  }

  if (cleanStaleFiles) {
    const expectedSet = new Set(writtenPaths);
    async function cleanDir(currentDir, prefix = '') {
      const entries = await fs.readdir(currentDir, {withFileTypes: true});
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = pathMod.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          // eslint-disable-next-line no-await-in-loop
          await cleanDir(full, rel);
        } else if (entry.isFile() && !expectedSet.has(rel)) {
          // eslint-disable-next-line no-await-in-loop
          await fs.unlink(full);
        }
      }
    }
    await cleanDir(rootDir, '');
  }

  return deepFreeze({
    directory: rootDir,
    manifestPath,
    writtenFiles: writtenPaths.sort(compareText),
  });
}

async function readProjectFileProjectionFromDirectory({
  directory,
  manifestPath = DEFAULT_PROJECT_MANIFEST_PATH,
  crypto,
} = {}) {
  requiredText(directory, 'directory');
  const normalizedManifestPath = normalizeRelativeProjectionPath(manifestPath, 'manifestPath');
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const rootDir = pathMod.resolve(directory);

  const files = {};
  async function walk(currentDir, prefix = '') {
    const entries = await fs.readdir(currentDir, {withFileTypes: true});
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = pathMod.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full, rel);
      } else if (entry.isFile()) {
        // eslint-disable-next-line no-await-in-loop
        files[rel] = await fs.readFile(full, 'utf8');
      }
    }
  }
  await walk(rootDir, '');

  const parsed = parseManifestFromFiles(files, normalizedManifestPath);
  const contentIdentity = computeFilesContentIdentity(files, {crypto});
  return deepFreeze({
    format: PROJECT_FILE_PROJECTION_V1,
    projectId: parsed.manifest.projectId,
    imageId: null,
    manifestPath: normalizedManifestPath,
    manifest: parsed.manifest,
    files,
    contentIdentity,
  });
}

// --- Authorized Project File Projection Seams ---

function invokeRequire(require, authority, authorityContext, operation, resource) {
  if (typeof require === 'function') {
    if (require.length >= 2) {
      require(operation, resource);
    } else {
      require({operation, resource});
    }
    return;
  }
  if (authority && typeof authority.require === 'function') {
    authority.require(authorityContext, {operation, resource});
    return;
  }
  throw new TypeError('authorized file projection operation requires a require function or {authority, authorityContext}');
}

async function authorizedExportProjectFileProjection({
  authority,
  authorityContext,
  require,
  images,
  imageId,
  projectId,
  gitDependencies = [],
  manifestPath = DEFAULT_PROJECT_MANIFEST_PATH,
  crypto,
} = {}) {
  if (!images || typeof images.getRecord !== 'function' || typeof images.getObject !== 'function') {
    fail('authorizedExportProjectFileProjection requires images with getRecord and getObject');
  }
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  normalizeRelativeProjectionPath(manifestPath, 'manifestPath');
  normalizeGitDependencyList(gitDependencies);

  // 1. Demand object/read on the Project object BEFORE any existence read (no-existence-oracle).
  invokeRequire(
    require,
    authority,
    authorityContext,
    OBJECT_READ_OPERATION,
    objectResource(imageId, projectObjectId(projectId)),
  );

  // 2. Read the Project descriptor and demand object/read on every member target in canonical order.
  const descriptor = await readProjectDescriptor({images, imageId, projectId});
  const targetDemands = descriptor.members
    .map((m) => m.target)
    .sort((a, b) => compareText(a.imageId, b.imageId) || compareText(a.objectId, b.objectId));
  const seenTargets = new Set();
  for (const target of targetDemands) {
    const key = `${target.imageId}:${target.objectId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    invokeRequire(
      require,
      authority,
      authorityContext,
      OBJECT_READ_OPERATION,
      objectResource(target.imageId, target.objectId),
    );
  }

  return await exportProjectFileProjection({
    images,
    imageId,
    projectId,
    gitDependencies,
    manifestPath,
    crypto,
  });
}

async function authorizedImportProjectFileProjection({
  authority,
  authorityContext,
  require,
  images,
  imageId,
  files,
  manifestPath = DEFAULT_PROJECT_MANIFEST_PATH,
  crypto,
} = {}) {
  if (!images || typeof images.getRecord !== 'function' || typeof images.getObject !== 'function') {
    fail('authorizedImportProjectFileProjection requires images with getRecord and getObject');
  }
  requiredText(imageId, 'imageId');
  // 1. Validate pure caller inputs and manifest BEFORE any authority check or storage read.
  const {manifest} = parseManifestFromFiles(files, manifestPath);

  // 2. Demand object/write on the Project object BEFORE any existence read or write (no-existence-oracle).
  invokeRequire(
    require,
    authority,
    authorityContext,
    OBJECT_WRITE_OPERATION,
    objectResource(imageId, projectObjectId(manifest.projectId)),
  );

  return await importProjectFileProjection({
    images,
    imageId,
    files,
    manifestPath,
    crypto,
  });
}

export {
  DEFAULT_PROJECT_MANIFEST_PATH,
  GIT_DEPENDENCY_SPEC_V1,
  PROJECT_FILE_PROJECTION_DIFF_V1,
  PROJECT_FILE_PROJECTION_MANIFEST_V1,
  PROJECT_FILE_PROJECTION_V1,
  ProjectFileProjectionError,
  authorizedExportProjectFileProjection,
  authorizedImportProjectFileProjection,
  diffProjectAgainstFileProjection,
  diffProjectFileProjection,
  exportProjectFileProjection,
  importProjectFileProjection,
  normalizeGitDependencyList,
  normalizeGitDependencySpec,
  normalizeProjectFileProjectionManifest,
  readProjectFileProjectionFromDirectory,
  writeProjectFileProjectionToDirectory,
};
