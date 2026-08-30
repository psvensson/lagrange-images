import {booleanValue, integerValue, textValue} from '../value/index.js';
import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {LAGRANGE_CODE_V1} from '../code/lagrange-code-v1.js';
import {parseSymmetricSmalltalkBlock} from './symmetric-smalltalk-parser.js';
import {isReservedWord} from './symmetric-smalltalk-tokenizer.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

function normalizeRootCaptures(captures) {
  if (!captures || typeof captures !== 'object' || Array.isArray(captures)) {
    throw new TypeError('captures must be an object mapping source name to stable binding id');
  }
  const result = new Map();
  const ids = new Set();
  for (const [name, id] of Object.entries(captures)) {
    if (!name) throw new TypeError('capture name must not be empty');
    // The fourth site of ADR 0056 decision 3, and the one the parser cannot reach: captures are
    // supplied programmatically rather than written in source.
    if (isReservedWord(name)) throw new TypeError(`capture name ${name} is a reserved word`);
    // The compiler's own intrinsic, reserved in both directions. Reserving only the name would let
    // a caller bind the *id* under another name and shadow `nil`'s meaning from outside the
    // compiler — the same reason `$nonLocalReturn` and the slot primitives reserve both.
    if (name === NIL_CAPTURE) throw new TypeError(`capture name ${NIL_CAPTURE} is reserved for the nil intrinsic`);
    if (name === SYMBOL_CAPTURE) throw new TypeError(`capture name ${SYMBOL_CAPTURE} is reserved for the symbol intrinsic`);
    // The compiler owns this whole key namespace. Reserving only the ids it happens to use would
    // let a caller supply an internal-looking name and slip past the global collision check, which
    // distinguishes its own captures by exactly this prefix.
    if (name.startsWith(GLOBAL_CAPTURE_PREFIX)) {
      throw new TypeError(`capture name ${name} is reserved: ${GLOBAL_CAPTURE_PREFIX} belongs to the compiler`);
    }
    if (typeof id !== 'string' || id.length === 0) throw new TypeError(`capture binding id for ${name} must be non-empty text`);
    if (id === NIL_BINDING_ID) throw new TypeError(`capture binding id ${NIL_BINDING_ID} is reserved for the nil intrinsic`);
    if (id === SYMBOL_BINDING_ID) throw new TypeError(`capture binding id ${SYMBOL_BINDING_ID} is reserved for the symbol intrinsic`);
    if (ids.has(id)) throw new TypeError(`duplicate capture binding id: ${id}`);
    ids.add(id);
    result.set(name, id);
  }
  return result;
}

// Which semantic representation this compilation unit needs, decided from what the program actually
// does rather than from what the parser happened to emit. A source that needs none of ADR 0043's
// semantics must still compile to exactly its lagrange-code/v0 artifact, so this asks about
// meaning: more than one statement, a declared temporary, or an assignment.
//
// A cell-mode capture is not tested for separately: capturing a mutable cell requires a temporary
// to have been declared, so temporaries already subsume it.
function needsMutableLexicalState(syntax) {
  if (!syntax || typeof syntax !== 'object') return false;
  switch (syntax.kind) {
    case 'assign':
      return true;
    case 'sequence':
      if (syntax.temporaries.length > 0 || syntax.statements.length > 1) return true;
      return syntax.statements.some((statement) => needsMutableLexicalState(statement));
    case 'block':
      return needsMutableLexicalState(syntax.body);
    // ADR 0055. A return wraps an ordinary expression, so v1 features hidden under one — an
    // assignment, a multi-statement Block — must still be seen. Omitting this case classifies
    // `^ [ | t | t := 1. t ]` as v0 and the artifact is then rejected against the closed v0 grammar.
    case 'return':
      return needsMutableLexicalState(syntax.value);
    // A cascade always lowers to hidden temporaries plus a statement sequence: the receiver must be
    // evaluated once even when it is already a plain name, because the alternative — replaying the
    // receiver expression per message — evaluates a send several times. So a cascade needs v1
    // regardless of what it is made of.
    case 'cascade':
      return true;
    case 'send':
      return needsMutableLexicalState(syntax.receiver)
        || syntax.arguments.some((argument) => needsMutableLexicalState(argument));
    // A symbol literal is an immutable compile-time value — it needs no v1 state, exactly
    // like integer, string, true, false, and nil.
    case 'symbol':
      return false;
    default:
      return false;
  }
}

