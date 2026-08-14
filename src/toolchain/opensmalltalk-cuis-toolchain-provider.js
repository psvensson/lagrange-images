import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, extname, join, resolve} from 'node:path';
import {bytesValue} from '../value/index.js';

const CUIS_BUILD_V1 = 'smalltalk/cuis-build-v1';
const CUIS_IMAGE_V1 = 'smalltalk/cuis-image-v1';
const CUIS_CHANGES_V1 = 'smalltalk/cuis-changes-v1';
const CUIS_SOURCES_V1 = 'smalltalk/cuis-sources-v1';
const CUIS_PACKAGE_V1 = 'smalltalk/cuis-package-v1';
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

function artifactKey(ref) {
  return `${ref.imageId}\u0000${ref.objectId}`;
}

function nodeMap(request) {
  return new Map(request.artifacts.map((node) => [artifactKey(node.ref), node]));
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
  if (baseChanges.length > 1) throw new TypeError('OpenSmalltalk Cuis build may contain at most one base-changes dependency');
  if (baseSources.length > 1) throw new TypeError('OpenSmalltalk Cuis build may contain at most one base-sources dependency');

  const baseImage = baseImages[0].artifact;
  if (baseImage.representation !== CUIS_IMAGE_V1) throw new TypeError(`base-image must be ${CUIS_IMAGE_V1}`);
  bytesArtifact(baseImage, 'OpenSmalltalk Cuis base image');
  const baseImageFileName = safeFileName(baseImage.metadata?.fileName, '.image', 'OpenSmalltalk Cuis base image metadata.fileName');

  const changes = baseChanges.length === 1 ? baseChanges[0].artifact : null;
  if (changes && changes.representation !== CUIS_CHANGES_V1) throw new TypeError(`base-changes must be ${CUIS_CHANGES_V1}`);
  const changesFileName = changes ? safeFileName(changes.metadata?.fileName, '.changes', 'OpenSmalltalk Cuis base changes metadata.fileName') : null;

  const sources = baseSources.length === 1 ? baseSources[0].artifact : null;
  if (sources && sources.representation !== CUIS_SOURCES_V1) throw new TypeError(`base-sources must be ${CUIS_SOURCES_V1}`);
  const sourcesFileName = sources ? safeFileName(sources.metadata?.fileName, '.sources', 'OpenSmalltalk Cuis base sources metadata.fileName') : null;

  const packageRecords = [];
  const packageNames = new Set();
  for (const {artifact} of packages) {
    if (artifact.representation !== CUIS_PACKAGE_V1) throw new TypeError(`package dependency must be ${CUIS_PACKAGE_V1}`);
    const fileName = safeFileName(artifact.metadata?.fileName, '.st', `OpenSmalltalk Cuis package ${artifact.id} metadata.fileName`);
    if (!fileName.endsWith('.pck.st')) throw new TypeError(`OpenSmalltalk Cuis package ${artifact.id} filename must end in .pck.st`);
    if (packageNames.has(fileName)) throw new TypeError(`duplicate OpenSmalltalk Cuis package filename: ${fileName}`);
    packageNames.add(fileName);
    packageRecords.push(Object.freeze({artifact, fileName}));
  }

  const supported = new Set([CUIS_BUILD_V1, CUIS_IMAGE_V1, CUIS_CHANGES_V1, CUIS_SOURCES_V1, CUIS_PACKAGE_V1]);
  for (const {artifact} of request.artifacts) {
    if (!supported.has(artifact.representation)) {
      throw new TypeError(`OpenSmalltalk Cuis toolchain does not support input representation: ${artifact.representation}`);
    }
  }

  return Object.freeze({
    baseImage,
    baseImageFileName,
    changes,
    changesFileName,
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

function normalizeOptions(options) {
  exactKeys(options, new Set(), 'OpenSmalltalk Cuis options');
  return Object.freeze({});
}

function imageStem(fileName) {
  return fileName.slice(0, -'.image'.length);
}

function buildScript(packages, targetFileName) {
  const installs = packages.map(({fileName}) => [
    `output nextPutAll: 'BUILD\\tPACKAGE\\t${fileName}\\tSTART'; newLine; flush.`,
    `CodePackageFile installPackage: DirectoryEntry currentDirectory // '${fileName}'.`,
    `output nextPutAll: 'BUILD\\tPACKAGE\\t${fileName}\\tDONE'; newLine; flush.`,
  ].join('\n')).join('\n');
  const stem = imageStem(targetFileName);
  return `| output |\noutput := StdIOWriteStream stdout.\noutput nextPutAll: 'BUILD\\tSTART'; newLine; flush.\n${installs}\noutput nextPutAll: 'BUILD\\tSAVE\\tSTART'; newLine; flush.\nSmalltalk saveAs: '${stem}'.\noutput nextPutAll: 'BUILD\\tSAVE\\tDONE'; newLine; flush.\nSmalltalk quitPrimitive: 0.\n`;
}

async function materializeBuild(graph, workspace, target) {
  await writeFile(join(workspace, graph.baseImageFileName), bytesArtifact(graph.baseImage, 'OpenSmalltalk Cuis base image'));
  if (graph.changes) await writeFile(join(workspace, graph.changesFileName), artifactBytes(graph.changes, 'OpenSmalltalk Cuis base changes'));
  if (graph.sources) await writeFile(join(workspace, graph.sourcesFileName), artifactBytes(graph.sources, 'OpenSmalltalk Cuis base sources'));
  for (const {artifact, fileName} of graph.packages) {
    await writeFile(join(workspace, fileName), artifactBytes(artifact, `OpenSmalltalk Cuis package ${artifact.id}`));
  }
  const scriptPath = join(workspace, 'lagrange-build.st');
  await writeFile(scriptPath, buildScript(graph.packages, target.fileName), 'utf8');
  return scriptPath;
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
      normalizeOptions(request.options);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cuis-toolchain-'));
      try {
        const scriptPath = await materializeBuild(graph, workspace, target);
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

        const sourceDependencies = graph.sources ? [{
          role: 'sources',
          artifact: request.artifacts.find(({artifact}) => artifact.id === graph.sources.id).ref,
        }] : [];
        const packageFileNames = graph.packages.map(({fileName}) => fileName);
        const packageArtifactIds = graph.packages.map(({artifact}) => artifact.id);
        const commonMetadata = {
          vmIdentity: stableVmIdentity,
          baseImageArtifactId: graph.baseImage.id,
          packageArtifactIds,
          packageFileNames,
          sourcesFileName: graph.sourcesFileName,
          snapshotMethod: 'saveAs/v0',
        };
        return Object.freeze({
          outputs: Object.freeze([
            Object.freeze({
              name: 'image',
              languageId: 'smalltalk',
              representation: CUIS_IMAGE_V1,
              content: bytesValue(imageBytes),
              dependencies: sourceDependencies,
              metadata: {...commonMetadata, fileName: target.fileName, companionChangesFileName: changesFileName},
            }),
            Object.freeze({
              name: 'changes',
              languageId: 'smalltalk',
              representation: CUIS_CHANGES_V1,
              content: bytesValue(changesBytes),
              dependencies: [],
              metadata: {...commonMetadata, fileName: changesFileName, companionImageFileName: target.fileName},
            }),
          ]),
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
  CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
  OPENSMALLTALK_CUIS_TOOLCHAIN_V0,
  OpenSmalltalkToolchainRunError,
  OpenSmalltalkToolchainRunner,
  buildScript as createCuisToolchainBuildScript,
  createOpenSmalltalkCuisToolchainProvider,
  materializeBuild as materializeCuisToolchainBuild,
  validateGraph as validateCuisToolchainGraph,
};
