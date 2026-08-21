import {canonicalizeValue, isObjectRef, objectRef} from '../value/index.js';
import {arenaImagesView} from './lexical-cells.js';
import {promoteClosure} from './closure-promotion.js';
import {NonLocalReturnTransfer} from './conditions.js';
import {CodeExecutorRegistry} from './executor-registry.js';
import {
  EscapingMutableClosureError,
  LexicalCellArena,
  MissingLexicalCellError,
  UNBOUND,
  UnboundBindingError,
} from './lexical-cells.js';

const MAX_ACTIVATION_DEPTH = 256;

// ADR 0054. Authority captured at `on:do:`/`ensure:` establishment, reachable only through the
// opaque token handed back — so a primitive can carry it without holding it, and nothing that
// crosses the primitive boundary is a capability (ADR 0037).
const CAPTURED_AUTHORITY = new WeakMap();



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
  // ADR 0055 decision 4. Liveness of a home method activation, keyed by its ADR 0050 frame — which
  // is only ever a key here. The frame's shape is validated as exactly {self, definingBehavior} at
  // the dispatch seam, and liveness is execution state rather than identity, so it must not become a
  // field.
  //
  // Three states, not two, and per executor rather than module-global. A *missing* entry means this
  // executor never ran that frame as a home, which is not the same as one that ran and returned —
  // collapsing them would report "already returned" for a frame that never was a home here. And a
  // dead entry is retained while the frame is reachable, which is what keeps the two apart.
  #homeActivations = new WeakMap();

  homeActivationState(frame) {
    return this.#homeActivations.get(frame)?.state ?? 'absent';
  }

  // The selector the home was dispatched with, so a dead-home failure can name the *method* rather
  // than only its class — `definingBehavior` alone identifies the class, which is not what ADR 0055
  // asks the diagnosis to say.
  homeActivationSelector(frame) {
    return this.#homeActivations.get(frame)?.selector ?? null;
  }

  // Private: ADR 0055 requires that outside code cannot forge liveness. A frame is only ever a key
  // here, and only this class writes.
  #markHomeActivation(frame, state, selector) {
    this.#homeActivations.set(frame, Object.freeze({state, selector}));
  }

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

    // ADR 0052 decision 5: a closure instance is execution-local. No environment record, no Block
    // record, no history event — the instance lives in the arena and becomes durable only if it
    // escapes, which is what makes evaluating a Block literal in a loop cost nothing.
    //
    // The instance's image is the prototype's, so dispatch-image behaviour is unchanged.
    const hasBindings = Object.keys(bindings).length > 0;
    let blockRef;
    if (arena) {
      const environment = hasBindings
        ? arena.mintClosureEnvironment(prototypeRef.imageId, {bindings})
        : null;
      blockRef = arena.mintClosureBlock(prototypeRef.imageId, {
        code: prototypeBlock.code,
        environment,
        metadata: {prototypeBlockId: prototypeRef.objectId},
      });
    } else {
      // No arena means no execution to be local to — a closure created outside one has nowhere
      // transient to live, so it is durable immediately.
      const environment = hasBindings
        ? await this.images.putLexicalEnvironment(prototypeRef.imageId, {bindings})
        : null;
      const block = await this.images.putBlock(prototypeRef.imageId, {
        code: prototypeBlock.code,
        environment: environment ? objectRef(environment.imageId, environment.id) : null,
        metadata: {prototypeBlockId: prototypeRef.objectId},
      });
      blockRef = objectRef(block.imageId, block.id);
    }
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
    conditionRuntime = null,
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
    // ADR 0052 decision 6: returning from a *root* execution is an escape, because the answer
    // reaches a caller with no arena. A nested send is not — it hands its answer back inside the
    // same arena, where a transient closure stays perfectly usable. The existing call structure
    // already draws that line exactly: the root is the execution that was given no arena.
    const ownsArena = !cellArena;
    const arena = cellArena ?? new LexicalCellArena();
    // ADR 0054: one execution-wide condition runtime, owned beside the arena and living exactly as
    // long. Nested sends share it, so a handler established anywhere in the execution is found from
    // anywhere else in it — including across a WASM boundary, which contributes no machinery of its
    // own.
    const conditions = conditionRuntime ?? arena.conditionRuntime();
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

    // ADR 0055 decision 3a. Computed *alongside* the expression above rather than by refactoring it,
    // so ADR 0050's priority semantics are reused rather than re-derived.
    //
    // Only a dispatch-supplied frame is owned. A kernel primitive inherits one and a closure restores
    // one — both are borrowers holding the very same object — so ownership, not frame equality, is
    // what decides where a non-local return stops. Otherwise the return primitive, which is running
    // with the home frame at the moment it raises, would catch its own transfer.
    const ownsFrame = activeFrame !== null
      && (invocationFrame !== null || this.invocations?.frameFor?.(activation) != null);
    // Marked live inside the protected region below, not here: a failure between this point and the
    // `try` — temporary initialization, for instance — would otherwise leave a frame permanently
    // live, and a later `^` naming it would be told its home is still running.
    const homeSelector = ownsFrame ? (activation.dispatch?.message?.value ?? null) : null;

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
      if (ownsFrame) this.#markHomeActivation(activeFrame, 'live', homeSelector);
      const result = await executor.execute(
      {activation, code},
      {
        images: view,
        // ADR 0054. Primitives reach the condition runtime through this facade and never through
        // an authority context: `establish` hands back a scope id, and the *invoker* it stores
        // closes over the authority in force here. A handler therefore runs with its establisher's
        // rights without any capability crossing the primitive boundary (ADR 0037).
        conditions: Object.freeze({
          runtime: conditions,
          // Captures the authority in force *here*, and nothing else. An opaque handle rather than
          // the context itself, so a primitive can carry it to a handler entry without ever holding
          // a capability (ADR 0037).
          captureAuthority: whileActive('captureAuthority', () => {
            const token = Object.freeze({});
            CAPTURED_AUTHORITY.set(token, authority);
            return token;
          }),
          // Invoked from whichever frame is *running* the Block, not from the frame that captured
          // the token. Depth is therefore the depth at the signal point — a handler on a deep
          // signalling stack must not be measured from where `on:do:` was written — and the
          // dispatch image is the Block's own, which is the ordinary rule for any Block and is what
          // keeps a cross-image handler using its own kernel rather than the establisher's.
          //
          // Invoking a Block rather than dispatching a selector keeps this language-neutral, and
          // lets ADR 0050 restore the Block's creation frame, which is what gives a handler its
          // establisher's `self` for free.
          // ADR 0055. The primitive asks whether the frame it was handed still has a running
          // owner; it never sees the registry, and a frame is only ever a key in it.
          homeActivationState: whileActive('homeActivationState', (frame) => this.homeActivationState(frame)),
          homeActivationSelector: whileActive('homeActivationSelector', (frame) => this.homeActivationSelector(frame)),
          invoke: whileActive('invoke', async (token, blockRef, args = []) => {
            if (!CAPTURED_AUTHORITY.has(token)) throw new TypeError('unknown captured authority token');
            if (depth >= MAX_ACTIVATION_DEPTH) throw new TypeError('activation depth limit exceeded');
            const activation = await this.invocations.prepareActivation({
              block: blockRef, arguments: args, images: view,
            });
            return await this.execute(activation, {
              depth: depth + 1,
              authority: CAPTURED_AUTHORITY.get(token),
              cellArena: arena,
              conditionRuntime: conditions,
              dispatchImage: normalizeObjectRef(blockRef, 'condition block').imageId,
            });
          }),
        }),
        // ADR 0052 decision 7a. The boundary that creates durable reachability calls this before
        // its write; the graph guard stays a tripwire proving a boundary was not forgotten, rather
        // than becoming the mechanism. A value with nothing transient in it comes straight back.
        promote: whileActive('promote', async (value) => await promoteClosure(this.images, arena, value)),
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
            conditionRuntime: conditions,
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
      const answer = canonicalizeValue(result);
      // Before leaving, while the arena still exists. Deliberately the returned Value only: a
      // durable object cannot secretly hold a transient closure, because creating that edge would
      // already have been refused at the graph write seam. Walking a returned object graph would be
      // I/O spent re-proving what the write boundary guarantees.
      return ownsArena ? await promoteClosure(this.images, arena, answer) : answer;
    } catch (error) {
      // Only the owner stops a return naming its own frame; a borrower lets it travel on.
      if (ownsFrame && error instanceof NonLocalReturnTransfer && error.frame === activeFrame) {
        const answer = canonicalizeValue(error.value);
        // The same escape boundary an ordinary return crosses (ADR 0052 decision 6): a root
        // execution's answer is promoted before leaving, while the arena still exists. Returning
        // this value unpromoted would let `^ [ ... ]` hand a transient closure to a caller that has
        // no arena to resolve it in.
        return ownsArena ? await promoteClosure(this.images, arena, answer) : answer;
      }
      throw error;
    } finally {
      // Also on the exceptional path: a trapping guest must not leave a live context behind.
      lifetime.active = false;
      // Dead from here on. Retained rather than deleted: while the frame is still reachable, a
      // `^` naming it must be told the method returned rather than that it has no home.
      // Marked dead rather than deleted: while the frame is still reachable, a `^` naming it must
      // be told the method returned rather than that it has no home.
      if (ownsFrame) this.#markHomeActivation(activeFrame, 'dead', homeSelector);
    }
  }
}

export {
  ActivationExecutor,
  ExpiredExecutionContextError,
  MAX_ACTIVATION_DEPTH,
  assertActivationRequest,
};
