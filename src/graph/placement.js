import {assertBackend, assertBackendTransaction} from '../backend/backend-contract.js';
import {IMAGE_COLLECTION, history, records} from '../image/storage-layout.js';
import {referencesOfValue} from '../value/index.js';
import {isObjectRef, objectRef, textValue} from '../value/scalars.js';
import {
  PER_OBJECT_RESIDENCY,
  RELOCATED_RECORD_KIND,
  SWEPT_RECORD_KIND,
  WHOLE_IMAGE_RESIDENCY,
} from './locator.js';

const RELOCATABLE_RECORD_KINDS = new Set([
  'object',
  'block',
  'lexical-environment',
  'code-artifact',
]);

const PLACEMENT_RECOVERY_REPORT_V1 = 'lagrange-placement-recovery-report/v1';
const FOREIGN_RUNTIME_PLACEMENT_RECEIPT_V1 = 'lagrange-foreign-runtime-placement-receipt/v1';
const WASM_PLACEMENT_RECEIPT_V1 = 'lagrange-wasm-placement-receipt/v1';

class PlacementIdempotencyConflictError extends TypeError {
  constructor(idempotencyKey, detail) {
    super(`Placement idempotency conflict for key ${JSON.stringify(idempotencyKey)}: ${detail}`);
    this.name = 'PlacementIdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

function normalizeOptionalIdempotencyKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('idempotencyKey must be a non-empty string when provided');
  }
  return value;
}

function assertNodeId(nodeId, label = 'nodeId') {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return nodeId;
}

function isSystemInfrastructureObject(record) {
  if (!record || record.kind !== 'object') return true;
  const id = record.id ?? '';
  if (
    id === 'smalltalk-kernel/v1' ||
    id === 'smalltalk/kernel' ||
    id === 'smalltalk-global-namespace/v1' ||
    id === 'smalltalk/globals' ||
    id === 'smalltalk-block-protocol/v1' ||
    id === 'smalltalk-block-unwind/v1' ||
    id === 'smalltalk/symbol-table' ||
    id === 'smalltalk/subclasses' ||
    id.startsWith('smalltalk/symbol/') ||
    id.startsWith('smalltalk/char/') ||
    id.endsWith('/namespace/v1')
  ) {
    return true;
  }
  const stMeta = record.metadata?.smalltalk;
  if (
    stMeta === 'behavior' ||
    stMeta === 'singleton' ||
    stMeta === 'class-state' ||
    stMeta === 'subclass-registry' ||
    stMeta === 'kernel-primitive' ||
    stMeta === 'method-dictionary'
  ) {
    return true;
  }
  const shapeId = record.shape?.objectId ?? '';
  if (
    shapeId === 'smalltalk/global-namespace-shape/v2' ||
    shapeId === 'smalltalk/global-namespace-shape/v1' ||
    shapeId === 'smalltalk/behavior-shape/v1' ||
    shapeId === 'smalltalk/kernel-shape/v1'
  ) {
    return true;
  }
  if (
    record.metadata &&
    typeof record.metadata === 'object' &&
    Object.values(record.metadata).some((val) => val === 'sentinel' || val === 'defsystem')
  ) {
    return true;
  }
  return false;
}

function buildRelocatedCandidateRecord(current, at) {
  switch (current.kind) {
    case 'object':
      return {
        kind: 'object',
        id: current.id,
        imageId: current.imageId,
        shape: structuredClone(current.shape),
        behavior: structuredClone(current.behavior),
        slots: structuredClone(current.slots),
        ...(current.indexed !== undefined ? {indexed: structuredClone(current.indexed)} : {}),
        metadata: structuredClone(current.metadata ?? {}),
        updatedAt: at,
      };
    case 'block':
      return {
        kind: 'block',
        id: current.id,
        imageId: current.imageId,
        code: structuredClone(current.code),
        environment: structuredClone(current.environment ?? null),
        metadata: structuredClone(current.metadata ?? {}),
        updatedAt: at,
      };
    case 'lexical-environment':
      return {
        kind: 'lexical-environment',
        id: current.id,
        imageId: current.imageId,
        parent: structuredClone(current.parent ?? null),
        bindings: structuredClone(current.bindings ?? {}),
        metadata: structuredClone(current.metadata ?? {}),
        updatedAt: at,
      };
    case 'code-artifact':
      return {
        kind: 'code-artifact',
        id: current.id,
        imageId: current.imageId,
        languageId: current.languageId ?? null,
        representation: current.representation,
        content: structuredClone(current.content),
        logicalPath: current.logicalPath ?? null,
        dependencies: structuredClone(current.dependencies ?? []),
        derivedFrom: structuredClone(current.derivedFrom ?? []),
        metadata: structuredClone(current.metadata ?? {}),
        updatedAt: at,
      };
    default:
      throw new TypeError(`unsupported record kind for relocation: ${current.kind}`);
  }
}

function buildTargetPutHistoryEvent(saved, at, relocationMeta = null) {
  const extra = relocationMeta
    ? {
        relocatedFrom: relocationMeta.fromNode,
        relocatedTo: relocationMeta.toNode,
      }
    : {};
  switch (saved.kind) {
    case 'object':
      return {
        type: 'object.put',
        at,
        objectId: saved.id,
        objectVersion: saved._version,
        object: structuredClone(saved),
        ...extra,
      };
    case 'block':
      return {
        type: 'block.put',
        at,
        blockId: saved.id,
        blockVersion: saved._version,
        block: structuredClone(saved),
        ...extra,
      };
    case 'lexical-environment':
      return {
        type: 'lexical-environment.put',
        at,
        environmentId: saved.id,
        environmentVersion: saved._version,
        environment: structuredClone(saved),
        ...extra,
      };
    case 'code-artifact':
      return {
        type: 'code-artifact.put',
        at,
        artifactId: saved.id,
        artifactVersion: saved._version,
        artifact: structuredClone(saved),
        ...extra,
      };
    default:
      throw new TypeError(`unsupported record kind for history event: ${saved.kind}`);
  }
}

