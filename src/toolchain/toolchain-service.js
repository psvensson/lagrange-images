import {randomUUID} from 'node:crypto';
import {normalizeDerivationKeyMaterial} from '../compilation/derivation-cache.js';
import {normalizeArtifactDependencies} from '../execution/model.js';
import {normalizeMetadata} from '../object/model.js';
import {canonicalizeValue, isObjectRef, objectRef} from '../value/index.js';
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
  for (const method of ['getCodeArtifact', 'putCodeArtifact']) {
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

function refKey(ref) {
  return `${ref.imageId}\u0000${ref.objectId}`;
}

async function resolveArtifactGraph(images, roots) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('toolchain roots must be a non-empty array');
  const rootRefs = Object.freeze(roots.map((root, index) => normalizeObjectRef(root, `toolchain root ${index}`)));
  const nodes = [];
  const byKey = new Map();
  const visiting = new Set();

  const visit = async (ref) => {
    const key = refKey(ref);
    if (visiting.has(key)) throw new TypeError(`artifact dependency cycle detected at ${ref.imageId}/${ref.objectId}`);
    const existing = byKey.get(key);
    if (existing) return existing;
    visiting.add(key);
    try {
      const artifact = await images.getCodeArtifact(ref.imageId, ref.objectId);
      if (!artifact) throw new TypeError(`toolchain artifact not found: ${ref.imageId}/${ref.objectId}`);
      const snapshot = deepFreeze({
        ...structuredClone(artifact),
        dependencies: structuredClone(artifact.dependencies ?? []),
      });
      const node = Object.freeze({ref, artifact: snapshot});
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
  } = {}) {
    const id = normalizeProviderId(providerId);
    const outputImageId = requiredText(imageId, 'toolchain output imageId');
    const provider = this.providers.get(id);
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

    const provenance = graph.artifacts.map(({ref}) => objectRef(ref.imageId, ref.objectId));
    const storedOutputs = [];
    for (const output of result.outputs) {
      const artifact = await this.images.putCodeArtifact(outputImageId, {
        id: resolvedIds.get(output.name),
        languageId: output.languageId,
        representation: output.representation,
        content: output.content,
        dependencies: output.dependencies,
        derivedFrom: provenance,
        metadata: {
          ...output.metadata,
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
    });
  }
}

export {
  TOOLCHAIN_PROVIDER_PROTOCOL_V0,
  ToolchainService,
  normalizeProviderResult,
  resolveArtifactGraph,
};