// One decision for the whole tree. A nested program is embedded verbatim in its parent's `block`
// op and is also installed as its own artifact, and both readers validate against a closed grammar
// — so a v1 program cannot carry a v0-shaped child, nor the reverse.
function selectSemanticRepresentation(syntax) {
  return needsMutableLexicalState(syntax) ? LAGRANGE_CODE_V1 : LAGRANGE_CODE_V0;
}

// ADR 0050. An instance variable is not a new kind of expression: it lowers to an ordinary send of a
// language-owned primitive, reached through ordinary captures, so nothing downstream of the compiler
// learns a new concept. These names are internal to the binder and cannot collide with source names,
// which the tokenizer restricts to identifier characters.
const INSTANCE_SLOT_READ_CAPTURE = '$instanceSlotRead';
// ADR 0055: reserved for the compiler's `^` lowering, like the slot-primitive captures above.
const NON_LOCAL_RETURN_CAPTURE = '$nonLocalReturn';
// ADR 0056 decision 2. `nil` is a language-owned image object, so it cannot be a literal Value —
// the generic model has no nil kind and does not get one. It lowers to a reserved binding whose id
// is stable across images; installation supplies that image's kernel nil.
const NIL_CAPTURE = '$nil';
const NIL_BINDING_ID = 'smalltalk/intrinsic/nil';
// Symbol literals lower to a send of the spelling to the image-local interner, exactly as
// `nil` lowers to a read of the nil intrinsic. The compiled artifact carries only the canonical
// spelling as a Text literal — never an image-specific Symbol ref.
const SYMBOL_CAPTURE = '$symbol';
const SYMBOL_BINDING_ID = 'smalltalk/intrinsic/symbol';
// Internal capture key for a resolved global. Prefixed so it cannot collide with any source name —
// the tokenizer restricts those to identifier characters.
const GLOBAL_CAPTURE_PREFIX = '$global:';
// Internal capture key for a resolved class variable. Same prefixing rationale as globals.
const CLASS_VAR_CAPTURE_PREFIX = '$classVar:';
const INSTANCE_SLOT_WRITE_CAPTURE = '$instanceSlotWrite';

class SemanticScope {
  constructor({
    parent = null, path, parameters = [], rootCaptures = new Map(), instanceVariables = new Map(),
    methodHome = false, intrinsics = new Map(), globals = new Map(), classVariables = new Map(),
  } = {}) {
    // ADR 0057. Name -> binding id, resolved from the image's namespace by the *caller* and handed
    // in. This compiler stays synchronous and image-independent: it never reads storage, and what it
    // emits is binding identity rather than any image-specific ref.
    this.globals = parent ? parent.globals : globals;
    // Class variables: name -> binding id, resolved from the class hierarchy by the *caller*.
    // Same compiler-purity rule as globals: the compiler sees only the flat map.
    this.classVariables = parent ? parent.classVariables : classVariables;
    // Which class-variable bindings this compilation actually resolved. Transient provenance,
    // exactly like globalsUsed.
    this.classVarsUsed = parent ? parent.classVarsUsed : new Set();
    // ADR 0057. Which global bindings this compilation actually resolved. Transient compiler
    // metadata — never part of `lagrange-code` — and the only correct answer to "is this capture a
    // global?", because a capture id does not say *why* the capture exists.
    this.globalsUsed = parent ? parent.globalsUsed : new Set();
    // ADR 0055. Reserved bindings the binder makes *available* without declaring. A declaration
    // becomes a program capture whether or not the source references it, so declaring the return
    // intrinsic eagerly would give every method a dependency it may never use. Requested on first
    // lowering instead, which needs no second inspection of the source.
    this.intrinsics = parent ? parent.intrinsics : intrinsics;
    // ADR 0055. Whether this compilation has a method to return from. Carried explicitly rather
    // than inferred from the presence of instance variables — a method with no instance variables
    // still has a home, and a standalone Block with captures still has none.
    this.methodHome = methodHome || parent?.methodHome === true;
    this.parent = parent;
    this.instanceVariables = parent ? parent.instanceVariables : instanceVariables;
    this.path = path;
    this.parameters = new Map();
    parameters.forEach((name, index) => {
      this.parameters.set(name, Object.freeze({
        id: `${path}:parameter:${index}`,
        name,
        index,
      }));
    });
    this.temporaries = new Map();
    this.captures = new Map();
    if (!parent) {
      for (const [name, id] of rootCaptures) {
        this.captures.set(name, Object.freeze({id, name, source: null, mutable: false}));
      }
    }
  }

