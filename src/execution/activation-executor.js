import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {CodeExecutorRegistry} from './executor-registry.js';

const MAX_ACTIVATION_DEPTH = 256;

function normalizeObjectRef(value, label) {
  const normalized = canonicalizeValue(value);
  if (!isObjectRef(normalized)) throw new TypeError(`${label} must be an unpinned object ref`);
  return normalized;
}

function sameRef(left, right) {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.imageId === right.imageId && left.objectId === right.objectId;
}

function assertActivationRequest(activation) {
  if (!activation || typeof activation !== 'object' || activation.kind !== 'activation-request') {
    throw new TypeError('activation must be an activation-request');
  }
  normalizeObjectRef(activation.block, 'activation block');
  normalizeObjectRef(activation.code, 'activation code');
  if (activation.environment !== null) normalizeObjectRef(activation.environment, 'activation environment');
  if (activation.receiver !== null) canonicalizeValue(activation.receiver);
  if (!Array.isArray(activation.arguments)) throw new TypeError('activation arguments must be an array');
  activation.arguments.forEach((value) => canonicalizeValue(value));
  return activation;
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getBlock', 'getCodeArtifact', 'getLexicalEnvironment']) {
    if (typeof images[method] !== 'function') throw new TypeError(`images service must implement ${method}`);
  }
  return images;
}

function assertInvocations(invocations) {
  if (invocations === null) return null;
  if (!invocations || typeof invocations.sendMessage !== 'function') {
    throw new TypeError('invocations must implement sendMessage or be null');
  }
  return invocations;
}

class ActivationExecutor {
  constructor({images, executors = new CodeExecutorRegistry(), invocations = null} = {}) {
    this.images = assertImages(images);
    if (!executors || typeof executors.get !== 'function') {
      throw new TypeError('executors must be a CodeExecutorRegistry-compatible object');
    }
    this.executors = executors;
    this.invocations = assertInvocations(invocations);
  }

  async lookupBinding(environmentRef, bindingId) {
    if (typeof bindingId !== 'string' || bindingId.length === 0) {
      throw new TypeError('binding id must be a non-empty string');
    }
    let currentRef = environmentRef;
    const visited = new Set();
    while (currentRef) {
      const ref = normalizeObjectRef(currentRef, 'lexical environment');
      const key = `${ref.imageId}\u0000${ref.objectId}`;
      if (visited.has(key)) throw new TypeError('lexical environment parent cycle detected');
      visited.add(key);

      const environment = await this.images.getLexicalEnvironment(ref.imageId, ref.objectId);
      if (!environment) {
        throw new TypeError(`lexical environment not found: ${ref.imageId}/${ref.objectId}`);
      }
      if (Object.hasOwn(environment.bindings, bindingId)) {
        return canonicalizeValue(environment.bindings[bindingId].value);
      }
      currentRef = environment.parent;
    }
    throw new TypeError(`lexical binding not found: ${bindingId}`);
  }

  async execute(activation, {depth = 0} = {}) {
    if (!Number.isInteger(depth) || depth < 0) throw new TypeError('activation depth must be a non-negative integer');
    if (depth > MAX_ACTIVATION_DEPTH) throw new TypeError('activation depth limit exceeded');
    assertActivationRequest(activation);

    const block = await this.images.getBlock(activation.block.imageId, activation.block.objectId);
    if (!block) throw new TypeError(`activation block not found: ${activation.block.imageId}/${activation.block.objectId}`);
    if (!sameRef(block.code, activation.code)) throw new TypeError('activation code does not match Block code');
    if (!sameRef(block.environment, activation.environment)) {
      throw new TypeError('activation environment does not match Block environment');
    }

    const code = await this.images.getCodeArtifact(activation.code.imageId, activation.code.objectId);
    if (!code) throw new TypeError(`activation code artifact not found: ${activation.code.imageId}/${activation.code.objectId}`);

    const executor = this.executors.get(code.representation);
    const result = await executor.execute(
      {activation, code},
      {
        images: this.images,
        lookupBinding: async (bindingId) => {
          if (!activation.environment) throw new TypeError(`lexical binding not found: ${bindingId}`);
          return await this.lookupBinding(activation.environment, bindingId);
        },
        sendMessage: async (request) => {
          if (!this.invocations) throw new TypeError('activation executor has no message runtime');
          if (depth >= MAX_ACTIVATION_DEPTH) throw new TypeError('activation depth limit exceeded');
          const nested = await this.invocations.sendMessage(request);
          return await this.execute(nested, {depth: depth + 1});
        },
      },
    );
    return canonicalizeValue(result);
  }
}

export {
  ActivationExecutor,
  MAX_ACTIVATION_DEPTH,
  assertActivationRequest,
};
