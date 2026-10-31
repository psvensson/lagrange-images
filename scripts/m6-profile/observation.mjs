import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

const STAGES = new Set(['setup', 'transaction', 'kernel', 'life', 'cleanup',
  'life.create-image', 'life.install-managed-release', 'life.read-recovered-closure',
  'life.install-standard-image', 'life.import-native-package']);

export class ProfilePrefixStop extends Error {
  constructor() { super('Bounded diagnostic prefix reached after completed backend operation'); this.name = 'ProfilePrefixStop'; this.code = 'M6_PROFILE_PREFIX_STOP'; }
}
export function createObserver({maxOperations, clock = () => performance.now(), persist = () => {}, maxPending = 128, maxStages = 128}) {
  const context = new AsyncLocalStorage();
  const state = {schema: 'm6-profile-observation/1', diagnosticOnly: true, acceptance: false,
    timingMeaning: 'Inclusive overlapping spans; never sum nested methods. Transaction phases describe backend SQL-session lifecycle, not physical SQL or record counts.',
    calls: {}, topLevelCompleted: 0, stopRequested: false, uncaught: null,
    transactionPhases: {count: 0, beforeWorkMs: 0, workMs: 0, afterWorkMs: 0},
    currentStage: 'unobserved', stages: [], completedByStartStage: {}, pending: [],
    transactionPhasesByStartStage: {},
    observationMeaning: 'Pending elapsed is observed age, never completed cost or a native snapshot. Costs are inclusive, include observer overhead, and overlap.',
    overflow: {pending: 0, stages: 0}};
  const active = new Map();
  let sequence = 0;
  function save() {
    const now = clock();
    state.observedAtMs = now;
    state.observedAtWall = new Date().toISOString();
    state.pending = [...active.values()].map((operation) => ({...operation,
      elapsedMs: Math.max(0, now - operation.startedMs),
      ...(operation.phaseStartedMs === undefined ? {} :
        {phaseElapsedMs: Math.max(0, now - operation.phaseStartedMs)})}));
    try { persist(state); } catch (failure) {
      state.telemetryFailure ||= {name: failure.name, code: failure.code ?? null};
    }
  }
  function stage(record) {
    if (!record || !STAGES.has(record.stage) ||
        !['started', 'passed', 'failed'].includes(record.state ?? 'started')) {
      state.telemetryFailure ||= {name: 'InvalidStageObservation', code: null};
      return;
    }
    state.currentStage = record.stage.startsWith('life.') && record.state === 'passed' ? 'life' : record.stage;
    state.lastStageObservation = {stage: record.stage, state: record.state ?? 'started'};
    if (state.stages.length < maxStages) state.stages.push({stage: record.stage,
      state: record.state ?? 'started', observedAtMs: clock()});
    else state.overflow.stages++;
    save();
  }
  function call(label, invoke, boundary = false) {
    const parent = context.getStore();
    const depth = parent?.boundaryDepth ?? 0;
    const started = clock();
    const operation = {id: ++sequence, label, parentId: parent?.id ?? null,
      depth: parent ? parent.operationDepth + 1 : 0, startedMs: started,
      startStage: state.currentStage};
    if (active.size < maxPending) active.set(operation.id, operation);
    else state.overflow.pending++;
    save();
    const metric = state.calls[label] ||= {count: 0, failed: 0, inclusiveMs: 0, returnedRows: 0};
    function finish(value, error) {
      const elapsedMs = Math.max(0, clock() - started);
      metric.count++; metric.inclusiveMs += elapsedMs;
      active.delete(operation.id);
      const grouped = state.completedByStartStage[operation.startStage] ||= {};
      const completed = grouped[label] ||= {count: 0, failed: 0, inclusiveMs: 0};
      completed.count++; completed.inclusiveMs += elapsedMs;
      if (error && !(error instanceof ProfilePrefixStop)) completed.failed++;
      if (error && !(error instanceof ProfilePrefixStop)) metric.failed++;
      if (!error && Array.isArray(value) && (label.endsWith('.scan') || label.endsWith('.listCodeArtifacts'))) metric.returnedRows += value.length;
      if (boundary && depth === 0) state.topLevelCompleted++;
      if (error) {
        try { save(); } catch { /* Original error retains priority. */ }
        throw error;
      }
      save();
      if (boundary && depth === 0 && !state.stopRequested && state.topLevelCompleted >= maxOperations) {
        state.stopRequested = true; save(); throw new ProfilePrefixStop();
      }
      return value;
    }
    const run = () => {
      let value;
      try { value = invoke(operation); } catch (error) { return finish(undefined, error); }
      return value && typeof value.then === 'function' ?
        value.then((result) => finish(result, null), (error) => finish(undefined, error)) :
        finish(value, null);
    };
    return context.run({id: operation.id, operationDepth: operation.depth,
      boundaryDepth: depth + (boundary ? 1 : 0)}, run);
  }
  function patch(target, name, label, boundary = false) {
    const original = target[name];
    if (typeof original !== 'function') throw new Error('Missing observed method: ' + name);
    target[name] = function(...args) { return call(label, () => Reflect.apply(original, this, args), boundary); };
  }
  function patchTransaction(target) {
    const original = target.transaction;
    target.transaction = function(...args) {
      const started = clock(); let entered = null; let left = null; let operation;
      const phase = (name) => { if (operation) { operation.transactionPhase = name; operation.phaseStartedMs = clock(); save(); } };
      const work = args[0];
      const wrapped = function(...workArgs) {
        entered = clock(); phase('work');
        let result;
        try { result = Reflect.apply(work, this, workArgs); }
        catch (error) { left = clock(); phase('afterWork'); throw error; }
        return result && typeof result.then === 'function' ?
          result.then((value) => { left = clock(); phase('afterWork'); return value; },
            (error) => { left = clock(); phase('afterWork'); throw error; }) :
          (left = clock(), phase('afterWork'), result);
      };
      const finishPhases = () => {
        if (entered !== null && left !== null) {
          const phases = state.transactionPhases;
          const grouped = state.transactionPhasesByStartStage[operation.startStage] ||=
            {count: 0, beforeWorkMs: 0, workMs: 0, afterWorkMs: 0};
          const completedAt = clock();
          for (const target of [phases, grouped]) {
            target.count++; target.beforeWorkMs += Math.max(0, entered - started);
            target.workMs += Math.max(0, left - entered);
            target.afterWorkMs += Math.max(0, completedAt - left);
          }
        }
      };
      return call('backend.transaction', (observed) => {
        operation = observed; phase('beforeWork');
        let result;
        try { result = Reflect.apply(original, this, [typeof work === 'function' ? wrapped : work, ...args.slice(1)]); }
        catch (error) { finishPhases(); throw error; }
        return result && typeof result.then === 'function' ?
          result.then((value) => { finishPhases(); return value; },
            (error) => { finishPhases(); throw error; }) :
          (finishPhases(), result);
      }, true);
    };
  }
  return {state, patch, patchTransaction, stage, snapshot: save};
}
