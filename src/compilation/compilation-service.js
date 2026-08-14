import {randomUUID} from 'node:crypto';
import {canonicalizeValue, isObjectRef, objectRef} from '../value/index.js';
import {normalizeMetadata} from '../object/model.js';
import {createDerivationDescriptor} from './derivation-cache.js';
import {CodeCompilerRegistry, normalizeRepresentation} from './compiler-registry.js';

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

function normalizeCompilerResult(result, source) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('compiler must return an artifact description object');
  }
  return Object.freeze({
    languageId: result.languageId === undefined ? source.languageId : result.languageId,
    content: canonicalizeValue(result.content),
    metadata: normalizeMetadata(result.metadata ?? {}, 'compiler result metadata'),
  });
}

class CompilationService {
  constructor({images, compilers = new CodeCompilerRegistry()} = {}) {
    this.images = assertImages(images);
    if (!compilers || typeof compilers.get !== 'function') {
      throw new TypeError('compilers must be a CodeCompilerRegistry-compatible object');
    }
    this.compilers = compilers;
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
    const descriptor = await createDerivationDescriptor(compiler, request, context);

    if (reuse && descriptor) {
      const existing = await this.findReusableArtifact(ref.imageId, target, descriptor);
      if (existing) return existing;
    }

    const result = normalizeCompilerResult(await compiler.compile(request, context), source);
    const callerMetadata = normalizeMetadata(metadata, 'compiled artifact metadata');
    const cacheMetadata = descriptor
      ? {compilerIdentity: descriptor.compilerIdentity, derivationKey: descriptor.derivationKey}
      : {};

    return await this.images.putCodeArtifact(ref.imageId, {
      id,
      languageId: result.languageId,
      representation: target,
      content: result.content,
      derivedFrom: [objectRef(ref.imageId, ref.objectId)],
      metadata: {...result.metadata, ...callerMetadata, ...cacheMetadata},
    });
  }
}

export {CompilationService};
