import {TupleMap, TupleSet} from '../support/tuple-map.js';
import {randomUUID} from 'node:crypto';
import {normalizeDerivationKeyMaterial} from '../compilation/derivation-cache.js';
import {normalizeArtifactDependencies} from '../execution/model.js';
import {normalizeMetadata} from '../object/model.js';
import {canonicalizeValue, isObjectRef, objectRef} from '../value/index.js';
import {createToolchainDerivationDescriptor} from './derivation-cache.js';
import {ToolchainProviderRegistry, normalizeProviderId} from './provider-registry.js';

const TOOLCHAIN_PROVIDER_PROTOCOL_V0 = 'lagrange-toolchain-provider/v0';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getImage', 'getRecord', 'getCodeArtifact', 'putCodeArtifact']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizePlainData(value, label) {
  normalizeDerivationKeyMaterial(value, label);
  return deepFreeze(structuredClone(value));
}

// A tuple key, not a joined string: image and object ids are arbitrary non-empty text, so
// no separator is safe to join on. See src/support/tuple-map.js.
function refKey(ref) {
  return [ref.imageId, ref.objectId];
}

function sameRef(left, right) {
  return left?.kind === right?.kind
    && left?.imageId === right?.imageId
    && left?.objectId === right?.objectId
    && (left?.revision ?? null) === (right?.revision ?? null);
}

function sameReferenceList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((ref, index) => sameRef(ref, right[index]));
}

function toolchainArtifactSnapshot(artifact) {
  return deepFreeze({
    kind: 'code-artifact',
    id: artifact.id,
    imageId: artifact.imageId,
    languageId: artifact.languageId ?? null,
    representation: artifact.representation,
    content: structuredClone(artifact.content),
    dependencies: structuredClone(artifact.dependencies ?? []),
    metadata: structuredClone(artifact.metadata ?? {}),
  });
}

async function resolveArtifactGraph(images, roots) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('toolchain roots must be a non-empty array');
  const rootRefs = Object.freeze(roots.map((root, index) => normalizeObjectRef(root, `toolchain root ${index}`)));
  const nodes = [];
  const byKey = new TupleMap(2);
  // A TupleSet, not a native Set: refKey now returns a fresh array each call, and a native
  // Set compares those by identity, so `has` would never match and cycle detection would
  // silently stop working.
  const visiting = new TupleSet(2);

  const visit = async (ref) => {
    const key = refKey(ref);
    if (visiting.has(key)) throw new TypeError(`artifact dependency cycle detected at ${ref.imageId}/${ref.objectId}`);
    const existing = byKey.get(key);
    if (existing) return existing;
    visiting.add(key);
    try {
      const artifact = await images.getCodeArtifact(ref.imageId, ref.objectId);
      if (!artifact) throw new TypeError(`toolchain artifact not found: ${ref.imageId}/${ref.objectId}`);
      const node = Object.freeze({ref, artifact: toolchainArtifactSnapshot(artifact)});
      byKey.set(key, node);
      nodes.push(node);
      for (const dependency of artifact.dependencies ?? []) await visit(dependency.artifact);
      return node;
    } finally {
      visiting.delete(key);
    }
  };

  for (const ref of rootRefs) await visit(ref);
  return Object.freeze({
    roots: Object.freeze(rootRefs.map((ref) => byKey.get(refKey(ref)))),
    artifacts: Object.freeze(nodes),
  });
}

function normalizeProviderOutput(output, index) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new TypeError(`toolchain output ${index} must be an object`);
  }
  const allowed = new Set(['name', 'languageId', 'representation', 'content', 'dependencies', 'metadata']);
  const extra = Object.keys(output).filter((key) => !allowed.has(key));
  if (extra.length) throw new TypeError(`unknown toolchain output ${index} fields: ${extra.join(', ')}`);
  return Object.freeze({
    name: requiredText(output.name, `toolchain output ${index} name`),
    languageId: output.languageId === undefined || output.languageId === null
      ? null
      : requiredText(output.languageId, `toolchain output ${index} languageId`),
    representation: requiredText(output.representation, `toolchain output ${index} representation`),
    content: canonicalizeValue(output.content),
    dependencies: normalizeArtifactDependencies(output.dependencies ?? []),
    metadata: normalizeMetadata(output.metadata ?? {}, `toolchain output ${index} metadata`),
  });
}

function normalizeProviderResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('toolchain provider must return a result object');
  }
  const allowed = new Set(['outputs', 'diagnostics']);
  const extra = Object.keys(result).filter((key) => !allowed.has(key));
  if (extra.length) throw new TypeError(`unknown toolchain result fields: ${extra.join(', ')}`);
  if (!Array.isArray(result.outputs) || result.outputs.length === 0) {
    throw new TypeError('toolchain provider result outputs must be a non-empty array');
  }
  const outputs = Object.freeze(result.outputs.map(normalizeProviderOutput));
  const names = new Set();
  for (const output of outputs) {
    if (names.has(output.name)) throw new TypeError(`duplicate toolchain output name: ${output.name}`);
    names.add(output.name);
  }
  const diagnostics = normalizePlainData(result.diagnostics ?? [], 'toolchain diagnostics');
  if (!Array.isArray(diagnostics)) throw new TypeError('toolchain diagnostics must be an array');
  return Object.freeze({outputs, diagnostics});
}

function normalizeOutputIds(outputIds) {
  if (!outputIds || typeof outputIds !== 'object' || Array.isArray(outputIds)) {
    throw new TypeError('toolchain outputIds must be an object keyed by output name');
  }
  const normalized = {};
  for (const [name, id] of Object.entries(outputIds)) {
    requiredText(name, 'toolchain outputIds name');
    normalized[name] = requiredText(id, `toolchain outputIds ${name}`);
  }
  return Object.freeze(normalized);
}

function completeCachedResult(artifacts, provenance) {
  if (artifacts.length === 0) return null;
  const count = artifacts[0].metadata?.toolchainOutputCount;
  if (!Number.isInteger(count) || count <= 0 || artifacts.length !== count) return null;
  const resultId = artifacts[0].metadata?.toolchainResultId;
  if (typeof resultId !== 'string' || resultId.length === 0) return null;
  const byIndex = new Map();
  const names = new Set();

  for (const artifact of artifacts) {
    const metadata = artifact.metadata ?? {};
    if (metadata.toolchainResultId !== resultId || metadata.toolchainOutputCount !== count) return null;
    const index = metadata.toolchainOutputIndex;
    const name = metadata.toolchainOutputName;
    if (!Number.isInteger(index) || index < 0 || index >= count || byIndex.has(index)) return null;
    if (typeof name !== 'string' || name.length === 0 || names.has(name)) return null;
    if (!sameReferenceList(artifact.derivedFrom ?? [], provenance)) return null;
    byIndex.set(index, Object.freeze({name, artifact}));
    names.add(name);
  }

  if (byIndex.size !== count) return null;
  return Object.freeze({
    resultId,
    outputs: Object.freeze([...byIndex.entries()].sort(([left], [right]) => left - right).map(([, output]) => output)),
  });
}

function requestedOutputIdsMatch(candidate, requestedOutputIds) {
  const byName = new Map(candidate.outputs.map((output) => [output.name, output.artifact.id]));
  for (const [name, requestedId] of Object.entries(requestedOutputIds)) {
    if (!byName.has(name)) return Object.freeze({matches: false, unknownName: name});
    if (byName.get(name) !== requestedId) return Object.freeze({matches: false, unknownName: null});
  }
  return Object.freeze({matches: true, unknownName: null});
}

async function findReusableToolchainResult({
  images,
  imageId,
  providerId,
  toolchainIdentity,
  derivationKey,
  provenance,
  requestedOutputIds,
}) {
  if (typeof images.listCodeArtifacts !== 'function') {
    throw new TypeError('toolchain result reuse requires images.listCodeArtifacts');
  }
  const artifacts = await images.listCodeArtifacts(imageId);
  const groups = new Map();
  for (const artifact of artifacts) {
    const metadata = artifact.metadata ?? {};
    if (metadata.toolchainProviderId !== providerId
      || metadata.toolchainIdentity !== toolchainIdentity
      || metadata.toolchainProtocol !== TOOLCHAIN_PROVIDER_PROTOCOL_V0
      || metadata.toolchainDerivationKey !== derivationKey
      || typeof metadata.toolchainResultId !== 'string') continue;
    const group = groups.get(metadata.toolchainResultId) ?? [];
    group.push(artifact);
    groups.set(metadata.toolchainResultId, group);
  }

  let unknownName = null;
  for (const resultId of [...groups.keys()].sort()) {
    const candidate = completeCachedResult(groups.get(resultId), provenance);
    if (!candidate) continue;
    const match = requestedOutputIdsMatch(candidate, requestedOutputIds);
    if (match.matches) return candidate;
    if (match.unknownName !== null) unknownName = match.unknownName;
  }
  if (unknownName !== null) throw new TypeError(`toolchain outputIds names unknown output: ${unknownName}`);
  return null;
}

class ToolchainService {
  constructor({images, providers = new ToolchainProviderRegistry()} = {}) {
    this.images = assertImages(images);
    if (!providers || typeof providers.get !== 'function') {
      throw new TypeError('providers must be a ToolchainProviderRegistry-compatible object');
    }
    this.providers = providers;
  }

