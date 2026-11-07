import {assertBackend, assertBackendTransaction} from '../backend/backend-contract.js';
import {IMAGE_COLLECTION, history, records} from '../image/storage-layout.js';
import {referencesOfValue} from '../value/index.js';
import {isObjectRef, textValue} from '../value/scalars.js';
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

function buildTargetPutHistoryEvent(saved, at) {
  switch (saved.kind) {
    case 'object':
      return {
        type: 'object.put',
        at,
        objectId: saved.id,
        objectVersion: saved._version,
        object: structuredClone(saved),
      };
    case 'block':
      return {
        type: 'block.put',
        at,
        blockId: saved.id,
        blockVersion: saved._version,
        block: structuredClone(saved),
      };
    case 'lexical-environment':
      return {
        type: 'lexical-environment.put',
        at,
        environmentId: saved.id,
        environmentVersion: saved._version,
        environment: structuredClone(saved),
      };
    case 'code-artifact':
      return {
        type: 'code-artifact.put',
        at,
        artifactId: saved.id,
        artifactVersion: saved._version,
        artifact: structuredClone(saved),
      };
    default:
      throw new TypeError(`unsupported record kind for history event: ${saved.kind}`);
  }
}

class PlacementPolicy {
  #nodes = new Map();
  #locators = new Set();

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

  async dispatchSend({
    fromNode = null,
    receiver,
    message,
    arguments: args = [],
    languageId = 'symmetric-smalltalk',
    dispatchImage = undefined,
  } = {}) {
    if (!isObjectRef(receiver)) throw new TypeError('dispatchSend requires an ObjectRef receiver');
    if (fromNode !== null) assertNodeId(fromNode, 'fromNode');
    const targetNodeId = await this.selectExecutionNode(receiver);
    const target = this.#nodes.get(targetNodeId);
    if (!target?.runtime) {
      throw new TypeError(`node ${targetNodeId} has no registered execution runtime`);
    }
    const selectorValue = typeof message === 'string' ? textValue(message) : message;
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
    return Object.freeze({
      node: targetNodeId,
      fromNode,
      routedRemotely: fromNode !== null && fromNode !== targetNodeId,
      value,
    });
  }

  async dispatchApply({
    fromNode = null,
    block,
    arguments: args = [],
    targetObject = null,
  } = {}) {
    if (!isObjectRef(block)) throw new TypeError('dispatchApply requires an ObjectRef block');
    if (fromNode !== null) assertNodeId(fromNode, 'fromNode');
    if (!Array.isArray(args)) {
      throw new TypeError('dispatchApply arguments must be an array');
    }
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
    return Object.freeze({
      node: targetNodeId,
      fromNode,
      routedRemotely: fromNode !== null && fromNode !== targetNodeId,
      value,
    });
  }

  async relocateObjects({refs, fromNode, toNode} = {}) {
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new TypeError('relocateObjects requires a non-empty array of ObjectRefs');
    }
    const receipts = [];
    for (const ref of refs) {
      receipts.push(await this.relocateObject({ref, fromNode, toNode}));
    }
    return Object.freeze(receipts);
  }

  async relocateRecords({refs, fromNode, toNode} = {}) {
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new TypeError('relocateRecords requires a non-empty array of ObjectRefs');
    }
    const receipts = [];
    for (const ref of refs) {
      receipts.push(await this.relocateRecord({ref, fromNode, toNode}));
    }
    return Object.freeze(receipts);
  }

  async relocateBlockClosure({
    block,
    fromNode,
    toNode,
    includeCodeArtifact = false,
    includeCapturedObjects = false,
  } = {}) {
    if (!isObjectRef(block)) {
      throw new TypeError('relocateBlockClosure requires an ObjectRef block');
    }
    assertNodeId(fromNode, 'fromNode');
    assertNodeId(toNode, 'toNode');
    if (fromNode === toNode) {
      throw new TypeError('relocateBlockClosure requires distinct fromNode and toNode');
    }

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

    if (includeCodeArtifact && isObjectRef(blockRecord.code)) {
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
    });
    return Object.freeze({
      block,
      fromNode,
      toNode,
      relocatedRefs: Object.freeze(refsToMove),
      receipts,
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

  async #relocateRecordInternal({ref, fromNode, toNode, requireObjectOnly}) {
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
    const source = this.#nodes.get(fromNode);
    if (!source) throw new TypeError(`unknown source node: ${fromNode}`);
    const target = this.#nodes.get(toNode);
    if (!target) throw new TypeError(`unknown target node: ${toNode}`);

    const current = await source.backend.get(records(ref.imageId), ref.objectId);
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

    const existingTarget = await target.backend.get(records(ref.imageId), ref.objectId);
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
      await transaction.append(history(ref.imageId), buildTargetPutHistoryEvent(saved, at));
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
    return Object.freeze({
      ref,
      recordKind: current.kind,
      fromNode,
      toNode,
      version: storedTarget._version,
      residencyKind: targetHasImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
    });
  }

  async relocateObject({ref, fromNode, toNode} = {}) {
    return await this.#relocateRecordInternal({
      ref,
      fromNode,
      toNode,
      requireObjectOnly: true,
    });
  }

  async relocateRecord({ref, fromNode, toNode} = {}) {
    return await this.#relocateRecordInternal({
      ref,
      fromNode,
      toNode,
      requireObjectOnly: false,
    });
  }
}

export {PlacementPolicy};