  // Declared before the statements are compiled, so `| total | total := 0` resolves.
  declareTemporaries(names) {
    names.forEach((name, index) => {
      if (this.parameters.has(name)) {
        throw new TypeError(`temporary ${name} shadows a parameter of the same activation`);
      }
      this.temporaries.set(name, Object.freeze({
        id: `${this.path}:temporary:${index}`,
        name,
      }));
    });
  }

  // Compiler-introduced bindings the source cannot name or collide with — `$` is not an identifier
  // character, so nothing reachable through `resolveName` ever reads one. A cascade uses these for
  // the shared receiver and the first message's answer.
  declareHiddenTemporary(key) {
    if (this.temporaries.has(key)) throw new TypeError(`duplicate hidden temporary ${key}`);
    const id = `${this.path}:${key}`;
    this.temporaries.set(key, Object.freeze({id, name: key}));
    return id;
  }

  addCapture(key, provided) {
    if (!this.captures.has(key)) {
      this.captures.set(key, Object.freeze({
        id: provided.id,
        name: provided.name,
        source: provided.value,
        mutable: provided.mutable === true,
      }));
    }
    return this.captures.get(key);
  }

  // ADR 0050 decision 3: lexical bindings first, and the instance variable only where resolution
  // would otherwise raise `unbound Symmetric Smalltalk name` — never earlier. A parameter named `x`
  // therefore shadows an instance variable named `x`.
  instanceSlot(name) {
    return this.instanceVariables.get(name) ?? null;
  }

  // Built in the *originating* scope, so `self` and the primitive capture resolve through this
  // scope's own chain. That is what makes an instance variable inside a nested Block mean the
  // defining method's receiver (ADR 0050 decision 10).
  canReturn() {
    return this.methodHome === true;
  }

  instanceSlotRead(slotId) {
    return Object.freeze({
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: this.resolveName(INSTANCE_SLOT_READ_CAPTURE),
      message: textValue('value:value:'),
      arguments: Object.freeze([this.resolveSelf(), Object.freeze({op: 'literal', value: textValue(slotId)})]),
    });
  }

  // ADR 0055. `^ expr` lowers to `$nonLocalReturn value: expr` — an ordinary send, so
  // `lagrange-code` gains no operation for it. `resolveName` walks the capture chain exactly as it
  // does for the slot primitives, so a nested Block inherits the binding by ordinary propagation.
  rootScope() {
    let scope = this;
    while (scope.parent) scope = scope.parent;
    return scope;
  }

  // Seeds the reserved binding at the root the first time a `^` is lowered, then resolves it by the
  // ordinary capture walk — so a nested Block inherits it exactly as it inherits anything else.
  requireIntrinsic(name) {
    const root = this.rootScope();
    const id = root.intrinsics.get(name);
    if (!id) throw new TypeError(`no ${name} intrinsic is available in this compilation`);
    if (!root.captures.has(name)) {
      root.captures.set(name, Object.freeze({id, name, source: null, mutable: false}));
    }
    return this.resolveName(name);
  }

