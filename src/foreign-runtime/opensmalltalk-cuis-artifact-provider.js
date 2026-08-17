import {TupleMap} from '../support/tuple-map.js';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, extname, join, resolve} from 'node:path';
import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0} from './definition-service.js';
import {LineProcessRunner} from './line-process-runner.js';
import {createOpenSmalltalkCuisProvider} from './opensmalltalk-cuis-provider.js';

const CUIS_RUNTIME_DEFINITION_V1 = 'smalltalk/cuis-runtime-definition-v1';
const CUIS_RUNTIME_DEFINITION_CONTRACT_V0 = 'cuis-runtime-definition/v0';
const OPENSMALLTALK_CUIS_ARTIFACT_PROVIDER_V0 = 'opensmalltalk-cuis-artifact-runtime/v0';
const CUIS_IMAGE_V1 = 'smalltalk/cuis-image-v1';
const CUIS_CHANGES_V1 = 'smalltalk/cuis-changes-v1';
const CUIS_SOURCES_V1 = 'smalltalk/cuis-sources-v1';
const CUIS_PACKAGE_V1 = 'smalltalk/cuis-package-v1';
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function safeFileName(value, extension, label) {
  const fileName = requiredText(value, label);
  if (basename(fileName) !== fileName || !SAFE_FILE.test(fileName) || fileName.includes('..') || extname(fileName) !== extension) {
    throw new TypeError(`${label} must be a safe ${extension} basename`);
  }
  return fileName;
}

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

// A tuple key, not a joined string: image and object ids are arbitrary non-empty text, so
// no separator is safe to join on. See src/support/tuple-map.js.
function artifactKey(ref) {
  return [ref.imageId, ref.objectId];
}

function artifactIdentity(ref) {
  return `artifact/${ref.imageId}/${ref.objectId}`;
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

function normalizeNode(node, label) {
  exactKeys(node, ['artifact', 'ref'], label);
  const ref = normalizeObjectRef(node.ref, `${label} ref`);
  const artifact = node.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || artifact.kind !== 'code-artifact') {
    throw new TypeError(`${label} artifact must be a code-artifact snapshot`);
  }
  if (artifact.imageId !== ref.imageId || artifact.id !== ref.objectId) {
    throw new TypeError(`${label} artifact identity must match its ref`);
  }
  return Object.freeze({ref, artifact});
}

function normalizeRuntimeDefinitionEnvelope(spec) {
  exactKeys(spec, ['runtimeDefinition'], 'OpenSmalltalk Cuis artifact runtime spec');
  const definition = spec.runtimeDefinition;
  exactKeys(definition, ['artifacts', 'protocol', 'root'], 'foreign runtime definition envelope');
  if (definition.protocol !== FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0) {
    throw new TypeError(`unsupported foreign runtime definition protocol: ${definition.protocol}`);
  }
  if (!Array.isArray(definition.artifacts) || definition.artifacts.length === 0) {
    throw new TypeError('foreign runtime definition artifacts must be a non-empty array');
  }
  const root = normalizeNode(definition.root, 'foreign runtime definition root');
  const artifacts = definition.artifacts.map((node, index) => normalizeNode(node, `foreign runtime definition artifact ${index}`));
  return Object.freeze({protocol: definition.protocol, root, artifacts: Object.freeze(artifacts)});
}

function nodeMap(definition) {
  const nodes = new TupleMap(2);
  for (const node of definition.artifacts) {
    const key = artifactKey(node.ref);
    if (nodes.has(key)) throw new TypeError(`duplicate foreign runtime definition artifact: ${node.ref.imageId}/${node.ref.objectId}`);
    nodes.set(key, node);
  }
  const root = nodes.get(artifactKey(definition.root.ref));
  if (!root) throw new TypeError('foreign runtime definition root is not present in artifacts');
  return nodes;
}

function nodeForDependency(nodes, dependency, label) {
  const node = nodes.get(artifactKey(dependency.artifact));
  if (!node) throw new TypeError(`${label} dependency is not present in the resolved runtime graph`);
  return node;
}

function imageStem(fileName) {
  return fileName.slice(0, -'.image'.length);
}

