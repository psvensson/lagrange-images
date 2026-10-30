import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const executeFile = promisify(execFile);
// Provisioning diagnostics can exceed execFile's implicit 1 MiB capture limit.
// Keep a finite bound while preserving the child's actual outcome and deadline.
const PROCESS_OUTPUT_LIMIT = 16 * 1024 * 1024;
const enabled = process.env.LAGRANGE_IMAGES_REAL_LAGRANGE === '1';
const processFixture = new URL('../fixtures/real-lagrange-backend-process.js', import.meta.url);
const m6SharedServerFixture = new URL('../fixtures/real-lagrange-m6-shared-server-process.js', import.meta.url);

test('real public Lagrange package commits atomic state and history', {
  skip: enabled ? false : 'set LAGRANGE_IMAGES_REAL_LAGRANGE=1 with lagrange-server installed',
  timeout: 180_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-real-'));
  const environment = {...process.env, LAGRANGE_BACKEND: 'lagrange'};
  try {
    await executeFile(process.execPath, [processFixture.pathname, directory], {
      env: environment,
      maxBuffer: PROCESS_OUTPUT_LIMIT,
      timeout: 160_000,
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('real public Lagrange package installs and reuses the kernel Behavior phases', {
  skip: enabled ? false : 'set LAGRANGE_IMAGES_REAL_LAGRANGE=1 with lagrange-server installed',
  timeout: 360_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-kernel-'));
  try {
    await executeFile(process.execPath, [processFixture.pathname, directory, 'kernel'], {
      env: {...process.env, LAGRANGE_BACKEND: 'lagrange'},
      maxBuffer: PROCESS_OUTPUT_LIMIT,
      timeout: 340_000,
    });
  } catch (error) {
    throw new Error(
      `Kernel child failed (${error.code ?? error.name}: ${error.message}); stdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`,
      {cause: error},
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('M6.3: two Images runtimes resolve and execute the unchanged Life graph through one shared Lagrange server', {
  skip: enabled ? false : 'set LAGRANGE_IMAGES_REAL_LAGRANGE=1 with lagrange-server installed',
  timeout: 360_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-m6-real-'));
  const environment = {...process.env, LAGRANGE_BACKEND: 'lagrange'};
  try {
    try {
      await executeFile(process.execPath, [m6SharedServerFixture.pathname, directory], {
        env: environment,
        maxBuffer: PROCESS_OUTPUT_LIMIT,
        timeout: 340_000,
      });
    } catch (error) {
      const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
      const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
      throw new Error(
        `M6.3 child process failed (${error.code ?? error.name}: ${error.message}); stdout:\n${stdout}\nstderr:\n${stderr}`,
        {cause: error},
      );
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
