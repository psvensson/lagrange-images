// The worker half of the lab fan-out (scripts/lab-suite.mjs). The controller ships this file's
// source to each worker with the snapshot and runs it there as `node .lab/driver.mjs`, inside the
// worker's checkout directory and under that directory's lock (the bash wrapper in lab-suite.mjs
// guards the directory, takes the flock and cleans it before this starts).
//
// PROTOCOL on stdin, one session per worker:
//
//   TAR <bytes>\n<exactly that many bytes of tar>       the snapshot, extracted here
//   {"run": {"id", "lane", "file"}}\n                    run one test file in one lane
//   {"end": true}\n                                      finish in-flight files and exit
//
// and on stdout, every line prefixed `LAB ` and JSON-encoded: the reporter's facts for each file
// (scripts/lab-suite-reporter.mjs) plus the driver's own phase, ready, done and finished facts.
// The controller keeps at most `slots` files in flight here and sends the next one as each
// finishes, so a worker that is slower than expected simply takes fewer files.
//
// Each file runs as its own `node --test <lane flag> <file>` — exactly how node --test isolates
// files anyway — under `nice`, with the lane's flag chosen here from a closed table.

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const LANE_FLAGS = Object.freeze({
  fast: '--test-skip-pattern=exhaustive-recovery:',
  recovery: '--test-name-pattern=exhaustive-recovery:',
});
export const SAFE_TEST_FILE = /^test\/[A-Za-z0-9_./-]+\.(?:c|m)?js$/;
const REPORTER = './scripts/lab-suite-reporter.mjs';

// Splits the session stream into the tar payload and the command lines that follow it, whatever
// the chunk boundaries.
export function createFrameReader({onTarChunk, onTarEnd, onLine}) {
  let state = 'header';
  let pending = Buffer.alloc(0);
  let remaining = 0;
  let text = '';
  const takeLines = () => {
    let at;
    while ((at = text.indexOf('\n')) !== -1) {
      const line = text.slice(0, at);
      text = text.slice(at + 1);
      if (line.trim()) onLine(line);
    }
  };
  return {
    push(chunk) {
      let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (state === 'header') {
        pending = Buffer.concat([pending, data]);
        const at = pending.indexOf(0x0a);
        if (at === -1) {
          if (pending.length > 64) throw new Error('lab session must start with a TAR header');
          return;
        }
        const match = /^TAR (\d+)$/.exec(pending.subarray(0, at).toString('utf8'));
        if (!match) throw new Error('lab session must start with a TAR header');
        remaining = Number(match[1]);
        data = pending.subarray(at + 1);
        pending = Buffer.alloc(0);
        state = 'tar';
        if (remaining === 0) { state = 'lines'; onTarEnd(); }
      }
      if (state === 'tar' && data.length) {
        const part = data.subarray(0, remaining);
        remaining -= part.length;
        onTarChunk(part);
        data = data.subarray(part.length);
        if (remaining === 0) { state = 'lines'; onTarEnd(); }
      }
      if (state === 'lines' && data.length) {
        text += data.toString('utf8');
        takeLines();
      }
    },
    end() {
      if (state !== 'lines') throw new Error('lab session ended before the snapshot was complete');
      if (text.trim()) onLine(text);
      text = '';
    },
  };
}

// A command line, validated. Answers {run: {id, lane, file}}, {end: true} or throws.
export function parseCommand(line) {
  const command = JSON.parse(line);
  if (command?.end === true) return {end: true};
  const run = command?.run;
  if (!run || !Number.isInteger(run.id) || !Object.hasOwn(LANE_FLAGS, run.lane) || !SAFE_TEST_FILE.test(run.file ?? '')) {
    throw new Error(`unusable lab command: ${line.slice(0, 200)}`);
  }
  return {run: {id: run.id, lane: run.lane, file: run.file}};
}

function emit(fact) {
  process.stdout.write(`LAB ${JSON.stringify(fact)}\n`);
}

function exec(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, {stdio: ['ignore', 'ignore', 'pipe'], ...options});
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => done({code: 127, stderr: String(error)}));
    child.on('close', (code) => done({code, stderr}));
  });
}

async function prepareDependencies() {
  const lock = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  let installed = null;
  try { installed = (await readFile('.lab/lock.sha', 'utf8')).trim(); } catch { /* first run */ }
  let haveModules = true;
  try { await readFile('node_modules/.package-lock.json'); } catch { haveModules = false; }
  if (installed === lock && haveModules) return true;
  emit({t: 'phase', phase: 'npm-ci'});
  const result = await exec('nice', ['-n', '10', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (result.code !== 0) {
    process.stderr.write(result.stderr);
    emit({t: 'error', reason: 'npm ci failed'});
    return false;
  }
  await writeFile('.lab/lock.sha', `${lock}\n`);
  return true;
}

function runFile({id, lane, file}, onClose) {
  const started = Date.now();
  const child = spawn('nice', ['-n', '10', process.execPath, '--test', LANE_FLAGS[lane], `--test-reporter=${REPORTER}`, file], {
    env: {...process.env, LAB_LANE: lane},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.startsWith('LAB ')) process.stdout.write(`${line}\n`);
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.on('close', (code) => {
    emit({t: 'done', id, lane, file, code, ms: Date.now() - started, ...(code !== 0 && stderr.trim() ? {stderr: stderr.trim()} : {})});
    onClose();
  });
}

async function main() {
  emit({t: 'phase', phase: 'extracting', node: process.version});
  const tar = spawn('tar', ['-x'], {stdio: ['pipe', 'ignore', 'inherit']});
  const tarDone = new Promise((done) => tar.on('close', done));
  const queued = [];
  let ready = false;
  let ended = false;
  let running = 0;
  let failed = false;
  const finishIfDone = () => {
    if (ended && running === 0 && queued.length === 0) {
      emit({t: 'finished'});
      process.exit(failed ? 1 : 0);
    }
  };
  const startQueued = () => {
    while (ready && queued.length) {
      const run = queued.shift();
      running += 1;
      runFile(run, () => { running -= 1; finishIfDone(); });
    }
  };
  const reader = createFrameReader({
    onTarChunk: (part) => {
      if (!tar.stdin.write(part)) {
        process.stdin.pause();
        tar.stdin.once('drain', () => process.stdin.resume());
      }
    },
    onTarEnd: () => {
      tar.stdin.end();
      tarDone.then(async (code) => {
        if (code !== 0) { emit({t: 'error', reason: 'snapshot extraction failed'}); process.exit(71); }
        if (!await prepareDependencies()) process.exit(72);
        ready = true;
        emit({t: 'ready'});
        startQueued();
        finishIfDone();
      });
    },
    onLine: (line) => {
      let command;
      try { command = parseCommand(line); } catch (error) {
        emit({t: 'error', reason: error.message});
        failed = true;
        return;
      }
      if (command.end) { ended = true; finishIfDone(); return; }
      queued.push(command.run);
      startQueued();
    },
  });
  process.stdin.on('data', (chunk) => {
    try { reader.push(chunk); } catch (error) { emit({t: 'error', reason: error.message}); process.exit(70); }
  });
  process.stdin.on('end', () => {
    try { reader.end(); } catch (error) { emit({t: 'error', reason: error.message}); process.exit(70); }
    ended = true;
    finishIfDone();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    emit({t: 'error', reason: error.message});
    process.exit(1);
  });
}