  nonLocalReturn(valueExpression) {
    return Object.freeze({
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: this.requireIntrinsic(NON_LOCAL_RETURN_CAPTURE),
      message: textValue('value:'),
      arguments: Object.freeze([valueExpression]),
    });
  }

  instanceSlotWrite(slotId, valueExpression) {
    return Object.freeze({
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: this.resolveName(INSTANCE_SLOT_WRITE_CAPTURE),
      message: textValue('value:value:value:'),
      arguments: Object.freeze([
        this.resolveSelf(),
        Object.freeze({op: 'literal', value: textValue(slotId)}),
        valueExpression,
      ]),
    });
  }

  resolveName(name) {
    const parameter = this.parameters.get(name);
    if (parameter) return Object.freeze({op: 'argument', index: parameter.index});
    const temporary = this.temporaries.get(name);
    if (temporary) return Object.freeze({op: 'binding', id: temporary.id});
    const capture = this.captures.get(name);
    if (capture) return Object.freeze({op: 'binding', id: capture.id});
    const provided = this.parent ? this.parent.provideName(name) : null;
    if (provided) return Object.freeze({op: 'binding', id: this.addCapture(name, provided).id});
    const slotId = this.instanceSlot(name);
    if (slotId) return this.instanceSlotRead(slotId);
    // Class variables resolve after instance variables and before globals. A subclass method
    // can read an ancestor's class var; an unrelated class cannot resolve it by name.
    const classVar = this.resolveClassVariable(name);
    if (classVar) return classVar;
    // Globals resolve LAST, so no future publication can change what a name already means inside a
    // method that binds it lexically or as an instance variable.
    const global = this.resolveGlobal(name);
    if (global) return global;
    throw new TypeError(`unbound Symmetric Smalltalk name: ${name}`);
  }

  // A global read is a `value` send to the binding — an ordinary send, so `lagrange-code` gains
  // nothing. The capture is requested on first use, so a method mentioning no global carries none,
  // and a nested Block that is the only user still acquires it through the ordinary capture walk.
  resolveGlobal(name) {
    const bindingId = this.globals.get(name);
    if (!bindingId) return null;
    const root = this.rootScope();

    // An explicit caller capture must not silently share a durable binding id with a resolved
    // global: two different meanings collapsing onto one environment key is exactly the sort of
    // aliasing that answers the wrong object.
    for (const [key, capture] of root.captures) {
      if (capture.id === bindingId && !key.startsWith(GLOBAL_CAPTURE_PREFIX)) {
        throw new TypeError(`capture ${key} collides with the global binding id ${bindingId}`);
      }
    }

    // Keyed by the *binding*, not by the source name. Keying by name would make the capture shadow
    // the global on every later read — `resolveName` finds a capture before it reaches global
    // resolution, so the second `Array` in a method would answer the binding object rather than the
    // class. It also makes an alias free: two names resolving to one binding share one capture,
    // which the closed capture grammar requires.
    const key = `${GLOBAL_CAPTURE_PREFIX}${bindingId}`;
    this.globalsUsed.add(bindingId);
    if (!root.captures.has(key)) {
      root.captures.set(key, Object.freeze({id: bindingId, name, source: null, mutable: false}));
    }
    return Object.freeze({
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: this.resolveName(key),
      message: textValue('value'),
      arguments: Object.freeze([]),
    });
  }

  // A class-variable read is a `value` send to the binding — an ordinary send, exactly like a
  // global read. The capture is keyed by the binding identity, not the source name.
  resolveClassVariable(name) {
    const bindingId = this.classVariables.get(name);
    if (!bindingId) return null;
    const root = this.rootScope();

    // Same collision check as globals: an explicit caller capture must not silently share a
    // durable binding id with a resolved class variable.
    for (const [key, capture] of root.captures) {
      if (capture.id === bindingId && !key.startsWith(CLASS_VAR_CAPTURE_PREFIX)) {
        throw new TypeError(`capture ${key} collides with the class-variable binding id ${bindingId}`);
      }
    }

    const key = `${CLASS_VAR_CAPTURE_PREFIX}${bindingId}`;
    this.classVarsUsed.add(bindingId);
    if (!root.captures.has(key)) {
      root.captures.set(key, Object.freeze({id: bindingId, name, source: null, mutable: false}));
    }
    return Object.freeze({
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: this.resolveName(key),
      message: textValue('value'),
      arguments: Object.freeze([]),
    });
  }

