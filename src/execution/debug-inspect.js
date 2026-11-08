import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {assertActivationRequest} from './activation-executor.js';
import {ActivationCancelledError, ConditionRuntime, UnhandledConditionError} from './conditions.js';

const ACTIVATION_STACK_REPORT_V1 = 'lagrange-activation-stack-report/v1';
const CONDITION_INSPECTION_REPORT_V1 = 'lagrange-condition-inspection-report/v1';

function resolveConditionRuntime(source) {
  if (!source) return null;
  if (source instanceof ConditionRuntime) return source;
  if (source.conditions?.runtime instanceof ConditionRuntime) return source.conditions.runtime;
  if (source.runtime instanceof ConditionRuntime) return source.runtime;
  if (typeof source.snapshotActivationFrames === 'function') return source;
  return null;
}

function normalizeFrameEntry(entry, index) {
  const representation = entry?.representation ?? null;
  const executionLane = entry?.executionLane
    ?? (typeof representation === 'string' && representation.startsWith('wasm-function/') ? 'wasm' : 'neutral');
  return Object.freeze({
    frameId: Number.isInteger(entry?.frameId) ? entry.frameId : index + 1,
    depth: Number.isInteger(entry?.depth) ? entry.depth : index,
    block: entry?.block ?? null,
    code: entry?.code ?? null,
    languageId: entry?.languageId ?? null,
    representation,
    executionLane,
    receiver: entry?.receiver ?? null,
    selector: entry?.selector ?? null,
    definingBehavior: entry?.definingBehavior ?? null,
    ownsFrame: Boolean(entry?.ownsFrame),
    argumentCount: Number.isInteger(entry?.argumentCount) ? entry.argumentCount : 0,
    metadata: Object.freeze({...(entry?.metadata ?? {})}),
    wasmState: entry?.wasmState ?? null,
    suspensionCount: Number.isInteger(entry?.suspensionCount) ? entry.suspensionCount : 0,
    resumedCount: Number.isInteger(entry?.resumedCount) ? entry.resumedCount : 0,
    lastSuspension: entry?.lastSuspension ? Object.freeze({...entry.lastSuspension}) : null,
  });
}

function captureActivationStackReport(source = null) {
  let rawFrames = [];
  let runtime = null;
  if (Array.isArray(source)) {
    rawFrames = source;
  } else {
    runtime = resolveConditionRuntime(source);
    if (runtime) {
      const current = runtime.snapshotActivationFrames?.() ?? [];
      rawFrames = current.length > 0
        ? current
        : (runtime.lastSignalSnapshot?.()?.frames ?? []);
    } else if (source?.conditionSnapshot?.frames) {
      rawFrames = source.conditionSnapshot.frames;
    } else if (Array.isArray(source?.frames)) {
      rawFrames = source.frames;
    }
  }

  const frames = Object.freeze(rawFrames.map((entry, idx) => normalizeFrameEntry(entry, idx)));
  const languages = Object.freeze(
    [...new Set(frames.map((frame) => frame.languageId).filter((lang) => typeof lang === 'string' && lang.length > 0))]
      .sort(),
  );
  const suspendedFrameCount = frames.filter((frame) => frame.wasmState === 'suspended').length;
  const totalSuspensions = frames.reduce((sum, frame) => sum + frame.suspensionCount, 0);
  const wasmResumptions = Object.freeze(runtime?.snapshotWasmResumptions?.() ?? []);

  return Object.freeze({
    schema: ACTIVATION_STACK_REPORT_V1,
    depth: frames.length,
    frames,
    languages,
    suspendedFrameCount,
    totalSuspensions,
    wasmResumptions,
  });
}

async function resolveRestartNameFromValue(images, value) {
  if (!value || typeof value !== 'object') return String(value ?? '');
  if (value.kind === 'text') return value.value;
  if (isObjectRef(value) && images && typeof images.getObject === 'function') {
    const obj = await images.getObject(value.imageId, value.objectId);
    const spelling = obj?.slots?.['symbol-spelling'] ?? obj?.slots?.['slot-name'] ?? null;
    if (spelling?.kind === 'text') return spelling.value;
    return value.objectId;
  }
  return String(value.value ?? '');
}

