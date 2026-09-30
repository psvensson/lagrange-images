import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const executeFile = promisify(execFile);
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
      timeout: 160_000,
    });
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
    await executeFile(process.execPath, [m6SharedServerFixture.pathname, directory], {
      env: environment,
      timeout: 340_000,
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
