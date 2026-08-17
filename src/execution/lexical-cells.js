import {canonicalizeValue} from '../value/index.js';

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

  constructor(id, name) {
    this.#id = id;
    this.#name = name ?? null;
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

  declare(id, name) {
    if (!this.#cells.has(id)) this.#cells.set(id, new LexicalCell(id, name));
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

  declare(temporaries) {
    for (const {id, name} of temporaries) this.#frame.declare(id, name);
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

export {
  ActivationCells,
  EscapingMutableClosureError,
  MissingLexicalCellError,
  LexicalCell,
  LexicalCellArena,
  LexicalFrame,
  UNBOUND,
  UnboundBindingError,
};
