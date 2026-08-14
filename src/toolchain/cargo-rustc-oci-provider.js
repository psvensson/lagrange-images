import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {posix} from 'node:path';
import {tmpdir} from 'node:os';
import {bytesValue} from '../value/index.js';
import {OciCliRunner, normalizePinnedOciImage} from './oci-cli-runner.js';

const RUST_SOURCE_V1 = 'rust/source-v1';
const RUST_CARGO_MANIFEST_V1 = 'rust/cargo-manifest-v1';
const RUST_CARGO_LOCK_V1 = 'rust/cargo-lock-v1';
const RUST_CARGO_CONFIG_V1 = 'rust/cargo-config-v1';
const RUST_CARGO_VENDOR_FILE_V1 = 'rust/cargo-vendor-file-v1';
const WASM_BINARY_V1 = 'wasm-binary/v1';
const CARGO_RUSTC_OCI_PROVIDER_ID = 'rust/cargo-oci';
const CARGO_RUSTC_OCI_PROVIDER_V0 = 'cargo-rustc-oci/v0';
const CARGO_RUSTC_OCI_PROVIDER_V1 = 'cargo-rustc-oci/v1';
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const SHA256 = /^[0-9a-f]{64}$/;

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

function artifactFileBytes(artifact, label) {
  if (artifact.content?.kind === 'text') return Buffer.from(artifact.content.value, 'utf8');
  if (artifact.content?.kind === 'bytes') return Buffer.from(artifact.content.base64, 'base64');
  throw new TypeError(`${label} content must be a text or bytes Value`);
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

function normalizeRustSourcePath(value, label = 'Rust source path') {
  const path = normalizePortableProjectPath(value, label);
  if (path === 'Cargo.toml' || path === 'Cargo.lock' || path === '.cargo' || path.startsWith('.cargo/') || path === 'vendor' || path.startsWith('vendor/')) {
    throw new TypeError(`${label} must not overlap Cargo manifest/lock/config or vendor paths`);
  }
  return path;
}

function normalizeVendorPath(value, label = 'Cargo vendor file path') {
  const path = normalizePortableProjectPath(value, label);
  const segments = path.split('/');
  if (segments.length < 3 || segments[0] !== 'vendor' || segments[1].startsWith('.')) {
    throw new TypeError(`${label} must be under vendor/<package-directory>/...`);
  }
  return path;
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

function vendorPackageFiles(vendorFiles) {
  const packages = new Map();
  for (const artifact of vendorFiles) {
    const path = normalizeVendorPath(artifact.metadata?.path, `Cargo vendor file ${artifact.id} metadata.path`);
    const segments = path.split('/');
    const packageDirectory = segments[1];
    const relativePath = segments.slice(2).join('/');
    let files = packages.get(packageDirectory);
    if (!files) {
      files = new Map();
      packages.set(packageDirectory, files);
    }
    if (files.has(relativePath)) throw new TypeError(`duplicate Cargo vendor package path: ${packageDirectory}/${relativePath}`);
    files.set(relativePath, artifact);
  }
  return packages;
}

function parseVendorChecksum(packageDirectory, artifact) {
  let checksum;
  try {
    checksum = JSON.parse(artifactFileBytes(artifact, `Cargo vendor ${packageDirectory} checksum`).toString('utf8'));
  } catch (error) {
    throw new TypeError(`Cargo vendor ${packageDirectory} .cargo-checksum.json must be valid JSON`, {cause: error});
  }
  if (!checksum || typeof checksum !== 'object' || Array.isArray(checksum)) {
    throw new TypeError(`Cargo vendor ${packageDirectory} checksum must be an object`);
  }
  if (checksum.package !== null && !SHA256.test(checksum.package)) {
    throw new TypeError(`Cargo vendor ${packageDirectory} package checksum must be null or lowercase SHA-256`);
  }
  if (!checksum.files || typeof checksum.files !== 'object' || Array.isArray(checksum.files)) {
    throw new TypeError(`Cargo vendor ${packageDirectory} checksum files must be an object`);
  }
  const files = new Map();
  for (const [pathValue, digest] of Object.entries(checksum.files)) {
    const path = normalizePortableProjectPath(pathValue, `Cargo vendor ${packageDirectory} checksum path`);
    if (path === '.cargo-checksum.json') throw new TypeError(`Cargo vendor ${packageDirectory} checksum must not checksum itself`);
    if (!SHA256.test(digest)) throw new TypeError(`Cargo vendor ${packageDirectory} checksum for ${path} must be lowercase SHA-256`);
    if (files.has(path)) throw new TypeError(`duplicate Cargo vendor checksum path: ${packageDirectory}/${path}`);
    files.set(path, digest);
  }
  return Object.freeze({package: checksum.package, files});
}

function validateVendorPackages(vendorFiles) {
  const packages = vendorPackageFiles(vendorFiles);
  const result = [];
  for (const [packageDirectory, files] of [...packages.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!files.has('Cargo.toml')) throw new TypeError(`Cargo vendor package ${packageDirectory} is missing Cargo.toml`);
    if (!files.has('.cargo-checksum.json')) throw new TypeError(`Cargo vendor package ${packageDirectory} is missing .cargo-checksum.json`);
    const checksum = parseVendorChecksum(packageDirectory, files.get('.cargo-checksum.json'));
    const actualPaths = [...files.keys()].filter((path) => path !== '.cargo-checksum.json').sort();
    const checksumPaths = [...checksum.files.keys()].sort();
    if (actualPaths.length !== checksumPaths.length || actualPaths.some((path, index) => path !== checksumPaths[index])) {
      throw new TypeError(`Cargo vendor package ${packageDirectory} checksum file list does not match explicit vendor files`);
    }
    for (const path of actualPaths) {
      const actual = createHash('sha256').update(artifactFileBytes(files.get(path), `Cargo vendor ${packageDirectory}/${path}`)).digest('hex');
      if (actual !== checksum.files.get(path)) throw new TypeError(`Cargo vendor package ${packageDirectory} checksum mismatch: ${path}`);
    }
    result.push(Object.freeze({packageDirectory, packageChecksum: checksum.package}));
  }
  return Object.freeze(result);
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
  const configs = artifactByRepresentation(request, RUST_CARGO_CONFIG_V1);
  const sources = artifactByRepresentation(request, RUST_SOURCE_V1);
  const vendorFiles = artifactByRepresentation(request, RUST_CARGO_VENDOR_FILE_V1);
  if (manifests.length !== 1) throw new TypeError('Cargo Rust graph must contain exactly one Cargo manifest');
  if (locks.length !== 1) throw new TypeError('Cargo Rust graph must contain exactly one Cargo.lock artifact');
  if (sources.length === 0) throw new TypeError('Cargo Rust graph must contain at least one Rust source artifact');
  if (configs.length > 1) throw new TypeError('Cargo Rust graph may contain at most one Cargo config artifact');
  if (vendorFiles.length > 0 && configs.length !== 1) {
    throw new TypeError('Cargo Rust vendored dependencies require exactly one Cargo config artifact');
  }

  const supported = new Set([
    RUST_CARGO_MANIFEST_V1,
    RUST_CARGO_LOCK_V1,
    RUST_CARGO_CONFIG_V1,
    RUST_SOURCE_V1,
    RUST_CARGO_VENDOR_FILE_V1,
  ]);
  for (const {artifact} of request.artifacts) {
    if (!supported.has(artifact.representation)) {
      throw new TypeError(`Cargo Rust provider does not support input representation: ${artifact.representation}`);
    }
  }
  const vendoredPackages = validateVendorPackages(vendorFiles.map(({artifact}) => artifact));
  return Object.freeze({
    manifest: manifests[0].artifact,
    lock: locks[0].artifact,
    config: configs.length === 1 ? configs[0].artifact : null,
    sources: Object.freeze(sources.map(({artifact}) => artifact)),
    vendorFiles: Object.freeze(vendorFiles.map(({artifact}) => artifact)),
    vendoredPackages,
  });
}

async function writeProjectFile(workspace, relativePath, content) {
  const segments = relativePath.split('/');
  const path = join(workspace, ...segments);
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content);
}

async function materializeCargoProject(request, workspace) {
  const graph = validateCargoGraph(request);
  const paths = new Set(['Cargo.toml', 'Cargo.lock']);
  await writeProjectFile(workspace, 'Cargo.toml', Buffer.from(textContent(graph.manifest, 'Cargo manifest'), 'utf8'));
  await writeProjectFile(workspace, 'Cargo.lock', Buffer.from(textContent(graph.lock, 'Cargo.lock'), 'utf8'));
  if (graph.config !== null) {
    paths.add('.cargo/config.toml');
    await writeProjectFile(workspace, '.cargo/config.toml', Buffer.from(textContent(graph.config, 'Cargo config'), 'utf8'));
  }
  for (const source of graph.sources) {
    const path = normalizeRustSourcePath(source.metadata?.path, `Rust source ${source.id} metadata.path`);
    if (paths.has(path)) throw new TypeError(`duplicate Cargo project path: ${path}`);
    paths.add(path);
    await writeProjectFile(workspace, path, Buffer.from(textContent(source, `Rust source ${source.id}`), 'utf8'));
  }
  for (const vendorFile of graph.vendorFiles) {
    const path = normalizeVendorPath(vendorFile.metadata?.path, `Cargo vendor file ${vendorFile.id} metadata.path`);
    if (paths.has(path)) throw new TypeError(`duplicate Cargo project path: ${path}`);
    paths.add(path);
    await writeProjectFile(workspace, path, artifactFileBytes(vendorFile, `Cargo vendor file ${vendorFile.id}`));
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
  const identity = `${CARGO_RUSTC_OCI_PROVIDER_V1}/${digest}`;

  return Object.freeze({
    identity,
    image: pinnedImage,
    async run(request) {
      const target = normalizeTarget(request.target);
      const options = normalizeOptions(request.options);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cargo-'));
      try {
        const graph = await materializeCargoProject(request, workspace);
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
              cargoVendored: graph.vendoredPackages.length > 0,
              cargoVendoredPackages: graph.vendoredPackages.length,
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
  CARGO_RUSTC_OCI_PROVIDER_V1,
  CargoRustcOciBuildError,
  RUST_CARGO_CONFIG_V1,
  RUST_CARGO_LOCK_V1,
  RUST_CARGO_MANIFEST_V1,
  RUST_CARGO_VENDOR_FILE_V1,
  RUST_SOURCE_V1,
  WASM_BINARY_V1,
  cargoBuildCommand,
  cargoOutputPath,
  createCargoRustcOciProvider,
  materializeCargoProject,
  normalizePortableProjectPath,
  normalizeVendorPath,
  validateVendorPackages,
};
