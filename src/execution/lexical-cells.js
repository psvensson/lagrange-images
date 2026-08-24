import {randomUUID} from 'node:crypto';
import {TupleMap} from '../support/tuple-map.js';
import {canonicalizeValue, objectRef} from '../value/index.js';
import {isTransientObjectId, transientObjectId} from '../value/transient-ref.js';
import {ConditionRuntime} from './conditions.js';

// A closure instance whose arena is gone. Distinct from "block not found" on purpose: ADR 0052
// decision 5c makes this rigorous, because a reserved id can never name a durable record, so its
// absence from the arena means expiry rather than a missing or corrupt record.
class ExpiredClosureInstanceError extends TypeError {
  constructor(imageId, objectId) {
    super(`closure instance ${imageId}/${objectId} has expired; its execution has ended`);
    this.name = 'ExpiredClosureInstanceError';
    this.imageId = imageId;
    this.objectId = objectId;
  }
}

// The lane-neutral lexical frame and cell substrate, per ADR 0043.
//
// This deliberately lives in the common execution layer rather than inside an executor. Two
// implementations of mutable lexical state — one for the neutral lane, one for WASM — is the
// architecture to avoid: the semantics would become lane-dependent, which ADR 0043 decision 10
// forbids. Both lanes consume these operations instead.
//
// A cell is identified by (lexical frame, static binding ID), never by binding ID alone. Binding
// IDs are static slot identity: the compiler derives them from a path defaulting to 'root', so
// `root:temporary:0` names a slot in the code, and two activations of that code — including two
// recursive activations — deliberately share it while needing distinct variables.
//
// Frame *identity* and frame *lifetime* are separate, and conflating them is the easy mistake:
//
//   different lexical invocation   ->  different frame
//   a frame stays reachable after its own call returns, if a closure still holds one of its cells
//   nothing captured it            ->  it goes away when its call returns
//   the root execution ends        ->  the arena dies with it
//
// So a factory that returns a counter closure keeps working for the rest of that execution:
//
//   make := [ | n | n := 0. [ n := n + 1 ] ].
//   counter := make value.  counter value.  counter value.   "2"
//
// The closure has escaped its declaring frame but not the execution that owns the arena. Only a
// later, independent execution meeting a durable {cell: true} capture raises.

// A host sentinel, never a canonical Value and never observable as one. When the object system
// arrives, a temporary's initial contents become the `nil` object ref and nothing here changes.
const UNBOUND = Symbol('lagrange.lexical.unbound');

class UnboundBindingError extends TypeError {
  constructor(name, id) {
    super(`lexical binding ${name ?? id} is unbound; it has no value until it is assigned`);
    this.name = 'UnboundBindingError';
    this.bindingId = id;
  }
}

// Raised when a closure that depends on a live cell is invoked without the execution that owns
// that cell. ADR 0043 decision 5: this case is unsupported, not silently reset to whatever the
// durable snapshot happened to hold.
class EscapingMutableClosureError extends TypeError {
  constructor(id, name) {
    super(
      `closure depends on the live lexical cell ${name ?? id}, which belonged to a finished execution; `
      + 'persistent mutable captured state needs an explicit survival contract',
    );
    this.name = 'EscapingMutableClosureError';
    this.bindingId = id;
  }
}

// Raised when a synchronous cell operation names a binding that is not a cell of this activation.
// The cell-only accessors deliberately do not fall back to the durable environment: that lookup is
// asynchronous, so a fallback would be unusable from a WASM import anyway, and offering one would
// reopen the snapshot channel that ADR 0043 decision 5 closes.
class MissingLexicalCellError extends TypeError {
  constructor(id) {
    super(`lexical binding ${id} is not a cell of this activation`);
    this.name = 'MissingLexicalCellError';
    this.bindingId = id;
  }
}

class LexicalCell {
  #id;
  #name;
  #contents = UNBOUND;

  // `initialContents` is how ADR 0044 decision 8 arrives: in a bootstrapped image a declared
  // temporary starts holding that image's `nil` ref, and elsewhere it starts UNBOUND exactly as
  // before. A cell holding nil is an ordinary bound cell — nothing downstream distinguishes it,
  // which is why this needs no new WASM ABI.
  constructor(id, name, initialContents = UNBOUND) {
    this.#id = id;
    this.#name = name ?? null;
    this.#contents = initialContents === UNBOUND ? UNBOUND : canonicalizeValue(initialContents);
  }