function validateCuisRuntimeDefinition(spec) {
  const definition = normalizeRuntimeDefinitionEnvelope(spec);
  const root = definition.root.artifact;
  if (root.representation !== CUIS_RUNTIME_DEFINITION_V1) {
    throw new TypeError(`OpenSmalltalk Cuis runtime definition must be ${CUIS_RUNTIME_DEFINITION_V1}`);
  }
  if (root.content?.kind !== 'text' || root.content.value !== CUIS_RUNTIME_DEFINITION_CONTRACT_V0) {
    throw new TypeError(`OpenSmalltalk Cuis runtime definition content must be ${CUIS_RUNTIME_DEFINITION_CONTRACT_V0}`);
  }

  const nodes = nodeMap(definition);
  const images = [];
  const changes = [];
  const sources = [];
  const packages = [];
  for (const dependency of root.dependencies ?? []) {
    const node = nodeForDependency(nodes, dependency, `OpenSmalltalk Cuis ${dependency.role}`);
    switch (dependency.role) {
      case 'image': images.push(node); break;
      case 'changes': changes.push(node); break;
      case 'sources': sources.push(node); break;
      case 'package': packages.push(node); break;
      default: throw new TypeError(`unsupported OpenSmalltalk Cuis runtime dependency role: ${dependency.role}`);
    }
  }

  if (images.length !== 1) throw new TypeError('OpenSmalltalk Cuis runtime definition requires exactly one image dependency');
  if (changes.length > 1) throw new TypeError('OpenSmalltalk Cuis runtime definition may contain at most one changes dependency');
  if (sources.length > 1) throw new TypeError('OpenSmalltalk Cuis runtime definition may contain at most one sources dependency');

  const imageNode = images[0];
  const image = imageNode.artifact;
  if (image.representation !== CUIS_IMAGE_V1) throw new TypeError(`runtime image must be ${CUIS_IMAGE_V1}`);
  bytesArtifact(image, 'OpenSmalltalk Cuis runtime image');
  const imageFileName = safeFileName(image.metadata?.fileName, '.image', 'OpenSmalltalk Cuis runtime image metadata.fileName');

  const changesNode = changes[0] ?? null;
  const changesArtifact = changesNode?.artifact ?? null;
  let changesFileName = null;
  if (changesArtifact) {
    if (changesArtifact.representation !== CUIS_CHANGES_V1) throw new TypeError(`runtime changes must be ${CUIS_CHANGES_V1}`);
    artifactBytes(changesArtifact, 'OpenSmalltalk Cuis runtime changes');
    changesFileName = safeFileName(changesArtifact.metadata?.fileName, '.changes', 'OpenSmalltalk Cuis runtime changes metadata.fileName');
    const expected = `${imageStem(imageFileName)}.changes`;
    if (changesFileName !== expected) throw new TypeError(`OpenSmalltalk Cuis runtime changes filename must be ${expected}`);
  }

  const sourcesNode = sources[0] ?? null;
  const sourcesArtifact = sourcesNode?.artifact ?? null;
  let sourcesFileName = null;
  if (sourcesArtifact) {
    if (sourcesArtifact.representation !== CUIS_SOURCES_V1) throw new TypeError(`runtime sources must be ${CUIS_SOURCES_V1}`);
    artifactBytes(sourcesArtifact, 'OpenSmalltalk Cuis runtime sources');
    sourcesFileName = safeFileName(sourcesArtifact.metadata?.fileName, '.sources', 'OpenSmalltalk Cuis runtime sources metadata.fileName');
  }

  const packageRecords = [];
  const packageFileNames = new Set();
  for (const node of packages) {
    const artifact = node.artifact;
    if (artifact.representation !== CUIS_PACKAGE_V1) throw new TypeError(`runtime package must be ${CUIS_PACKAGE_V1}`);
    artifactBytes(artifact, `OpenSmalltalk Cuis runtime package ${artifact.id}`);
    const fileName = safeFileName(artifact.metadata?.fileName, '.st', `OpenSmalltalk Cuis runtime package ${artifact.id} metadata.fileName`);
    if (!fileName.endsWith('.pck.st')) throw new TypeError(`OpenSmalltalk Cuis runtime package ${artifact.id} filename must end in .pck.st`);
    if (packageFileNames.has(fileName)) throw new TypeError(`duplicate OpenSmalltalk Cuis runtime package filename: ${fileName}`);
    packageFileNames.add(fileName);
    const identity = typeof artifact.metadata?.identity === 'string' && artifact.metadata.identity.length > 0
      ? artifact.metadata.identity
      : artifactIdentity(node.ref);
    packageRecords.push(Object.freeze({ref: node.ref, artifact, fileName, identity}));
  }

  const supported = new Set([
    CUIS_RUNTIME_DEFINITION_V1,
    CUIS_IMAGE_V1,
    CUIS_CHANGES_V1,
    CUIS_SOURCES_V1,
    CUIS_PACKAGE_V1,
  ]);
  for (const {artifact} of definition.artifacts) {
    if (!supported.has(artifact.representation)) {
      throw new TypeError(`OpenSmalltalk Cuis runtime does not support artifact representation: ${artifact.representation}`);
    }
  }

  return Object.freeze({
    protocol: definition.protocol,
    definitionRef: definition.root.ref,
    imageRef: imageNode.ref,
    image,
    imageFileName,
    changesRef: changesNode?.ref ?? null,
    changes: changesArtifact,
    changesFileName,
    sourcesRef: sourcesNode?.ref ?? null,
    sources: sourcesArtifact,
    sourcesFileName,
    packages: Object.freeze(packageRecords),
  });
}