  // A class-variable write is a `value:` send to the binding — an ordinary send. Unlike globals,
  // class variables are mutable shared state, so assignment lowers to `value: newValue`.
  resolveClassVariableWrite(name, valueExpression) {
    const bindingId = this.classVariables.get(name);
    if (!bindingId) return null;
    const root = this.rootScope();

    for (const [key, capture] of root.captures) {
      if (capture.id === bindingId && !key.startsWith(CLASS_VAR_CAPTURE_PREFIX)) {
        throw new TypeError(`capture ${key} collides with the class-variable binding id ${bindingId}`);
      }
    }

    const key = `${CLASS_VAR_CAPTURE_PREFIX}${bindingId}`;
    this.classVarsUsed.add(bindingId);
    if (!root.captures.has(key)) {
      root.captures.set(key, Object.freeze({id: bindingId, name, source: null, mutable: false}));
    }
    return Object.freeze({
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: this.resolveName(key),
      message: textValue('value:'),
      arguments: Object.freeze([valueExpression]),
    });
  }

  // Assignment needs a cell, so only a temporary — or a capture that resolves to one — qualifies.
  // Parameters and the receiver are not assignable, and a root capture names a durable environment
  // binding rather than a cell, which ADR 0043 decision 2 keeps out of assignment's reach.
  // Resolution finds the binding *first* and checks write legality *second*; it never keeps
  // searching for something assignable. So a parameter named `x` shadows an instance variable named
  // `x` for writes too, and `x := 5` stays illegal rather than becoming a slot write.
  resolveWrite(name) {
    if (this.parameters.has(name)) throw new TypeError(`cannot assign to parameter ${name}`);
    const temporary = this.temporaries.get(name);
    if (temporary) return {kind: 'binding', id: temporary.id};
    const existing = this.captures.get(name);
    if (existing) {
      if (!existing.mutable) throw new TypeError(`cannot assign to captured binding ${name}`);
      return {kind: 'binding', id: existing.id};
    }
    const provided = this.parent ? this.parent.provideName(name) : null;
    if (provided) {
      if (provided.mutable !== true) throw new TypeError(`cannot assign to captured binding ${name}`);
      return {kind: 'binding', id: this.addCapture(name, provided).id};
    }
    const slotId = this.instanceSlot(name);
    if (slotId) return {kind: 'instance', slotId};
    // Class variables are writable: assignment lowers to a `value:` send on the binding.
    if (this.classVariables.has(name)) {
      return {kind: 'classVariable', name};
    }
    // ADR 0057: assignment never reaches a global, and the check sits *last* so it matches the read
    // order — a temporary or instance variable of the same name shadows a global for writes exactly
    // as it does for reads. A known global then gets a diagnosis saying what is actually wrong,
    // rather than being reported as an unbound name; nothing is lowered and no setter exists.
    if (this.globals.has(name)) {
      throw new TypeError(`global assignment is not supported: ${name}`);
    }
    throw new TypeError(`unbound Symmetric Smalltalk name: ${name}`);
  }

  resolveSelf() {
    if (!this.parent) return Object.freeze({op: 'receiver'});
    const provided = this.parent.provideSelf();
    const capture = this.addCapture('$self', provided);
    return Object.freeze({op: 'binding', id: capture.id});
  }

