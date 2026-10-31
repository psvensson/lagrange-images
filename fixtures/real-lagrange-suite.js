import assert from 'node:assert/strict';
import {writeSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

export const REAL_LAGRANGE_BUDGETS = Object.freeze({
  setup: 160_000,
  transaction: 160_000,
  kernel: 340_000,
  life: 340_000,
  cleanup: 20_000,
  // The sum of the three former child envelopes. This shared ceiling can
  // preempt a phase before its individual allowance is exhausted.
  child: 840_000,
  parent: 860_000,
});
export const REAL_LAGRANGE_REPORT_PREFIX = 'IMAGES_REAL_LAGRANGE_REPORT ';

function abortTimedOutChild(record) {
  // A rejected Promise.race would leave the native operation running. End
  // this owned process instead; the parent waits for close before cleanup.
  try {
    writeSync(2, `${JSON.stringify({
      type: 'IMAGES_REAL_LAGRANGE_PHASE_TIMEOUT',
      ...record,
    })}\n`);
  } finally {
    process.exit(124);
  }
}

// start owns cleanup of a rejected startup (LagrangeBackend.start already
// does this). Once it resolves, this fixture owns exactly one stop call.
export async function runRealLagrangeSuite({
  start,
  stop,
  scenarios,
  observe = () => {},
  setupTimeoutMs = REAL_LAGRANGE_BUDGETS.setup,
  cleanupTimeoutMs = REAL_LAGRANGE_BUDGETS.cleanup,
}) {
  assert.equal(typeof start, 'function');
  assert.equal(typeof stop, 'function');
  assert.ok(Array.isArray(scenarios) && scenarios.length > 0);
  const names = scenarios.map(({name}) => name);
  assert.equal(new Set(names).size, names.length, 'unique scenario names');
  for (const {name, run} of scenarios) {
    assert.ok(typeof name === 'string' && !['setup', 'cleanup'].includes(name));
    assert.equal(typeof run, 'function');
  }
  for (const timeoutMs of [setupTimeoutMs, cleanupTimeoutMs, ...scenarios.map((s) => s.timeoutMs)]) {
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  }
  const phases = [];
  const emit = (record) => {
    // Optional live diagnostics must never strand a successfully acquired
    // resource. The returned, strictly checked report owns completion proof.
    try { observe(record); } catch {}
  };
  async function phase(name, timeoutMs, operation) {
    const started = performance.now();
    emit({phase: name, state: 'started', timeoutMs});
    const watchdog = setTimeout(() => abortTimedOutChild({
      phase: name, timeoutMs, elapsedMs: performance.now() - started,
      disposition: 'inconclusive',
    }), timeoutMs);
    try {
      const value = await operation();
      const elapsedMs = performance.now() - started;
      // Synchronous work may prevent the timer callback from running. It must
      // not cancel an overdue watchdog and publish a passing phase.
      if (elapsedMs >= timeoutMs) abortTimedOutChild({
        phase: name, timeoutMs, elapsedMs, disposition: 'inconclusive',
      });
      const record = {phase: name, state: 'passed', elapsedMs};
      phases.push(record);
      emit(record);
      return value;
    } catch (error) {
      emit({phase: name, state: 'failed', elapsedMs: performance.now() - started,
        error: {name: error?.name, code: error?.code, message: String(error?.message).slice(0, 1000)}});
      throw error;
    } finally {
      clearTimeout(watchdog);
    }
  }

  const resource = await phase('setup', setupTimeoutMs, start);
  let failed = false;
  let failure;
  try {
    for (const {name, timeoutMs, run} of scenarios) {
      await phase(name, timeoutMs, () => run(resource));
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await phase('cleanup', cleanupTimeoutMs, () => stop(resource));
  } catch (error) {
    if (failed) throw new AggregateError([failure, error], 'Scenario and cleanup both failed');
    throw error;
  }
  if (failed) throw failure;
  return {schema: 'images-real-lagrange/v1', phases};
}

export function readRealLagrangeReport(stdout, scenarioNames) {
  const reports = stdout.split('\n').filter((line) => line.startsWith(REAL_LAGRANGE_REPORT_PREFIX));
  assert.equal(reports.length, 1, 'exactly one completed real Lagrange suite report');
  const report = JSON.parse(reports[0].slice(REAL_LAGRANGE_REPORT_PREFIX.length));
  assert.equal(report.schema, 'images-real-lagrange/v1');
  assert.deepEqual(report.phases.map(({phase}) => phase), ['setup', ...scenarioNames, 'cleanup']);
  for (const {state, elapsedMs} of report.phases) {
    assert.equal(state, 'passed');
    assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0, 'finite measured phase duration');
  }
  return report;
}
