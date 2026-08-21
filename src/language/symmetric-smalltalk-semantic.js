import {integerValue, textValue} from '../value/index.js';
import {LAGRANGE_CODE_V0} from '../code/lagrange-code-v0.js';
import {LAGRANGE_CODE_V1} from '../code/lagrange-code-v1.js';
import {parseSymmetricSmalltalkBlock} from './symmetric-smalltalk-parser.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

function normalizeRootCaptures(captures) {
  if (!captures || typeof captures !== 'object' || Array.isArray(captures)) {
    throw new TypeError('captures must be an object mapping source name to stable binding id');
  }
  const result = new Map();
  const ids = new Set();
  for (const [name, id] of Object.entries(captures)) {
    if (!name) throw new TypeError('capture name must not be empty');
    if (typeof id !== 'string' || id.length === 0) throw new TypeError(`capture binding id for ${name} must be non-empty text`);
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
    case 'send':
      return needsMutableLexicalState(syntax.receiver)
        || syntax.arguments.some((argument) => needsMutableLexicalState(argument));
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
const INSTANCE_SLOT_WRITE_CAPTURE = '$instanceSlotWrite';

class SemanticScope {
  constructor({
    parent = null, path, parameters = [], rootCaptures = new Map(), instanceVariables = new Map(),
    methodHome = false,
  } = {}) {
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
  nonLocalReturn(valueExpression) {
    return Object.freeze({
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: this.resolveName(NON_LOCAL_RETURN_CAPTURE),
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
    throw new TypeError(`unbound Symmetric Smalltalk name: ${name}`);
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

function compileExpression(syntax, scope, state) {
  switch (syntax.kind) {
    case 'integer':
      return Object.freeze({op: 'literal', value: integerValue(syntax.value)});
    case 'string':
      return Object.freeze({op: 'literal', value: textValue(syntax.value)});
    case 'self':
      return scope.resolveSelf();
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
      return target.kind === 'instance'
        ? scope.instanceSlotWrite(target.slotId, value)
        : Object.freeze({op: 'binding-write', id: target.id, value});
    }
    case 'send':
      return Object.freeze({
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: compileExpression(syntax.receiver, scope, state),
        message: textValue(syntax.selector),
        arguments: Object.freeze(syntax.arguments.map((entry) => compileExpression(entry, scope, state))),
      });
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
} = {}) {
  const scope = new SemanticScope({
    parent, path, parameters: syntax.parameters, rootCaptures, instanceVariables, methodHome,
  });
  const state = {path, nextBlock: 0, representation};
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
  });
}

function compileSymmetricSmalltalkSemanticBlock(source, {
  captures = {}, instanceVariables = {}, methodHome = false,
} = {}) {
  const syntax = parseSymmetricSmalltalkBlock(source);
  const representation = selectSemanticRepresentation(syntax);
  const compiled = compileBlockSyntax(syntax, {
    path: 'root',
    rootCaptures: normalizeRootCaptures(captures),
    instanceVariables: new Map(Object.entries(instanceVariables)),
    representation,
    methodHome,
  });
  return Object.freeze({syntax, program: compiled.program, representation});
}

export {
  INSTANCE_SLOT_READ_CAPTURE,
  NON_LOCAL_RETURN_CAPTURE,
  INSTANCE_SLOT_WRITE_CAPTURE,
  compileSymmetricSmalltalkSemanticBlock,
  needsMutableLexicalState,
  selectSemanticRepresentation,
};
