import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

export class ProfilePrefixStop extends Error {
  constructor() { super('Bounded diagnostic prefix reached after completed backend operation'); this.name = 'ProfilePrefixStop'; this.code = 'M6_PROFILE_PREFIX_STOP'; }
}
export function createObserver({maxOperations, clock = () => performance.now(), persist = () => {}}) {
  const context = new AsyncLocalStorage();
  const state = {schema: 'm6-profile-observation/1', diagnosticOnly: true, acceptance: false,
    timingMeaning: 'Inclusive overlapping spans; never sum nested methods. Transaction phases describe backend SQL-session lifecycle, not physical SQL or record counts.',
    calls: {}, topLevelCompleted: 0, stopRequested: false, uncaught: null,
    transactionPhases: {count: 0, beforeWorkMs: 0, workMs: 0, afterWorkMs: 0}};
  function save() {
    try { persist(state); } catch (failure) {
      state.telemetryFailure ||= {name: failure.name, code: failure.code ?? null};
      throw failure;
    }
  }
  function call(label, invoke, boundary = false) {
    const depth = context.getStore()?.depth ?? 0;
    const started = clock();
    const metric = state.calls[label] ||= {count: 0, failed: 0, inclusiveMs: 0, returnedRows: 0};
    function finish(value, error) {
      metric.count++; metric.inclusiveMs += Math.max(0, clock() - started);
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
      try { value = invoke(); } catch (error) { return finish(undefined, error); }
      return value && typeof value.then === 'function' ?
        value.then((result) => finish(result, null), (error) => finish(undefined, error)) :
        finish(value, null);
    };
    return boundary ? context.run({depth: depth + 1}, run) : run();
  }
  function patch(target, name, label, boundary = false) {
    const original = target[name];
    if (typeof original !== 'function') throw new Error('Missing observed method: ' + name);
    target[name] = function(...args) { return call(label, () => Reflect.apply(original, this, args), boundary); };
  }
  function patchTransaction(target) {
    const original = target.transaction;
    target.transaction = function(...args) {
      const started = clock(); let entered = null; let left = null;
      const work = args[0];
      const wrapped = function(...workArgs) {
        entered = clock();
        let result;
        try { result = Reflect.apply(work, this, workArgs); }
        catch (error) { left = clock(); throw error; }
        return result && typeof result.then === 'function' ?
          result.then((value) => { left = clock(); return value; },
            (error) => { left = clock(); throw error; }) :
          (left = clock(), result);
      };
      const finishPhases = () => {
        if (entered !== null && left !== null) {
          const phases = state.transactionPhases;
          phases.count++; phases.beforeWorkMs += Math.max(0, entered - started);
          phases.workMs += Math.max(0, left - entered); phases.afterWorkMs += Math.max(0, clock() - left);
        }
      };
      return call('backend.transaction', () => {
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
  return {state, patch, patchTransaction};
}
