import {ensureCodeArtifact, ensureCodeArtifacts} from '../graph/ensure-records.js';
import {uuid as randomUUID} from '../support/default-crypto.js';
import {normalizeArtifactDependencies} from '../execution/model.js';
import {canonicalizeValue, isObjectRef, objectRef} from '../value/index.js';
import {normalizeMetadata} from '../object/model.js';
import {createDerivationDescriptor} from './derivation-cache.js';
import {CodeCompilerRegistry, normalizeRepresentation} from './compiler-registry.js';
import {COMPILATION_GROUP_KIND} from './group.js';
import {CompilationGroupCompilerRegistry, normalizePolicyId} from './group-compiler-registry.js';

function normalizeObjectRef(value, label) {
  const normalized = canonicalizeValue(value);
  if (!isObjectRef(normalized)) throw new TypeError(`${label} must be an unpinned object ref`);
  return normalized;
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getCodeArtifact', 'putCodeArtifact']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

function requiredKey(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes(':')) {
    throw new TypeError(`${label} must be non-empty text without ':'`);
  }
  return value;
}

// A compiler result is either ONE artifact description {content, dependencies, metadata} — the
// common case — or a RESULT GRAPH {primary, artifacts: [{key, representation, content,
// dependencies, metadata}]} when a compilation's durable form is several records that must become
// visible together (a compiled module = its raw bytes + its semantic descriptor + the edge between
// them). A graph dependency's `artifact` may name a sibling by key; the service resolves it to that
// sibling's ref at persistence time. This is the generic repair of the old one-result-one-artifact
// assumption: no target-specific branch lives here, and the compiler never manufactures artifacts.
function normalizeCompilerResult(result, fallbackLanguageId = null) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('compiler must return an artifact description object');
  }
  const languageId = result.languageId === undefined ? fallbackLanguageId : result.languageId;
  if (result.artifacts === undefined) {
    return Object.freeze({
      languageId,
      content: canonicalizeValue(result.content),
      dependencies: normalizeArtifactDependencies(result.dependencies ?? []),
      metadata: normalizeMetadata(result.metadata ?? {}, 'compiler result metadata'),
    });
  }
  if (!Array.isArray(result.artifacts) || result.artifacts.length === 0) {
    throw new TypeError('compiler result graph must list at least one artifact');
  }
  const keys = new Set();
  const artifacts = result.artifacts.map((entry, index) => {
    const label = `compiler result artifact ${index}`;
    const key = requiredKey(entry?.key, `${label} key`);
    if (keys.has(key)) throw new TypeError(`compiler result graph repeats key ${key}`);
    keys.add(key);
    return Object.freeze({
      key,
      representation: normalizeRepresentation(entry.representation, `${label} representation`),
      content: canonicalizeValue(entry.content),
      dependencies: Object.freeze((entry.dependencies ?? []).map((dependency) => Object.freeze({
        role: dependency?.role,
        artifact: typeof dependency?.artifact === 'string' ? dependency.artifact : canonicalizeValue(dependency?.artifact),
      }))),
      metadata: normalizeMetadata(entry.metadata ?? {}, `${label} metadata`),
    });
  });
  const primary = requiredKey(result.primary, 'compiler result primary key');
  if (!keys.has(primary)) throw new TypeError(`compiler result primary ${primary} is not among its artifacts`);
  for (const artifact of artifacts) {
    for (const dependency of artifact.dependencies) {
      if (typeof dependency.artifact === 'string' && !keys.has(dependency.artifact)) {
        throw new TypeError(`compiler result artifact ${artifact.key} depends on unknown sibling ${dependency.artifact}`);
      }
    }
  }
  return Object.freeze({languageId, primary, artifacts: Object.freeze(artifacts)});
}

// Persist one normalized compiler result at `id` and return the artifact a caller compiles FOR
// (the single artifact, or the graph's primary). Sibling ids derive from the primary id, so the
// whole graph is ensure-exact-or-create at deterministic ids exactly like a single artifact; a
// graph goes through ONE createRecords batch, so its descriptor can never be durably visible
// without its implementation. Caller and cache metadata land on the primary only.
async function persistCompilerResult(images, imageId, {id, target, result, derivedFrom, callerMetadata, cacheMetadata}) {
  if (result.artifacts === undefined) {
    return await ensureCodeArtifact(images, imageId, {
      id,
      languageId: result.languageId,
      representation: target,
      content: result.content,
      dependencies: result.dependencies,
      derivedFrom,
      metadata: {...result.metadata, ...callerMetadata, ...cacheMetadata},
    });
  }
  const idOf = (key) => (key === result.primary ? id : `${id}:${key}`);
  const records = result.artifacts.map((artifact) => {
    const isPrimary = artifact.key === result.primary;
    if (isPrimary && artifact.representation !== target) {
      throw new TypeError(`compiler result primary must be ${target}, got ${artifact.representation}`);
    }
    return {
      id: idOf(artifact.key),
      languageId: result.languageId,
      representation: artifact.representation,
      content: artifact.content,
      dependencies: normalizeArtifactDependencies(artifact.dependencies.map(({role, artifact: target}) => ({
        role,
        artifact: typeof target === 'string' ? objectRef(imageId, idOf(target)) : target,
      }))),
      derivedFrom,
      metadata: isPrimary ? {...artifact.metadata, ...callerMetadata, ...cacheMetadata} : artifact.metadata,
    };
  });
  const stored = await ensureCodeArtifacts(images, imageId, records);
  return stored[result.artifacts.findIndex((artifact) => artifact.key === result.primary)];
}

