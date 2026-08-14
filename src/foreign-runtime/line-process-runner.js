import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const STDERR_LIMIT = 16 * 1024;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeTimeout(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

class LineProcessTimeoutError extends Error {
  constructor(action, timeoutMs) {
    super(`line process timed out waiting for ${action} after ${timeoutMs}ms`);
    this.name = 'LineProcessTimeoutError';
    this.action = action;
    this.timeoutMs = timeoutMs;
  }
}

class LineProcessExitedError extends Error {
  constructor({code = null, signal = null, stderr = '', cause = null} = {}) {
    const status = cause
      ? `failed to start: ${cause.message}`
      : `exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`;
    const detail = stderr.length > 0 ? `: ${stderr.trim()}` : '';
    super(`line process ${status}${detail}`, cause ? {cause} : undefined);
    this.name = 'LineProcessExitedError';
    this.code = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

class LineProcessSession {
  constructor(child) {
    if (!child || typeof child !== 'object') throw new TypeError('line process child is required');
    this.child = child;
    this.lines = [];
    this.waiters = [];
    this.stderr = '';
    this.exitResult = null;
    this.exitError = null;

    const stdout = createInterface({input: child.stdout, crlfDelay: Infinity});
    this.stdout = stdout;
    stdout.on('line', (line) => this.#acceptLine(line));
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
      if (this.stderr.length > STDERR_LIMIT) this.stderr = this.stderr.slice(-STDERR_LIMIT);
    });

    this.exitPromise = new Promise((resolve, reject) => {
      child.once('error', (cause) => {
        const error = new LineProcessExitedError({stderr: this.stderr, cause});
        this.exitError = error;
        this.#rejectWaiters(error);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        stdout.close();
        const result = Object.freeze({code, signal, stderr: this.stderr});
        this.exitResult = result;
        this.#rejectWaiters(new LineProcessExitedError(result));
        resolve(result);
      });
    });
    this.exitPromise.catch(() => {});
  }

  #acceptLine(line) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(line);
      return;
    }
    this.lines.push(line);
  }

  #rejectWaiters(error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async writeLine(line) {
    if (typeof line !== 'string' || /[\r\n]/.test(line)) {
      throw new TypeError('line process writeLine requires one line without CR/LF');
    }
    if (this.exitError) throw this.exitError;
    if (this.exitResult) throw new LineProcessExitedError(this.exitResult);
    await new Promise((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, 'utf8', (error) => error ? reject(error) : resolve());
    });
  }

  async nextLine({timeoutMs = 10_000, action = 'output line'} = {}) {
    normalizeTimeout(timeoutMs, 'line process nextLine timeoutMs');
    requiredText(action, 'line process nextLine action');
    if (this.lines.length > 0) return this.lines.shift();
    if (this.exitError) throw this.exitError;
    if (this.exitResult) throw new LineProcessExitedError(this.exitResult);

    return await new Promise((resolve, reject) => {
      const waiter = {resolve, reject, timer: null};
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new LineProcessTimeoutError(action, timeoutMs));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async waitForExit({timeoutMs = 5_000} = {}) {
    normalizeTimeout(timeoutMs, 'line process waitForExit timeoutMs');
    if (this.exitError) throw this.exitError;
    if (this.exitResult) return this.exitResult;
    let timer;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new LineProcessTimeoutError('process exit', timeoutMs)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  kill(signal = 'SIGKILL') {
    if (!this.exitResult && !this.exitError) this.child.kill(signal);
  }

  stderrText() {
    return this.stderr;
  }
}

class LineProcessRunner {
  constructor({spawnProcess = spawn} = {}) {
    if (typeof spawnProcess !== 'function') throw new TypeError('line process spawnProcess must be a function');
    this.spawnProcess = spawnProcess;
  }

  async start({command, args = [], cwd = undefined, environment = {}} = {}) {
    const executable = requiredText(command, 'line process command');
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('line process args must be an array of strings');
    }
    if (cwd !== undefined) requiredText(cwd, 'line process cwd');
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
      throw new TypeError('line process environment must be an object');
    }
    for (const [key, value] of Object.entries(environment)) {
      requiredText(key, 'line process environment key');
      if (typeof value !== 'string') throw new TypeError(`line process environment ${key} must be a string`);
    }

    const child = this.spawnProcess(executable, [...args], {
      cwd,
      env: {...process.env, ...environment},
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new LineProcessSession(child);
  }
}

export {
  LineProcessExitedError,
  LineProcessRunner,
  LineProcessSession,
  LineProcessTimeoutError,
};
