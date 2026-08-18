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

// ADR 0045 decision 7. A resolution names the Block to activate and, optionally, the object that
// should actually receive it. The key is absent for every send in the substrate today; a language
// personality uses it when the thing a message was sent to and the thing that runs the method are
// deliberately different — as a Symmetric Smalltalk boolean Value and its `true`/`false` singleton
// are.
//
// An unpinned object ref, and nothing else. The purpose is to nominate an *object* as the effective
// receiver; permitting an immediate Value would let a personality substitute one Value for another
// with nothing to detect it. Relaxing this later is easy, and discovering it after the fact is not.
function normalizeDispatchResolution(resolution) {
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
    throw new TypeError('message dispatcher must return a resolution object');
  }
  const optional = ['effectiveReceiver', 'frame', 'inheritsFrame'];
  const extra = Object.keys(resolution).filter((key) => key !== 'block' && !optional.includes(key));
  if (!Object.hasOwn(resolution, 'block') || extra.length > 0) {
    throw new TypeError(
      `message dispatcher resolution must contain block, and may contain ${optional.join(', ')}`,
    );
  }
  const block = normalizeObjectRef(resolution.block, 'message dispatcher block');
  const frame = normalizeInvocationFrame(resolution);
  if (!Object.hasOwn(resolution, 'effectiveReceiver')) {
    return Object.freeze({block, effectiveReceiver: null, ...frame});
  }
  // Present but empty is a caller mistake, not a second way to spell the default: absence is the
  // only way to say "the original receiver".
  if (resolution.effectiveReceiver === null || resolution.effectiveReceiver === undefined) {
    throw new TypeError(
      'message dispatcher effectiveReceiver must be an unpinned object ref; '
      + 'omit the key to keep the original receiver',
    );
  }
  return Object.freeze({
    block,
    effectiveReceiver: normalizeObjectRef(resolution.effectiveReceiver, 'message dispatcher effectiveReceiver'),
    ...frame,
  });
}

// ADR 0050 decision 5b. The trusted facts of one dispatch, kept out of the activation record on
// purpose: a permission fact does not belong in the closed model ADR 0005 defined and every executor
// consumes. `inheritsFrame` is the language saying "this callee is my own host operation", which is
// the only case that may borrow the invoker's frame.
function normalizeInvocationFrame(resolution) {
  if (Object.hasOwn(resolution, 'inheritsFrame')) {
    if (resolution.inheritsFrame !== true) throw new TypeError('message dispatcher inheritsFrame must be true when present');
    if (Object.hasOwn(resolution, 'frame')) throw new TypeError('a resolution may inherit a frame or supply one, not both');
    return {inheritsFrame: true};
  }
  if (!Object.hasOwn(resolution, 'frame')) return {};
  const {frame} = resolution;
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !sameKeys(frame, ['self', 'definingBehavior'])) {
    throw new TypeError('message dispatcher frame must contain exactly self and definingBehavior');
  }
  return {
    frame: Object.freeze({
      self: canonicalizeValue(frame.self),
      definingBehavior: normalizeObjectRef(frame.definingBehavior, 'message dispatcher frame definingBehavior'),
    }),
  };
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

  // `dispatchImage` is execution context, exactly as depth and authority are: it never appears on
  // the request, on a Value, or in the durable graph. An immediate receiver carries no image, so
  // this is what says which kernel's Integer applies (ADR 0044 decision 5a).
  // The activation alone, for every caller that does not need the envelope. Kept as the ordinary
  // entry point so nothing outside the execution layer has to know a frame exists.
  async sendMessage(input, options = {}) {
    return (await this.prepareDispatch(input, options)).activation;
  }

  // ADR 0050 decision 5b: the activation request *and* the transient envelope beside it. Built here,
  // from the normalized resolution, so nothing a guest supplied can reach it — a message-send request
  // validates exact keys and the envelope is not one of them. `invokeBlock` produces none, so a
  // directly invoked Block has no frame at all.
  async prepareDispatch(input, {dispatchImage = null} = {}) {
    const request = createMessageSendRequest(input);
    const dispatcher = this.dispatchers.get(request.languageId);
    const resolution = normalizeDispatchResolution(
      await dispatcher.resolveMessage(request, {images: this.images, dispatchImage}),
    );

    const activation = await this.prepareActivation({
      block: resolution.block,
      arguments: request.arguments,
      // The effective receiver is what the method's `self` is. It is transient in exactly the way
      // the dispatch image is: it reaches the activation and nothing else — no request field, no
      // Value, no durable record.
      receiver: resolution.effectiveReceiver ?? request.receiver,
      dispatch: {
        languageId: request.languageId,
        message: request.message,
      },
    });
    return Object.freeze({
      activation,
      frame: resolution.frame ?? null,
      inheritsFrame: resolution.inheritsFrame === true,
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
