import {randomUUID} from 'node:crypto';
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

function normalizeCompilerResult(result, fallbackLanguageId = null) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('compiler must return an artifact description object');
  }
  return Object.freeze({
    languageId: result.languageId === undefined ? fallbackLanguageId : result.languageId,
    content: canonicalizeValue(result.content),
    dependencies: normalizeArtifactDependencies(result.dependencies ?? []),
    metadata: normalizeMetadata(result.metadata ?? {}, 'compiler result metadata'),
  });
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

    return await this.images.putCodeArtifact(ref.imageId, {
      id,
      languageId: result.languageId,
      representation: target,
      content: result.content,
      dependencies: result.dependencies,
      derivedFrom: [objectRef(ref.imageId, ref.objectId)],
      metadata: {...result.metadata, ...callerMetadata, ...cacheMetadata},
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

    return await this.images.putCodeArtifact(imageId, {
      id,
      languageId: result.languageId,
      representation: target,
      content: result.content,
      dependencies: result.dependencies,
      derivedFrom: refs.map((ref) => objectRef(ref.imageId, ref.objectId)),
      metadata: {...result.metadata, ...callerMetadata, ...cacheMetadata},
    });
  }
}

export {CompilationService};
