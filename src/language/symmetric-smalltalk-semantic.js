import {integerValue, textValue} from '../value/index.js';
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

class SemanticScope {
  constructor({parent = null, path, parameters = [], rootCaptures = new Map()} = {}) {
    this.parent = parent;
    this.path = path;
    this.parameters = new Map();
    parameters.forEach((name, index) => {
      this.parameters.set(name, Object.freeze({
        id: `${path}:parameter:${index}`,
        name,
        index,
      }));
    });
    this.captures = new Map();
    if (!parent) {
      for (const [name, id] of rootCaptures) {
        this.captures.set(name, Object.freeze({id, name, source: null}));
      }
    }
  }

  addCapture(key, provided) {
    if (!this.captures.has(key)) {
      this.captures.set(key, Object.freeze({
        id: provided.id,
        name: provided.name,
        source: provided.value,
      }));
    }
    return this.captures.get(key);
  }

  resolveName(name) {
    const parameter = this.parameters.get(name);
    if (parameter) return Object.freeze({op: 'argument', index: parameter.index});
    const capture = this.captures.get(name);
    if (capture) return Object.freeze({op: 'binding', id: capture.id});
    if (!this.parent) throw new TypeError(`unbound Symmetric Smalltalk name: ${name}`);
    const provided = this.parent.provideName(name);
    if (!provided) throw new TypeError(`unbound Symmetric Smalltalk name: ${name}`);
    const added = this.addCapture(name, provided);
    return Object.freeze({op: 'binding', id: added.id});
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
        value: Object.freeze({op: 'argument', index: parameter.index}),
      });
    }
    const capture = this.captures.get(name);
    if (capture) {
      return Object.freeze({
        id: capture.id,
        name: capture.name,
        value: Object.freeze({op: 'binding', id: capture.id}),
      });
    }
    if (!this.parent) return null;
    this.resolveName(name);
    const inherited = this.captures.get(name);
    return Object.freeze({
      id: inherited.id,
      name: inherited.name,
      value: Object.freeze({op: 'binding', id: inherited.id}),
    });
  }

  provideSelf() {
    if (!this.parent) {
      return Object.freeze({
        id: `${this.path}:self`,
        name: 'self',
        value: Object.freeze({op: 'receiver'}),
      });
    }
    this.resolveSelf();
    const capture = this.captures.get('$self');
    return Object.freeze({
      id: capture.id,
      name: capture.name,
      value: Object.freeze({op: 'binding', id: capture.id}),
    });
  }

  parameterDescriptors() {
    return Object.freeze([...this.parameters.values()].map(({id, name}) => Object.freeze({id, name})));
  }

  captureDescriptors() {
    return Object.freeze([...this.captures.values()].map(({id, name}) => Object.freeze({id, name})));
  }

  captureInitializers() {
    return Object.freeze([...this.captures.values()]
      .filter(({source}) => source !== null)
      .map(({id, name, source}) => Object.freeze({id, name, value: source})));
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
      const nested = compileBlockSyntax(syntax, {parent: scope, path: blockId});
      return Object.freeze({
        op: 'block',
        blockId,
        captures: nested.captureInitializers,
        program: nested.program,
      });
    }
    default:
      throw new TypeError(`unsupported Symmetric Smalltalk syntax kind: ${syntax.kind}`);
  }
}

function compileBlockSyntax(syntax, {parent = null, path = 'root', rootCaptures = new Map()} = {}) {
  const scope = new SemanticScope({parent, path, parameters: syntax.parameters, rootCaptures});
  const state = {path, nextBlock: 0};
  const body = compileExpression(syntax.body, scope, state);
  return Object.freeze({
    program: Object.freeze({
      parameters: scope.parameterDescriptors(),
      captures: scope.captureDescriptors(),
      body,
    }),
    captureInitializers: scope.captureInitializers(),
  });
}

function compileSymmetricSmalltalkSemanticBlock(source, {captures = {}} = {}) {
  const syntax = parseSymmetricSmalltalkBlock(source);
  const compiled = compileBlockSyntax(syntax, {
    path: 'root',
    rootCaptures: normalizeRootCaptures(captures),
  });
  return Object.freeze({syntax, program: compiled.program});
}

export {compileSymmetricSmalltalkSemanticBlock};