  provideName(name) {
    const parameter = this.parameters.get(name);
    if (parameter) {
      return Object.freeze({
        id: parameter.id,
        name: parameter.name,
        mutable: false,
        value: Object.freeze({op: 'argument', index: parameter.index}),
      });
    }
    // A temporary is the one thing a nested Block must reach by cell rather than by snapshot.
    const temporary = this.temporaries.get(name);
    if (temporary) {
      return Object.freeze({
        id: temporary.id,
        name: temporary.name,
        mutable: true,
        value: Object.freeze({op: 'binding', id: temporary.id}),
      });
    }
    const capture = this.captures.get(name);
    if (capture) {
      return Object.freeze({
        id: capture.id,
        name: capture.name,
        mutable: capture.mutable,
        value: Object.freeze({op: 'binding', id: capture.id}),
      });
    }
    if (!this.parent) return null;
    // Ask upward directly rather than going through `resolveName`. Since ADR 0050 `resolveName` may
    // answer an *instance variable* — an expression, not a capture — and then there is nothing here
    // for a descendant to capture. Answering null in that case is right: the originating scope
    // resolves the instance variable itself, which is what makes the read reach the defining
    // method's receiver from any depth.
    const provided = this.parent.provideName(name);
    if (!provided) return null;
    const inherited = this.addCapture(name, provided);
    return Object.freeze({
      id: inherited.id,
      name: inherited.name,
      mutable: inherited.mutable,
      value: Object.freeze({op: 'binding', id: inherited.id}),
    });
  }

  provideSelf() {
    if (!this.parent) {
      return Object.freeze({
        id: `${this.path}:self`,
        name: 'self',
        mutable: false,
        value: Object.freeze({op: 'receiver'}),
      });
    }
    this.resolveSelf();
    const capture = this.captures.get('$self');
    return Object.freeze({
      id: capture.id,
      name: capture.name,
      mutable: capture.mutable,
      value: Object.freeze({op: 'binding', id: capture.id}),
    });
  }

  parameterDescriptors() {
    return Object.freeze([...this.parameters.values()].map(({id, name}) => Object.freeze({id, name})));
  }

  temporaryDescriptors() {
    return Object.freeze([...this.temporaries.values()].map(({id, name}) => Object.freeze({id, name})));
  }

  captureDescriptors(representation) {
    return Object.freeze([...this.captures.values()].map(({id, name, mutable}) => (
      representation === LAGRANGE_CODE_V1
        ? Object.freeze({id, mode: mutable ? 'cell' : 'snapshot', name})
        : Object.freeze({id, name})
    )));
  }

  // What the enclosing activation must supply when it creates the Block. A cell-mode capture
  // deliberately carries no value expression: there is nothing to evaluate, which is what stops a
  // snapshot reappearing under a different name.
  captureInitializers(representation) {
    const entries = [...this.captures.values()].filter(({source}) => source !== null);
    return Object.freeze(entries.map(({id, name, source, mutable}) => {
      if (representation !== LAGRANGE_CODE_V1) return Object.freeze({id, name, value: source});
      return mutable
        ? Object.freeze({id, mode: 'cell', name})
        : Object.freeze({id, mode: 'snapshot', name, value: source});
    }));
  }
}

// `receiverExpression` is already lowered: cascades compile their receiver once into a hidden
// temporary and hand every message the same binding read.
function compileSend(receiverExpression, selector, args, scope, state) {
  return Object.freeze({
    op: 'send',
    languageId: SYMMETRIC_SMALLTALK_ID,
    receiver: receiverExpression,
    message: textValue(selector),
    arguments: Object.freeze(args.map((entry) => compileExpression(entry, scope, state))),
  });
}