async function extractRestartsFromImagePairChain(images, headValue) {
  if (!images || typeof images.getObject !== 'function' || !isObjectRef(headValue)) {
    return [];
  }
  const collected = [];
  const visited = new Set();
  let cursor = headValue;

  while (isObjectRef(cursor)) {
    const key = `${cursor.imageId}/${cursor.objectId}`;
    if (visited.has(key)) break;
    visited.add(key);

    const cell = await images.getObject(cursor.imageId, cursor.objectId);
    if (!cell || !Array.isArray(cell.indexed) || cell.indexed.length < 2) {
      break;
    }
    const pairRef = cell.indexed[0];
    const nextRef = cell.indexed[1];
    if (isObjectRef(pairRef)) {
      const pairObj = await images.getObject(pairRef.imageId, pairRef.objectId);
      if (pairObj && Array.isArray(pairObj.indexed) && pairObj.indexed.length >= 2) {
        const rawName = pairObj.indexed[0];
        const handlerTarget = pairObj.indexed[1];
        const name = await resolveRestartNameFromValue(images, rawName);
        let blockRef = isObjectRef(handlerTarget) ? handlerTarget : null;
        if (blockRef && typeof images.getBlock === 'function') {
          const maybeBlock = await images.getBlock(blockRef.imageId, blockRef.objectId);
          if (!maybeBlock) {
            const wrapperObj = await images.getObject(blockRef.imageId, blockRef.objectId);
            const innerBlock = wrapperObj?.slots?.['slot-block'] ?? wrapperObj?.slots?.block ?? null;
            if (isObjectRef(innerBlock)) blockRef = innerBlock;
          }
        }
        if (name && blockRef) {
          collected.push(Object.freeze({
            restartId: null,
            name,
            block: blockRef,
            description: null,
            source: 'image-alist',
            active: true,
          }));
        }
      }
    }
    cursor = nextRef;
  }
  return collected;
}

async function listAvailableRestarts({
  images = null,
  conditionRuntime = null,
  restartList = null,
  restartBindingRef = null,
} = {}) {
  const results = [];
  const runtime = resolveConditionRuntime(conditionRuntime);
  if (runtime) {
    const liveRestarts = runtime.snapshotRestarts?.() ?? [];
    const signalRestarts = runtime.lastSignalSnapshot?.()?.restarts ?? [];
    const sourceRestarts = liveRestarts.length > 0 ? liveRestarts : signalRestarts;
    for (const entry of sourceRestarts) {
      results.push(Object.freeze({
        restartId: entry.restartId ?? null,
        name: String(entry.name),
        block: entry.block,
        description: entry.description ?? null,
        source: 'condition-runtime',
        active: true,
      }));
    }
  }

  if (Array.isArray(restartList)) {
    for (const entry of restartList) {
      if (!entry || typeof entry !== 'object') continue;
      const name = String(entry.name ?? '');
      const block = entry.block ?? null;
      if (name && isObjectRef(block)) {
        results.push(Object.freeze({
          restartId: entry.restartId ?? null,
          name,
          block: canonicalizeValue(block),
          description: entry.description ?? null,
          source: 'explicit-list',
          active: true,
        }));
      }
    }
  } else if (isObjectRef(restartList)) {
    const chainEntries = await extractRestartsFromImagePairChain(images, restartList);
    results.push(...chainEntries);
  }

  if (isObjectRef(restartBindingRef) && images && typeof images.getObject === 'function') {
    const bindingObj = await images.getObject(restartBindingRef.imageId, restartBindingRef.objectId);
    const bindingValue = bindingObj?.slots?.['global-binding-value']
      ?? bindingObj?.slots?.['slot-value']
      ?? bindingObj?.slots?.value
      ?? null;
    if (isObjectRef(bindingValue)) {
      const chainEntries = await extractRestartsFromImagePairChain(images, bindingValue);
      results.push(...chainEntries);
    }
  }

  return Object.freeze(results);
}

async function captureConditionAndStackReport({
  conditionRuntime = null,
  condition = null,
  error = null,
  images = null,
  restartList = null,
  restartBindingRef = null,
} = {}) {
  const runtime = resolveConditionRuntime(conditionRuntime);
  const snapshot = error?.conditionSnapshot ?? runtime?.lastSignalSnapshot?.() ?? null;

  const resolvedCondition = condition ?? snapshot?.condition ?? null;
  const description = snapshot?.description
    ?? error?.description
    ?? (typeof error?.message === 'string' ? error.message : 'condition');
  const handled = snapshot ? Boolean(snapshot.handled) : false;
  const handlerScopeId = snapshot?.handlerScopeId ?? null;

  const stackReport = snapshot?.frames
    ? captureActivationStackReport(snapshot.frames)
    : captureActivationStackReport(runtime);

  const scopes = Object.freeze(
    snapshot?.scopes ?? runtime?.snapshotScopes?.() ?? [],
  );
  const occurrences = Object.freeze(
    runtime?.snapshotOccurrences?.() ?? [],
  );
  const restarts = await listAvailableRestarts({
    images,
    conditionRuntime: runtime,
    restartList,
    restartBindingRef,
  });

  return Object.freeze({
    schema: CONDITION_INSPECTION_REPORT_V1,
    handled,
    condition: resolvedCondition ? canonicalizeValue(resolvedCondition) : null,
    description,
    errorName: error?.name ?? null,
    handlerScopeId,
    stackReport,
    scopes,
    occurrences,
    restarts,
  });
}

