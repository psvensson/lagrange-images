import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

const executeFile = promisify(execFile);
const workerPath = new URL('./support/process-restart-worker.js', import.meta.url).pathname;

test('LagrangeBackend survives full OS process restart and recovers polyglot Smalltalk/Common Lisp classes, Shape-migrated objects, named branches, history-safe GC tombstones, and managed Project installations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lagrange-process-restart-durability-'));
  const dbPath = join(dir, 'durable-node.sqlite');
  try {
    // Phase 1: Spawn child process 1 to populate durable state and exit completely
    const {stdout: populateOut} = await executeFile(
      process.execPath,
      [workerPath, 'populate', dbPath],
      {timeout: 120_000},
    );
    const populateReceipt = JSON.parse(populateOut.trim().split('\n').pop());
    assert.equal(populateReceipt.phase, 'populate');
    assert.equal(populateReceipt.ok, true);
    assert.equal(populateReceipt.migratedCount, 1);
    assert.ok(populateReceipt.sweptIds.includes('orphan-temp-1'));
    assert.match(populateReceipt.releaseId, /^sha256:/);

    // Phase 2: Spawn a brand-new OS child process 2 over the same on-disk SQLite database
    const {stdout: verifyOut} = await executeFile(
      process.execPath,
      [workerPath, 'verify-and-advance', dbPath],
      {timeout: 120_000},
    );
    const verifyReceipt = JSON.parse(verifyOut.trim().split('\n').pop());
    assert.equal(verifyReceipt.phase, 'verify-and-advance');
    assert.equal(verifyReceipt.ok, true);
    assert.equal(verifyReceipt.updatedCount, 20);
    assert.equal(verifyReceipt.clResult, 120);
    assert.equal(verifyReceipt.branchRevision, populateReceipt.branchRevision);
    assert.equal(verifyReceipt.passedTests, 1);
    assert.equal(verifyReceipt.installedReleaseId, populateReceipt.releaseId);

    // Phase 3: Spawn a third OS child process to verify mutations from Process 2 persisted durably
    const {stdout: thirdOut} = await executeFile(
      process.execPath,
      [workerPath, 'verify-post-restart-mutation', dbPath],
      {timeout: 120_000},
    );
    const thirdReceipt = JSON.parse(thirdOut.trim().split('\n').pop());
    assert.equal(thirdReceipt.phase, 'verify-post-restart-mutation');
    assert.equal(thirdReceipt.ok, true);
    assert.equal(thirdReceipt.persistedCount, 20);
    assert.equal(thirdReceipt.nextCount, 30);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