  async run({
    providerId,
    imageId,
    roots,
    target = {},
    options = {},
    outputIds = {},
    reuse = true,
  } = {}) {
    if (typeof reuse !== 'boolean') throw new TypeError('toolchain reuse must be a boolean');
    const id = normalizeProviderId(providerId);
    const outputImageId = requiredText(imageId, 'toolchain output imageId');
    const provider = this.providers.get(id);
    await this.images.getImage(outputImageId);
    const graph = await resolveArtifactGraph(this.images, roots);
    const normalizedTarget = normalizePlainData(target, 'toolchain target');
    const normalizedOptions = normalizePlainData(options, 'toolchain options');
    const requestedOutputIds = normalizeOutputIds(outputIds);

    const request = Object.freeze({
      protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0,
      providerId: id,
      toolchainIdentity: provider.identity,
      roots: graph.roots,
      artifacts: graph.artifacts,
      target: normalizedTarget,
      options: normalizedOptions,
    });
    const context = Object.freeze({protocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0});
    const descriptor = await createToolchainDerivationDescriptor(provider, request, context);
    const provenance = graph.artifacts.map(({ref}) => objectRef(ref.imageId, ref.objectId));

    if (reuse && descriptor) {
      const reusable = await findReusableToolchainResult({
        images: this.images,
        imageId: outputImageId,
        providerId: id,
        toolchainIdentity: descriptor.toolchainIdentity,
        derivationKey: descriptor.derivationKey,
        provenance,
        requestedOutputIds,
      });
      if (reusable) {
        return Object.freeze({
          providerId: id,
          toolchainIdentity: provider.identity,
          roots: Object.freeze(graph.roots.map(({ref}) => ref)),
          inputs: Object.freeze(graph.artifacts.map(({ref}) => ref)),
          outputs: reusable.outputs,
          diagnostics: Object.freeze([]),
          reused: true,
          derivationKey: descriptor.derivationKey,
        });
      }
    }

    const result = normalizeProviderResult(await provider.run(request, context));
    const outputNames = new Set(result.outputs.map(({name}) => name));
    for (const name of Object.keys(requestedOutputIds)) {
      if (!outputNames.has(name)) throw new TypeError(`toolchain outputIds names unknown output: ${name}`);
    }
    const resolvedIds = new Map();
    const seenIds = new Set();
    for (const output of result.outputs) {
      const outputId = requestedOutputIds[output.name] ?? randomUUID();
      if (seenIds.has(outputId)) throw new TypeError(`duplicate toolchain output id: ${outputId}`);
      seenIds.add(outputId);
      resolvedIds.set(output.name, outputId);
      for (const dependency of output.dependencies) {
        const dependencyArtifact = await this.images.getCodeArtifact(
          dependency.artifact.imageId,
          dependency.artifact.objectId,
        );
        if (!dependencyArtifact) {
          throw new TypeError(`toolchain output dependency not found: ${dependency.artifact.imageId}/${dependency.artifact.objectId}`);
        }
      }
    }
    for (const [name, outputId] of resolvedIds) {
      if (await this.images.getRecord(outputImageId, outputId)) {
        throw new TypeError(`toolchain output already exists: ${name} -> ${outputImageId}/${outputId}`);
      }
    }

    const resultId = descriptor ? randomUUID() : null;
    const storedOutputs = [];
    for (const [index, output] of result.outputs.entries()) {
      const cacheMetadata = descriptor ? {
        toolchainDerivationKey: descriptor.derivationKey,
        toolchainResultId: resultId,
        toolchainOutputName: output.name,
        toolchainOutputIndex: index,
        toolchainOutputCount: result.outputs.length,
      } : {};
      const artifact = await this.images.putCodeArtifact(outputImageId, {
        id: resolvedIds.get(output.name),
        languageId: output.languageId,
        representation: output.representation,
        content: output.content,
        dependencies: output.dependencies,
        derivedFrom: provenance,
        metadata: {
          ...output.metadata,
          ...cacheMetadata,
          toolchainProviderId: id,
          toolchainIdentity: provider.identity,
          toolchainProtocol: TOOLCHAIN_PROVIDER_PROTOCOL_V0,
        },
      });
      storedOutputs.push(Object.freeze({name: output.name, artifact}));
    }

    return Object.freeze({
      providerId: id,
      toolchainIdentity: provider.identity,
      roots: Object.freeze(graph.roots.map(({ref}) => ref)),
      inputs: Object.freeze(graph.artifacts.map(({ref}) => ref)),
      outputs: Object.freeze(storedOutputs),
      diagnostics: result.diagnostics,
      reused: false,
      derivationKey: descriptor?.derivationKey ?? null,
    });
  }
}

export {
  TOOLCHAIN_PROVIDER_PROTOCOL_V0,
  ToolchainService,
  completeCachedResult,
  findReusableToolchainResult,
  normalizeProviderResult,
  resolveArtifactGraph,
  toolchainArtifactSnapshot,
};
