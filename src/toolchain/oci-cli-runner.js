import {execFile as execFileCallback} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFileCallback);
const OCI_SHA256_IMAGE = /@sha256:[0-9a-f]{64}$/;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizePinnedOciImage(value) {
  const image = requiredText(value, 'OCI image');
  if (!OCI_SHA256_IMAGE.test(image)) {
    throw new TypeError('OCI build image must be pinned by @sha256:<64 lowercase hex digits>');
  }
  return image;
}

function normalizeCommand(value, label = 'OCI container command') {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty string array`);
  return Object.freeze(value.map((entry, index) => requiredText(entry, `${label} ${index}`)));
}

function normalizeEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('OCI environment must be an object');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`invalid OCI environment variable name: ${key}`);
    result[key] = requiredText(value[key], `OCI environment ${key}`);
  }
  return Object.freeze(result);
}

function defaultContainerUser() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return null;
  return `${process.getuid()}:${process.getgid()}`;
}

function buildOciRunArgs({
  image,
  workspace,
  command,
  containerWorkdir = '/workspace',
  network = 'none',
  user = defaultContainerUser(),
  environment = {},
} = {}) {
  const pinnedImage = normalizePinnedOciImage(image);
  const hostWorkspace = resolve(requiredText(workspace, 'OCI workspace'));
  const workdir = requiredText(containerWorkdir, 'OCI container workdir');
  const networkMode = requiredText(network, 'OCI network mode');
  const containerCommand = normalizeCommand(command);
  const env = normalizeEnvironment(environment);
  if (user !== null) requiredText(user, 'OCI container user');

  // The executed program is always stated as an explicit --entrypoint rather than left to the
  // image's own ENTRYPOINT. A toolchain image's declared entrypoint is undeclared build input:
  // it can wrap, rewrite or ignore the command the provider asked for. Overriding it keeps the
  // program part of the closed contract, and lets any digest-pinned image that merely *contains*
  // Cargo/rustc serve as a toolchain regardless of what it was originally packaged to run.
  const [program, ...programArguments] = containerCommand;
  const args = [
    'run',
    '--rm',
    '--network', networkMode,
    '--mount', `type=bind,src=${hostWorkspace},dst=${workdir}`,
    '--workdir', workdir,
    '--entrypoint', program,
  ];
  if (user !== null) args.push('--user', user);
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  args.push(pinnedImage, ...programArguments);
  return Object.freeze(args);
}

class OciCliUnavailableError extends Error {
  constructor(command, cause) {
    super(`OCI CLI unavailable: ${command}`);
    this.name = 'OciCliUnavailableError';
    this.command = command;
    this.cause = cause;
  }
}

class OciCliRunner {
  constructor({
    command = 'docker',
    execFile = execFileAsync,
    maxBuffer = 8 * 1024 * 1024,
    user = defaultContainerUser(),
  } = {}) {
    this.command = requiredText(command, 'OCI CLI command');
    if (typeof execFile !== 'function') throw new TypeError('OCI CLI execFile must be a function');
    if (!Number.isInteger(maxBuffer) || maxBuffer <= 0) throw new TypeError('OCI CLI maxBuffer must be a positive integer');
    if (user !== null) requiredText(user, 'OCI container user');
    this.execFile = execFile;
    this.maxBuffer = maxBuffer;
    this.user = user;
  }

  async run(request = {}) {
    const args = buildOciRunArgs({...request, user: request.user === undefined ? this.user : request.user});
    try {
      const result = await this.execFile(this.command, args, {encoding: 'utf8', maxBuffer: this.maxBuffer});
      return Object.freeze({
        exitCode: 0,
        stdout: typeof result?.stdout === 'string' ? result.stdout : '',
        stderr: typeof result?.stderr === 'string' ? result.stderr : '',
      });
    } catch (error) {
      if (Number.isInteger(error?.code)) {
        return Object.freeze({
          exitCode: error.code,
          stdout: typeof error.stdout === 'string' ? error.stdout : '',
          stderr: typeof error.stderr === 'string' ? error.stderr : '',
        });
      }
      throw new OciCliUnavailableError(this.command, error);
    }
  }
}

export {
  OciCliRunner,
  OciCliUnavailableError,
  buildOciRunArgs,
  defaultContainerUser,
  normalizePinnedOciImage,
};