async function materializeCuisRuntimeDefinition(graph, workspace) {
  const imagePath = join(workspace, graph.imageFileName);
  await writeFile(imagePath, bytesArtifact(graph.image, 'OpenSmalltalk Cuis runtime image'));
  if (graph.changes) {
    await writeFile(join(workspace, graph.changesFileName), artifactBytes(graph.changes, 'OpenSmalltalk Cuis runtime changes'));
  }
  if (graph.sources) {
    await writeFile(join(workspace, graph.sourcesFileName), artifactBytes(graph.sources, 'OpenSmalltalk Cuis runtime sources'));
  }
  const packages = [];
  for (const entry of graph.packages) {
    const path = join(workspace, entry.fileName);
    await writeFile(path, artifactBytes(entry.artifact, `OpenSmalltalk Cuis runtime package ${entry.artifact.id}`));
    packages.push(Object.freeze({path, identity: entry.identity}));
  }
  return Object.freeze({imagePath, packages: Object.freeze(packages)});
}

function createArtifactBackedOpenSmalltalkCuisProvider({
  vmPath,
  vmIdentity,
  runner = new LineProcessRunner(),
  workspaceRoot = tmpdir(),
  startupTimeoutMs = 15_000,
  callTimeoutMs = 10_000,
  stopTimeoutMs = 5_000,
} = {}) {
  const executable = resolve(requiredText(vmPath, 'OpenSmalltalk VM path'));
  const stableVmIdentity = requiredText(vmIdentity, 'OpenSmalltalk VM identity');
  if (!runner || typeof runner.start !== 'function') throw new TypeError('OpenSmalltalk runner must implement start(request)');
  const root = resolve(requiredText(workspaceRoot, 'OpenSmalltalk workspaceRoot'));
  positiveInteger(startupTimeoutMs, 'OpenSmalltalk startupTimeoutMs');
  positiveInteger(callTimeoutMs, 'OpenSmalltalk callTimeoutMs');
  positiveInteger(stopTimeoutMs, 'OpenSmalltalk stopTimeoutMs');
  const digest = createHash('sha256').update(stableVmIdentity).digest('hex');
  const identity = `${OPENSMALLTALK_CUIS_ARTIFACT_PROVIDER_V0}/${digest}`;

  return Object.freeze({
    identity,
    vmIdentity: stableVmIdentity,
    async start(request) {
      const graph = validateCuisRuntimeDefinition(request.spec);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cuis-artifact-runtime-'));
      let innerProvider = null;
      let started = null;
      try {
        const materialized = await materializeCuisRuntimeDefinition(graph, workspace);
        const imageIdentity = artifactIdentity(graph.imageRef);
        innerProvider = createOpenSmalltalkCuisProvider({
          vmPath: executable,
          imagePath: materialized.imagePath,
          vmIdentity: stableVmIdentity,
          imageIdentity,
          runner,
          workspaceRoot: join(workspace, 'session'),
          startupTimeoutMs,
          callTimeoutMs,
          stopTimeoutMs,
        });
        started = await innerProvider.start({
          spec: {packages: materialized.packages},
        });
        return Object.freeze({
          handle: {
            provider: innerProvider,
            runtimeHandle: started.handle,
            workspace,
          },
          metadata: Object.freeze({
            ...started.metadata,
            definitionProtocol: graph.protocol,
            definition: graph.definitionRef,
            imageArtifact: graph.imageRef,
            changesArtifact: graph.changesRef,
            sourcesArtifact: graph.sourcesRef,
            packages: graph.packages.map(({ref, identity: packageIdentity, fileName}) => Object.freeze({
              artifact: ref,
              identity: packageIdentity,
              fileName,
            })),
          }),
        });
      } catch (error) {
        if (started && innerProvider) {
          try {
            await innerProvider.stop(started.handle);
          } catch {
            // Preserve the original start/materialization failure.
          }
        }
        await rm(workspace, {recursive: true, force: true});
        throw error;
      }
    },
    async call(handle, request, context) {
      return await handle.provider.call(handle.runtimeHandle, request, context);
    },
    async stop(handle, request, context) {
      try {
        await handle.provider.stop(handle.runtimeHandle, request, context);
      } finally {
        await rm(handle.workspace, {recursive: true, force: true});
      }
    },
  });
}

export {
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  OPENSMALLTALK_CUIS_ARTIFACT_PROVIDER_V0,
  createArtifactBackedOpenSmalltalkCuisProvider,
  materializeCuisRuntimeDefinition,
  validateCuisRuntimeDefinition,
};