function compileExpression(syntax, scope, state) {
  switch (syntax.kind) {
    case 'integer':
      return Object.freeze({op: 'literal', value: integerValue(syntax.value)});
    case 'string':
      return Object.freeze({op: 'literal', value: textValue(syntax.value)});
    case 'self':
      return scope.resolveSelf();
    // ADR 0056 decision 1: the canonical boolean Values themselves, not the kernel singletons. The
    // singleton is only ever a *dispatch* personality (ADR 0045), so compiling the literal to a ref
    // would undo that separation at the source level.
    case 'true':
      return Object.freeze({op: 'literal', value: booleanValue(true)});
    case 'false':
      return Object.freeze({op: 'literal', value: booleanValue(false)});
    // Requested lazily, so a program that never writes `nil` carries no binding for it and its
    // installer writes no environment (ADR 0055's rule, applied again).
    case 'nil':
      return scope.requireIntrinsic(NIL_CAPTURE);
    // A symbol literal lowers to an ordinary send of the canonical spelling to the interner
    // primitive, reached through the intrinsic capture walk. The artifact carries only the
    // spelling as a Text literal — no image-specific Symbol ref, no new lagrange-code op.
    case 'symbol':
      return Object.freeze({
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: scope.requireIntrinsic(SYMBOL_CAPTURE),
        message: textValue('value:'),
        arguments: Object.freeze([Object.freeze({op: 'literal', value: textValue(syntax.value)})]),
      });
    case 'name':
      return scope.resolveName(syntax.name);
    case 'return': {
      // A Block compiled with no method context has no home to return from, and never could have —
      // that is a fact about the compilation, so it is reported here rather than at invocation. It
      // is deliberately distinct from an escaped method Block, which compiled legitimately and
      // fails later because its home died.
      if (!scope.canReturn()) {
        throw new TypeError('non-local return requires a method home: `^` is only valid inside a method');
      }
      return scope.nonLocalReturn(compileExpression(syntax.value, scope, state));
    }
    case 'assign': {
      const target = scope.resolveWrite(syntax.name);
      const value = compileExpression(syntax.value, scope, state);
      if (target.kind === 'instance') return scope.instanceSlotWrite(target.slotId, value);
      if (target.kind === 'classVariable') return scope.resolveClassVariableWrite(target.name, value);
      return Object.freeze({op: 'binding-write', id: target.id, value});
    }
    case 'send':
      return compileSend(
        compileExpression(syntax.receiver, scope, state), syntax.selector, syntax.arguments, scope, state,
      );
    // `receiver m1; m2; m3` lowers to ordinary v1 state and sends — the IR gains no cascade op:
    //
    //   $recv := <receiver>.
    //   $first := $recv m1.
    //   $recv m2.
    //   $recv m3.
    //   $first
    //
    // which is exactly the cascade contract: the receiver is evaluated once, every message goes to
    // that object in source order, and the cascade answers the first message's value. Hidden
    // temporaries carry both, so nothing the source wrote is rewritten and no name can collide.
    case 'cascade': {
      const receiverId = scope.declareHiddenTemporary(`$cascadeReceiver:${state.nextCascade}`);
      const answerId = scope.declareHiddenTemporary(`$cascadeAnswer:${state.nextCascade}`);
      state.nextCascade += 1;
      const receiverRead = Object.freeze({op: 'binding', id: receiverId});
      const statements = [
        Object.freeze({
          op: 'binding-write',
          id: receiverId,
          value: compileExpression(syntax.receiver, scope, state),
        }),
        ...syntax.messages.map(({selector, arguments: args}, index) => {
          const send = compileSend(receiverRead, selector, args, scope, state);
          return index === 0
            ? Object.freeze({op: 'binding-write', id: answerId, value: send})
            : send;
        }),
        Object.freeze({op: 'binding', id: answerId}),
      ];
      return Object.freeze({op: 'sequence', statements: Object.freeze(statements)});
    }
    case 'block': {
      const blockId = `${state.path}/block:${state.nextBlock}`;
      state.nextBlock += 1;
      const nested = compileBlockSyntax(syntax, {
        parent: scope,
        path: blockId,
        representation: state.representation,
      });
      return Object.freeze({
        op: 'block',
        blockId,
        captures: nested.captureInitializers,
        program: nested.program,
      });
    }
    // Temporaries belong to the activation, so a sequence is only ever a Block body and is
    // compiled by compileBlockSyntax. Reaching here would mean a scope had gone missing.
    case 'sequence':
      throw new TypeError('a statement sequence may only appear as a block body');
    default:
      throw new TypeError(`unsupported Symmetric Smalltalk syntax kind: ${syntax.kind}`);
  }
}

