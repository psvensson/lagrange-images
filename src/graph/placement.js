import {assertBackend, assertBackendTransaction} from '../backend/backend-contract.js';
import {IMAGE_COLLECTION, history, records} from '../image/storage-layout.js';
import {isObjectRef} from '../value/scalars.js';
import {PER_OBJECT_RESIDENCY, RELOCATED_RECORD_KIND, WHOLE_IMAGE_RESIDENCY} from './locator.js';

function assertNodeId(nodeId, label = 'nodeId') {
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return nodeId;
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
    if (locator) {
      this.registerLocator(locator);
    }
    for (const [existingId, existing] of this.#nodes.entries()) {
      if (existingId === nodeId) continue;
      existing.locator?.registerPeer?.(nodeId, backend);
      locator?.registerPeer?.(existingId, existing.backend);
    }
    this.#nodes.set(nodeId, {nodeId, backend, locator});
    return this;
  }

  async inspectResidency(ref) {
    if (!isObjectRef(ref)) throw new TypeError('placement policy requires an ObjectRef');
    const liveMatches = [];
    for (const [nodeId, {backend}] of this.#nodes.entries()) {
      const record = await backend.get(records(ref.imageId), ref.objectId);
      if (record && record.kind !== RELOCATED_RECORD_KIND) {
        liveMatches.push({nodeId, backend, record});
      }
    }
    if (liveMatches.length > 1) {
      const holders = liveMatches.map(({nodeId}) => nodeId).join(', ');
      throw new TypeError(
        `duplicate live object records for ${ref.imageId}/${ref.objectId} across nodes: ${holders}`,
      );
    }
    if (liveMatches.length === 0) return null;
    const {nodeId, backend, record} = liveMatches[0];
    const hasLocalImage = Boolean(await backend.get(IMAGE_COLLECTION, ref.imageId));
    return Object.freeze({
      imageId: ref.imageId,
      objectId: ref.objectId,
      node: nodeId,
      kind: hasLocalImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
      version: record._version,
    });
  }

  async relocateObject({ref, fromNode, toNode} = {}) {
    if (!isObjectRef(ref)) throw new TypeError('relocateObject requires an ObjectRef');
    assertNodeId(fromNode, 'fromNode');
    assertNodeId(toNode, 'toNode');
    if (fromNode === toNode) {
      throw new TypeError('relocateObject requires distinct fromNode and toNode');
    }
    const source = this.#nodes.get(fromNode);
    if (!source) throw new TypeError(`unknown source node: ${fromNode}`);
    const target = this.#nodes.get(toNode);
    if (!target) throw new TypeError(`unknown target node: ${toNode}`);

    const current = await source.backend.get(records(ref.imageId), ref.objectId);
    if (!current || current.kind === RELOCATED_RECORD_KIND) {
      throw new TypeError(`object not resident on ${fromNode}: ${ref.imageId}/${ref.objectId}`);
    }
    if (current.kind !== 'object') {
      throw new TypeError(
        `only object records may be relocated: ${ref.imageId}/${ref.objectId} (${current.kind})`,
      );
    }

    const existingTarget = await target.backend.get(records(ref.imageId), ref.objectId);
    if (existingTarget && existingTarget.kind !== RELOCATED_RECORD_KIND) {
      throw new TypeError(`object already resident on ${toNode}: ${ref.imageId}/${ref.objectId}`);
    }

    const at = this.clock().toISOString();
    const candidate = {
      kind: 'object',
      id: current.id,
      imageId: current.imageId,
      shape: structuredClone(current.shape),
      behavior: structuredClone(current.behavior),
      slots: structuredClone(current.slots),
      ...(current.indexed !== undefined ? {indexed: structuredClone(current.indexed)} : {}),
      metadata: structuredClone(current.metadata),
      updatedAt: at,
    };

    const storedTarget = await target.backend.transaction(async (txCandidate) => {
      const transaction = assertBackendTransaction(txCandidate);
      const saved = await transaction.put(records(ref.imageId), ref.objectId, candidate, {
        expectedVersion: existingTarget ? existingTarget._version : 0,
      });
      await transaction.append(history(ref.imageId), {
        type: 'object.put',
        at,
        objectId: saved.id,
        objectVersion: saved._version,
        object: structuredClone(saved),
      });
      return saved;
    });

    const tombstone = {
      kind: RELOCATED_RECORD_KIND,
      id: ref.objectId,
      imageId: ref.imageId,
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
        type: 'object.relocated',
        at,
        objectId: ref.objectId,
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
      fromNode,
      toNode,
      version: storedTarget._version,
      residencyKind: targetHasImage ? WHOLE_IMAGE_RESIDENCY : PER_OBJECT_RESIDENCY,
    });
  }
}

export {PlacementPolicy};