  get id() { return this.#id; }
  get name() { return this.#name; }
  get bound() { return this.#contents !== UNBOUND; }

  read() {
    if (this.#contents === UNBOUND) throw new UnboundBindingError(this.#name, this.#id);
    return this.#contents;
  }

  // Assignment is an expression, so the written value is returned.
  write(value) {
    this.#contents = canonicalizeValue(value);
    return this.#contents;
  }

  // Deliberately no snapshot() method. Persisting a mutable capture always writes
  // {name, cell: true} regardless of what the cell currently holds, so that no value is
  // reachable in the durable record for a later invocation to silently restart from. A snapshot
  // accessor would exist only to defeat that, so it does not exist.
}

// One lexical activation's cells. Opaque: nothing outside resolves a cell except through here.
class LexicalFrame {
  #cells = new Map();

  declare(id, name, initialContents = UNBOUND) {
    if (!this.#cells.has(id)) this.#cells.set(id, new LexicalCell(id, name, initialContents));
    return this.#cells.get(id);
  }

  own(id) {
    return this.#cells.get(id) ?? null;
  }
}

// Execution-scoped. What the arena actually owns is the closure-to-cell associations: those must
// outlive the activation that created the closure, and must not outlive the execution — which is
// what makes cells activation state under ADR 0041 rather than something that survives by accident.
//
// It deliberately does *not* keep a list of frames. A frame is reachable while its activation runs,
// and afterwards only through cells some closure captured, so an unwatched frame becomes collectable
// as soon as its call returns. Holding every frame for the execution's duration would retain one
// Map per send in a long loop while changing no semantics.
class LexicalCellArena {
  #closureCells = new Map();

  allocateFrame() {
    return new LexicalFrame();
  }

  // The transient association between a closure Block created in this execution and the cells it
  // captured. The durable environment cannot express cell identity, so this is what lets a
  // same-execution closure resolve the *declaring* frame's cell rather than a snapshot.
  //
  // Nested by imageId then objectId, because a Block ref is a two-part identity and flattening it
  // into one string is not injective: object ids are arbitrary non-empty text, so any separator can
  // itself appear inside a part. `a<sep>b` + `c` and `a` + `b<sep>c` would then collide and one
  // closure would resolve another closure's cells. A tuple lookup cannot be got wrong this way.
  associate(blockRef, cells) {
    if (cells.size === 0) return;
    let byObject = this.#closureCells.get(blockRef.imageId);
    if (!byObject) {
      byObject = new Map();
      this.#closureCells.set(blockRef.imageId, byObject);
    }
    byObject.set(blockRef.objectId, new Map(cells));
  }

  capturedCells(blockRef) {
    return this.#closureCells.get(blockRef.imageId)?.get(blockRef.objectId) ?? null;
  }

  // One lexical activation's view: its own fresh frame, plus the cells the Block being activated
  // captured when some earlier activation in this same execution created it.
  activationCells(blockRef) {
    return new ActivationCells(this, this.allocateFrame(), this.capturedCells(blockRef));
  }

  // ADR 0050 decision 10a. The frame in force where a closure was created, so activating it later in
  // the *same* execution restores lexical `self`. Deliberately here rather than in a durable record:
  // a persisted defining Behavior would be forgeable data, which is the vector self-only exists to
  // close. Dying with the arena is the feature.
  associateFrame(blockRef, frame) {
    this.frames ??= new TupleMap(2);
    this.frames.set([blockRef.imageId, blockRef.objectId], frame);
  }

  frameFor(blockRef) {
    return this.frames?.get([blockRef.imageId, blockRef.objectId]) ?? null;
  }

  // ADR 0052 decision 5a. Closure instances that have not escaped live here rather than in the
  // graph, keyed by the same instance ref the cells and frame above are keyed by — one keying
  // scheme, so an instance's cells, frame and definition are all reached the same way.
  //
  // The stored shapes deliberately mirror the durable Block and LexicalEnvironment records field for
  // field. Promotion is then a copy rather than a translation, which is what keeps a promoted
  // closure the same representation as one written eagerly.
  #instances = new TupleMap(2);

  #mint(imageId, kind, record) {
    const objectId = transientObjectId(`${kind}/${this.#nextInstance += 1}/${this.#nonce}`);
    this.#instances.set([imageId, objectId], record);
    return objectRef(imageId, objectId);
  }

  #nextInstance = 0;

  // Per-arena, so a transient id minted by one execution can never be mistaken for one minted by
  // another — including after an arena is gone, where the id must read as expired rather than as
  // some other execution's live instance.
  #nonce = randomUUID();

  // The instance's image is its prototype's, so dispatch-image behaviour needs no special case for
  // a transient receiver (ADR 0044 decision 5a, ADR 0051 decision 3).
  mintClosureBlock(imageId, {code, environment = null, metadata = {}}) {
    return this.#mint(imageId, 'block', Object.freeze({
      kind: 'block', code, environment, metadata: Object.freeze({...metadata}),
    }));
  }

  mintClosureEnvironment(imageId, {bindings, parent = null}) {
    return this.#mint(imageId, 'environment', Object.freeze({
      kind: 'lexical-environment', bindings: Object.freeze({...bindings}), parent,
    }));
  }

  // ADR 0060 decision 3. An object allocated inside this execution begins here rather than in the
  // durable store: `basicNew` and condition allocation mint into the arena, and the object becomes
  // durable only if a reference crosses a durability boundary. The record mirrors the durable
  // object record field for field — shape, behavior, slots, indexed, metadata — so promotion is a
  // copy rather than a translation, exactly as ADR 0052 made it for closures.
  mintObject(imageId, {shape, behavior, slots = {}, indexed = null, metadata = {}}) {
    return this.#mint(imageId, 'object', Object.freeze({
      kind: 'object',
      shape,
      behavior,
      slots: Object.freeze({...slots}),
      // A non-indexed Shape omits the property entirely, preserving the durable record form.
      ...(indexed === null ? {} : {indexed: Object.freeze([...indexed])}),
      metadata: Object.freeze({...metadata}),
    }));
  }

  transientRecord(imageId, objectId) {
    return this.#instances.get([imageId, objectId]) ?? null;
  }

  // ADR 0060: a slot or indexed write to an object that has not escaped stays in the arena. The
  // record is replaced whole (slots and indexed are immutable snapshots), mirroring the durable
  // whole-record rewrite, so a later read in the same execution sees the new state and a promotion
  // that follows publishes the latest. There is no version to CAS on — the record is
  // execution-local, so the only writer is this execution itself.
  mutateTransientObject(imageId, objectId, {slots = null, indexed = null} = {}) {
    const key = [imageId, objectId];
    const record = this.#instances.get(key);
    if (!record) throw new ExpiredClosureInstanceError(imageId, objectId);
    if (record.kind !== 'object') {
      throw new TypeError(`only a transient object can be mutated: ${imageId}/${objectId}`);
    }
    this.#instances.set(key, Object.freeze({
      ...record,
      slots: slots === null ? record.slots : Object.freeze({...slots}),
      ...(indexed === null
        ? (Object.hasOwn(record, 'indexed') ? {indexed: record.indexed} : {})
        : {indexed: Object.freeze([...indexed])}),
    }));
  }

  transientEntries() {
    return this.#instances.entries();
  }

  // ADR 0052 decision 7a. Lives on the arena so promotion is idempotent for the whole execution
  // rather than per boundary: a closure written into two slots must be one closure both times.
  #promotionMemo = new TupleMap(2);

  promotionMemo() {
    return this.#promotionMemo;
  }

  // ADR 0054. Kept on the arena because its lifetime is the arena's: a handler established in this
  // execution must not be findable from a later one, for the same reason a defining frame is not.
  #conditions = null;

  conditionRuntime() {
    this.#conditions ??= new ConditionRuntime();
    return this.#conditions;
  }
}