class PlacementPolicy {
  #nodes = new Map();
  #locators = new Set();
  #idempotencyReceipts = new Map();

  constructor({nodes = {}, locators = [], clock = () => new Date()} = {}) {
    this.clock = clock;
    if (nodes && typeof nodes === 'object') {
      const entries = nodes instanceof Map || Array.isArray(nodes)
        ? nodes
        : Object.entries(nodes);
      for (const [nodeId, target] of entries) {
        this.registerNode(nodeId, target);
      }
    }
    for (const locator of locators ?? []) {
      this.registerLocator(locator);
    }
  }

  registerLocator(locator) {
    if (!locator || typeof locator.locate !== 'function') {
      throw new TypeError('placement policy locator must provide locate(ref)');
    }
    this.#locators.add(locator);
    return this;
  }

  registerNode(nodeId, target) {
    assertNodeId(nodeId);
    const backend = assertBackend(target?.backend ?? target);
    const locator = target?.locator ?? target?.images?.locator ?? null;
    const runtime = target?.invocations && target?.executor ? target : null;
    if (locator) {
      this.registerLocator(locator);
    }
    for (const [existingId, existing] of this.#nodes.entries()) {
      if (existingId === nodeId) continue;
      existing.locator?.registerPeer?.(nodeId, backend);
      locator?.registerPeer?.(existingId, existing.backend);
    }
    this.#nodes.set(nodeId, {nodeId, backend, locator, runtime});
    return this;
  }

