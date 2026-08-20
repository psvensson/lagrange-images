import {canonicalizeValue, isObjectRef, objectRef} from '../value/index.js';
import {arenaImagesView} from './lexical-cells.js';
import {CodeExecutorRegistry} from './executor-registry.js';
import {
  EscapingMutableClosureError,
  LexicalCellArena,
  MissingLexicalCellError,
  UNBOUND,
  UnboundBindingError,
} from './lexical-cells.js';

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

// ADR 0037 says authority belongs to the individual active call and that its lifetime is the
// invocation lifetime. Without this the executor context outlives the activation: a retained
// `require` keeps authorizing, and a retained `sendMessage` keeps executing, long after
// `execute` returned.
class ExpiredExecutionContextError extends TypeError {
  constructor(operation) {
    super(`${operation} was called after its activation completed; the execution context does not outlive the activation`);
    this.name = 'ExpiredExecutionContextError';
    this.operation = operation;
  }
}

function assertImages(images) {
  if (!images || typeof images !== 'object') throw new TypeError('images service is required');
  for (const method of ['getBlock', 'getCodeArtifact', 'getLexicalEnvironment', 'putLexicalEnvironment', 'putBlock']) {
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
  // `temporaryInitializer` is how a language personality says what a declared temporary starts as,
  // without the execution layer learning what `nil` is. The mechanism lives here — one place,
  // before the lanes diverge — while the policy comes from the language: ADR 0044 wires one that
  // answers the dispatch image's Smalltalk `nil` for Symmetric Smalltalk artifacts, and nothing
  // otherwise, in which case a temporary starts UNBOUND exactly as ADR 0043 decided.
  constructor({
    images,
    executors = new CodeExecutorRegistry(),
    invocations = null,
    authority = null,
    temporaryInitializer = null,
  } = {}) {
    if (temporaryInitializer !== null && typeof temporaryInitializer !== 'function') {
      throw new TypeError('temporaryInitializer must be a function or null');
    }
    this.temporaryInitializer = temporaryInitializer;
    this.images = assertImages(images);
    // The authority *service*, not a context. Per ADR 0037 it is never handed to an executor.
    this.authority = authority;
    if (!executors || typeof executors.get !== 'function') {
      throw new TypeError('executors must be a CodeExecutorRegistry-compatible object');
    }
    this.executors = executors;
    this.invocations = assertInvocations(invocations);
  }

  // The durable record rather than its value, because the three capture dispositions of ADR 0043
  // mean different things and only one of them carries a value at all.
  async lookupBindingRecord(environmentRef, bindingId, images = this.images) {
    if (typeof bindingId !== 'string' || bindingId.length === 0) {
      throw new TypeError('binding id must be a non-empty string');
    }
    let currentRef = environmentRef;
    // Nested by imageId then objectId. Flattening a two-part identity into one string needs a
    // separator that cannot occur inside either part, and object ids are arbitrary non-empty text,
    // so no such separator exists — the same non-injectivity that makes object resources encode
    // each part rather than concatenate them.
    const visited = new Map();
    while (currentRef) {
      const ref = normalizeObjectRef(currentRef, 'lexical environment');
      let visitedObjects = visited.get(ref.imageId);
      if (!visitedObjects) {
        visitedObjects = new Set();
        visited.set(ref.imageId, visitedObjects);
      }
      if (visitedObjects.has(ref.objectId)) throw new TypeError('lexical environment parent cycle detected');
      visitedObjects.add(ref.objectId);

      const environment = await images.getLexicalEnvironment(ref.imageId, ref.objectId);
      if (!environment) {
        throw new TypeError(`lexical environment not found: ${ref.imageId}/${ref.objectId}`);
      }
      if (Object.hasOwn(environment.bindings, bindingId)) return environment.bindings[bindingId];
      currentRef = environment.parent;
    }
    return null;
  }

  async lookupBinding(environmentRef, bindingId, images = this.images) {
    const record = await this.lookupBindingRecord(environmentRef, bindingId, images);
    if (!record) throw new TypeError(`lexical binding not found: ${bindingId}`);
    if (record.cell === true) throw new EscapingMutableClosureError(bindingId, record.name);
    if (record.unbound === true) throw new UnboundBindingError(record.name, bindingId);
    return canonicalizeValue(record.value);
  }

  async createClosure({prototype, captures}, cells = null, arena = null, frame = null) {
    const prototypeRef = normalizeObjectRef(prototype, 'closure prototype');
    if (!Array.isArray(captures)) throw new TypeError('closure captures must be an array');
    const prototypeBlock = await this.images.getBlock(prototypeRef.imageId, prototypeRef.objectId);
    if (!prototypeBlock) {
      throw new TypeError(`closure prototype Block not found: ${prototypeRef.imageId}/${prototypeRef.objectId}`);
    }

    const bindings = {};
    const capturedCells = new Map();
    for (const capture of captures) {
      if (!capture || typeof capture !== 'object' || Array.isArray(capture)) throw new TypeError('closure capture must be an object');
      if (typeof capture.id !== 'string' || capture.id.length === 0) throw new TypeError('closure capture id must be non-empty text');
      if (typeof capture.name !== 'string' || capture.name.length === 0) throw new TypeError('closure capture name must be non-empty text');
      if (Object.hasOwn(bindings, capture.id)) throw new TypeError(`duplicate closure capture id: ${capture.id}`);
      if (capture.mode === 'cell') {
        // The cell of the frame that *declared* the binding, which is what `cells.resolve` walks
        // to — not whichever frame happens to be running. The durable record says only that a
        // cell is required: writing the current contents would hand a later invocation an old
        // value to restart from, which ADR 0043 decision 5 rules out.
        const cell = cells?.resolve(capture.id) ?? null;
        if (!cell) throw new EscapingMutableClosureError(capture.id, capture.name);
        capturedCells.set(capture.id, cell);
        bindings[capture.id] = {name: capture.name, cell: true};
        continue;
      }
      bindings[capture.id] = {name: capture.name, value: canonicalizeValue(capture.value)};
    }

    let environment = null;
    if (Object.keys(bindings).length > 0) {
      environment = await this.images.putLexicalEnvironment(prototypeRef.imageId, {bindings});
    }
    const block = await this.images.putBlock(prototypeRef.imageId, {
      code: prototypeBlock.code,
      environment: environment ? objectRef(environment.imageId, environment.id) : null,
      metadata: {prototypeBlockId: prototypeRef.objectId},
    });
    const blockRef = objectRef(block.imageId, block.id);
    // Execution-scoped, never durable: this is the only thing that lets a closure created in this
    // execution reach a live cell, and it dies with the arena.
    cells?.associate(blockRef, capturedCells);
    // Lexical frame state, alongside the lexical cells that already work this way. Execution-scoped
    // by construction: it dies with the arena, which is what makes an escaped closure fail closed
    // rather than carry a forgeable claim into a later execution (ADR 0050 decision 10a).
    if (frame) arena?.associateFrame?.(blockRef, frame);
    return blockRef;
  }

  // `authorityContext` is execution context in exactly the way `depth` already is: real,
  // load-bearing, and absent from the durable model. Nothing is added to the activation.
  // `invocationFrame` is ADR 0050 decision 5b's transient envelope, and `inheritedFrame` is the
  // caller's frame offered to a callee the language marked as its own host operation. Both are
  // execution context in exactly the way `depth` and `authority` are: they reach no activation
  // record, no Value and no durable state.
  async execute(activation, {
    depth = 0,
    authority = null,
    cellArena = null,
    dispatchImage = null,
    invocationFrame = null,
    inheritedFrame = null,
  } = {}) {
    if (!Number.isInteger(depth) || depth < 0) throw new TypeError('activation depth must be a non-negative integer');
    if (depth > MAX_ACTIVATION_DEPTH) throw new TypeError('activation depth limit exceeded');
    assertActivationRequest(activation);

    // The root execution owns the arena; nested sends share it. That is a lifetime relationship and
    // nothing more: cells are still reached by frame, so sharing an arena never means sharing a
    // variable. It is what makes a returned closure keep working for the rest of this execution
    // while still expiring when the execution does.
    //
    // Created here, before the verification reads below, because ADR 0052 lets the activation's
    // Block be a closure instance that lives only in the arena — so the resolver has to exist
    // before anything tries to resolve.
    const arena = cellArena ?? new LexicalCellArena();
    // ADR 0052 decision 5a: one resolution rule for this execution, shared by the executors, the
    // dispatcher and this class's own reads. Identical to `this.images` when there is no arena.
    const view = arenaImagesView(this.images, arena);

    const block = await view.getBlock(activation.block.imageId, activation.block.objectId);
    if (!block) throw new TypeError(`activation block not found: ${activation.block.imageId}/${activation.block.objectId}`);
    if (!sameRef(block.code, activation.code)) throw new TypeError('activation code does not match Block code');
    if (!sameRef(block.environment, activation.environment)) {
      throw new TypeError('activation environment does not match Block environment');
    }

    const code = await view.getCodeArtifact(activation.code.imageId, activation.code.objectId);
    if (!code) throw new TypeError(`activation code artifact not found: ${activation.code.imageId}/${activation.code.objectId}`);

    const executor = this.executors.get(code.representation);

    const cells = arena.activationCells(activation.block);

    // ADR 0050 decision 5a, in priority order:
    //
    //   a dispatch that supplied a frame        REPLACES  — the callee runs as its own self
    //   a callee the language marked inheriting INHERITS  — its host operation acts for the caller
    //   a closure created inside a framed frame  RESTORES  — lexical self, per decision 10
    //   anything else                            NONE      — and the slot primitives are unusable
    //
    // The restore case is also what makes decision 10a fail closed for free: the association lives
    // in the arena, the arena dies with the execution, so a closure invoked in a *later* execution
    // finds nothing rather than believing a durable claim.
    const activeFrame = invocationFrame
      ?? this.invocations?.frameFor?.(activation)
      ?? inheritedFrame
      ?? arena.frameFor?.(activation.block)
      ?? null;

    // ADR 0044 decision 5a. A root activation dispatches in its own Block's image; a nested one
    // inherits what its sender computed. Context, never a field on the activation.
    const activeDispatchImage = dispatchImage ?? activation.block.imageId;

    // Resolved once per activation, before any executor runs, so both lanes see one answer.
    let initialTemporaryContents = UNBOUND;
    if (this.temporaryInitializer) {
      // The artifact's language identity travels with the request, because initialization policy
      // belongs to a language rather than to an image. The execution layer still knows nothing
      // about any particular language — only that an artifact has one.
      const initial = await this.temporaryInitializer({
        images: view,
        dispatchImage: activeDispatchImage,
        languageId: code.languageId ?? null,
      });
      if (initial !== null && initial !== undefined) initialTemporaryContents = canonicalizeValue(initial);
    }

    // A mutable record rather than mere stack scoping, so that "active" can later mean "the
    // logical activation is still alive" once async activations exist, instead of "a
    // JavaScript frame happens to be on the stack".
    const lifetime = {active: true};
    const whileActive = (operation, implementation) => (...args) => {
      if (!lifetime.active) throw new ExpiredExecutionContextError(operation);
      return implementation(...args);
    };

    try {
      const result = await executor.execute(
      {activation, code},
      {
        images: view,
        // Check-only, and the only authority operation that crosses this seam. There is no
        // grant to return, no context to read, and no principal to branch on. Absent
        // authority fails closed rather than permitting.
        require: whileActive('require', (demand) => {
          if (!this.authority) throw new TypeError('no authority service is configured; this execution has no capabilities');
          if (authority === null) throw new TypeError('no authority context was supplied; this execution has no capabilities');
          return this.authority.require(authority, demand);
        }),
        lookupBinding: whileActive('lookupBinding', async (bindingId) => {
          if (!activation.environment) throw new TypeError(`lexical binding not found: ${bindingId}`);
          return await this.lookupBinding(activation.environment, bindingId, view);
        }),
        // Declared, not initialized: a temporary has no value until it is assigned, and there is
        // no nil to give it. Reading one before assignment raises rather than defaulting.
        declareTemporaries: whileActive('declareTemporaries', (temporaries) => {
          if (!Array.isArray(temporaries)) throw new TypeError('temporaries must be an array');
          cells.declare(temporaries, initialTemporaryContents);
        }),
        // Cell-only and synchronous, which `readBinding` cannot be: it falls through to an awaited
        // durable-environment lookup. A WASM import must return a value, not a promise, so the
        // WASM lane uses these and never the general ones. Absence raises rather than falling
        // back, so there is no path by which a durable snapshot could answer a cell read.
        readCell: whileActive('readCell', (bindingId) => {
          const cell = cells.resolve(bindingId);
          if (!cell) throw new MissingLexicalCellError(bindingId);
          return cell.read();
        }),
        writeCell: whileActive('writeCell', (bindingId, value) => {
          const cell = cells.resolve(bindingId);
          if (!cell) throw new MissingLexicalCellError(bindingId);
          return cell.write(value);
        }),
        readBinding: whileActive('readBinding', async (bindingId) => {
          const cell = cells.resolve(bindingId);
          if (cell) return cell.read();
          if (!activation.environment) throw new TypeError(`lexical binding not found: ${bindingId}`);
          return await this.lookupBinding(activation.environment, bindingId, view);
        }),
        writeBinding: whileActive('writeBinding', async (bindingId, value) => {
          const cell = cells.resolve(bindingId);
          if (cell) return cell.write(value);
          // Assignment reaches cells only. A durable binding is layout plus a snapshot, and ADR
          // 0043 decision 2 keeps assignment out of the graph entirely.
          const record = activation.environment
            ? await this.lookupBindingRecord(activation.environment, bindingId, view)
            : null;
          if (record?.cell === true) throw new EscapingMutableClosureError(bindingId, record.name);
          if (record) throw new TypeError(`lexical binding ${bindingId} is not an assignable cell`);
          throw new TypeError(`lexical binding not found: ${bindingId}`);
        }),
        // Read-only, and only meaningful to a language-owned executor: it is the identity of the
        // method activation this operation is acting for, never a capability.
        invocationFrame: activeFrame,
        createClosure: whileActive('createClosure', async (request) => await this.createClosure(request, cells, arena, activeFrame)),
        // A nested send inherits the current authority. An executor may ask for a narrower
        // child, but never receives one: the attenuation happens here, so no executor ever
        // holds a context. Since attenuation only narrows, a nested send can lose rights and
        // can never gain them.
        sendMessage: whileActive('sendMessage', async (request, {attenuate = null} = {}) => {
          if (!this.invocations) throw new TypeError('activation executor has no message runtime');
          if (depth >= MAX_ACTIVATION_DEPTH) throw new TypeError('activation depth limit exceeded');
          let nestedAuthority = authority;
          if (attenuate !== null) {
            if (!this.authority) throw new TypeError('cannot attenuate without an authority service');
            if (authority === null) throw new TypeError('cannot attenuate without an authority context');
            nestedAuthority = this.authority.attenuate(authority, {grants: attenuate});
          }
          // An object receiver dispatches in its own image; an immediate one has none, so the
          // sender's dispatch image carries through unchanged.
          const nextDispatchImage = isObjectRef(request.receiver)
            ? request.receiver.imageId
            : activeDispatchImage;
          const dispatched = await this.invocations.prepareDispatch(request, {
            dispatchImage: nextDispatchImage, images: view,
          });
          return await this.execute(dispatched.activation, {
            depth: depth + 1,
            authority: nestedAuthority,
            cellArena: arena,
            dispatchImage: nextDispatchImage,
            invocationFrame: dispatched.frame,
            // Offered only where the language said this callee is its own host operation. An
            // ordinary Block send inherits nothing, so a method cannot lend its identity to a Block
            // it merely invoked.
            inheritedFrame: dispatched.inheritsFrame ? activeFrame : null,
          });
        }),
      },
      );
      return canonicalizeValue(result);
    } finally {
      // Also on the exceptional path: a trapping guest must not leave a live context behind.
      lifetime.active = false;
    }
  }
}

export {
  ActivationExecutor,
  ExpiredExecutionContextError,
  MAX_ACTIVATION_DEPTH,
  assertActivationRequest,
};