// What an executor is given. Deliberately narrow: declare a slot, resolve one, associate a new
// closure. No frame, no arena and no cell contents leak through it, so both execution lanes share
// one lexical-state model instead of each growing its own.
class ActivationCells {
  #arena;
  #frame;
  #captured;

  constructor(arena, frame, captured) {
    this.#arena = arena;
    this.#frame = frame;
    this.#captured = captured;
  }

  // One place, before the neutral and WASM lanes diverge. Four executors independently learning
  // about `nil` is the lane-dependent-semantics mistake ADR 0043 decision 10 forbids.
  declare(temporaries, initialContents = UNBOUND) {
    for (const {id, name} of temporaries) this.#frame.declare(id, name, initialContents);
  }

  // This activation's own slot first, then a captured cell — never the other way round, so a
  // recursive activation shadows the identically-named static slot it captured.
  resolve(id) {
    return this.#frame.own(id) ?? this.#captured?.get(id) ?? null;
  }

  associate(blockRef, cells) {
    this.#arena.associate(blockRef, cells);
  }
}



// ADR 0052 decision 5a: Block resolution is arena-first, then durable.
//
// Delivered as a view over the images service rather than as a new parameter on every reader,
// because the readers that must see a transient instance — `prepareActivation`, the language
// dispatcher's Block recognition, binding lookup — all already take an images service. A view keeps
// one resolution rule in one place instead of three call sites remembering to check the arena.
//
// The view is execution context in exactly the way `dispatchImage` is: it is built per execution,
// it reaches no durable record, and it dies with the arena.
function arenaImagesView(images, arena) {
  if (!arena) return images;
  const view = Object.create(images);
  const transient = (imageId, objectId, kind) => {
    const record = arena.transientRecord(imageId, objectId);
    if (!record) return null;
    return record.kind === kind ? record : null;
  };
  // Durable fallback is never reached for a reserved id, because decision 5b forbids a durable
  // record from taking one. A reserved id absent from this arena is therefore an *expired*
  // instance, which is a lifetime error rather than a missing record — and saying so is the
  // difference between "your closure outlived its execution" and "your image is corrupt".
  //
  // One nuance ADR 0060 forces: the dispatcher asks *every* object receiver "are you a Block?"
  // first (ADR 0044's Block-personality check), so a transient *object* is looked up as a Block on
  // every send to it. That is a negative answer, not an expiry — the id is live in the arena as a
  // different kind, and only a reserved id present *nowhere* in the arena has outlived its
  // execution. So "not this kind" answers null and lets the durable-negative fall through, while
  // "not in the arena at all" is the lifetime error.
  const resolve = async (imageId, objectId, kind, durable) => {
    const record = arena.transientRecord(imageId, objectId);
    if (record) return record.kind === kind ? record : null;
    if (isTransientObjectId(objectId)) {
      throw new ExpiredClosureInstanceError(imageId, objectId);
    }
    return await durable.call(images, imageId, objectId);
  };
  view.getBlock = (imageId, objectId) => resolve(imageId, objectId, 'block', images.getBlock);
  view.getLexicalEnvironment = (imageId, objectId) =>
    resolve(imageId, objectId, 'lexical-environment', images.getLexicalEnvironment);
  // ADR 0060: object reads resolve arena-first, exactly as Block reads already do — so a primitive
  // holding a transient receiver (a `basicNew` result, an unhandled condition still in its
  // execution) sees its state without the object ever becoming durable. The durable fallback is
  // never reached for a reserved id, for the same reason as above.
  // A transient record's id is its arena key rather than a stored field, but every reader and
  // writer below the view addresses a record by `record.id` — the whole-record rewrites in the
  // slot, indexed and Dictionary primitives all rebuild from it. Surface the id on the record the
  // view answers so those paths work unchanged against a transient object; the durable record
  // already carries its own id.
  view.getObject = async (imageId, objectId) => {
    const record = arena.transientRecord(imageId, objectId);
    if (record) {
      if (record.kind !== 'object') return null;
      return Object.freeze({...record, id: objectId});
    }
    if (isTransientObjectId(objectId)) throw new ExpiredClosureInstanceError(imageId, objectId);
    return await images.getObject(imageId, objectId);
  };
  // A write naming a reserved id is a write to an object still in this arena — `basicNew`'s whole
  // point is that the id is minted transient and the record lives here until escape. A durable id
  // falls through to the durable store unchanged. The arena path deliberately ignores the durable
  // CAS contract: a transient record has no version, and this execution is its only writer.
  view.putObject = async (imageId, record, options = {}) => {
    if (isTransientObjectId(record?.id)) {
      const existing = arena.transientRecord(imageId, record.id);
      if (!existing) throw new ExpiredClosureInstanceError(imageId, record.id);
      arena.mutateTransientObject(imageId, record.id, {
        slots: record.slots,
        indexed: Object.hasOwn(record, 'indexed') ? record.indexed : null,
      });
      return record;
    }
    return await images.putObject(imageId, record, options);
  };
  return view;
}

export {
  ActivationCells,
  EscapingMutableClosureError,
  ExpiredClosureInstanceError,
  MissingLexicalCellError,
  LexicalCell,
  LexicalCellArena,
  LexicalFrame,
  UNBOUND,
  UnboundBindingError,
  arenaImagesView,
};