async function invokeCapturedRestart({
  executor,
  invocations,
  images = null,
  conditionRuntime = null,
  restart,
  restarts = [],
  arguments: args = [],
  authority = null,
} = {}) {
  if (!executor || typeof executor.execute !== 'function') {
    throw new TypeError('invokeCapturedRestart requires an ActivationExecutor');
  }
  if (!invocations || typeof invocations.prepareActivation !== 'function') {
    throw new TypeError('invokeCapturedRestart requires an InvocationService');
  }

  let targetRestart = null;
  if (typeof restart === 'string') {
    const available = restarts.length > 0
      ? restarts
      : await listAvailableRestarts({images, conditionRuntime});
    targetRestart = available.find((entry) => entry.name === restart) ?? null;
    if (!targetRestart) {
      throw new TypeError(`restart not found: ${restart}`);
    }
  } else if (restart && typeof restart === 'object' && isObjectRef(restart.block)) {
    targetRestart = restart;
  } else if (isObjectRef(restart)) {
    targetRestart = {name: 'anonymous', block: restart};
  } else {
    throw new TypeError('invokeCapturedRestart requires a restart name, descriptor, or Block ref');
  }

  const normalizedArgs = Array.isArray(args) ? args.map((arg) => canonicalizeValue(arg)) : [];
  const prepareOpts = {
    block: canonicalizeValue(targetRestart.block),
    arguments: normalizedArgs,
  };
  if (images) prepareOpts.images = images;
  const activation = await invocations.prepareActivation(prepareOpts);
  const runtime = resolveConditionRuntime(conditionRuntime);

  return await executor.execute(activation, {
    authority,
    ...(runtime ? {conditionRuntime: runtime} : {}),
  });
}

function compareCanonicalResources(left, right) {
  if (left.imageId !== right.imageId) return left.imageId.localeCompare(right.imageId);
  return left.objectId.localeCompare(right.objectId);
}

async function authorizedInspectExecutionCondition({
  images = null,
  executor,
  invocations = null,
  activation,
  authority = null,
  restartBindingRef = null,
  signal = null,
  require,
} = {}) {
  if (typeof require !== 'function') {
    throw new TypeError('authorizedInspectExecutionCondition requires a require(demand) function');
  }
  if (!executor || typeof executor.execute !== 'function') {
    throw new TypeError('authorizedInspectExecutionCondition requires an ActivationExecutor');
  }
  assertActivationRequest(activation);

  const demandedTargets = [
    {imageId: activation.block.imageId, objectId: activation.block.objectId},
  ];
  if (restartBindingRef !== null) {
    if (!isObjectRef(restartBindingRef)) {
      throw new TypeError('restartBindingRef must be an unpinned ObjectRef or null');
    }
    demandedTargets.push({imageId: restartBindingRef.imageId, objectId: restartBindingRef.objectId});
  }
  demandedTargets.sort(compareCanonicalResources);
  const seenResources = new Set();
  for (const target of demandedTargets) {
    const resource = objectResource(target.imageId, target.objectId);
    if (seenResources.has(resource)) continue;
    seenResources.add(resource);
    require({
      operation: OBJECT_READ_OPERATION,
      resource,
    });
  }

  const conditionRuntime = new ConditionRuntime();
  try {
    const value = await executor.execute(activation, {
      authority,
      conditionRuntime,
      signal,
    });
    const lastSnapshot = conditionRuntime.lastSignalSnapshot();
    const conditionReport = lastSnapshot
      ? await captureConditionAndStackReport({
        conditionRuntime,
        images: images ?? executor.images,
        restartBindingRef,
      })
      : null;
    return Object.freeze({
      status: 'completed',
      value,
      errorName: null,
      description: null,
      stackReport: captureActivationStackReport(conditionRuntime),
      conditionReport,
      invocations,
    });
  } catch (error) {
    if (error instanceof ActivationCancelledError) {
      return Object.freeze({
        status: 'cancelled',
        value: null,
        errorName: 'ActivationCancelledError',
        description: error.message,
        stackReport: captureActivationStackReport(error.frames?.length ? error.frames : conditionRuntime),
        conditionReport: null,
        invocations,
      });
    }
    if (error instanceof UnhandledConditionError || error?.conditionSnapshot) {
      const conditionReport = await captureConditionAndStackReport({
        conditionRuntime,
        error,
        images: images ?? executor.images,
        restartBindingRef,
      });
      return Object.freeze({
        status: 'unhandled-condition',
        value: null,
        errorName: error.name ?? 'UnhandledConditionError',
        description: conditionReport.description,
        stackReport: conditionReport.stackReport,
        conditionReport,
        invocations,
      });
    }
    throw error;
  }
}

export {
  ACTIVATION_STACK_REPORT_V1,
  CONDITION_INSPECTION_REPORT_V1,
  authorizedInspectExecutionCondition,
  captureActivationStackReport,
  captureConditionAndStackReport,
  invokeCapturedRestart,
  listAvailableRestarts,
};
