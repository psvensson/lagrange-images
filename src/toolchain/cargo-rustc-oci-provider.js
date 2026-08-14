import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {posix} from 'node:path';
import {tmpdir} from 'node:os';
import {bytesValue} from '../value/index.js';
import {OciCliRunner, normalizePinnedOciImage} from './oci-cli-runner.js';

const RUST_SOURCE_V1 = 'rust/source-v1';
const RUST_CARGO_MANIFEST_V1 = 'rust/cargo-manifest-v1';
const RUST_CARGO_LOCK_V1 = 'rust/cargo-lock-v1';
const WASM_BINARY_V1 = 'wasm-binary/v1';
const CARGO_RUSTC_OCI_PROVIDER_ID = 'rust/cargo-oci';
const CARGO_RUSTC_OCI_PROVIDER_V0 = 'cargo-rustc-oci/v0';
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new TypeError(`unknown ${label} fields: ${extra.join(', ')}`);
  return value;
}

function textContent(artifact, label) {
  if (artifact.content?.kind !== 'text') throw new TypeError(`${label} content must be a text Value`);
  return artifact.content.value;
}

function normalizePortableProjectPath(value, label = 'Rust source path') {
  const path = requiredText(value, label);
  if (path.includes('\\') || path.includes('\0') || posix.isAbsolute(path)) {
    throw new TypeError(`${label} must be a portable relative POSIX path`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} must not contain empty, . or .. path segments`);
  }
  return segments.join('/');
}

function safeCargoName(value, label) {
  const name = requiredText(value, label);
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') {
    throw new TypeError(`${label} must use only portable Cargo target-name characters`);
  }
  return name;
}

function normalizeTarget(target) {
  exactKeys(target, new Set(['representation', 'triple', 'binary', 'profile', 'package']), 'Cargo Rust target');
  if (target.representation !== WASM_BINARY_V1) {
    throw new TypeError(`Cargo Rust target representation must be ${WASM_BINARY_V1}`);
  }
  const triple = safeCargoName(target.triple, 'Cargo Rust target triple');
  const binary = safeCargoName(target.binary, 'Cargo Rust binary');
  const profile = target.profile ?? 'release';
  if (!['release', 'debug'].includes(profile)) throw new TypeError('Cargo Rust profile must be release or debug');
  const packageName = target.package === undefined ? null : safeCargoName(target.package, 'Cargo Rust package');
  return Object.freeze({representation: WASM_BINARY_V1, triple, binary, profile, package: packageName});
}

function normalizeFeatures(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('Cargo Rust features must be an array');
  const seen = new Set();
  return Object.freeze(value.map((feature, index) => {
    const name = requiredText(feature, `Cargo Rust feature ${index}`);
    if (!/^[A-Za-z0-9_.+/-]+$/.test(name)) throw new TypeError(`Cargo Rust feature ${index} contains unsupported characters`);
    if (seen.has(name)) throw new TypeError(`duplicate Cargo Rust feature: ${name}`);
    seen.add(name);
    return name;
  }));
}

function normalizeOptions(options) {
  exactKeys(options, new Set(['features', 'noDefaultFeatures', 'allFeatures']), 'Cargo Rust options');
  const features = normalizeFeatures(options.features);
  const noDefaultFeatures = options.noDefaultFeatures ?? false;
  const allFeatures = options.allFeatures ?? false;
  if (typeof noDefaultFeatures !== 'boolean' || typeof allFeatures !== 'boolean') {
    throw new TypeError('Cargo Rust feature flags must be booleans');
  }
  if (allFeatures && (features.length > 0 || noDefaultFeatures)) {
    throw new TypeError('Cargo Rust allFeatures cannot be combined with features or noDefaultFeatures');
  }
  return Object.freeze({features, noDefaultFeatures, allFeatures});
}

function artifactByRepresentation(request, representation) {
  return request.artifacts.filter(({artifact}) => artifact.representation === representation);
}

function validateCargoGraph(request) {
  if (!request || typeof request !== 'object') throw new TypeError('Cargo Rust provider request is required');
  if (!Array.isArray(request.roots) || request.roots.length !== 1) {
    throw new TypeError('Cargo Rust provider requires exactly one root artifact');
  }
  if (request.roots[0].artifact.representation !== RUST_CARGO_MANIFEST_V1) {
    throw new TypeError(`Cargo Rust root must be ${RUST_CARGO_MANIFEST_V1}`);
  }
  const manifests = artifactByRepresentation(request, RUST_CARGO_MANIFEST_V1);
  const locks = artifactByRepresentation(request, RUST_CARGO_LOCK_V1);
  const sources = artifactByRepresentation(request, RUST_SOURCE_V1);
  if (manifests.length !== 1) throw new TypeError('Cargo Rust graph must contain exactly one Cargo manifest');
  if (locks.length !== 1) throw new TypeError('Cargo Rust graph must contain exactly one Cargo.lock artifact');
  if (sources.length === 0) throw new TypeError('Cargo Rust graph must contain at least one Rust source artifact');

  const supported = new Set([RUST_CARGO_MANIFEST_V1, RUST_CARGO_LOCK_V1, RUST_SOURCE_V1]);
  for (const {artifact} of request.artifacts) {
    if (!supported.has(artifact.representation)) {
      throw new TypeError(`Cargo Rust provider does not support input representation: ${artifact.representation}`);
    }
  }
  return Object.freeze({manifest: manifests[0].artifact, lock: locks[0].artifact, sources: Object.freeze(sources.map(({artifact}) => artifact))});
}

async function writeProjectFile(workspace, relativePath, content) {
  const segments = relativePath.split('/');
  const path = join(workspace, ...segments);
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content, 'utf8');
}

async function materializeCargoProject(request, workspace) {
  const graph = validateCargoGraph(request);
  const paths = new Set(['Cargo.toml', 'Cargo.lock']);
  await writeProjectFile(workspace, 'Cargo.toml', textContent(graph.manifest, 'Cargo manifest'));
  await writeProjectFile(workspace, 'Cargo.lock', textContent(graph.lock, 'Cargo.lock'));
  for (const source of graph.sources) {
    const path = normalizePortableProjectPath(source.metadata?.path, `Rust source ${source.id} metadata.path`);
    if (paths.has(path)) throw new TypeError(`duplicate Cargo project path: ${path}`);
    paths.add(path);
    await writeProjectFile(workspace, path, textContent(source, `Rust source ${source.id}`));
  }
  return graph;
}

function cargoBuildCommand(target, options) {
  const command = ['cargo', 'build', '--frozen', '--target', target.triple, '--target-dir', 'target', '--bin', target.binary];
  if (target.package !== null) command.push('--package', target.package);
  if (target.profile === 'release') command.push('--release');
  if (options.features.length > 0) command.push('--features', options.features.join(','));
  if (options.noDefaultFeatures) command.push('--no-default-features');
  if (options.allFeatures) command.push('--all-features');
  return Object.freeze(command);
}

function cargoOutputPath(workspace, target) {
  const profileDirectory = target.profile === 'release' ? 'release' : 'debug';
  return join(workspace, 'target', target.triple, profileDirectory, `${target.binary}.wasm`);
}

function diagnosticsFromRun(result) {
  const diagnostics = [];
  if (result.stdout.length > 0) diagnostics.push(Object.freeze({severity: 'note', source: 'cargo', stream: 'stdout', message: result.stdout}));
  if (result.stderr.length > 0) diagnostics.push(Object.freeze({severity: 'note', source: 'cargo', stream: 'stderr', message: result.stderr}));
  return Object.freeze(diagnostics);
}

class CargoRustcOciBuildError extends Error {
  constructor({exitCode, stdout = '', stderr = ''}) {
    super(`Cargo/rustc OCI build failed with exit code ${exitCode}`);
    this.name = 'CargoRustcOciBuildError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function createCargoRustcOciProvider({
  image,
  runner = new OciCliRunner(),
  workspaceRoot = tmpdir(),
  containerWorkdir = '/workspace',
} = {}) {
  const pinnedImage = normalizePinnedOciImage(image);
  if (!runner || typeof runner.run !== 'function') throw new TypeError('Cargo Rust OCI runner must implement run(request)');
  const root = resolve(requiredText(workspaceRoot, 'Cargo Rust workspaceRoot'));
  const workdir = requiredText(containerWorkdir, 'Cargo Rust container workdir');
  const digest = pinnedImage.slice(pinnedImage.lastIndexOf('@') + 1);
  const identity = `${CARGO_RUSTC_OCI_PROVIDER_V0}/${digest}`;

  return Object.freeze({
    identity,
    image: pinnedImage,
    async run(request) {
      const target = normalizeTarget(request.target);
      const options = normalizeOptions(request.options);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cargo-'));
      try {
        await materializeCargoProject(request, workspace);
        const command = cargoBuildCommand(target, options);
        const result = await runner.run({
          image: pinnedImage,
          workspace,
          containerWorkdir: workdir,
          network: 'none',
          environment: {
            HOME: '/tmp/lagrange-home',
            CARGO_HOME: '/tmp/lagrange-cargo-home',
          },
          command,
        });
        if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
          throw new TypeError('Cargo Rust OCI runner must return exitCode, stdout and stderr');
        }
        if (result.exitCode !== 0) throw new CargoRustcOciBuildError(result);

        const outputPath = cargoOutputPath(workspace, target);
        let bytes;
        try {
          bytes = await readFile(outputPath);
        } catch (error) {
          throw new TypeError(`Cargo Rust OCI build did not produce expected WASM output: ${outputPath}`, {cause: error});
        }
        if (bytes.length < WASM_HEADER.length || !bytes.subarray(0, WASM_HEADER.length).equals(WASM_HEADER)) {
          throw new TypeError('Cargo Rust OCI output is not a version-1 WebAssembly binary');
        }

        return Object.freeze({
          outputs: Object.freeze([Object.freeze({
            name: 'module',
            languageId: 'rust',
            representation: WASM_BINARY_V1,
            content: bytesValue(bytes),
            dependencies: Object.freeze([]),
            metadata: Object.freeze({
              cargoBinary: target.binary,
              cargoPackage: target.package,
              cargoProfile: target.profile,
              cargoFrozen: true,
              rustTargetTriple: target.triple,
              ociImage: pinnedImage,
              ociImageDigest: digest,
              ociNetwork: 'none',
            }),
          })]),
          diagnostics: diagnosticsFromRun(result),
        });
      } finally {
        await rm(workspace, {recursive: true, force: true});
      }
    },
  });
}

export {
  CARGO_RUSTC_OCI_PROVIDER_ID,
  CARGO_RUSTC_OCI_PROVIDER_V0,
  CargoRustcOciBuildError,
  RUST_CARGO_LOCK_V1,
  RUST_CARGO_MANIFEST_V1,
  RUST_SOURCE_V1,
  WASM_BINARY_V1,
  cargoBuildCommand,
  cargoOutputPath,
  createCargoRustcOciProvider,
  materializeCargoProject,
  normalizePortableProjectPath,
};
