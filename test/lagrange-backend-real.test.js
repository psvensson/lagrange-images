import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {REAL_LAGRANGE_BUDGETS, readRealLagrangeReport} from '../fixtures/real-lagrange-suite.js';

const executeFile = promisify(execFile);
const PROCESS_OUTPUT_LIMIT = 16 * 1024 * 1024;
const enabled = process.env.LAGRANGE_IMAGES_REAL_LAGRANGE === '1';
const processFixture = new URL('../fixtures/real-lagrange-backend-process.js', import.meta.url);

test('warm real Lagrange commits state/history, reuses kernel/class pairs and executes unchanged Life across two runtimes (M6.3)', {
  skip: enabled ? false : 'set LAGRANGE_IMAGES_REAL_LAGRANGE=1 with lagrange-server installed',
  timeout: REAL_LAGRANGE_BUDGETS.parent,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-images-warm-'));
  try {
    const {stdout} = await executeFile(process.execPath, [processFixture.pathname, directory, 'warm'], {
      env: {...process.env, LAGRANGE_BACKEND: 'lagrange'},
      maxBuffer: PROCESS_OUTPUT_LIMIT,
      timeout: REAL_LAGRANGE_BUDGETS.child,
      killSignal: 'SIGKILL',
    });
    t.diagnostic(JSON.stringify(readRealLagrangeReport(stdout, ['transaction', 'kernel', 'life'])));
  } catch (error) {
    const disposition = error.killed || error.code === 124 ? 'resource bound exhausted (inconclusive)' : 'proof failed';
    throw new Error(
      `Warm Lagrange child failed (${error.code ?? error.name}: ${error.message}); ` +
      `${disposition}; stdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`,
      {cause: error},
    );
  } finally {
    // execFile settles only after the owned child's streams close.
    await rm(directory, {recursive: true, force: true});
  }
});