  async #readLiveRecord(ref) {
    if (!isObjectRef(ref)) return null;
    const liveMatches = [];
    for (const [nodeId, {backend}] of this.#nodes.entries()) {
      const record = await backend.get(records(ref.imageId), ref.objectId);
      if (record && record.kind !== RELOCATED_RECORD_KIND && record.kind !== SWEPT_RECORD_KIND) {
        liveMatches.push({nodeId, backend, record});
      }
    }
    if (liveMatches.length > 1) {
      const holders = liveMatches.map(({nodeId}) => nodeId).join(', ');
      throw new TypeError(
        `duplicate live object records for ${ref.imageId}/${ref.objectId} across nodes: ${holders}`,
      );
    }
    return liveMatches[0] ?? null;
  }

  async #collectBlockTargetObjectRefs(blockRef, args = []) {
    const candidateMap = new Map();
    const addCandidate = (ref) => {
      if (!isObjectRef(ref)) return;
      candidateMap.set(`${ref.imageId}\0${ref.objectId}`, ref);
    };

    for (const arg of args ?? []) {
      for (const ref of referencesOfValue(arg)) {
        addCandidate(ref);
      }
    }

    const blockMatch = await this.#readLiveRecord(blockRef);
    const blockRecord = blockMatch?.record ?? null;
    let envRef = blockRecord?.environment ?? null;
    let depth = 0;
    const visitedEnvs = new Set();

    while (isObjectRef(envRef) && depth < 16) {
      const envKey = `${envRef.imageId}\0${envRef.objectId}`;
      if (visitedEnvs.has(envKey)) break;
      visitedEnvs.add(envKey);
      depth += 1;

      const envMatch = await this.#readLiveRecord(envRef);
      const envRecord = envMatch?.record ?? null;
      if (!envRecord || envRecord.kind !== 'lexical-environment') break;

      for (const binding of Object.values(envRecord.bindings ?? {})) {
        if (!binding || binding.value === undefined) continue;
        for (const ref of referencesOfValue(binding.value)) {
          addCandidate(ref);
        }
      }
      envRef = envRecord.parent ?? null;
    }

    const dataObjectMatches = [];
    for (const ref of candidateMap.values()) {
      const match = await this.#readLiveRecord(ref);
      if (!match || match.record.kind !== 'object') continue;

      // Follow GlobalBinding value slot if it points to a user data object
      if (match.record.shape?.objectId === 'smalltalk/global-binding-shape/v1') {
        const boundVal = match.record.slots?.['global-binding-value'];
        if (isObjectRef(boundVal)) {
          const innerMatch = await this.#readLiveRecord(boundVal);
          if (
            innerMatch &&
            innerMatch.record.kind === 'object' &&
            !isSystemInfrastructureObject(innerMatch.record)
          ) {
            const hasLocalImage = Boolean(
              await innerMatch.backend.get(IMAGE_COLLECTION, boundVal.imageId),
            );
            dataObjectMatches.push({
              ref: boundVal,
              node: innerMatch.nodeId,
              residencyKind: hasLocalImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
            });
          }
        }
        continue;
      }

      if (isSystemInfrastructureObject(match.record)) continue;
      const hasLocalImage = Boolean(await match.backend.get(IMAGE_COLLECTION, ref.imageId));
      dataObjectMatches.push({
        ref,
        node: match.nodeId,
        residencyKind: hasLocalImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
      });
    }

    return dataObjectMatches;
  }

  async selectExecutionNode(ref) {
    if (!isObjectRef(ref)) throw new TypeError('selectExecutionNode requires an ObjectRef');
    const residency = await this.inspectResidency(ref);
    if (!residency) {
      throw new TypeError(`unable to locate resident node for ${ref.imageId}/${ref.objectId}`);
    }
    return residency.node;
  }

  async selectBlockExecutionNode(block, {arguments: args = [], targetObject = null} = {}) {
    if (!isObjectRef(block)) {
      throw new TypeError('selectBlockExecutionNode requires an ObjectRef block');
    }
    if (targetObject !== null) {
      if (!isObjectRef(targetObject)) {
        throw new TypeError('selectBlockExecutionNode targetObject must be an ObjectRef when provided');
      }
      return await this.selectExecutionNode(targetObject);
    }

    const blockResidency = await this.inspectResidency(block);
    if (!blockResidency) {
      throw new TypeError(`unable to locate resident node for ${block.imageId}/${block.objectId}`);
    }

    const dataMatches = await this.#collectBlockTargetObjectRefs(block, args);
    const perObjectCounts = new Map();
    const totalCounts = new Map();

    for (const item of dataMatches) {
      totalCounts.set(item.node, (totalCounts.get(item.node) ?? 0) + 1);
      if (item.residencyKind === PER_OBJECT_RESIDENCY) {
        perObjectCounts.set(item.node, (perObjectCounts.get(item.node) ?? 0) + 1);
      }
    }

    if (perObjectCounts.size > 0) {
      const ranked = [...perObjectCounts.entries()].sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1];
        const totalDiff = (totalCounts.get(right[0]) ?? 0) - (totalCounts.get(left[0]) ?? 0);
        if (totalDiff !== 0) return totalDiff;
        if (left[0] === blockResidency.node) return -1;
        if (right[0] === blockResidency.node) return 1;
        return left[0].localeCompare(right[0]);
      });
      return ranked[0][0];
    }

    if (blockResidency.kind === PER_OBJECT_RESIDENCY) {
      return blockResidency.node;
    }

    if (totalCounts.size > 0) {
      const ranked = [...totalCounts.entries()].sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1];
        if (left[0] === blockResidency.node) return -1;
        if (right[0] === blockResidency.node) return 1;
        return left[0].localeCompare(right[0]);
      });
      return ranked[0][0];
    }

    return blockResidency.node;
  }

  #checkIdempotency(idempotencyKey, signature) {
    const key = normalizeOptionalIdempotencyKey(idempotencyKey);
    if (!key) return null;
    const existing = this.#idempotencyReceipts.get(key);
    if (!existing) return null;
    if (existing.signature !== signature) {
      throw new PlacementIdempotencyConflictError(
        key,
        `reused with different operation parameters (${existing.signature} vs ${signature})`,
      );
    }
    return Object.freeze({...existing.receipt, replayed: true});
  }

  #recordIdempotency(idempotencyKey, signature, receipt) {
    const key = normalizeOptionalIdempotencyKey(idempotencyKey);
    if (!key) return receipt;
    this.#idempotencyReceipts.set(key, {signature, receipt});
    return receipt;
  }

  async #executeWithRetry(retryOptions, refsToInvalidate, fn) {
    const maxAttempts = Number.isInteger(retryOptions?.maxAttempts) && retryOptions.maxAttempts >= 1
      ? retryOptions.maxAttempts
      : 1;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await fn(attempt);
        return {result, attempts: attempt};
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts) throw err;
        for (const locator of this.#locators) {
          for (const ref of refsToInvalidate ?? []) {
            if (isObjectRef(ref)) locator.invalidate?.(ref);
          }
        }
      }
    }
    throw lastError;
  }

  async dispatchSend({
    fromNode = null,
    receiver,
    message,
    arguments: args = [],
    languageId = 'symmetric-smalltalk',
    dispatchImage = undefined,
    idempotencyKey = null,
    retry = null,
  } = {}) {
    if (!isObjectRef(receiver)) throw new TypeError('dispatchSend requires an ObjectRef receiver');
    if (fromNode !== null) assertNodeId(fromNode, 'fromNode');
    const selectorValue = typeof message === 'string' ? textValue(message) : message;
    const signature = JSON.stringify({
      op: 'dispatchSend',
      fromNode,
      receiver,
      message: selectorValue,
      args,
      languageId,
      dispatchImage: dispatchImage ?? receiver.imageId,
    });
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return replayed;

    const {result, attempts} = await this.#executeWithRetry(
      retry,
      [receiver, ...args.flatMap((a) => referencesOfValue(a))],
      async () => {
        const targetNodeId = await this.selectExecutionNode(receiver);
        const target = this.#nodes.get(targetNodeId);
        if (!target?.runtime) {
          throw new TypeError(`node ${targetNodeId} has no registered execution runtime`);
        }
        const activation = await target.runtime.invocations.sendMessage(
          {
            receiver,
            message: selectorValue,
            arguments: args,
            languageId,
          },
          {dispatchImage: dispatchImage ?? receiver.imageId},
        );
        const value = await target.runtime.executor.execute(activation);
        return {targetNodeId, value};
      },
    );

    const receipt = Object.freeze({
      node: result.targetNodeId,
      fromNode,
      routedRemotely: fromNode !== null && fromNode !== result.targetNodeId,
      value: result.value,
      attempts,
      replayed: false,
    });
    return this.#recordIdempotency(idempotencyKey, signature, receipt);
  }

  async dispatchApply({
    fromNode = null,
    block,
    arguments: args = [],
    targetObject = null,
    idempotencyKey = null,
    retry = null,
  } = {}) {
    if (!isObjectRef(block)) throw new TypeError('dispatchApply requires an ObjectRef block');
    if (fromNode !== null) assertNodeId(fromNode, 'fromNode');
    if (!Array.isArray(args)) {
      throw new TypeError('dispatchApply arguments must be an array');
    }
    const signature = JSON.stringify({
      op: 'dispatchApply',
      fromNode,
      block,
      args,
      targetObject,
    });
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return replayed;

    const {result, attempts} = await this.#executeWithRetry(
      retry,
      [block, targetObject, ...args.flatMap((a) => referencesOfValue(a))],
      async () => {
        const targetNodeId = await this.selectBlockExecutionNode(block, {
          arguments: args,
          targetObject,
        });
        const target = this.#nodes.get(targetNodeId);
        if (!target?.runtime) {
          throw new TypeError(`node ${targetNodeId} has no registered execution runtime`);
        }
        const activation = await target.runtime.invocations.invokeBlock(block, args);
        const value = await target.runtime.executor.execute(activation);
        return {targetNodeId, value};
      },
    );

    const receipt = Object.freeze({
      node: result.targetNodeId,
      fromNode,
      routedRemotely: fromNode !== null && fromNode !== result.targetNodeId,
      value: result.value,
      attempts,
      replayed: false,
    });
    return this.#recordIdempotency(idempotencyKey, signature, receipt);
  }

  async relocateObjects({refs, fromNode, toNode, idempotencyKey = null} = {}) {
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new TypeError('relocateObjects requires a non-empty array of ObjectRefs');
    }
    const signature = JSON.stringify({op: 'relocateObjects', refs, fromNode, toNode});
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return Object.freeze(replayed.receipts);
    const receipts = [];
    for (const ref of refs) {
      receipts.push(
        await this.relocateObject({
          ref,
          fromNode,
          toNode,
          idempotent: idempotencyKey !== null,
        }),
      );
    }
    const frozen = Object.freeze(receipts);
    if (idempotencyKey !== null) {
      this.#recordIdempotency(idempotencyKey, signature, {receipts: frozen});
    }
    return frozen;
  }

  async relocateRecords({refs, fromNode, toNode, idempotencyKey = null, idempotent = false} = {}) {
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new TypeError('relocateRecords requires a non-empty array of ObjectRefs');
    }
    const signature = JSON.stringify({op: 'relocateRecords', refs, fromNode, toNode});
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return Object.freeze(replayed.receipts);
    const receipts = [];
    for (const ref of refs) {
      receipts.push(
        await this.relocateRecord({
          ref,
          fromNode,
          toNode,
          idempotent: idempotent || idempotencyKey !== null,
        }),
      );
    }
    const frozen = Object.freeze(receipts);
    if (idempotencyKey !== null) {
      this.#recordIdempotency(idempotencyKey, signature, {receipts: frozen});
    }
    return frozen;
  }

  async #collectCodeArtifactDependencyClosureOnNode(backend, rootArtifactRef, addRefFn) {
    const queue = [rootArtifactRef];
    const visited = new Set();
    while (queue.length > 0) {
      const currRef = queue.shift();
      if (!isObjectRef(currRef)) continue;
      const key = `${currRef.imageId}\0${currRef.objectId}`;
      if (visited.has(key)) continue;
      visited.add(key);

      // eslint-disable-next-line no-await-in-loop
      const artRec = await addRefFn(currRef, new Set(['code-artifact']));
      if (!artRec) continue;
      for (const dep of artRec.dependencies ?? []) {
        if (isObjectRef(dep?.artifact)) {
          queue.push(dep.artifact);
        }
      }
      for (const srcRef of artRec.derivedFrom ?? []) {
        if (isObjectRef(srcRef)) {
          queue.push(srcRef);
        }
      }
    }
  }

  async relocateBlockClosure({
    block,
    fromNode,
    toNode,
    includeCodeArtifact = false,
    includeCodeArtifactClosure = false,
    includeCapturedObjects = false,
    idempotencyKey = null,
  } = {}) {
    if (!isObjectRef(block)) {
      throw new TypeError('relocateBlockClosure requires an ObjectRef block');
    }
    assertNodeId(fromNode, 'fromNode');
    assertNodeId(toNode, 'toNode');
    if (fromNode === toNode) {
      throw new TypeError('relocateBlockClosure requires distinct fromNode and toNode');
    }
    const signature = JSON.stringify({
      op: 'relocateBlockClosure',
      block,
      fromNode,
      toNode,
      includeCodeArtifact,
      includeCodeArtifactClosure,
      includeCapturedObjects,
    });
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return replayed;

    const source = this.#nodes.get(fromNode);
    if (!source) throw new TypeError(`unknown source node: ${fromNode}`);
    const blockRecord = await source.backend.get(records(block.imageId), block.objectId);
    if (!blockRecord || blockRecord.kind !== 'block') {
      throw new TypeError(`block not resident on ${fromNode}: ${block.imageId}/${block.objectId}`);
    }

    const refsToMove = [];
    const seenKeys = new Set();
    const addRefIfResidentOnFromNode = async (ref, allowedKinds) => {
      if (!isObjectRef(ref)) return null;
      const key = `${ref.imageId}\0${ref.objectId}`;
      if (seenKeys.has(key)) return null;
      const rec = await source.backend.get(records(ref.imageId), ref.objectId);
      if (
        !rec ||
        rec.kind === RELOCATED_RECORD_KIND ||
        rec.kind === SWEPT_RECORD_KIND ||
        !allowedKinds.has(rec.kind)
      ) {
        return null;
      }
      if (rec.kind === 'object' && isSystemInfrastructureObject(rec)) {
        return null;
      }
      seenKeys.add(key);
      refsToMove.push(ref);
      return rec;
    };

    await addRefIfResidentOnFromNode(block, new Set(['block']));

    if (includeCodeArtifactClosure && isObjectRef(blockRecord.code)) {
      await this.#collectCodeArtifactDependencyClosureOnNode(
        source.backend,
        blockRecord.code,
        addRefIfResidentOnFromNode,
      );
    } else if (includeCodeArtifact && isObjectRef(blockRecord.code)) {
      await addRefIfResidentOnFromNode(blockRecord.code, new Set(['code-artifact']));
    }

    let envRef = blockRecord.environment ?? null;
    let depth = 0;
    while (isObjectRef(envRef) && depth < 16) {
      depth += 1;
      const envRec = await addRefIfResidentOnFromNode(envRef, new Set(['lexical-environment']));
      if (!envRec) break;
      if (includeCapturedObjects) {
        for (const binding of Object.values(envRec.bindings ?? {})) {
          if (!binding || binding.value === undefined) continue;
          for (const candidateRef of referencesOfValue(binding.value)) {
            await addRefIfResidentOnFromNode(candidateRef, new Set(['object']));
          }
        }
      }
      envRef = envRec.parent ?? null;
    }

    const receipts = await this.relocateRecords({
      refs: refsToMove,
      fromNode,
      toNode,
      idempotent: idempotencyKey !== null,
    });
    const receipt = Object.freeze({
      block,
      fromNode,
      toNode,
      relocatedRefs: Object.freeze(refsToMove),
      receipts,
      replayed: false,
    });
    return this.#recordIdempotency(idempotencyKey, signature, receipt);
  }

  async relocateWasmArtifactClosure({
    target,
    fromNode,
    toNode,
    includeCapturedObjects = false,
    idempotencyKey = null,
  } = {}) {
    if (!isObjectRef(target)) {
      throw new TypeError('relocateWasmArtifactClosure requires an ObjectRef target (Block or CodeArtifact)');
    }
    assertNodeId(fromNode, 'fromNode');
    assertNodeId(toNode, 'toNode');
    if (fromNode === toNode) {
      throw new TypeError('relocateWasmArtifactClosure requires distinct fromNode and toNode');
    }
    const signature = JSON.stringify({
      op: 'relocateWasmArtifactClosure',
      target,
      fromNode,
      toNode,
      includeCapturedObjects,
    });
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return replayed;

    const source = this.#nodes.get(fromNode);
    if (!source) throw new TypeError(`unknown source node: ${fromNode}`);
    const rootRec = await source.backend.get(records(target.imageId), target.objectId);
    if (!rootRec || rootRec.kind === RELOCATED_RECORD_KIND || rootRec.kind === SWEPT_RECORD_KIND) {
      throw new TypeError(`WASM target not resident on ${fromNode}: ${target.imageId}/${target.objectId}`);
    }

    if (rootRec.kind === 'block') {
      const moved = await this.relocateBlockClosure({
        block: target,
        fromNode,
        toNode,
        includeCodeArtifact: true,
        includeCodeArtifactClosure: true,
        includeCapturedObjects,
      });
      const receipt = Object.freeze({
        format: WASM_PLACEMENT_RECEIPT_V1,
        target,
        targetKind: 'block',
        fromNode,
        toNode,
        relocatedRefs: moved.relocatedRefs,
        receipts: moved.receipts,
        replayed: false,
      });
      return this.#recordIdempotency(idempotencyKey, signature, receipt);
    }

    if (rootRec.kind !== 'code-artifact') {
      throw new TypeError(
        `relocateWasmArtifactClosure requires a block or code-artifact record, got ${rootRec.kind}`,
      );
    }

    const refsToMove = [];
    const seenKeys = new Set();
    const addRefIfResidentOnFromNode = async (ref, allowedKinds) => {
      if (!isObjectRef(ref)) return null;
      const key = `${ref.imageId}\0${ref.objectId}`;
      if (seenKeys.has(key)) return null;
      const rec = await source.backend.get(records(ref.imageId), ref.objectId);
      if (
        !rec ||
        rec.kind === RELOCATED_RECORD_KIND ||
        rec.kind === SWEPT_RECORD_KIND ||
        !allowedKinds.has(rec.kind)
      ) {
        return null;
      }
      seenKeys.add(key);
      refsToMove.push(ref);
      return rec;
    };

    await this.#collectCodeArtifactDependencyClosureOnNode(
      source.backend,
      target,
      addRefIfResidentOnFromNode,
    );

    const receipts = await this.relocateRecords({
      refs: refsToMove,
      fromNode,
      toNode,
      idempotent: idempotencyKey !== null,
    });
    const receipt = Object.freeze({
      format: WASM_PLACEMENT_RECEIPT_V1,
      target,
      targetKind: 'code-artifact',
      fromNode,
      toNode,
      relocatedRefs: Object.freeze(refsToMove),
      receipts,
      replayed: false,
    });
    return this.#recordIdempotency(idempotencyKey, signature, receipt);
  }

  async reconcileForeignRuntimePlacement({
    definitionOrBlock,
    preferredNode = null,
    idempotencyKey = null,
  } = {}) {
    if (!isObjectRef(definitionOrBlock)) {
      throw new TypeError('reconcileForeignRuntimePlacement requires an ObjectRef definitionOrBlock');
    }
    if (preferredNode !== null) assertNodeId(preferredNode, 'preferredNode');
    const signature = JSON.stringify({
      op: 'reconcileForeignRuntimePlacement',
      definitionOrBlock,
      preferredNode,
    });
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return replayed;

    const rootMatch = await this.#readLiveRecord(definitionOrBlock);
    if (!rootMatch) {
      throw new TypeError(
        `foreign runtime target not found on any registered node: ${definitionOrBlock.imageId}/${definitionOrBlock.objectId}`,
      );
    }

    const closureEntries = [];
    const seenKeys = new Set();
    const visitRef = async (ref) => {
      if (!isObjectRef(ref)) return null;
      const key = `${ref.imageId}\0${ref.objectId}`;
      if (seenKeys.has(key)) {
        return closureEntries.find((e) => `${e.ref.imageId}\0${e.ref.objectId}` === key) ?? null;
      }
      const match = await this.#readLiveRecord(ref);
      if (!match) return null;
      seenKeys.add(key);
      const entry = {ref, nodeId: match.nodeId, record: match.record};
      closureEntries.push(entry);

      if (match.record.kind === 'block') {
        if (isObjectRef(match.record.code)) await visitRef(match.record.code);
        if (isObjectRef(match.record.environment)) await visitRef(match.record.environment);
      } else if (match.record.kind === 'lexical-environment') {
        if (isObjectRef(match.record.parent)) await visitRef(match.record.parent);
      } else if (match.record.kind === 'code-artifact') {
        for (const dep of match.record.dependencies ?? []) {
          if (isObjectRef(dep?.artifact)) {
            // eslint-disable-next-line no-await-in-loop
            await visitRef(dep.artifact);
          }
        }
      }
      return entry;
    };

    const rootEntry = await visitRef(definitionOrBlock);
    let definitionEntry = null;
    if (rootEntry.record.kind === 'code-artifact') {
      const runtimeDefDep = (rootEntry.record.dependencies ?? []).find(
        (d) => d?.role === 'runtime-definition' && isObjectRef(d?.artifact),
      );
      if (runtimeDefDep) {
        definitionEntry = await visitRef(runtimeDefDep.artifact);
      } else {
        definitionEntry = rootEntry;
      }
    } else if (rootEntry.record.kind === 'block' && isObjectRef(rootEntry.record.code)) {
      const codeEntry = await visitRef(rootEntry.record.code);
      const runtimeDefDep = (codeEntry?.record?.dependencies ?? []).find(
        (d) => d?.role === 'runtime-definition' && isObjectRef(d?.artifact),
      );
      definitionEntry = runtimeDefDep ? await visitRef(runtimeDefDep.artifact) : codeEntry;
    }

    if (!definitionEntry || definitionEntry.record.kind !== 'code-artifact') {
      throw new TypeError(
        `unable to resolve foreign runtime definition CodeArtifact from ${definitionOrBlock.imageId}/${definitionOrBlock.objectId}`,
      );
    }

    const representation = definitionEntry.record.representation;
    let resolvedProviderId = null;
    const capableNodes = [];
    for (const [nodeId, nodeInfo] of this.#nodes.entries()) {
      const bindings = nodeInfo.runtime?.foreignRuntimeDefinitionBindings;
      const providers = nodeInfo.runtime?.foreignRuntimeProviders;
      if (bindings && typeof bindings.has === 'function' && bindings.has(representation)) {
        const pid = bindings.get(representation);
        if (!providers || typeof providers.has !== 'function' || providers.has(pid)) {
          capableNodes.push(nodeId);
          if (resolvedProviderId === null) resolvedProviderId = pid;
        }
      }
    }

    let selectedNode;
    if (preferredNode !== null) {
      if (capableNodes.length > 0 && !capableNodes.includes(preferredNode)) {
        throw new TypeError(
          `preferredNode ${preferredNode} does not have a registered provider for ${representation}`,
        );
      }
      selectedNode = preferredNode;
    } else if (capableNodes.length > 0) {
      selectedNode = capableNodes.includes(definitionEntry.nodeId)
        ? definitionEntry.nodeId
        : capableNodes[0];
    } else {
      selectedNode = definitionEntry.nodeId;
    }

    const relocatedRefs = [];
    const receipts = [];
    for (const entry of closureEntries) {
      if (entry.nodeId === selectedNode) continue;
      if (entry.record.kind === 'object' && isSystemInfrastructureObject(entry.record)) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await this.relocateRecord({
        ref: entry.ref,
        fromNode: entry.nodeId,
        toNode: selectedNode,
        idempotent: true,
      });
      relocatedRefs.push(entry.ref);
      receipts.push(r);
    }

    const receipt = Object.freeze({
      format: FOREIGN_RUNTIME_PLACEMENT_RECEIPT_V1,
      definitionRef: definitionEntry.ref,
      representation,
      providerId: resolvedProviderId,
      capableNodes: Object.freeze(capableNodes),
      selectedNode,
      relocatedRefs: Object.freeze(relocatedRefs),
      receipts: Object.freeze(receipts),
      replayed: false,
    });
    return this.#recordIdempotency(idempotencyKey, signature, receipt);
  }

  async reconcileInterruptedRelocations({imageId = null, refs = null} = {}) {
    const candidatePairs = new Map(); // `${imageId}\0${objectId}` -> {imageId, objectId}
    if (Array.isArray(refs) && refs.length > 0) {
      for (const ref of refs) {
        if (!isObjectRef(ref)) {
          throw new TypeError('reconcileInterruptedRelocations refs must be ObjectRefs');
        }
        candidatePairs.set(`${ref.imageId}\0${ref.objectId}`, {
          imageId: ref.imageId,
          objectId: ref.objectId,
        });
      }
    } else {
      const imageIds = new Set();
      if (typeof imageId === 'string' && imageId.length > 0) {
        imageIds.add(imageId);
      } else {
        for (const {backend} of this.#nodes.values()) {
          if (typeof backend.scan === 'function') {
            // eslint-disable-next-line no-await-in-loop
            const imgs = await backend.scan(IMAGE_COLLECTION);
            for (const entry of imgs ?? []) {
              const id = entry?.value?.id ?? entry?.key ?? entry?.id;
              if (id) imageIds.add(id);
            }
          }
        }
      }
      for (const imgId of imageIds) {
        for (const {backend} of this.#nodes.values()) {
          if (typeof backend.scan === 'function') {
            // eslint-disable-next-line no-await-in-loop
            const recs = await backend.scan(records(imgId));
            for (const entry of recs ?? []) {
              const id = entry?.value?.id ?? entry?.key ?? entry?.id;
              if (id) {
                candidatePairs.set(`${imgId}\0${id}`, {
                  imageId: imgId,
                  objectId: id,
                });
              }
            }
          }
        }
      }
    }

    const healed = [];
    const at = this.clock().toISOString();

    for (const {imageId: imgId, objectId: objId} of candidatePairs.values()) {
      const liveHolders = [];
      for (const [nodeId, {backend}] of this.#nodes.entries()) {
        // eslint-disable-next-line no-await-in-loop
        const rec = await backend.get(records(imgId), objId);
        if (rec && rec.kind !== RELOCATED_RECORD_KIND && rec.kind !== SWEPT_RECORD_KIND) {
          liveHolders.push({nodeId, backend, record: rec});
        }
      }
      if (liveHolders.length <= 1) continue;

      // Determine authoritative target node vs interrupted source node(s)
      // 1. Check history events for explicit relocatedFrom / relocatedTo provenance
      let chosenTarget = null;
      let chosenFrom = null;
      for (const holder of liveHolders) {
        if (typeof holder.backend.readStream === 'function') {
          // eslint-disable-next-line no-await-in-loop
          const events = await holder.backend.readStream(history(imgId));
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i]?.value ?? events[i];
            const evId = ev?.objectId ?? ev?.blockId ?? ev?.environmentId ?? ev?.artifactId;
            if (evId === objId && ev?.relocatedTo === holder.nodeId && ev?.relocatedFrom) {
              chosenTarget = holder;
              chosenFrom = ev.relocatedFrom;
              break;
            }
          }
        }
        if (chosenTarget) break;
      }

      // 2. Fallback to latest updatedAt timestamp among live holders
      if (!chosenTarget) {
        const sorted = [...liveHolders].sort((a, b) => {
          const tA = a.record.updatedAt ?? '';
          const tB = b.record.updatedAt ?? '';
          return tB.localeCompare(tA) || a.nodeId.localeCompare(b.nodeId);
        });
        chosenTarget = sorted[0];
      }

      const staleHolders = liveHolders.filter((h) => h.nodeId !== chosenTarget.nodeId);
      for (const stale of staleHolders) {
        const tombstone = {
          kind: RELOCATED_RECORD_KIND,
          id: objId,
          imageId: imgId,
          recordKind: stale.record.kind,
          node: chosenTarget.nodeId,
          fromNode: stale.nodeId,
          relocatedAt: at,
        };
        // eslint-disable-next-line no-await-in-loop
        await stale.backend.transaction(async (txCandidate) => {
          const transaction = assertBackendTransaction(txCandidate);
          const savedTombstone = await transaction.put(records(imgId), objId, tombstone, {
            expectedVersion: stale.record._version,
          });
          await transaction.append(history(imgId), {
            type: stale.record.kind === 'object' ? 'object.relocated' : 'record.relocated',
            at,
            objectId: objId,
            recordId: objId,
            recordKind: stale.record.kind,
            fromNode: stale.nodeId,
            toNode: chosenTarget.nodeId,
            relocationVersion: savedTombstone._version,
            reconciledInterruptedRelocation: true,
          });
        });

        const ref = objectRef(imgId, objId);
        for (const locator of this.#locators) {
          locator.invalidate?.(ref);
        }

        healed.push(
          Object.freeze({
            ref,
            recordKind: chosenTarget.record.kind,
            fromNode: chosenFrom ?? stale.nodeId,
            toNode: chosenTarget.nodeId,
            targetVersion: chosenTarget.record._version,
          }),
        );
      }
    }

    return Object.freeze({
      format: PLACEMENT_RECOVERY_REPORT_V1,
      healedCount: healed.length,
      healed: Object.freeze(healed),
    });
  }

  async inspectResidency(ref) {
    if (!isObjectRef(ref)) throw new TypeError('placement policy requires an ObjectRef');
    const match = await this.#readLiveRecord(ref);
    if (!match) return null;
    const {nodeId, backend, record} = match;
    const hasLocalImage = Boolean(await backend.get(IMAGE_COLLECTION, ref.imageId));
    return Object.freeze({
      imageId: ref.imageId,
      objectId: ref.objectId,
      node: nodeId,
      kind: hasLocalImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
      version: record._version,
    });
  }

  async #relocateRecordInternal({
    ref,
    fromNode,
    toNode,
    requireObjectOnly,
    idempotencyKey = null,
    idempotent = false,
  }) {
    if (!isObjectRef(ref)) {
      throw new TypeError(`${requireObjectOnly ? 'relocateObject' : 'relocateRecord'} requires an ObjectRef`);
    }
    assertNodeId(fromNode, 'fromNode');
    assertNodeId(toNode, 'toNode');
    if (fromNode === toNode) {
      throw new TypeError(
        `${requireObjectOnly ? 'relocateObject' : 'relocateRecord'} requires distinct fromNode and toNode`,
      );
    }
    const signature = JSON.stringify({
      op: requireObjectOnly ? 'relocateObject' : 'relocateRecord',
      ref,
      fromNode,
      toNode,
    });
    const replayed = this.#checkIdempotency(idempotencyKey, signature);
    if (replayed) return replayed;

    const source = this.#nodes.get(fromNode);
    if (!source) throw new TypeError(`unknown source node: ${fromNode}`);
    const target = this.#nodes.get(toNode);
    if (!target) throw new TypeError(`unknown target node: ${toNode}`);

    const current = await source.backend.get(records(ref.imageId), ref.objectId);
    const existingTarget = await target.backend.get(records(ref.imageId), ref.objectId);

    // Durable idempotent convergence: if source already holds a relocated marker pointing to toNode
    // and toNode holds the live record, converge when idempotent / idempotencyKey is enabled.
    if (
      (idempotent || idempotencyKey !== null) &&
      current?.kind === RELOCATED_RECORD_KIND &&
      current.node === toNode &&
      existingTarget &&
      existingTarget.kind !== RELOCATED_RECORD_KIND &&
      existingTarget.kind !== SWEPT_RECORD_KIND
    ) {
      const targetHasImage = Boolean(await target.backend.get(IMAGE_COLLECTION, ref.imageId));
      const convergedReceipt = Object.freeze({
        ref,
        recordKind: existingTarget.kind,
        fromNode,
        toNode,
        version: existingTarget._version,
        residencyKind: targetHasImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
        replayed: true,
      });
      return this.#recordIdempotency(idempotencyKey, signature, convergedReceipt);
    }

    if (!current || current.kind === RELOCATED_RECORD_KIND || current.kind === SWEPT_RECORD_KIND) {
      throw new TypeError(`object not resident on ${fromNode}: ${ref.imageId}/${ref.objectId}`);
    }
    if (requireObjectOnly && current.kind !== 'object') {
      throw new TypeError(
        `only object records may be relocated: ${ref.imageId}/${ref.objectId} (${current.kind})`,
      );
    }
    if (!RELOCATABLE_RECORD_KINDS.has(current.kind)) {
      throw new TypeError(
        `record kind ${current.kind} cannot be relocated: ${ref.imageId}/${ref.objectId}`,
      );
    }

    if (
      existingTarget &&
      existingTarget.kind !== RELOCATED_RECORD_KIND &&
      existingTarget.kind !== SWEPT_RECORD_KIND
    ) {
      throw new TypeError(`object already resident on ${toNode}: ${ref.imageId}/${ref.objectId}`);
    }

    const at = this.clock().toISOString();
    const candidate = buildRelocatedCandidateRecord(current, at);

    const storedTarget = await target.backend.transaction(async (txCandidate) => {
      const transaction = assertBackendTransaction(txCandidate);
      const saved = await transaction.put(records(ref.imageId), ref.objectId, candidate, {
        expectedVersion: existingTarget ? existingTarget._version : 0,
      });
      await transaction.append(
        history(ref.imageId),
        buildTargetPutHistoryEvent(saved, at, {fromNode, toNode}),
      );
      return saved;
    });

    const tombstone = {
      kind: RELOCATED_RECORD_KIND,
      id: ref.objectId,
      imageId: ref.imageId,
      recordKind: current.kind,
      node: toNode,
      fromNode,
      relocatedAt: at,
    };

    await source.backend.transaction(async (txCandidate) => {
      const transaction = assertBackendTransaction(txCandidate);
      const savedTombstone = await transaction.put(records(ref.imageId), ref.objectId, tombstone, {
        expectedVersion: current._version,
      });
      await transaction.append(history(ref.imageId), {
        type: current.kind === 'object' ? 'object.relocated' : 'record.relocated',
        at,
        objectId: ref.objectId,
        recordId: ref.objectId,
        recordKind: current.kind,
        fromNode,
        toNode,
        relocationVersion: savedTombstone._version,
      });
    });

    for (const [nodeId, {backend}] of this.#nodes.entries()) {
      if (nodeId === fromNode || nodeId === toNode) continue;
      const otherRecord = await backend.get(records(ref.imageId), ref.objectId);
      if (otherRecord?.kind === RELOCATED_RECORD_KIND && otherRecord.node !== toNode) {
        await backend.transaction(async (txCandidate) => {
          const transaction = assertBackendTransaction(txCandidate);
          await transaction.put(
            records(ref.imageId),
            ref.objectId,
            {...otherRecord, node: toNode, relocatedAt: at, _version: undefined},
            {expectedVersion: otherRecord._version},
          );
        });
      }
    }

    for (const locator of this.#locators) {
      locator.invalidate?.(ref);
    }

    const targetHasImage = Boolean(await target.backend.get(IMAGE_COLLECTION, ref.imageId));
    const receipt = Object.freeze({
      ref,
      recordKind: current.kind,
      fromNode,
      toNode,
      version: storedTarget._version,
      residencyKind: targetHasImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
      replayed: false,
    });
    return this.#recordIdempotency(idempotencyKey, signature, receipt);
  }

  async relocateObject({ref, fromNode, toNode, idempotencyKey = null, idempotent = false} = {}) {
    return await this.#relocateRecordInternal({
      ref,
      fromNode,
      toNode,
      requireObjectOnly: true,
      idempotencyKey,
      idempotent,
    });
  }

  async relocateRecord({ref, fromNode, toNode, idempotencyKey = null, idempotent = false} = {}) {
    return await this.#relocateRecordInternal({
      ref,
      fromNode,
      toNode,
      requireObjectOnly: false,
      idempotencyKey,
      idempotent,
    });
  }
}

export {
  FOREIGN_RUNTIME_PLACEMENT_RECEIPT_V1,
  PLACEMENT_RECOVERY_REPORT_V1,
  PlacementIdempotencyConflictError,
  PlacementPolicy,
  WASM_PLACEMENT_RECEIPT_V1,
};