function commonLanguageId(artifacts) {
  if (artifacts.length === 0) return null;
  const first = artifacts[0].languageId;
  return artifacts.every((artifact) => artifact.languageId === first) ? first : null;
}

class CompilationService {
  constructor({
    images,
    compilers = new CodeCompilerRegistry(),
    groupCompilers = new CompilationGroupCompilerRegistry(),
  } = {}) {
    this.images = assertImages(images);
    if (!compilers || typeof compilers.get !== 'function') {
      throw new TypeError('compilers must be a CodeCompilerRegistry-compatible object');
    }
    if (!groupCompilers || typeof groupCompilers.get !== 'function') {
      throw new TypeError('groupCompilers must be a CompilationGroupCompilerRegistry-compatible object');
    }
    this.compilers = compilers;
    this.groupCompilers = groupCompilers;
  }

  async findReusableArtifact(imageId, targetRepresentation, descriptor) {
    if (!descriptor) return null;
    if (typeof this.images.listCodeArtifacts !== 'function') {
      throw new TypeError('reusable compilation requires images.listCodeArtifacts');
    }
    const artifacts = await this.images.listCodeArtifacts(imageId);
    return artifacts.find((artifact) =>
      artifact.representation === targetRepresentation
      && artifact.metadata?.compilerIdentity === descriptor.compilerIdentity
      && artifact.metadata?.derivationKey === descriptor.derivationKey) ?? null;
  }

  async compileArtifact(sourceRef, {
    targetRepresentation,
    id = randomUUID(),
    metadata = {},
    options = {},
    reuse = true,
  } = {}) {
    if (typeof reuse !== 'boolean') throw new TypeError('reuse must be a boolean');
    const ref = normalizeObjectRef(sourceRef, 'source code artifact');
    const target = normalizeRepresentation(targetRepresentation, 'target representation');
    const source = await this.images.getCodeArtifact(ref.imageId, ref.objectId);
    if (!source) throw new TypeError(`source code artifact not found: ${ref.imageId}/${ref.objectId}`);

    const compiler = this.compilers.get(source.representation, target);
    const request = Object.freeze({source, targetRepresentation: target, options});
    const context = Object.freeze({images: this.images});
    const callerMetadata = normalizeMetadata(metadata, 'compiled artifact metadata');
    const descriptor = await createDerivationDescriptor(compiler, request, context, callerMetadata);

    if (reuse && descriptor) {
      const existing = await this.findReusableArtifact(ref.imageId, target, descriptor);
      if (existing) return existing;
    }

    const result = normalizeCompilerResult(await compiler.compile(request, context), source.languageId);
    const cacheMetadata = descriptor
      ? {compilerIdentity: descriptor.compilerIdentity, derivationKey: descriptor.derivationKey}
      : {};

    return await persistCompilerResult(this.images, ref.imageId, {
      id, target, result, callerMetadata, cacheMetadata,
      derivedFrom: [objectRef(ref.imageId, ref.objectId)],
    });
  }

  async compileGroup(group, {
    id = randomUUID(),
    metadata = {},
    reuse = true,
  } = {}) {
    if (typeof reuse !== 'boolean') throw new TypeError('reuse must be a boolean');
    if (!group || typeof group !== 'object' || Array.isArray(group) || group.kind !== COMPILATION_GROUP_KIND) {
      throw new TypeError(`group must be a ${COMPILATION_GROUP_KIND}`);
    }
    const policyId = normalizePolicyId(group.policyId);
    const target = normalizeRepresentation(group.targetRepresentation, 'compilation group target representation');
    if (!Array.isArray(group.members) || group.members.length === 0) {
      throw new TypeError('compilation group members must be a non-empty array');
    }

    const refs = group.members.map((member, index) => normalizeObjectRef(member, `compilation group member ${index}`));
    const imageId = refs[0].imageId;
    if (refs.some((ref) => ref.imageId !== imageId)) {
      throw new TypeError('grouped compilation currently requires all members to belong to one image');
    }
    const members = [];
    for (const ref of refs) {
      const artifact = await this.images.getCodeArtifact(ref.imageId, ref.objectId);
      if (!artifact) throw new TypeError(`compilation group member not found: ${ref.imageId}/${ref.objectId}`);
      members.push(artifact);
    }

    const compiler = this.groupCompilers.get(policyId, target);
    const request = Object.freeze({
      group,
      members: Object.freeze(members),
      targetRepresentation: target,
      options: group.options,
    });
    const context = Object.freeze({images: this.images});
    const callerMetadata = normalizeMetadata(metadata, 'compiled group artifact metadata');
    const descriptor = await createDerivationDescriptor(compiler, request, context, callerMetadata);

    if (reuse && descriptor) {
      const existing = await this.findReusableArtifact(imageId, target, descriptor);
      if (existing) return existing;
    }

    const result = normalizeCompilerResult(await compiler.compile(request, context), commonLanguageId(members));
    const cacheMetadata = descriptor
      ? {compilerIdentity: descriptor.compilerIdentity, derivationKey: descriptor.derivationKey}
      : {};

    return await persistCompilerResult(this.images, imageId, {
      id, target, result, callerMetadata, cacheMetadata,
      derivedFrom: refs.map((ref) => objectRef(ref.imageId, ref.objectId)),
    });
  }
}

export {CompilationService};
