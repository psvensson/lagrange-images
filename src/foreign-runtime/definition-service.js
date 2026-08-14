import {canonicalizeValue, isObjectRef} from '../value/index.js';

const FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0 = 'lagrange-foreign-runtime-definition/v0';

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function assertImages(images) {
  if (!images || typeof images.getCodeArtifact !== 'function') {
    throw new TypeError('foreign runtime definition service requires images.getCodeArtifact');
  }
  return images;
}

function assertRuntimes(runtimes) {
  if (!runtimes || typeof runtimes.start !== 'function') {
    throw new TypeError('foreign runtime definition service requires runtimes.start');
  }
  return runtimes;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function refKey(ref) {
  return `${ref.imageId}\u0000${ref.objectId}`;
}

function runtimeArtifactSnapshot(artifact) {
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

async function resolveForeignRuntimeDefinition(images, definition) {
  const service = assertImages(images);
  const rootRef = normalizeObjectRef(definition, 'foreign runtime definition');
  const artifacts = [];
  const byKey = new Map();
  const visiting = new Set();

  const visit = async (ref) => {
    const key = refKey(ref);
    if (visiting.has(key)) {
      throw new TypeError(`foreign runtime artifact dependency cycle detected at ${ref.imageId}/${ref.objectId}`);
    }
    const existing = byKey.get(key);
    if (existing) return existing;

    visiting.add(key);
    try {
      const artifact = await service.getCodeArtifact(ref.imageId, ref.objectId);
      if (!artifact) {
        throw new TypeError(`foreign runtime definition artifact not found: ${ref.imageId}/${ref.objectId}`);
      }
      const node = Object.freeze({ref, artifact: runtimeArtifactSnapshot(artifact)});
      byKey.set(key, node);
      artifacts.push(node);
      for (const dependency of artifact.dependencies ?? []) {
        await visit(dependency.artifact);
      }
      return node;
    } finally {
      visiting.delete(key);
    }
  };

  const root = await visit(rootRef);
  return deepFreeze({
    protocol: FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0,
    root,
    artifacts,
  });
}

class ForeignRuntimeDefinitionService {
  constructor({images, runtimes} = {}) {
    this.images = assertImages(images);
    this.runtimes = assertRuntimes(runtimes);
  }

  async start({providerId, definition} = {}) {
    const runtimeDefinition = await resolveForeignRuntimeDefinition(this.images, definition);
    return await this.runtimes.start({
      providerId,
      spec: {runtimeDefinition},
    });
  }
}

export {
  FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0,
  ForeignRuntimeDefinitionService,
  resolveForeignRuntimeDefinition,
  runtimeArtifactSnapshot,
};