function compileBody(syntax, scope, state) {
  if (syntax.kind !== 'sequence') return compileExpression(syntax, scope, state);
  scope.declareTemporaries(syntax.temporaries);
  const statements = Object.freeze(syntax.statements.map((statement) => compileExpression(statement, scope, state)));
  return statements.length === 1 ? statements[0] : Object.freeze({op: 'sequence', statements});
}

function compileBlockSyntax(syntax, {
  parent = null,
  path = 'root',
  rootCaptures = new Map(),
  instanceVariables = new Map(),
  representation = LAGRANGE_CODE_V0,
  methodHome = false,
  intrinsics = new Map(),
  globals = new Map(),
  classVariables = new Map(),
} = {}) {
  const scope = new SemanticScope({
    parent, path, parameters: syntax.parameters, rootCaptures, instanceVariables, methodHome,
    intrinsics, globals, classVariables,
  });
  const state = {path, nextBlock: 0, nextCascade: 0, representation};
  const body = compileBody(syntax.body, scope, state);
  const program = representation === LAGRANGE_CODE_V1
    ? Object.freeze({
      parameters: scope.parameterDescriptors(),
      temporaries: scope.temporaryDescriptors(),
      captures: scope.captureDescriptors(representation),
      body,
    })
    : Object.freeze({
      parameters: scope.parameterDescriptors(),
      captures: scope.captureDescriptors(representation),
      body,
    });
  return Object.freeze({
    program,
    captureInitializers: scope.captureInitializers(representation),
    globalBindingIdsUsed: Object.freeze([...scope.globalsUsed]),
    classVariableBindingIdsUsed: Object.freeze([...scope.classVarsUsed]),
  });
}

function compileSymmetricSmalltalkSemanticBlock(source, {
  captures = {}, instanceVariables = {}, methodHome = false, intrinsics = {}, globals = {},
  classVariables = {},
} = {}) {
  // ADR 0056: `nil` is the compiler's own intrinsic, so it is supplied here rather than by each
  // caller. Centralised for two reasons — every Symmetric Smalltalk compilation can write `nil`
  // whatever entry point it came through, and no caller can redefine what `nil` means. A caller may
  // still add intrinsics of its own; it may not replace this one, and saying so beats silently
  // winning an ordering race with it.
  if (Object.hasOwn(intrinsics, NIL_CAPTURE)) {
    throw new TypeError(`the ${NIL_CAPTURE} intrinsic is owned by the compiler and cannot be replaced`);
  }
  if (Object.hasOwn(intrinsics, SYMBOL_CAPTURE)) {
    throw new TypeError(`the ${SYMBOL_CAPTURE} intrinsic is owned by the compiler and cannot be replaced`);
  }
  const syntax = parseSymmetricSmalltalkBlock(source);
  const representation = selectSemanticRepresentation(syntax);
  const compiled = compileBlockSyntax(syntax, {
    path: 'root',
    rootCaptures: normalizeRootCaptures(captures),
    instanceVariables: new Map(Object.entries(instanceVariables)),
    representation,
    methodHome,
    intrinsics: new Map([
      ...Object.entries(intrinsics),
      [NIL_CAPTURE, NIL_BINDING_ID],
      [SYMBOL_CAPTURE, SYMBOL_BINDING_ID],
    ]),
    globals: new Map(Object.entries(globals)),
    classVariables: new Map(Object.entries(classVariables)),
  });
  return Object.freeze({
    syntax,
    program: compiled.program,
    representation,
    globalBindingIdsUsed: compiled.globalBindingIdsUsed,
    classVariableBindingIdsUsed: compiled.classVariableBindingIdsUsed,
  });
}

export {
  CLASS_VAR_CAPTURE_PREFIX,
  INSTANCE_SLOT_READ_CAPTURE,
  NIL_BINDING_ID,
  NIL_CAPTURE,
  NON_LOCAL_RETURN_CAPTURE,
  INSTANCE_SLOT_WRITE_CAPTURE,
  SYMBOL_BINDING_ID,
  SYMBOL_CAPTURE,
  compileSymmetricSmalltalkSemanticBlock,
  needsMutableLexicalState,
  selectSemanticRepresentation,
};
