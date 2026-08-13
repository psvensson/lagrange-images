import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {DispatchRegistry, normalizeLanguageId} from './registry.js';

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeObjectRef(value, label) {
  const normalized = canonicalizeValue(value);
  if (!isObjectRef(normalized)) throw new TypeError(`${label} must be an unpinned object ref`);
  return normalized;
}

function normalizeArguments(values) {
  if (!Array.isArray(values)) throw new TypeError('arguments must be an array');
  return Object.freeze(values.map((value) => canonicalizeValue(value)));
}

function createMessageSendRequest({languageId, receiver, message, arguments: args = []}) {
  return Object.freeze({
    kind: 'message-send',
    languageId: normalizeLanguageId(languageId),
    receiver: canonicalizeValue(receiver),
    message: canonicalizeValue(message),
    arguments: normalizeArguments(args),
  });
}

function normalizeDispatchResolution(resolution) {
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
    throw new TypeError('message dispatcher must return a resolution object');
  }
  if (!sameKeys(resolution, ['block'])) {
    throw new TypeError('message dispatcher resolution must contain exactly block');
  }
  return Object.freeze({
    block: normalizeObjectRef(resolution.block, 'message dispatcher block'),
  });
}

function normalizeDispatchInfo(dispatch) {
  if (dispatch === null) return null;
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    throw new TypeError('dispatch info must be an object or null');
  }
  if (!sameKeys(dispatch, ['languageId', 'message'])) {
    throw new TypeError('dispatch info must contain exactly languageId and message');
  }
  return Object.freeze({
    languageId: normalizeLanguageId(dispatch.languageId),
    message: canonicalizeValue(dispatch.message),
  });
}

function assertImageService(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getBlock', 'getCodeArtifact', 'getLexicalEnvironment']) {
    if (typeof images[method] !== 'function') {
      throw new TypeError(`images service must implement ${method}`);
    }
  }
  return images;
}

class InvocationService {
  constructor({images, dispatchers = new DispatchRegistry()} = {}) {
    this.images = assertImageService(images);
    if (!dispatchers || typeof dispatchers.get !== 'function') {
      throw new TypeError('dispatchers must be a DispatchRegistry-compatible object');
    }
    this.dispatchers = dispatchers;
  }

  async invokeBlock(blockRef, args = []) {
    return await this.prepareActivation({
      block: blockRef,
      arguments: args,
      receiver: null,
      dispatch: null,
    });
  }

  async sendMessage(input) {
    const request = createMessageSendRequest(input);
    const dispatcher = this.dispatchers.get(request.languageId);
    const resolution = normalizeDispatchResolution(
      await dispatcher.resolveMessage(request, {images: this.images}),
    );

    return await this.prepareActivation({
      block: resolution.block,
      arguments: request.arguments,
      receiver: request.receiver,
      dispatch: {
        languageId: request.languageId,
        message: request.message,
      },
    });
  }

  async prepareActivation({block, arguments: args = [], receiver = null, dispatch = null}) {
    const blockRef = normalizeObjectRef(block, 'activation block');
    const normalizedArguments = normalizeArguments(args);
    const normalizedReceiver = receiver === null ? null : canonicalizeValue(receiver);
    const normalizedDispatch = normalizeDispatchInfo(dispatch);

    const blockRecord = await this.images.getBlock(blockRef.imageId, blockRef.objectId);
    if (!blockRecord) {
      throw new TypeError(`activation block not found: ${blockRef.imageId}/${blockRef.objectId}`);
    }

    const code = await this.images.getCodeArtifact(blockRecord.code.imageId, blockRecord.code.objectId);
    if (!code) {
      throw new TypeError(`activation code artifact not found: ${blockRecord.code.imageId}/${blockRecord.code.objectId}`);
    }

    if (blockRecord.environment) {
      const environment = await this.images.getLexicalEnvironment(
        blockRecord.environment.imageId,
        blockRecord.environment.objectId,
      );
      if (!environment) {
        throw new TypeError(
          `activation lexical environment not found: ${blockRecord.environment.imageId}/${blockRecord.environment.objectId}`,
        );
      }
    }

    return Object.freeze({
      kind: 'activation-request',
      block: blockRef,
      code: blockRecord.code,
      environment: blockRecord.environment,
      receiver: normalizedReceiver,
      arguments: normalizedArguments,
      dispatch: normalizedDispatch,
    });
  }
}

export {
  InvocationService,
  createMessageSendRequest,
  normalizeDispatchResolution,
};
export {
  DispatchNotFoundError,
  DispatchRegistrationError,
  DispatchRegistry,
} from './registry.js';
