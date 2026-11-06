import {uuid as randomUUID} from '../support/default-crypto.js';
import {base64urlEncode, utf8Encode} from '../support/portable-bytes.js';
import {LAGRANGE_CODE_V2} from '../code/lagrange-code-v1.js';
import {CompilationService, createDefaultCodeCompilerRegistry} from '../compilation/index.js';
import {NEUTRAL_EXPRESSION_V2} from '../execution/neutral-expression-v1.js';
import {
  ensureBlock,
  ensureCodeArtifact,
  ensureLexicalEnvironment,
  ensureObject,
} from '../graph/ensure-records.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {
  VALUE_KIND,
  canonicalizeValue,
  integerValue,
  isObjectRef,
  objectRef,
  textValue,
} from '../value/index.js';
import {installWasmV1BlockTree} from '../wasm/tree-installer-v1.js';
import {installSmalltalkAllocationProtocol} from './smalltalk-allocation.js';
import {
  assertMethodLane,
  defineMethods,
  definePolyglotMethodBridge,
  ensureNamedClass,
  ensureSmalltalkShape,
} from './smalltalk-class-builder.js';
import {
  CONDITION_CLASSES,
  installSmalltalkConditionProtocol,
  installSmalltalkExceptionAccessors,
} from './smalltalk-conditions.js';
import {installSmalltalkControlFlow} from './smalltalk-control-flow.js';
import {installSmalltalkEqualityProtocol} from './smalltalk-dictionary.js';
import {
  NAMESPACE_OBJECT_ID,
  createNamespace,
  findNamespace,
  globalDeclarations,
  installSmalltalkGlobalNamespace,
  publishGlobal,
  publishSmalltalkClassGlobals,
  rebindGlobal,
  resolveGlobal,
} from './smalltalk-globals.js';
import {installSmalltalkIndexedProtocol} from './smalltalk-indexed.js';
import {
  defineMethodsFromSource,
  installSmalltalkInstanceVariableProtocol,
} from './smalltalk-instance-variables.js';
import {installSmalltalkIntegerProtocol} from './smalltalk-integer.js';
import {findSmalltalkKernel, installSmalltalkKernel} from './smalltalk-kernel.js';
import {sameRef} from './smalltalk-lookup.js';
import {executableTargetFor, installNestedPrototypes} from './smalltalk-nested-blocks.js';
import {
  SYMBOL_CLASS_NAME,
  SYMBOL_SHAPE_ID,
  SYMBOL_SPELLING_SLOT,
  symbolObjectId,
} from './smalltalk-primitives-symbol.js';
import {installSmalltalkSymbolProtocol} from './smalltalk-symbol.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

const COMMON_LISP_ID = 'common-lisp';
const COMMON_LISP_SOURCE_V0 = 'common-lisp/source-v0';
const COMMON_LISP_SYNTAX_V0 = 'common-lisp/syntax-v0';
const COMMON_LISP_NAMESPACE_ID = 'common-lisp/namespace/v1';
const CONS_CLASS_NAME = 'Cons';
const CONS_SHAPE_ID = 'smalltalk/cons-instance-shape/v1';
const BLOCK_CLOSURE_CLASS_NAME = 'BlockClosure';

const COMMON_LISP = Object.freeze({
  id: COMMON_LISP_ID,
  name: 'Common Lisp',
  version: '0.1.0',
});

const CL_NIL_BINDING_ID = 'common-lisp/nil';
const CL_T_BINDING_ID = 'common-lisp/t';
const CL_SYMBOL_INTERN_ID = 'smalltalk/primitive/symbol-intern';

const RUNTIME_BLOCK_IDS = Object.freeze({
  CONS: 'common-lisp/runtime/cons',
  CAR: 'common-lisp/runtime/car',
  CDR: 'common-lisp/runtime/cdr',
  RPLACA: 'common-lisp/runtime/rplaca',
  RPLACD: 'common-lisp/runtime/rplacd',
  CONSP: 'common-lisp/runtime/consp',
  ATOM: 'common-lisp/runtime/atom',
  SYMBOLP: 'common-lisp/runtime/symbolp',
  LISTP: 'common-lisp/runtime/listp',
  FUNCTIONP: 'common-lisp/runtime/functionp',
  INTEGERP: 'common-lisp/runtime/integerp',
  STRINGP: 'common-lisp/runtime/stringp',
  NULL: 'common-lisp/runtime/null',
  EQ: 'common-lisp/runtime/eq',
  EQUAL: 'common-lisp/runtime/equal',
  ADD: 'common-lisp/runtime/add',
  SUB: 'common-lisp/runtime/sub',
  MUL: 'common-lisp/runtime/mul',
  FLOOR: 'common-lisp/runtime/floor',
  MOD: 'common-lisp/runtime/mod',
  NUM_EQ: 'common-lisp/runtime/num-eq',
  NUM_NEQ: 'common-lisp/runtime/num-neq',
  LT: 'common-lisp/runtime/lt',
  GT: 'common-lisp/runtime/gt',
  LE: 'common-lisp/runtime/le',
  GE: 'common-lisp/runtime/ge',
  INC: 'common-lisp/runtime/1+',
  DEC: 'common-lisp/runtime/1-',
  SIGNAL: 'common-lisp/runtime/signal',
  USE_VALUE: 'common-lisp/runtime/use-value',
  RETURN_FROM_HANDLER: 'common-lisp/runtime/return-from-handler',
});

const RUNTIME_FUNCTION_BY_NAME = Object.freeze({
  CONS: RUNTIME_BLOCK_IDS.CONS,
  CAR: RUNTIME_BLOCK_IDS.CAR,
  CDR: RUNTIME_BLOCK_IDS.CDR,
  FIRST: RUNTIME_BLOCK_IDS.CAR,
  REST: RUNTIME_BLOCK_IDS.CDR,
  RPLACA: RUNTIME_BLOCK_IDS.RPLACA,
  RPLACD: RUNTIME_BLOCK_IDS.RPLACD,
  CONSP: RUNTIME_BLOCK_IDS.CONSP,
  ATOM: RUNTIME_BLOCK_IDS.ATOM,
  SYMBOLP: RUNTIME_BLOCK_IDS.SYMBOLP,
  LISTP: RUNTIME_BLOCK_IDS.LISTP,
  FUNCTIONP: RUNTIME_BLOCK_IDS.FUNCTIONP,
  INTEGERP: RUNTIME_BLOCK_IDS.INTEGERP,
  NUMBERP: RUNTIME_BLOCK_IDS.INTEGERP,
  STRINGP: RUNTIME_BLOCK_IDS.STRINGP,
  NULL: RUNTIME_BLOCK_IDS.NULL,
  NOT: RUNTIME_BLOCK_IDS.NULL,
  EQ: RUNTIME_BLOCK_IDS.EQ,
  EQL: RUNTIME_BLOCK_IDS.EQ,
  EQUAL: RUNTIME_BLOCK_IDS.EQUAL,
  '+': RUNTIME_BLOCK_IDS.ADD,
  '-': RUNTIME_BLOCK_IDS.SUB,
  '*': RUNTIME_BLOCK_IDS.MUL,
  '/': RUNTIME_BLOCK_IDS.FLOOR,
  FLOOR: RUNTIME_BLOCK_IDS.FLOOR,
  TRUNCATE: RUNTIME_BLOCK_IDS.FLOOR,
  MOD: RUNTIME_BLOCK_IDS.MOD,
  REM: RUNTIME_BLOCK_IDS.MOD,
  '=': RUNTIME_BLOCK_IDS.NUM_EQ,
  '/=': RUNTIME_BLOCK_IDS.NUM_NEQ,
  '<': RUNTIME_BLOCK_IDS.LT,
  '>': RUNTIME_BLOCK_IDS.GT,
  '<=': RUNTIME_BLOCK_IDS.LE,
  '>=': RUNTIME_BLOCK_IDS.GE,
  '1+': RUNTIME_BLOCK_IDS.INC,
  '1-': RUNTIME_BLOCK_IDS.DEC,
  SIGNAL: RUNTIME_BLOCK_IDS.SIGNAL,
  ERROR: RUNTIME_BLOCK_IDS.SIGNAL,
  'USE-VALUE': RUNTIME_BLOCK_IDS.USE_VALUE,
  'RETURN-FROM-HANDLER': RUNTIME_BLOCK_IDS.RETURN_FROM_HANDLER,
});

const STANDARD_LIBRARY_SOURCE = `
(defun second (list) (car (cdr list)))
(defun third (list) (car (cdr (cdr list))))
(defun caar (x) (car (car x)))
(defun cadr (x) (car (cdr x)))
(defun cdar (x) (cdr (car x)))
(defun cddr (x) (cdr (cdr x)))

(defun length (list)
  (if (null list)
      0
      (+ 1 (length (cdr list)))))

(defun append (left right)
  (if (null left)
      right
      (cons (car left) (append (cdr left) right))))

(defun %reverse-into (list acc)
  (if (null list)
      acc
      (%reverse-into (cdr list) (cons (car list) acc))))

(defun reverse (list)
  (%reverse-into list nil))

(defun mapcar (fn list)
  (if (null list)
      nil
      (cons (funcall fn (car list))
            (mapcar fn (cdr list)))))

(defun nth (n list)
  (if (<= n 0)
      (car list)
      (nth (- n 1) (cdr list))))

(defun member (item list)
  (if (null list)
      nil
      (if (equal item (car list))
          list
          (member item (cdr list)))))

(defun assoc (key alist)
  (if (null alist)
      nil
      (let ((pair (car alist)))
        (if (and (consp pair) (equal key (car pair)))
            pair
            (assoc key (cdr alist))))))

(defun remove-if (pred list)
  (if (null list)
      nil
      (if (funcall pred (car list))
          (remove-if pred (cdr list))
          (cons (car list) (remove-if pred (cdr list))))))

(defun remove-if-not (pred list)
  (if (null list)
      nil
      (if (funcall pred (car list))
          (cons (car list) (remove-if-not pred (cdr list)))
          (remove-if-not pred (cdr list)))))

(defun reduce (fn list initial)
  (if (null list)
      initial
      (reduce fn (cdr list) (funcall fn initial (car list)))))

(defun every (pred list)
  (if (null list)
      t
      (if (funcall pred (car list))
          (every pred (cdr list))
          nil)))

(defun some (pred list)
  (if (null list)
      nil
      (let ((res (funcall pred (car list))))
        (if res
            res
            (some pred (cdr list))))))
`;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be non-empty text`);
  }
  return value;
}

function commonLispFunctionBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp function name').toUpperCase();
  return `common-lisp/function-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispVariableBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp variable name').toUpperCase();
  return `common-lisp/variable-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispFunctionBlockId(name, revisionKey = null) {
  const canonical = requiredText(name, 'Common Lisp function name').toUpperCase();
  const base = `common-lisp/function/${base64urlEncode(utf8Encode(canonical))}`;
  return revisionKey ? `${base}/rev/${revisionKey}` : base;
}

// -----------------------------------------------------------------------------
// Reader (S-expression tokenizer & parser)
// -----------------------------------------------------------------------------

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDelimiter(ch) {
  return ch === undefined
    || isWhitespace(ch)
    || ch === '('
    || ch === ')'
    || ch === '\''
    || ch === '`'
    || ch === ','
    || ch === '"'
    || ch === ';';
}

function tokenizeCommonLispSource(source) {
  if (typeof source !== 'string') {
    throw new SyntaxError('Common Lisp source must be a string');
  }
  const tokens = [];
  let index = 0;
  const length = source.length;

  while (index < length) {
    const ch = source[index];
    if (isWhitespace(ch)) {
      index += 1;
      continue;
    }
    if (ch === ';') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '#' && source[index + 1] === '|') {
      index += 2;
      let depth = 1;
      while (index < length && depth > 0) {
        if (source[index] === '#' && source[index + 1] === '|') {
          depth += 1;
          index += 2;
        } else if (source[index] === '|' && source[index + 1] === '#') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) throw new SyntaxError('unterminated Common Lisp #| ... |# block comment');
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '\'' || ch === '`') {
      tokens.push({type: ch, value: ch});
      index += 1;
      continue;
    }
    if (ch === ',') {
      if (source[index + 1] === '@') {
        tokens.push({type: ',@', value: ',@'});
        index += 2;
      } else {
        tokens.push({type: ',', value: ','});
        index += 1;
      }
      continue;
    }
    if (ch === '#' && source[index + 1] === '\'') {
      tokens.push({type: '#\'', value: '#\''});
      index += 2;
      continue;
    }
    if (ch === '#' && /[xXbBoO]/.test(source[index + 1] ?? '')) {
      const radixChar = source[index + 1].toLowerCase();
      const prefix = radixChar === 'x' ? '0x' : radixChar === 'b' ? '0b' : '0o';
      index += 2;
      let sign = 1n;
      if (source[index] === '+' || source[index] === '-') {
        if (source[index] === '-') sign = -1n;
        index += 1;
      }
      const start = index;
      while (!isDelimiter(source[index])) index += 1;
      const digits = source.slice(start, index);
      if (digits.length === 0) throw new SyntaxError(`invalid Common Lisp #${radixChar} integer literal`);
      let parsed;
      try {
        parsed = sign * BigInt(`${prefix}${digits}`);
      } catch (error) {
        throw new SyntaxError(`invalid Common Lisp #${radixChar}${digits} integer literal`, {cause: error});
      }
      tokens.push({type: 'integer', value: parsed.toString(10)});
      continue;
    }
    if (ch === '"') {
      index += 1;
      let chars = '';
      let closed = false;
      while (index < length) {
        const cur = source[index];
        if (cur === '"') {
          index += 1;
          closed = true;
          break;
        }
        if (cur === '\\') {
          index += 1;
          if (index >= length) throw new SyntaxError('unterminated string escape in Common Lisp source');
          const esc = source[index];
          if (esc === 'n') chars += '\n';
          else if (esc === 't') chars += '\t';
          else if (esc === 'r') chars += '\r';
          else chars += esc;
          index += 1;
        } else {
          chars += cur;
          index += 1;
        }
      }
      if (!closed) throw new SyntaxError('unterminated string literal in Common Lisp source');
      tokens.push({type: 'string', value: chars});
      continue;
    }

    // Symbol or integer token (supporting |...| pipe escapes)
    let rawChars = '';
    let canonicalChars = '';
    let hasEscape = false;
    while (index < length && !isDelimiter(source[index])) {
      if (source[index] === '|') {
        hasEscape = true;
        index += 1;
        let closedPipe = false;
        while (index < length) {
          if (source[index] === '|') {
            index += 1;
            closedPipe = true;
            break;
          }
          if (source[index] === '\\') {
            index += 1;
            if (index >= length) throw new SyntaxError('unterminated pipe escape in Common Lisp symbol');
          }
          rawChars += source[index];
          canonicalChars += source[index];
          index += 1;
        }
        if (!closedPipe) throw new SyntaxError('unterminated |...| symbol in Common Lisp source');
      } else if (source[index] === '\\') {
        hasEscape = true;
        index += 1;
        if (index >= length) throw new SyntaxError('unterminated character escape in Common Lisp symbol');
        rawChars += source[index];
        canonicalChars += source[index];
        index += 1;
      } else {
        rawChars += source[index];
        canonicalChars += source[index].toUpperCase();
        index += 1;
      }
    }

    if (!hasEscape && rawChars === '.') {
      tokens.push({type: '.', value: '.'});
      continue;
    }
    if (!hasEscape && /^[+-]?[0-9]+$/.test(rawChars)) {
      tokens.push({type: 'integer', value: BigInt(rawChars).toString(10)});
      continue;
    }
    const isKeyword = canonicalChars.startsWith(':') && canonicalChars.length > 1;
    const spelling = isKeyword ? rawChars.slice(1) : rawChars;
    tokens.push({
      type: 'symbol',
      name: canonicalChars,
      spelling,
      keyword: isKeyword,
      escaped: hasEscape,
    });
  }

  return tokens;
}

function makeSymbolNode(name, {spelling = name, keyword = name.startsWith(':') && name.length > 1} = {}) {
  return Object.freeze({
    kind: 'symbol',
    name,
    spelling,
    keyword,
  });
}

function makeListNode(elements, dottedTail = null) {
  if (elements.length === 0 && dottedTail === null) {
    return makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
  }
  return Object.freeze({
    kind: 'list',
    elements: Object.freeze([...elements]),
    dottedTail,
  });
}

function expandQuasiquote(form) {
  if (!form || typeof form !== 'object') return form;
  if (form.kind === 'unquote') return form.expr;
  if (form.kind === 'unquote-splicing') {
    throw new SyntaxError('Common Lisp ,@ (unquote-splicing) is only valid inside a list');
  }
  if (form.kind !== 'list') {
    return makeListNode([makeSymbolNode('QUOTE'), form]);
  }
  if (form.elements.length === 2 && form.elements[0].kind === 'symbol' && form.elements[0].name === 'UNQUOTE') {
    return form.elements[1];
  }
  // Build right-to-left using CONS and APPEND
  let acc = form.dottedTail
    ? expandQuasiquote(form.dottedTail)
    : makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
  for (let i = form.elements.length - 1; i >= 0; i -= 1) {
    const elem = form.elements[i];
    if (elem.kind === 'unquote-splicing') {
      acc = makeListNode([makeSymbolNode('APPEND'), elem.expr, acc]);
    } else {
      acc = makeListNode([makeSymbolNode('CONS'), expandQuasiquote(elem), acc]);
    }
  }
  return acc;
}

function readCommonLispSource(source) {
  const tokens = tokenizeCommonLispSource(source);
  let cursor = 0;

  function readForm() {
    if (cursor >= tokens.length) {
      throw new SyntaxError('unexpected end of Common Lisp input');
    }
    const token = tokens[cursor];
    cursor += 1;

    switch (token.type) {
      case 'integer':
        return Object.freeze({kind: 'integer', value: token.value});
      case 'string':
        return Object.freeze({kind: 'string', value: token.value});
      case 'symbol':
        return makeSymbolNode(token.name, {spelling: token.spelling, keyword: token.keyword});
      case '\'':
        return makeListNode([makeSymbolNode('QUOTE'), readForm()]);
      case '#\'':
        return makeListNode([makeSymbolNode('FUNCTION'), readForm()]);
      case '`':
        return expandQuasiquote(readForm());
      case ',':
        return Object.freeze({kind: 'unquote', expr: readForm()});
      case ',@':
        return Object.freeze({kind: 'unquote-splicing', expr: readForm()});
      case '(': {
        const elements = [];
        let dottedTail = null;
        while (cursor < tokens.length && tokens[cursor].type !== ')') {
          if (tokens[cursor].type === '.') {
            if (elements.length === 0) {
              throw new SyntaxError('Common Lisp dotted pair cannot begin with .');
            }
            cursor += 1;
            dottedTail = readForm();
            if (cursor >= tokens.length || tokens[cursor].type !== ')') {
              throw new SyntaxError('Common Lisp dotted pair must have exactly one form after .');
            }
            break;
          }
          elements.push(readForm());
        }
        if (cursor >= tokens.length || tokens[cursor].type !== ')') {
          throw new SyntaxError('unterminated list in Common Lisp source');
        }
        cursor += 1;
        return makeListNode(elements, dottedTail);
      }
      case ')':
      case '.':
        throw new SyntaxError(`unexpected ${token.type} in Common Lisp source`);
      default:
        throw new SyntaxError(`unknown Common Lisp token: ${token.type}`);
    }
  }

  const forms = [];
  while (cursor < tokens.length) {
    const form = readForm();
    if (form.kind === 'unquote' || form.kind === 'unquote-splicing') {
      throw new SyntaxError('Common Lisp unquote (, or ,@) outside backquote');
    }
    forms.push(form);
  }
  return Object.freeze(forms);
}

// -----------------------------------------------------------------------------
// Semantic Compiler to lagrange-code/v2
// -----------------------------------------------------------------------------

function isNilSymbol(form) {
  return Boolean(form && form.kind === 'symbol' && form.name === 'NIL');
}

function isTSymbol(form) {
  return Boolean(form && form.kind === 'symbol' && form.name === 'T');
}

function collectMutatedVariables(form, mutated = new Set()) {
  if (!form || typeof form !== 'object') return mutated;
  if (form.kind !== 'list') return mutated;
  const [head, ...rest] = form.elements;
  if (head?.kind === 'symbol') {
    if (head.name === 'QUOTE') return mutated;
    if (head.name === 'SETQ') {
      for (let i = 0; i < rest.length; i += 2) {
        const target = rest[i];
        if (target?.kind === 'symbol') mutated.add(target.name);
        if (rest[i + 1]) collectMutatedVariables(rest[i + 1], mutated);
      }
      return mutated;
    }
    if (head.name === 'LABELS') {
      const bindings = rest[0]?.kind === 'list' ? rest[0].elements : [];
      for (const b of bindings) {
        if (b?.kind === 'list' && b.elements[0]?.kind === 'symbol') {
          mutated.add(b.elements[0].name);
        }
      }
    }
  }
  for (const elem of form.elements) collectMutatedVariables(elem, mutated);
  if (form.dottedTail) collectMutatedVariables(form.dottedTail, mutated);
  return mutated;
}

const CONDITION_CLASS_ALIASES = Object.freeze({
  EXCEPTION: 'Exception',
  CONDITION: 'Exception',
  T: 'Exception',
  ERROR: 'Error',
  'ZERO-DIVIDE': 'ZeroDivide',
  ZERODIVIDE: 'ZeroDivide',
  'DIVISION-BY-ZERO': 'ZeroDivide',
  'INDEX-BOUNDS': 'IndexBounds',
  INDEXBOUNDS: 'IndexBounds',
  'INDEX-OUT-OF-RANGE': 'IndexOutOfRange',
  INDEXOUTOFRANGE: 'IndexOutOfRange',
  'EMPTY-COLLECTION': 'EmptyCollection',
  EMPTYCOLLECTION: 'EmptyCollection',
  'KEY-NOT-FOUND': 'KeyNotFound',
  KEYNOTFOUND: 'KeyNotFound',
});

function compileCommonLispSemanticProgram(forms, {
  parameters = [],
  captures = {},
  globals = {},
  functionBindings = {},
  variableBindings = {},
  macros = {},
} = {}) {
  if (!Array.isArray(forms)) {
    throw new TypeError('compileCommonLispSemanticProgram forms must be an array');
  }
  const mutatedNames = new Set();
  for (const form of forms) collectMutatedVariables(form, mutatedNames);

  const globalMap = new Map(Object.entries(globals));
  const globalCaseInsensitive = new Map();
  for (const [k, v] of Object.entries(globals)) {
    globalCaseInsensitive.set(k.toUpperCase(), {name: k, id: v});
  }
  const fnBindingMap = new Map(Object.entries(functionBindings));
  const varBindingMap = new Map(Object.entries(variableBindings));
  const callerCaptureNames = new Map();
  for (const [key, entry] of Object.entries(captures)) {
    const id = typeof entry === 'object' && entry !== null && typeof entry.id === 'string' ? entry.id : key;
    const name = typeof entry === 'object' && entry !== null && typeof entry.name === 'string' ? entry.name : key;
    callerCaptureNames.set(name.toUpperCase(), {id, name});
    callerCaptureNames.set(name, {id, name});
  }

  let nextTempId = 0;
  let nextBlockId = 0;
  const globalBindingIdsUsed = new Set();
  const runtimeBlocksUsed = new Set();
  const internedSymbolsUsed = new Set();

  function freshTemp(prefix = 'tmp') {
    nextTempId += 1;
    const id = `cl:temp:${prefix}:${nextTempId}`;
    return {id, name: `${prefix}_${nextTempId}`};
  }

  function freshBlockId(prefix = 'lambda') {
    nextBlockId += 1;
    return `cl:block:${prefix}:${nextBlockId}`;
  }

  function resolveGlobalName(symNode) {
    if (varBindingMap.has(symNode.name)) {
      const id = varBindingMap.get(symNode.name);
      globalBindingIdsUsed.add(id);
      return {id, name: symNode.name};
    }
    if (globalMap.has(symNode.spelling)) {
      const id = globalMap.get(symNode.spelling);
      globalBindingIdsUsed.add(id);
      return {id, name: symNode.spelling};
    }
    if (globalMap.has(symNode.name)) {
      const id = globalMap.get(symNode.name);
      globalBindingIdsUsed.add(id);
      return {id, name: symNode.name};
    }
    const ci = globalCaseInsensitive.get(symNode.name);
    if (ci) {
      globalBindingIdsUsed.add(ci.id);
      return ci;
    }
    return null;
  }

  function resolveFunctionGlobal(symNode) {
    if (fnBindingMap.has(symNode.name)) {
      const id = fnBindingMap.get(symNode.name);
      globalBindingIdsUsed.add(id);
      return {kind: 'global-binding', id, name: symNode.name};
    }
    if (Object.hasOwn(RUNTIME_FUNCTION_BY_NAME, symNode.name)) {
      const id = RUNTIME_FUNCTION_BY_NAME[symNode.name];
      runtimeBlocksUsed.add(id);
      return {kind: 'runtime-block', id, name: symNode.name};
    }
    const globalEntry = resolveGlobalName(symNode);
    if (globalEntry) {
      return {kind: 'global-binding', id: globalEntry.id, name: globalEntry.name};
    }
    return null;
  }

  function createScope({parent = null, paramNames = []} = {}) {
    const scope = {
      parent,
      params: new Map(),
      locals: new Map(),
      temporaries: [],
      captures: new Map(),
      entryStatements: [],
    };
    paramNames.forEach((rawName, index) => {
      const canonical = String(rawName).toUpperCase();
      if (scope.params.has(canonical)) {
        throw new SyntaxError(`duplicate Common Lisp parameter name: ${rawName}`);
      }
      if (mutatedNames.has(canonical)) {
        const cell = freshTemp(`param_${canonical}`);
        scope.temporaries.push(cell);
        scope.entryStatements.push({
          op: 'binding-write',
          id: cell.id,
          value: {op: 'argument', index},
        });
        scope.locals.set(canonical, {id: cell.id, name: canonical, mutated: true});
      } else {
        scope.params.set(canonical, {
          index,
          id: `cl:param:${index}:${canonical}`,
          name: canonical,
        });
      }
    });
    return scope;
  }

  function declareLocal(scope, symName, {forceMutated = false} = {}) {
    const canonical = String(symName).toUpperCase();
    const temp = freshTemp(canonical.replace(/[^A-Za-z0-9_]/g, '_'));
    const mutated = forceMutated || mutatedNames.has(canonical);
    const entry = {id: temp.id, name: canonical, mutated};
    scope.temporaries.push({id: temp.id, name: temp.name});
    return entry;
  }

  function requireRootCapture(scope, id, name) {
    let cursor = scope;
    const chain = [];
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.parent;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const s = chain[i];
      if (!s.captures.has(id)) {
        s.captures.set(id, {
          id,
          name,
          mode: 'snapshot',
          value: {op: 'binding', id},
        });
      }
    }
    return {op: 'binding', id};
  }

  function refNil(scope) {
    return requireRootCapture(scope, CL_NIL_BINDING_ID, 'nil');
  }

  function refT(scope) {
    return requireRootCapture(scope, CL_T_BINDING_ID, 't');
  }

  function refRuntimeBlock(scope, runtimeId, label = runtimeId) {
    runtimeBlocksUsed.add(runtimeId);
    return requireRootCapture(scope, runtimeId, label);
  }

  function internSymbolExpr(scope, symbolName) {
    const canonical = String(symbolName);
    internedSymbolsUsed.add(canonical);
    const interner = requireRootCapture(scope, CL_SYMBOL_INTERN_ID, '$symbol');
    return {
      op: 'apply',
      callee: interner,
      arguments: [{op: 'literal', value: textValue(canonical)}],
    };
  }

  function lookupLexical(scope, canonicalName) {
    let cursor = scope;
    const crossedScopes = [];
    while (cursor) {
      if (cursor.locals.has(canonicalName)) {
        const local = cursor.locals.get(canonicalName);
        if (crossedScopes.length === 0) {
          return {kind: 'local', id: local.id, name: local.name, mutated: local.mutated};
        }
        const captureMode = local.mutated ? 'cell' : 'snapshot';
        for (let i = crossedScopes.length - 1; i >= 0; i -= 1) {
          const childScope = crossedScopes[i];
          if (!childScope.captures.has(local.id)) {
            childScope.captures.set(
              local.id,
              captureMode === 'cell'
                ? {id: local.id, name: local.name, mode: 'cell'}
                : {id: local.id, name: local.name, mode: 'snapshot', value: {op: 'binding', id: local.id}},
            );
          }
        }
        return {kind: 'captured-local', id: local.id, name: local.name, mutated: local.mutated};
      }
      if (cursor.params.has(canonicalName)) {
        const param = cursor.params.get(canonicalName);
        if (crossedScopes.length === 0) {
          return {kind: 'param', index: param.index, id: param.id, name: param.name, mutated: false};
        }
        for (let i = crossedScopes.length - 1; i >= 0; i -= 1) {
          const childScope = crossedScopes[i];
          const isDirectChild = i === crossedScopes.length - 1;
          if (!childScope.captures.has(param.id)) {
            childScope.captures.set(param.id, {
              id: param.id,
              name: param.name,
              mode: 'snapshot',
              value: isDirectChild
                ? {op: 'argument', index: param.index}
                : {op: 'binding', id: param.id},
            });
          }
        }
        return {kind: 'captured-param', id: param.id, name: param.name, mutated: false};
      }
      crossedScopes.push(cursor);
      cursor = cursor.parent;
    }
    return null;
  }

  function compileQuoted(scope, form) {
    if (form.kind === 'integer') {
      return {op: 'literal', value: integerValue(BigInt(form.value))};
    }
    if (form.kind === 'string') {
      return {op: 'literal', value: textValue(form.value)};
    }
    if (form.kind === 'symbol') {
      if (isNilSymbol(form)) return refNil(scope);
      if (isTSymbol(form)) return refT(scope);
      return internSymbolExpr(scope, form.name);
    }
    if (form.kind === 'list') {
      let acc = form.dottedTail ? compileQuoted(scope, form.dottedTail) : refNil(scope);
      for (let i = form.elements.length - 1; i >= 0; i -= 1) {
        acc = {
          op: 'apply',
          callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.CONS, '$cons'),
          arguments: [compileQuoted(scope, form.elements[i]), acc],
        };
      }
      return acc;
    }
    throw new SyntaxError(`cannot quote unsupported Common Lisp form: ${JSON.stringify(form)}`);
  }

  function compileSequence(scope, exprs) {
    if (exprs.length === 0) return refNil(scope);
    if (exprs.length === 1) return compileForm(scope, exprs[0]);
    return {
      op: 'sequence',
      statements: exprs.map((e) => compileForm(scope, e)),
    };
  }

  function compileTruthBranch(scope, testExpr, thenExpr, elseExpr) {
    return {
      op: 'if',
      condition: {
        op: 'equals',
        left: testExpr,
        right: refNil(scope),
      },
      then: elseExpr,
      else: thenExpr,
    };
  }

  function compileLambdaExpr(parentScope, paramListForm, bodyForms, label = 'lambda') {
    const paramNames = [];
    if (paramListForm.kind === 'symbol' && isNilSymbol(paramListForm)) {
      // () empty parameter list
    } else if (paramListForm.kind === 'list') {
      for (const p of paramListForm.elements) {
        if (p.kind !== 'symbol' || isNilSymbol(p) || isTSymbol(p) || p.keyword) {
          throw new SyntaxError(`Common Lisp lambda parameter must be an ordinary symbol, got ${p?.name ?? p?.kind}`);
        }
        paramNames.push(p.name);
      }
    } else {
      throw new SyntaxError('Common Lisp lambda parameter list must be a list of symbols');
    }

    const childScope = createScope({parent: parentScope, paramNames});
    const compiledBody = compileSequence(childScope, bodyForms);
    const body = childScope.entryStatements.length > 0
      ? {op: 'sequence', statements: [...childScope.entryStatements, compiledBody]}
      : compiledBody;

    const captureDescriptors = [];
    const blockCaptures = [];
    for (const cap of childScope.captures.values()) {
      captureDescriptors.push({id: cap.id, name: cap.name, mode: cap.mode});
      if (cap.mode === 'cell') {
        blockCaptures.push({id: cap.id, name: cap.name, mode: 'cell'});
      } else {
        blockCaptures.push({id: cap.id, name: cap.name, mode: 'snapshot', value: cap.value});
      }
    }

    const blockId = freshBlockId(label);
    return {
      op: 'block',
      blockId,
      captures: blockCaptures,
      program: {
        parameters: paramNames.map((name, idx) => ({id: `cl:param:${idx}:${name.toUpperCase()}`, name: name.toUpperCase()})),
        temporaries: childScope.temporaries,
        captures: captureDescriptors,
        body,
      },
    };
  }

  function compileFunctionRef(scope, target) {
    if (target.kind === 'symbol') {
      const lexical = lookupLexical(scope, target.name);
      if (lexical) {
        return lexical.kind === 'param'
          ? {op: 'argument', index: lexical.index}
          : {op: 'binding', id: lexical.id};
      }
      const fnGlobal = resolveFunctionGlobal(target);
      if (!fnGlobal) {
        throw new SyntaxError(`unbound Common Lisp function: ${target.name}`);
      }
      if (fnGlobal.kind === 'runtime-block') {
        return refRuntimeBlock(scope, fnGlobal.id, target.name);
      }
      const bindingExpr = requireRootCapture(scope, fnGlobal.id, fnGlobal.name);
      return {
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: bindingExpr,
        message: textValue('value'),
        arguments: [],
      };
    }
    if (target.kind === 'list' && target.elements[0]?.kind === 'symbol' && target.elements[0].name === 'LAMBDA') {
      const [, paramForm, ...bodyForms] = target.elements;
      if (!paramForm) throw new SyntaxError('Common Lisp lambda requires a parameter list');
      return compileLambdaExpr(scope, paramForm, bodyForms);
    }
    throw new SyntaxError(`invalid Common Lisp function designator in FUNCTION: ${JSON.stringify(target)}`);
  }

  function resolveConditionClassExpr(scope, typeSym) {
    if (!typeSym || typeSym.kind !== 'symbol') {
      throw new SyntaxError('Common Lisp condition handler type must be a symbol');
    }
    const aliasClass = CONDITION_CLASS_ALIASES[typeSym.name] ?? typeSym.spelling;
    const globalId = globalMap.get(aliasClass)
      ?? globalCaseInsensitive.get(aliasClass.toUpperCase())?.id
      ?? `smalltalk/global-binding/${aliasClass}`;
    globalBindingIdsUsed.add(globalId);
    const bindingExpr = requireRootCapture(scope, globalId, aliasClass);
    return {
      op: 'send',
      languageId: SYMMETRIC_SMALLTALK_ID,
      receiver: bindingExpr,
      message: textValue('value'),
      arguments: [],
    };
  }

  function extractSelectorSpelling(selectorForm) {
    if (selectorForm?.kind === 'string') return selectorForm.value;
    if (selectorForm?.kind === 'symbol') return selectorForm.spelling;
    if (
      selectorForm?.kind === 'list'
      && selectorForm.elements.length === 2
      && selectorForm.elements[0]?.kind === 'symbol'
      && selectorForm.elements[0].name === 'QUOTE'
      && selectorForm.elements[1]?.kind === 'symbol'
    ) {
      return selectorForm.elements[1].spelling;
    }
    throw new SyntaxError('Common Lisp (send receiver selector ...) requires a keyword, quoted symbol, or string selector');
  }

  function compileForm(scope, form) {
    if (!form || typeof form !== 'object') {
      throw new SyntaxError('invalid Common Lisp form');
    }
    if (form.kind === 'integer') {
      return {op: 'literal', value: integerValue(BigInt(form.value))};
    }
    if (form.kind === 'string') {
      return {op: 'literal', value: textValue(form.value)};
    }
    if (form.kind === 'symbol') {
      if (isNilSymbol(form)) return refNil(scope);
      if (isTSymbol(form)) return refT(scope);
      if (form.keyword) return internSymbolExpr(scope, form.name);

      const lexical = lookupLexical(scope, form.name);
      if (lexical) {
        return lexical.kind === 'param'
          ? {op: 'argument', index: lexical.index}
          : {op: 'binding', id: lexical.id};
      }
      const callerCap = callerCaptureNames.get(form.name) ?? callerCaptureNames.get(form.spelling);
      if (callerCap) {
        return requireRootCapture(scope, callerCap.id, callerCap.name);
      }
      const globalEntry = resolveGlobalName(form);
      if (globalEntry) {
        const bindingExpr = requireRootCapture(scope, globalEntry.id, globalEntry.name);
        return {
          op: 'send',
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: bindingExpr,
          message: textValue('value'),
          arguments: [],
        };
      }
      throw new SyntaxError(`unbound Common Lisp symbol: ${form.name}`);
    }

    if (form.kind !== 'list') {
      throw new SyntaxError(`unsupported Common Lisp form kind: ${form.kind}`);
    }
    if (form.dottedTail !== null) {
      throw new SyntaxError('dotted list cannot be evaluated as a Common Lisp function call');
    }

    const [head, ...args] = form.elements;

    // Direct lambda application: ((lambda (x) ...) arg1)
    if (head.kind === 'list' && head.elements[0]?.kind === 'symbol' && head.elements[0].name === 'LAMBDA') {
      const [, paramForm, ...bodyForms] = head.elements;
      if (!paramForm) throw new SyntaxError('Common Lisp lambda requires a parameter list');
      const callee = compileLambdaExpr(scope, paramForm, bodyForms);
      return {
        op: 'apply',
        callee,
        arguments: args.map((a) => compileForm(scope, a)),
      };
    }

    if (head.kind !== 'symbol') {
      throw new SyntaxError('Common Lisp compound form head must be a symbol or lambda expression');
    }

    // Macro expansion
    if (Object.hasOwn(macros, head.name)) {
      const expanded = macros[head.name](args);
      return compileForm(scope, expanded);
    }

    switch (head.name) {
      case 'QUOTE': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp QUOTE requires exactly 1 argument');
        return compileQuoted(scope, args[0]);
      }
      case 'PROGN':
        return compileSequence(scope, args);
      case 'PROG1': {
        if (args.length === 0) throw new SyntaxError('Common Lisp PROG1 requires at least 1 form');
        if (args.length === 1) return compileForm(scope, args[0]);
        const temp = declareLocal(scope, 'prog1');
        return {
          op: 'sequence',
          statements: [
            {op: 'binding-write', id: temp.id, value: compileForm(scope, args[0])},
            ...args.slice(1).map((a) => compileForm(scope, a)),
            {op: 'binding', id: temp.id},
          ],
        };
      }
      case 'IF': {
        if (args.length < 2 || args.length > 3) {
          throw new SyntaxError('Common Lisp IF requires 2 or 3 arguments');
        }
        const testExpr = compileForm(scope, args[0]);
        const thenExpr = compileForm(scope, args[1]);
        const elseExpr = args.length === 3 ? compileForm(scope, args[2]) : refNil(scope);
        return compileTruthBranch(scope, testExpr, thenExpr, elseExpr);
      }
      case 'WHEN': {
        if (args.length < 1) throw new SyntaxError('Common Lisp WHEN requires a test expression');
        const [testForm, ...bodyForms] = args;
        return compileTruthBranch(
          scope,
          compileForm(scope, testForm),
          compileSequence(scope, bodyForms),
          refNil(scope),
        );
      }
      case 'UNLESS': {
        if (args.length < 1) throw new SyntaxError('Common Lisp UNLESS requires a test expression');
        const [testForm, ...bodyForms] = args;
        return compileTruthBranch(
          scope,
          compileForm(scope, testForm),
          refNil(scope),
          compileSequence(scope, bodyForms),
        );
      }
      case 'COND': {
        let acc = refNil(scope);
        for (let i = args.length - 1; i >= 0; i -= 1) {
          const clause = args[i];
          if (clause?.kind !== 'list' || clause.elements.length === 0) {
            throw new SyntaxError('Common Lisp COND clause must be a non-empty list');
          }
          const [testForm, ...bodyForms] = clause.elements;
          if (bodyForms.length === 0) {
            const temp = declareLocal(scope, 'cond');
            acc = {
              op: 'sequence',
              statements: [
                {op: 'binding-write', id: temp.id, value: compileForm(scope, testForm)},
                compileTruthBranch(scope, {op: 'binding', id: temp.id}, {op: 'binding', id: temp.id}, acc),
              ],
            };
          } else if (isTSymbol(testForm)) {
            acc = compileSequence(scope, bodyForms);
          } else {
            acc = compileTruthBranch(
              scope,
              compileForm(scope, testForm),
              compileSequence(scope, bodyForms),
              acc,
            );
          }
        }
        return acc;
      }
      case 'AND': {
        if (args.length === 0) return refT(scope);
        if (args.length === 1) return compileForm(scope, args[0]);
        let acc = compileForm(scope, args[args.length - 1]);
        for (let i = args.length - 2; i >= 0; i -= 1) {
          acc = compileTruthBranch(scope, compileForm(scope, args[i]), acc, refNil(scope));
        }
        return acc;
      }
      case 'OR': {
        if (args.length === 0) return refNil(scope);
        if (args.length === 1) return compileForm(scope, args[0]);
        let acc = compileForm(scope, args[args.length - 1]);
        for (let i = args.length - 2; i >= 0; i -= 1) {
          const temp = declareLocal(scope, 'or');
          acc = {
            op: 'sequence',
            statements: [
              {op: 'binding-write', id: temp.id, value: compileForm(scope, args[i])},
              compileTruthBranch(scope, {op: 'binding', id: temp.id}, {op: 'binding', id: temp.id}, acc),
            ],
          };
        }
        return acc;
      }
      case 'LET': {
        if (args.length < 1) throw new SyntaxError('Common Lisp LET requires a binding list');
        const [bindingsForm, ...bodyForms] = args;
        const bindingItems = isNilSymbol(bindingsForm)
          ? []
          : bindingsForm.kind === 'list'
            ? bindingsForm.elements
            : null;
        if (bindingItems === null) throw new SyntaxError('Common Lisp LET bindings must be a list');
        if (bindingItems.length === 0) return compileSequence(scope, bodyForms);

        // Evaluate all initializers in the prior lexical visibility, then bind
        const evaluated = bindingItems.map((item) => {
          if (item.kind === 'symbol') {
            return {name: item.name, initExpr: refNil(scope)};
          }
          if (item.kind === 'list' && (item.elements.length === 1 || item.elements.length === 2)) {
            const varSym = item.elements[0];
            if (varSym?.kind !== 'symbol' || isNilSymbol(varSym) || isTSymbol(varSym) || varSym.keyword) {
              throw new SyntaxError('Common Lisp LET variable must be an ordinary symbol');
            }
            const initExpr = item.elements.length === 2 ? compileForm(scope, item.elements[1]) : refNil(scope);
            return {name: varSym.name, initExpr};
          }
          throw new SyntaxError('invalid Common Lisp LET binding specification');
        });

        const savedLocals = new Map(scope.locals);
        const statements = [];
        for (const {name, initExpr} of evaluated) {
          const local = declareLocal(scope, name);
          statements.push({op: 'binding-write', id: local.id, value: initExpr});
          scope.locals.set(name, local);
        }
        const bodyExpr = compileSequence(scope, bodyForms);
        scope.locals = savedLocals;
        return {op: 'sequence', statements: [...statements, bodyExpr]};
      }
      case 'LET*': {
        if (args.length < 1) throw new SyntaxError('Common Lisp LET* requires a binding list');
        const [bindingsForm, ...bodyForms] = args;
        const bindingItems = isNilSymbol(bindingsForm)
          ? []
          : bindingsForm.kind === 'list'
            ? bindingsForm.elements
            : null;
        if (bindingItems === null) throw new SyntaxError('Common Lisp LET* bindings must be a list');
        if (bindingItems.length === 0) return compileSequence(scope, bodyForms);

        const savedLocals = new Map(scope.locals);
        const statements = [];
        for (const item of bindingItems) {
          let name;
          let initExpr;
          if (item.kind === 'symbol') {
            name = item.name;
            initExpr = refNil(scope);
          } else if (item.kind === 'list' && (item.elements.length === 1 || item.elements.length === 2)) {
            const varSym = item.elements[0];
            if (varSym?.kind !== 'symbol' || isNilSymbol(varSym) || isTSymbol(varSym) || varSym.keyword) {
              throw new SyntaxError('Common Lisp LET* variable must be an ordinary symbol');
            }
            name = varSym.name;
            initExpr = item.elements.length === 2 ? compileForm(scope, item.elements[1]) : refNil(scope);
          } else {
            throw new SyntaxError('invalid Common Lisp LET* binding specification');
          }
          const local = declareLocal(scope, name);
          statements.push({op: 'binding-write', id: local.id, value: initExpr});
          scope.locals.set(name, local);
        }
        const bodyExpr = compileSequence(scope, bodyForms);
        scope.locals = savedLocals;
        return {op: 'sequence', statements: [...statements, bodyExpr]};
      }
      case 'SETQ': {
        if (args.length === 0 || args.length % 2 !== 0) {
          throw new SyntaxError('Common Lisp SETQ requires an even number of variable/value arguments');
        }
        const statements = [];
        for (let i = 0; i < args.length; i += 2) {
          const target = args[i];
          const valForm = args[i + 1];
          if (target?.kind !== 'symbol' || isNilSymbol(target) || isTSymbol(target) || target.keyword) {
            throw new SyntaxError('Common Lisp SETQ target must be a mutable symbol');
          }
          const lexical = lookupLexical(scope, target.name);
          if (!lexical) {
            throw new SyntaxError(`unbound Common Lisp variable in SETQ: ${target.name}`);
          }
          statements.push({
            op: 'binding-write',
            id: lexical.id,
            value: compileForm(scope, valForm),
          });
        }
        return statements.length === 1 ? statements[0] : {op: 'sequence', statements};
      }
      case 'LAMBDA': {
        const [paramForm, ...bodyForms] = args;
        if (!paramForm) throw new SyntaxError('Common Lisp LAMBDA requires a parameter list');
        return compileLambdaExpr(scope, paramForm, bodyForms);
      }
      case 'FUNCTION': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp FUNCTION requires 1 argument');
        return compileFunctionRef(scope, args[0]);
      }
      case 'FLET': {
        if (args.length < 1) throw new SyntaxError('Common Lisp FLET requires a function binding list');
        const [defsForm, ...bodyForms] = args;
        const defs = isNilSymbol(defsForm) ? [] : defsForm.kind === 'list' ? defsForm.elements : null;
        if (defs === null) throw new SyntaxError('Common Lisp FLET definitions must be a list');
        const compiledDefs = defs.map((def) => {
          if (def?.kind !== 'list' || def.elements.length < 2 || def.elements[0]?.kind !== 'symbol') {
            throw new SyntaxError('invalid Common Lisp FLET function definition');
          }
          const [fnSym, paramForm, ...fnBody] = def.elements;
          return {name: fnSym.name, expr: compileLambdaExpr(scope, paramForm, fnBody, fnSym.name)};
        });
        const savedLocals = new Map(scope.locals);
        const statements = [];
        for (const {name, expr} of compiledDefs) {
          const local = declareLocal(scope, name);
          statements.push({op: 'binding-write', id: local.id, value: expr});
          scope.locals.set(name, local);
        }
        const bodyExpr = compileSequence(scope, bodyForms);
        scope.locals = savedLocals;
        return statements.length === 0 ? bodyExpr : {op: 'sequence', statements: [...statements, bodyExpr]};
      }
      case 'LABELS': {
        if (args.length < 1) throw new SyntaxError('Common Lisp LABELS requires a function binding list');
        const [defsForm, ...bodyForms] = args;
        const defs = isNilSymbol(defsForm) ? [] : defsForm.kind === 'list' ? defsForm.elements : null;
        if (defs === null) throw new SyntaxError('Common Lisp LABELS definitions must be a list');
        const savedLocals = new Map(scope.locals);
        const entries = [];
        for (const def of defs) {
          if (def?.kind !== 'list' || def.elements.length < 2 || def.elements[0]?.kind !== 'symbol') {
            throw new SyntaxError('invalid Common Lisp LABELS function definition');
          }
          const [fnSym, paramForm, ...fnBody] = def.elements;
          const local = declareLocal(scope, fnSym.name, {forceMutated: true});
          scope.locals.set(fnSym.name, local);
          entries.push({local, fnSym, paramForm, fnBody});
        }
        const statements = entries.map(({local, fnSym, paramForm, fnBody}) => ({
          op: 'binding-write',
          id: local.id,
          value: compileLambdaExpr(scope, paramForm, fnBody, fnSym.name),
        }));
        const bodyExpr = compileSequence(scope, bodyForms);
        scope.locals = savedLocals;
        return statements.length === 0 ? bodyExpr : {op: 'sequence', statements: [...statements, bodyExpr]};
      }
      case 'FUNCALL': {
        if (args.length < 1) throw new SyntaxError('Common Lisp FUNCALL requires a function argument');
        const [fnForm, ...callArgs] = args;
        return {
          op: 'apply',
          callee: compileForm(scope, fnForm),
          arguments: callArgs.map((a) => compileForm(scope, a)),
        };
      }
      case 'LIST': {
        let acc = refNil(scope);
        for (let i = args.length - 1; i >= 0; i -= 1) {
          acc = {
            op: 'apply',
            callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.CONS, '$cons'),
            arguments: [compileForm(scope, args[i]), acc],
          };
        }
        return acc;
      }
      case 'LIST*': {
        if (args.length === 0) throw new SyntaxError('Common Lisp LIST* requires at least 1 argument');
        let acc = compileForm(scope, args[args.length - 1]);
        for (let i = args.length - 2; i >= 0; i -= 1) {
          acc = {
            op: 'apply',
            callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.CONS, '$cons'),
            arguments: [compileForm(scope, args[i]), acc],
          };
        }
        return acc;
      }
      case '+': {
        if (args.length === 0) return {op: 'literal', value: integerValue(0n)};
        if (args.length === 1) return compileForm(scope, args[0]);
        let acc = compileForm(scope, args[0]);
        for (let i = 1; i < args.length; i += 1) {
          acc = {op: 'integer-add', left: acc, right: compileForm(scope, args[i])};
        }
        return acc;
      }
      case '-': {
        if (args.length === 0) throw new SyntaxError('Common Lisp - requires at least 1 argument');
        const subBlock = refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.SUB, '$-');
        if (args.length === 1) {
          return {
            op: 'apply',
            callee: subBlock,
            arguments: [{op: 'literal', value: integerValue(0n)}, compileForm(scope, args[0])],
          };
        }
        let acc = compileForm(scope, args[0]);
        for (let i = 1; i < args.length; i += 1) {
          acc = {
            op: 'apply',
            callee: subBlock,
            arguments: [acc, compileForm(scope, args[i])],
          };
        }
        return acc;
      }
      case '*': {
        if (args.length === 0) return {op: 'literal', value: integerValue(1n)};
        if (args.length === 1) return compileForm(scope, args[0]);
        const mulBlock = refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.MUL, '$*');
        let acc = compileForm(scope, args[0]);
        for (let i = 1; i < args.length; i += 1) {
          acc = {
            op: 'apply',
            callee: mulBlock,
            arguments: [acc, compileForm(scope, args[i])],
          };
        }
        return acc;
      }
      case '1+': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp 1+ requires 1 argument');
        return {
          op: 'integer-add',
          left: compileForm(scope, args[0]),
          right: {op: 'literal', value: integerValue(1n)},
        };
      }
      case '1-': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp 1- requires 1 argument');
        return {
          op: 'apply',
          callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.SUB, '$-'),
          arguments: [compileForm(scope, args[0]), {op: 'literal', value: integerValue(1n)}],
        };
      }
      case 'ZEROP': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp ZEROP requires 1 argument');
        return {
          op: 'if',
          condition: {
            op: 'equals',
            left: compileForm(scope, args[0]),
            right: {op: 'literal', value: integerValue(0n)},
          },
          then: refT(scope),
          else: refNil(scope),
        };
      }
      case 'PLUSP': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp PLUSP requires 1 argument');
        return {
          op: 'apply',
          callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.GT, '$>'),
          arguments: [compileForm(scope, args[0]), {op: 'literal', value: integerValue(0n)}],
        };
      }
      case 'MINUSP': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp MINUSP requires 1 argument');
        return {
          op: 'apply',
          callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.LT, '$<'),
          arguments: [compileForm(scope, args[0]), {op: 'literal', value: integerValue(0n)}],
        };
      }
      case 'EQ':
      case 'EQL':
      case '=': {
        if (args.length !== 2) throw new SyntaxError(`Common Lisp ${head.name} requires 2 arguments`);
        return {
          op: 'if',
          condition: {
            op: 'equals',
            left: compileForm(scope, args[0]),
            right: compileForm(scope, args[1]),
          },
          then: refT(scope),
          else: refNil(scope),
        };
      }
      case '/=': {
        if (args.length !== 2) throw new SyntaxError('Common Lisp /= requires 2 arguments');
        return {
          op: 'if',
          condition: {
            op: 'equals',
            left: compileForm(scope, args[0]),
            right: compileForm(scope, args[1]),
          },
          then: refNil(scope),
          else: refT(scope),
        };
      }
      case 'NULL':
      case 'NOT': {
        if (args.length !== 1) throw new SyntaxError(`Common Lisp ${head.name} requires 1 argument`);
        return {
          op: 'if',
          condition: {
            op: 'equals',
            left: compileForm(scope, args[0]),
            right: refNil(scope),
          },
          then: refT(scope),
          else: refNil(scope),
        };
      }
      case 'SEND': {
        if (args.length < 2) {
          throw new SyntaxError('Common Lisp (send receiver selector ...) requires at least receiver and selector');
        }
        const [receiverForm, selectorForm, ...sendArgs] = args;
        const selector = extractSelectorSpelling(selectorForm);
        return {
          op: 'send',
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: compileForm(scope, receiverForm),
          message: textValue(selector),
          arguments: sendArgs.map((a) => compileForm(scope, a)),
        };
      }
      case 'CONDITION-MESSAGE': {
        if (args.length !== 1) throw new SyntaxError('Common Lisp CONDITION-MESSAGE requires 1 argument');
        return {
          op: 'send',
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: compileForm(scope, args[0]),
          message: textValue('messageText'),
          arguments: [],
        };
      }
      case 'UNWIND-PROTECT': {
        if (args.length < 1) throw new SyntaxError('Common Lisp UNWIND-PROTECT requires a protected form');
        const [protectedForm, ...cleanupForms] = args;
        if (cleanupForms.length === 0) return compileForm(scope, protectedForm);
        const emptyList = makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
        const protectedBlock = compileLambdaExpr(scope, emptyList, [protectedForm], 'unwind_protected');
        const cleanupBlock = compileLambdaExpr(scope, emptyList, cleanupForms, 'unwind_cleanup');
        return {
          op: 'send',
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: protectedBlock,
          message: textValue('ensure:'),
          arguments: [cleanupBlock],
        };
      }
      case 'HANDLER-CASE': {
        if (args.length < 1) throw new SyntaxError('Common Lisp HANDLER-CASE requires a protected form');
        const [protectedForm, ...clauses] = args;
        const emptyList = makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
        let currentExpr = compileForm(scope, protectedForm);
        for (let i = clauses.length - 1; i >= 0; i -= 1) {
          const clause = clauses[i];
          if (clause?.kind !== 'list' || clause.elements.length < 2) {
            throw new SyntaxError('Common Lisp HANDLER-CASE clause must be (type (var) body...)');
          }
          const [typeSym, varList, ...handlerBody] = clause.elements;
          const conditionClassExpr = resolveConditionClassExpr(scope, typeSym);
          const paramList = isNilSymbol(varList)
            ? makeListNode([makeSymbolNode('IGNORED_CONDITION')])
            : varList;
          const handlerBlock = compileLambdaExpr(scope, paramList, handlerBody, 'handler_case');
          const protectedBlock = compileLambdaExpr(
            scope,
            emptyList,
            [protectedForm],
            'handler_protected',
          );
          // Replace the inner body of protectedBlock with the already-wrapped currentExpr if nested
          protectedBlock.program = Object.freeze({
            ...protectedBlock.program,
            body: i === clauses.length - 1 ? protectedBlock.program.body : currentExpr,
          });
          currentExpr = {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: protectedBlock,
            message: textValue('on:do:'),
            arguments: [conditionClassExpr, handlerBlock],
          };
        }
        return currentExpr;
      }
      case 'HANDLER-BIND': {
        if (args.length < 1) throw new SyntaxError('Common Lisp HANDLER-BIND requires a binding list');
        const [bindingsForm, ...bodyForms] = args;
        const bindings = isNilSymbol(bindingsForm)
          ? []
          : bindingsForm.kind === 'list'
            ? bindingsForm.elements
            : null;
        if (bindings === null) throw new SyntaxError('Common Lisp HANDLER-BIND bindings must be a list');
        if (bindings.length === 0) return compileSequence(scope, bodyForms);
        const emptyList = makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
        let currentForms = bodyForms;
        let currentExpr = null;
        for (let i = bindings.length - 1; i >= 0; i -= 1) {
          const b = bindings[i];
          if (b?.kind !== 'list' || b.elements.length !== 2) {
            throw new SyntaxError('Common Lisp HANDLER-BIND entry must be (type handler-fn)');
          }
          const [typeSym, handlerForm] = b.elements;
          const conditionClassExpr = resolveConditionClassExpr(scope, typeSym);
          const handlerBlock = compileForm(scope, handlerForm);
          const protectedBlock = compileLambdaExpr(scope, emptyList, currentForms, 'handler_bind_protected');
          if (currentExpr !== null) {
            protectedBlock.program = Object.freeze({
              ...protectedBlock.program,
              body: currentExpr,
            });
          }
          currentExpr = {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: protectedBlock,
            message: textValue('on:do:'),
            arguments: [conditionClassExpr, handlerBlock],
          };
        }
        return currentExpr;
      }
      case 'IGNORE-ERRORS': {
        const emptyList = makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
        const protectedBlock = compileLambdaExpr(scope, emptyList, args, 'ignore_errors_protected');
        const handlerBlock = compileLambdaExpr(
          scope,
          makeListNode([makeSymbolNode('IGNORED_ERROR')]),
          [emptyList],
          'ignore_errors_handler',
        );
        const conditionClassExpr = resolveConditionClassExpr(scope, makeSymbolNode('ERROR'));
        return {
          op: 'send',
          languageId: SYMMETRIC_SMALLTALK_ID,
          receiver: protectedBlock,
          message: textValue('on:do:'),
          arguments: [conditionClassExpr, handlerBlock],
        };
      }
      default: {
        // Check lexical function binding first (flet / labels / parameter)
        const lexical = lookupLexical(scope, head.name);
        if (lexical) {
          const callee = lexical.kind === 'param'
            ? {op: 'argument', index: lexical.index}
            : {op: 'binding', id: lexical.id};
          return {
            op: 'apply',
            callee,
            arguments: args.map((a) => compileForm(scope, a)),
          };
        }
        const fnGlobal = resolveFunctionGlobal(head);
        if (!fnGlobal) {
          throw new SyntaxError(`unbound Common Lisp function: ${head.name}`);
        }
        const callee = fnGlobal.kind === 'runtime-block'
          ? refRuntimeBlock(scope, fnGlobal.id, head.name)
          : {
            op: 'send',
            languageId: SYMMETRIC_SMALLTALK_ID,
            receiver: requireRootCapture(scope, fnGlobal.id, fnGlobal.name),
            message: textValue('value'),
            arguments: [],
          };
        return {
          op: 'apply',
          callee,
          arguments: args.map((a) => compileForm(scope, a)),
        };
      }
    }
  }

  const rootScope = createScope({parent: null, paramNames: parameters});
  const compiledBody = compileSequence(rootScope, forms);
  const body = rootScope.entryStatements.length > 0
    ? {op: 'sequence', statements: [...rootScope.entryStatements, compiledBody]}
    : compiledBody;

  const captureDescriptors = [];
  for (const cap of rootScope.captures.values()) {
    captureDescriptors.push({id: cap.id, name: cap.name, mode: 'snapshot'});
  }

  const program = Object.freeze({
    parameters: Object.freeze(
      parameters.map((name, idx) => Object.freeze({
        id: `cl:param:${idx}:${String(name).toUpperCase()}`,
        name: String(name).toUpperCase(),
      })),
    ),
    temporaries: Object.freeze(rootScope.temporaries.map((t) => Object.freeze({...t}))),
    captures: Object.freeze(captureDescriptors.map((c) => Object.freeze({...c}))),
    body,
  });

  return Object.freeze({
    syntax: forms,
    program,
    semanticProgram: program,
    representation: LAGRANGE_CODE_V2,
    globalBindingIdsUsed: Object.freeze([...globalBindingIdsUsed]),
    runtimeBlocksUsed: Object.freeze([...runtimeBlocksUsed]),
    internedSymbolsUsed: Object.freeze([...internedSymbolsUsed]),
  });
}

function compileCommonLispBlock(source, options = {}) {
  const forms = typeof source === 'string' ? readCommonLispSource(source) : source;
  return compileCommonLispSemanticProgram(forms, options);
}

// -----------------------------------------------------------------------------
// In-Image Runtime & Block Installation
// -----------------------------------------------------------------------------

function resolveCompilation(images, compilation) {
  if (compilation) {
    if (typeof compilation.compileArtifact !== 'function') {
      throw new TypeError('compilation service must implement compileArtifact');
    }
    return compilation;
  }
  return new CompilationService({images, compilers: createDefaultCodeCompilerRegistry()});
}

async function ensureInternedSymbol(images, imageId, spelling) {
  const id = symbolObjectId(spelling);
  await ensureObject(images, imageId, {
    id,
    shape: objectRef(imageId, SYMBOL_SHAPE_ID),
    behavior: objectRef(imageId, `smalltalk/class/${SYMBOL_CLASS_NAME}`),
    slots: {[SYMBOL_SPELLING_SLOT]: textValue(spelling)},
    metadata: {},
  });
  return objectRef(imageId, id);
}

async function installRuntimeHelperBlock({
  images,
  compilation,
  imageId,
  id,
  program,
  bindings = {},
  lane = 'neutral',
}) {
  const semantic = await ensureCodeArtifact(images, imageId, {
    id: `${id}:semantic`,
    languageId: COMMON_LISP_ID,
    representation: LAGRANGE_CODE_V2,
    content: textValue(JSON.stringify(program)),
    metadata: {commonLisp: 'runtime-helper', helperId: id},
  });

  let envRef = null;
  if (Object.keys(bindings).length > 0) {
    const env = await ensureLexicalEnvironment(images, imageId, {
      id: `${id}:environment`,
      bindings,
    });
    envRef = objectRef(imageId, env.id);
  }

  if (lane === 'wasm') {
    const installed = await installWasmV1BlockTree({
      images,
      compilation,
      semanticRef: objectRef(imageId, semantic.id),
      id,
      environment: envRef,
      metadata: {commonLisp: 'runtime-helper', lane: 'wasm'},
    });
    return objectRef(imageId, installed.block.id);
  }

  const codeArtifact = await compilation.compileArtifact(
    objectRef(imageId, semantic.id),
    {
      id: `${id}:code`,
      targetRepresentation: NEUTRAL_EXPRESSION_V2,
      options: {blockPrototypes: {}},
    },
  );
  const block = await ensureBlock(images, imageId, {
    id,
    code: objectRef(imageId, codeArtifact.id),
    environment: envRef,
    metadata: {commonLisp: 'runtime-helper', lane: 'neutral'},
  });
  return objectRef(imageId, block.id);
}

async function installCommonLispRuntimePrimitives({images, compilation, imageId, kernel, tRef, lane}) {
  const ref = (objectId) => objectRef(imageId, objectId);
  const nilCap = {id: CL_NIL_BINDING_ID, name: 'nil', mode: 'snapshot'};
  const tCap = {id: CL_T_BINDING_ID, name: 't', mode: 'snapshot'};
  const nilBinding = {[CL_NIL_BINDING_ID]: {name: 'nil', value: kernel.nil}};
  const boolBindings = {
    ...nilBinding,
    [CL_T_BINDING_ID]: {name: 't', value: tRef},
  };

  // 1. cons(a, b)
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.CONS,
    bindings: {
      'smalltalk/primitive/basic-new-sized': {name: '$basicNewSized', value: ref('smalltalk/primitive/basic-new-sized')},
      'smalltalk/primitive/indexed-at-put': {name: '$indexedAtPut', value: ref('smalltalk/primitive/indexed-at-put')},
      'smalltalk/class/Cons': {name: 'Cons', value: ref('smalltalk/class/Cons')},
    },
    program: {
      parameters: [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}],
      temporaries: [{id: 'cell', name: 'CELL'}],
      captures: [
        {id: 'smalltalk/primitive/basic-new-sized', name: '$basicNewSized', mode: 'snapshot'},
        {id: 'smalltalk/primitive/indexed-at-put', name: '$indexedAtPut', mode: 'snapshot'},
        {id: 'smalltalk/class/Cons', name: 'Cons', mode: 'snapshot'},
      ],
      body: {
        op: 'sequence',
        statements: [
          {
            op: 'binding-write',
            id: 'cell',
            value: {
              op: 'apply',
              callee: {op: 'binding', id: 'smalltalk/primitive/basic-new-sized'},
              arguments: [
                {op: 'binding', id: 'smalltalk/class/Cons'},
                {op: 'literal', value: integerValue(2n)},
              ],
            },
          },
          {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/indexed-at-put'},
            arguments: [
              {op: 'binding', id: 'cell'},
              {op: 'literal', value: integerValue(0n)},
              {op: 'argument', index: 0},
            ],
          },
          {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/indexed-at-put'},
            arguments: [
              {op: 'binding', id: 'cell'},
              {op: 'literal', value: integerValue(1n)},
              {op: 'argument', index: 1},
            ],
          },
          {op: 'binding', id: 'cell'},
        ],
      },
    },
  });

  // 2. car(x) & cdr(x)
  for (const [helperId, index] of [[RUNTIME_BLOCK_IDS.CAR, 0n], [RUNTIME_BLOCK_IDS.CDR, 1n]]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {
        ...nilBinding,
        'smalltalk/primitive/indexed-at': {name: '$indexedAt', value: ref('smalltalk/primitive/indexed-at')},
      },
      program: {
        parameters: [{id: 'x', name: 'X'}],
        temporaries: [],
        captures: [
          nilCap,
          {id: 'smalltalk/primitive/indexed-at', name: '$indexedAt', mode: 'snapshot'},
        ],
        body: {
          op: 'if',
          condition: {
            op: 'equals',
            left: {op: 'argument', index: 0},
            right: {op: 'binding', id: CL_NIL_BINDING_ID},
          },
          then: {op: 'binding', id: CL_NIL_BINDING_ID},
          else: {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/indexed-at'},
            arguments: [
              {op: 'argument', index: 0},
              {op: 'literal', value: integerValue(index)},
            ],
          },
        },
      },
    });
  }

  // 3. rplaca(cons, val) & rplacd(cons, val)
  for (const [helperId, index] of [[RUNTIME_BLOCK_IDS.RPLACA, 0n], [RUNTIME_BLOCK_IDS.RPLACD, 1n]]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {
        'smalltalk/primitive/indexed-at-put': {name: '$indexedAtPut', value: ref('smalltalk/primitive/indexed-at-put')},
      },
      program: {
        parameters: [{id: 'cons', name: 'CONS'}, {id: 'val', name: 'VAL'}],
        temporaries: [],
        captures: [{id: 'smalltalk/primitive/indexed-at-put', name: '$indexedAtPut', mode: 'snapshot'}],
        body: {
          op: 'sequence',
          statements: [
            {
              op: 'apply',
              callee: {op: 'binding', id: 'smalltalk/primitive/indexed-at-put'},
              arguments: [
                {op: 'argument', index: 0},
                {op: 'literal', value: integerValue(index)},
                {op: 'argument', index: 1},
              ],
            },
            {op: 'argument', index: 0},
          ],
        },
      },
    });
  }

  // 4. Class-based predicates: consp, atom, functionp, integerp, stringp
  const classPredicates = [
    [RUNTIME_BLOCK_IDS.CONSP, 'smalltalk/class/Cons', false],
    [RUNTIME_BLOCK_IDS.ATOM, 'smalltalk/class/Cons', true],
    [RUNTIME_BLOCK_IDS.FUNCTIONP, `smalltalk/class/${BLOCK_CLOSURE_CLASS_NAME}`, false],
    [RUNTIME_BLOCK_IDS.INTEGERP, 'smalltalk/class/Integer', false],
    [RUNTIME_BLOCK_IDS.STRINGP, 'smalltalk/class/Text', false],
  ];
  for (const [helperId, targetClassId, invert] of classPredicates) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {
        ...boolBindings,
        'smalltalk/primitive/class-of': {name: '$classOf', value: ref('smalltalk/primitive/class-of')},
        [targetClassId]: {name: targetClassId, value: ref(targetClassId)},
      },
      program: {
        parameters: [{id: 'x', name: 'X'}],
        temporaries: [],
        captures: [
          nilCap,
          tCap,
          {id: 'smalltalk/primitive/class-of', name: '$classOf', mode: 'snapshot'},
          {id: targetClassId, name: targetClassId, mode: 'snapshot'},
        ],
        body: {
          op: 'if',
          condition: {
            op: 'equals',
            left: {
              op: 'apply',
              callee: {op: 'binding', id: 'smalltalk/primitive/class-of'},
              arguments: [{op: 'argument', index: 0}],
            },
            right: {op: 'binding', id: targetClassId},
          },
          then: {op: 'binding', id: invert ? CL_NIL_BINDING_ID : CL_T_BINDING_ID},
          else: {op: 'binding', id: invert ? CL_T_BINDING_ID : CL_NIL_BINDING_ID},
        },
      },
    });
  }

  // 5. Nil-or-Class predicates: symbolp, listp
  for (const [helperId, targetClassId] of [
    [RUNTIME_BLOCK_IDS.SYMBOLP, 'smalltalk/class/Symbol'],
    [RUNTIME_BLOCK_IDS.LISTP, 'smalltalk/class/Cons'],
  ]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {
        ...boolBindings,
        'smalltalk/primitive/class-of': {name: '$classOf', value: ref('smalltalk/primitive/class-of')},
        [targetClassId]: {name: targetClassId, value: ref(targetClassId)},
      },
      program: {
        parameters: [{id: 'x', name: 'X'}],
        temporaries: [],
        captures: [
          nilCap,
          tCap,
          {id: 'smalltalk/primitive/class-of', name: '$classOf', mode: 'snapshot'},
          {id: targetClassId, name: targetClassId, mode: 'snapshot'},
        ],
        body: {
          op: 'if',
          condition: {
            op: 'equals',
            left: {op: 'argument', index: 0},
            right: {op: 'binding', id: CL_NIL_BINDING_ID},
          },
          then: {op: 'binding', id: CL_T_BINDING_ID},
          else: {
            op: 'if',
            condition: {
              op: 'equals',
              left: {
                op: 'apply',
                callee: {op: 'binding', id: 'smalltalk/primitive/class-of'},
                arguments: [{op: 'argument', index: 0}],
              },
              right: {op: 'binding', id: targetClassId},
            },
            then: {op: 'binding', id: CL_T_BINDING_ID},
            else: {op: 'binding', id: CL_NIL_BINDING_ID},
          },
        },
      },
    });
  }

  // 6. null / not, eq / eql, =, /=
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.NULL,
    bindings: boolBindings,
    program: {
      parameters: [{id: 'x', name: 'X'}],
      temporaries: [],
      captures: [nilCap, tCap],
      body: {
        op: 'if',
        condition: {
          op: 'equals',
          left: {op: 'argument', index: 0},
          right: {op: 'binding', id: CL_NIL_BINDING_ID},
        },
        then: {op: 'binding', id: CL_T_BINDING_ID},
        else: {op: 'binding', id: CL_NIL_BINDING_ID},
      },
    },
  });

  for (const [helperId, invert] of [
    [RUNTIME_BLOCK_IDS.EQ, false],
    [RUNTIME_BLOCK_IDS.NUM_EQ, false],
    [RUNTIME_BLOCK_IDS.NUM_NEQ, true],
  ]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: boolBindings,
      program: {
        parameters: [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}],
        temporaries: [],
        captures: [nilCap, tCap],
        body: {
          op: 'if',
          condition: {
            op: 'equals',
            left: {op: 'argument', index: 0},
            right: {op: 'argument', index: 1},
          },
          then: {op: 'binding', id: invert ? CL_NIL_BINDING_ID : CL_T_BINDING_ID},
          else: {op: 'binding', id: invert ? CL_T_BINDING_ID : CL_NIL_BINDING_ID},
        },
      },
    });
  }

  // equal(a, b) via built-in-equals (with recursive cons support in standard library if needed)
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.EQUAL,
    bindings: {
      ...boolBindings,
      'smalltalk/primitive/built-in-equals': {name: '$builtInEquals', value: ref('smalltalk/primitive/built-in-equals')},
    },
    program: {
      parameters: [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}],
      temporaries: [],
      captures: [
        nilCap,
        tCap,
        {id: 'smalltalk/primitive/built-in-equals', name: '$builtInEquals', mode: 'snapshot'},
      ],
      body: {
        op: 'if',
        condition: {
          op: 'apply',
          callee: {op: 'binding', id: 'smalltalk/primitive/built-in-equals'},
          arguments: [{op: 'argument', index: 0}, {op: 'argument', index: 1}],
        },
        then: {op: 'binding', id: CL_T_BINDING_ID},
        else: {op: 'binding', id: CL_NIL_BINDING_ID},
      },
    },
  });

  // 7. Arithmetic & numeric comparisons: +, -, *, floor, mod, 1+, 1-, <, >, <=, >=
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.ADD,
    program: {
      parameters: [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}],
      temporaries: [],
      captures: [],
      body: {
        op: 'integer-add',
        left: {op: 'argument', index: 0},
        right: {op: 'argument', index: 1},
      },
    },
  });

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.INC,
    program: {
      parameters: [{id: 'a', name: 'A'}],
      temporaries: [],
      captures: [],
      body: {
        op: 'integer-add',
        left: {op: 'argument', index: 0},
        right: {op: 'literal', value: integerValue(1n)},
      },
    },
  });

  for (const [helperId, primId] of [
    [RUNTIME_BLOCK_IDS.SUB, 'smalltalk/primitive/integer-subtract'],
    [RUNTIME_BLOCK_IDS.MUL, 'smalltalk/primitive/integer-multiply'],
    [RUNTIME_BLOCK_IDS.FLOOR, 'smalltalk/primitive/integer-floor-divide'],
    [RUNTIME_BLOCK_IDS.MOD, 'smalltalk/primitive/integer-modulo'],
  ]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {[primId]: {name: primId, value: ref(primId)}},
      program: {
        parameters: [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}],
        temporaries: [],
        captures: [{id: primId, name: primId, mode: 'snapshot'}],
        body: {
          op: 'apply',
          callee: {op: 'binding', id: primId},
          arguments: [{op: 'argument', index: 0}, {op: 'argument', index: 1}],
        },
      },
    });
  }

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.DEC,
    bindings: {
      'smalltalk/primitive/integer-subtract': {
        name: '$sub',
        value: ref('smalltalk/primitive/integer-subtract'),
      },
    },
    program: {
      parameters: [{id: 'a', name: 'A'}],
      temporaries: [],
      captures: [{id: 'smalltalk/primitive/integer-subtract', name: '$sub', mode: 'snapshot'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'smalltalk/primitive/integer-subtract'},
        arguments: [{op: 'argument', index: 0}, {op: 'literal', value: integerValue(1n)}],
      },
    },
  });

  // <, >, <=, >=
  const comparisons = [
    [RUNTIME_BLOCK_IDS.LT, 0, 1, false],
    [RUNTIME_BLOCK_IDS.GT, 1, 0, false],
    [RUNTIME_BLOCK_IDS.LE, 1, 0, true],
    [RUNTIME_BLOCK_IDS.GE, 0, 1, true],
  ];
  for (const [helperId, leftIdx, rightIdx, invert] of comparisons) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {
        ...boolBindings,
        'smalltalk/primitive/integer-less-than': {
          name: '$lt',
          value: ref('smalltalk/primitive/integer-less-than'),
        },
      },
      program: {
        parameters: [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}],
        temporaries: [],
        captures: [
          nilCap,
          tCap,
          {id: 'smalltalk/primitive/integer-less-than', name: '$lt', mode: 'snapshot'},
        ],
        body: {
          op: 'if',
          condition: {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/integer-less-than'},
            arguments: [{op: 'argument', index: leftIdx}, {op: 'argument', index: rightIdx}],
          },
          then: {op: 'binding', id: invert ? CL_NIL_BINDING_ID : CL_T_BINDING_ID},
          else: {op: 'binding', id: invert ? CL_T_BINDING_ID : CL_NIL_BINDING_ID},
        },
      },
    });
  }

  // 8. Conditions: signal/error, use-value, return-from-handler
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.SIGNAL,
    bindings: {
      'smalltalk/primitive/class-of': {name: '$classOf', value: ref('smalltalk/primitive/class-of')},
      'smalltalk/class/Text': {name: 'Text', value: ref('smalltalk/class/Text')},
      'smalltalk/class/Error': {name: 'Error', value: ref('smalltalk/class/Error')},
      'smalltalk/primitive/basic-new': {name: '$basicNew', value: ref('smalltalk/primitive/basic-new')},
      'smalltalk/primitive/condition-signal': {
        name: '$signal',
        value: ref('smalltalk/primitive/condition-signal'),
      },
    },
    program: {
      parameters: [{id: 'c', name: 'C'}],
      temporaries: [{id: 'err', name: 'ERR'}],
      captures: [
        {id: 'smalltalk/primitive/class-of', name: '$classOf', mode: 'snapshot'},
        {id: 'smalltalk/class/Text', name: 'Text', mode: 'snapshot'},
        {id: 'smalltalk/class/Error', name: 'Error', mode: 'snapshot'},
        {id: 'smalltalk/primitive/basic-new', name: '$basicNew', mode: 'snapshot'},
        {id: 'smalltalk/primitive/condition-signal', name: '$signal', mode: 'snapshot'},
      ],
      body: {
        op: 'if',
        condition: {
          op: 'equals',
          left: {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/class-of'},
            arguments: [{op: 'argument', index: 0}],
          },
          right: {op: 'binding', id: 'smalltalk/class/Text'},
        },
        then: {
          op: 'sequence',
          statements: [
            {
              op: 'binding-write',
              id: 'err',
              value: {
                op: 'apply',
                callee: {op: 'binding', id: 'smalltalk/primitive/basic-new'},
                arguments: [{op: 'binding', id: 'smalltalk/class/Error'}],
              },
            },
            {
              op: 'send',
              languageId: SYMMETRIC_SMALLTALK_ID,
              receiver: {op: 'binding', id: 'err'},
              message: textValue('messageText:'),
              arguments: [{op: 'argument', index: 0}],
            },
            {
              op: 'apply',
              callee: {op: 'binding', id: 'smalltalk/primitive/condition-signal'},
              arguments: [{op: 'binding', id: 'err'}],
            },
          ],
        },
        else: {
          op: 'apply',
          callee: {op: 'binding', id: 'smalltalk/primitive/condition-signal'},
          arguments: [{op: 'argument', index: 0}],
        },
      },
    },
  });

  for (const [helperId, primId] of [
    [RUNTIME_BLOCK_IDS.USE_VALUE, 'smalltalk/primitive/condition-resume'],
    [RUNTIME_BLOCK_IDS.RETURN_FROM_HANDLER, 'smalltalk/primitive/condition-return'],
  ]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {[primId]: {name: primId, value: ref(primId)}},
      program: {
        parameters: [{id: 'c', name: 'C'}, {id: 'val', name: 'VAL'}],
        temporaries: [],
        captures: [{id: primId, name: primId, mode: 'snapshot'}],
        body: {
          op: 'apply',
          callee: {op: 'binding', id: primId},
          arguments: [{op: 'argument', index: 0}, {op: 'argument', index: 1}],
        },
      },
    });
  }
}

async function ensureGlobalBindingInNamespace({
  images,
  imageId,
  namespaceId,
  name,
  bindingId,
  value,
}) {
  const existing = await resolveGlobal({images, imageId, name, namespaceId});
  if (!existing) {
    await publishGlobal({
      images,
      imageId,
      namespaceId,
      name,
      bindingId,
      value,
    });
    return objectRef(imageId, bindingId);
  }
  await rebindGlobal({
    images,
    imageId,
    bindingId: existing.objectId,
    value,
  });
  return existing;
}

async function installCommonLispRuntime({
  images,
  compilation = null,
  imageId,
  lane = 'neutral',
} = {}) {
  requiredText(imageId, 'image id');
  assertMethodLane(lane);
  const compiler = resolveCompilation(images, compilation);

  let kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) {
    await installSmalltalkKernel({images, imageId});
    kernel = await findSmalltalkKernel({images, imageId});
  }
  await installSmalltalkInstanceVariableProtocol({images, imageId});
  await installSmalltalkAllocationProtocol({images, compilation: compiler, imageId, lane});
  await installSmalltalkControlFlow({images, compilation: compiler, imageId, lane});
  await installSmalltalkIndexedProtocol({images, compilation: compiler, imageId, lane});
  await installSmalltalkEqualityProtocol({images, compilation: compiler, imageId, lane});
  await installSmalltalkIntegerProtocol({images, compilation: compiler, imageId, lane});
  await defineMethods({
    images,
    compilation: compiler,
    imageId,
    lane,
    classRef: kernel.integerClass,
    methods: [
      {
        selector: '+',
        program: {
          parameters: [{id: 'plus:arg', name: 'n'}],
          captures: [],
          body: {
            op: 'integer-add',
            left: {op: 'receiver'},
            right: {op: 'argument', index: 0},
          },
        },
      },
    ],
  });
  await installSmalltalkSymbolProtocol({images, compilation: compiler, imageId, lane});
  await installSmalltalkConditionProtocol({images, compilation: compiler, imageId, lane});
  await installSmalltalkExceptionAccessors({images, compilation: compiler, imageId, lane});
  await defineMethodsFromSource({
    images,
    compilation: compiler,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/Exception'),
    allowRedefinition: true,
    methods: [{selector: 'messageText:', source: '[ :t | messageText := t. ^self ]'}],
  });
  await installSmalltalkGlobalNamespace({images, compilation: compiler, imageId, lane});

  // Ensure Cons and BlockClosure classes exist in the image
  const consShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: CONS_SHAPE_ID,
    slots: [],
    indexed: SHAPE_INDEXED.VALUES,
  });
  const {classRef: consClassRef} = await ensureNamedClass({
    images,
    imageId,
    name: CONS_CLASS_NAME,
    superclassRef: kernel.objectClass,
    instanceShapeRef: consShapeRef,
  });
  await defineMethodsFromSource({
    images,
    compilation: compiler,
    imageId,
    lane,
    classRef: consClassRef,
    allowRedefinition: true,
    methods: [
      {selector: 'isCons', source: '[ ^true ]'},
    ],
  });
  await defineMethodsFromSource({
    images,
    compilation: compiler,
    imageId,
    lane,
    classRef: kernel.objectClass,
    allowRedefinition: true,
    methods: [{selector: 'isCons', source: '[ ^false ]'}],
  });
  const {classRef: blockClosureClassRef} = await ensureNamedClass({
    images,
    imageId,
    name: BLOCK_CLOSURE_CLASS_NAME,
    superclassRef: kernel.objectClass,
  });

  await publishSmalltalkClassGlobals({
    images,
    imageId,
    names: [
      'Array',
      'Symbol',
      CONS_CLASS_NAME,
      BLOCK_CLOSURE_CLASS_NAME,
      ...CONDITION_CLASSES.map(({name}) => name),
    ],
  });

  const tRef = await ensureInternedSymbol(images, imageId, 'T');
  await createNamespace({
    images,
    imageId,
    namespaceId: COMMON_LISP_NAMESPACE_ID,
    parent: NAMESPACE_OBJECT_ID,
  });

  await installCommonLispRuntimePrimitives({
    images,
    compilation: compiler,
    imageId,
    kernel,
    tRef,
    lane,
  });

  for (const [selector, helperId] of [
    ['car', RUNTIME_BLOCK_IDS.CAR],
    ['cdr', RUNTIME_BLOCK_IDS.CDR],
    ['car:', RUNTIME_BLOCK_IDS.RPLACA],
    ['cdr:', RUNTIME_BLOCK_IDS.RPLACD],
  ]) {
    await definePolyglotMethodBridge({
      images,
      compilation: compiler,
      imageId,
      classRef: consClassRef,
      selector,
      callableBlockRef: objectRef(imageId, helperId),
      passSelf: true,
      lane,
    });
  }

  // Install the Common Lisp standard library functions (if not already present)
  const ns = await findNamespace({images, imageId, namespaceId: COMMON_LISP_NAMESPACE_ID});
  if (!ns?.entries.has('MAPCAR')) {
    await installCommonLispProgram({
      images,
      compilation: compiler,
      imageId,
      source: STANDARD_LIBRARY_SOURCE,
      lane,
      skipRuntimeEnsure: true,
    });
  }

  return Object.freeze({
    imageId,
    consClass: consClassRef,
    blockClosureClass: blockClosureClassRef,
    nil: kernel.nil,
    t: tRef,
    namespaceId: COMMON_LISP_NAMESPACE_ID,
  });
}

async function ensureCommonLispEnvironment({
  images,
  imageId,
  id,
  parent = null,
  program,
  captures = {},
}) {
  const programCaptures = program.captures ?? [];
  if (programCaptures.length === 0) return parent;

  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const tRef = await ensureInternedSymbol(images, imageId, 'T');

  const callerById = new Map();
  for (const [key, entry] of Object.entries(captures)) {
    const capId = typeof entry === 'object' && entry !== null && typeof entry.id === 'string' ? entry.id : key;
    const capName = typeof entry === 'object' && entry !== null && typeof entry.name === 'string' ? entry.name : key;
    const capVal = typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'value') ? entry.value : entry;
    callerById.set(capId, {name: capName, value: canonicalizeValue(capVal)});
  }

  const bindings = {};
  for (const {id: captureId, name} of programCaptures) {
    if (callerById.has(captureId)) {
      bindings[captureId] = callerById.get(captureId);
    } else if (captureId === CL_NIL_BINDING_ID) {
      bindings[captureId] = {name: 'nil', value: kernel.nil};
    } else if (captureId === CL_T_BINDING_ID) {
      bindings[captureId] = {name: 't', value: tRef};
    } else {
      bindings[captureId] = {name, value: objectRef(imageId, captureId)};
    }
  }

  const record = await ensureLexicalEnvironment(images, imageId, {
    id: `${id}:compiler-environment`,
    ...(parent ? {parent} : {}),
    bindings,
  });
  return objectRef(imageId, record.id);
}

async function collectCommonLispCompileContext({images, imageId}) {
  const globals = await globalDeclarations({images, imageId, namespaceId: COMMON_LISP_NAMESPACE_ID});
  const functionBindings = {};
  const variableBindings = {};
  for (const [name, bindingId] of Object.entries(globals)) {
    if (bindingId.startsWith('common-lisp/function-binding/')) {
      functionBindings[name] = bindingId;
    } else if (bindingId.startsWith('common-lisp/variable-binding/')) {
      variableBindings[name] = bindingId;
    }
  }
  return {globals, functionBindings, variableBindings};
}

async function installCommonLispBlock({
  images,
  compilation = null,
  imageId,
  source,
  id = randomUUID(),
  parameters = [],
  captures = {},
  environment = null,
  lane = 'neutral',
  metadata = {},
  compileContext = null,
} = {}) {
  requiredText(imageId, 'image id');
  assertMethodLane(lane);
  const compiler = resolveCompilation(images, compilation);
  const ctx = compileContext ?? (await collectCommonLispCompileContext({images, imageId}));
  const forms = typeof source === 'string' ? readCommonLispSource(source) : source;
  const {
    syntax,
    semanticProgram,
    representation,
    globalBindingIdsUsed,
    runtimeBlocksUsed,
    internedSymbolsUsed,
  } = compileCommonLispSemanticProgram(forms, {
    parameters,
    captures,
    globals: ctx.globals,
    functionBindings: ctx.functionBindings,
    variableBindings: ctx.variableBindings,
    macros: ctx.macros ?? {},
  });

  // Ensure any quoted symbols referenced via symbol-intern have their Symbol protocol ready
  for (const symSpelling of internedSymbolsUsed) {
    await ensureInternedSymbol(images, imageId, symSpelling);
  }

  const sourceText = typeof source === 'string' ? source : JSON.stringify(source);
  const sourceArtifact = await ensureCodeArtifact(images, imageId, {
    id: `${id}:source`,
    languageId: COMMON_LISP_ID,
    representation: COMMON_LISP_SOURCE_V0,
    content: textValue(sourceText),
    metadata,
  });
  const syntaxArtifact = await ensureCodeArtifact(images, imageId, {
    id: `${id}:syntax`,
    languageId: COMMON_LISP_ID,
    representation: COMMON_LISP_SYNTAX_V0,
    content: textValue(JSON.stringify(syntax)),
    derivedFrom: [objectRef(imageId, sourceArtifact.id)],
  });
  const semanticArtifact = await ensureCodeArtifact(images, imageId, {
    id: `${id}:semantic`,
    languageId: COMMON_LISP_ID,
    representation,
    content: textValue(JSON.stringify(semanticProgram)),
    derivedFrom: [objectRef(imageId, syntaxArtifact.id)],
  });

  const blockEnvironment = await ensureCommonLispEnvironment({
    images,
    imageId,
    id,
    parent: environment,
    program: semanticProgram,
    captures,
  });

  if (lane === 'wasm') {
    const wasmInstalled = await installWasmV1BlockTree({
      images,
      compilation: compiler,
      semanticRef: objectRef(imageId, semanticArtifact.id),
      id,
      environment: blockEnvironment,
      metadata: {...metadata, commonLisp: 'block', lane: 'wasm'},
    });
    return Object.freeze({
      syntax,
      semanticProgram,
      representation,
      globalBindingIdsUsed,
      runtimeBlocksUsed,
      sourceArtifact,
      syntaxArtifact,
      semanticArtifact,
      codeArtifact: wasmInstalled.functionArtifact,
      moduleArtifact: wasmInstalled.moduleArtifact,
      blockPrototypes: wasmInstalled.blockPrototypes,
      block: wasmInstalled.block,
    });
  }

  const blockPrototypes = await installNestedPrototypes({
    images,
    compilation: compiler,
    imageId,
    rootId: id,
    parentSemanticRef: objectRef(imageId, semanticArtifact.id),
    program: semanticProgram,
    representation,
    languageId: COMMON_LISP_ID,
  });
  const codeArtifact = await compiler.compileArtifact(
    objectRef(imageId, semanticArtifact.id),
    {
      id: `${id}:code`,
      targetRepresentation: executableTargetFor(representation),
      options: {blockPrototypes},
    },
  );
  const block = await ensureBlock(images, imageId, {
    id,
    code: objectRef(imageId, codeArtifact.id),
    environment: blockEnvironment,
    metadata: {...metadata, commonLisp: 'block', lane: 'neutral'},
  });

  return Object.freeze({
    syntax,
    semanticProgram,
    representation,
    globalBindingIdsUsed,
    runtimeBlocksUsed,
    sourceArtifact,
    syntaxArtifact,
    semanticArtifact,
    codeArtifact,
    blockPrototypes,
    block,
  });
}

function parseTopLevelDefun(form) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFUN') {
    return null;
  }
  if (form.elements.length < 3) {
    throw new SyntaxError('Common Lisp DEFUN requires a name, parameter list, and body');
  }
  const [, nameSym, paramForm, ...bodyForms] = form.elements;
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError('Common Lisp DEFUN name must be an ordinary symbol');
  }
  const parameters = [];
  if (isNilSymbol(paramForm)) {
    // 0 parameters
  } else if (paramForm?.kind === 'list') {
    for (const p of paramForm.elements) {
      if (p?.kind !== 'symbol' || isNilSymbol(p) || isTSymbol(p) || p.keyword) {
        throw new SyntaxError('Common Lisp DEFUN parameter must be an ordinary symbol');
      }
      parameters.push(p.name);
    }
  } else {
    throw new SyntaxError('Common Lisp DEFUN parameter list must be a list of symbols');
  }
  return {name: nameSym.name, parameters, bodyForms};
}

function parseTopLevelDefvar(form) {
  if (
    form?.kind !== 'list'
    || form.elements[0]?.kind !== 'symbol'
    || (form.elements[0].name !== 'DEFPARAMETER' && form.elements[0].name !== 'DEFVAR')
  ) {
    return null;
  }
  if (form.elements.length < 2 || form.elements.length > 4) {
    throw new SyntaxError(`Common Lisp ${form.elements[0].name} requires a variable name and optional initial value`);
  }
  const [headSym, nameSym, valueForm] = form.elements;
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError(`Common Lisp ${headSym.name} target must be an ordinary symbol`);
  }
  return {
    kind: headSym.name,
    name: nameSym.name,
    valueForm: valueForm ?? makeSymbolNode('NIL', {spelling: 'nil', keyword: false}),
  };
}

async function installCommonLispProgram({
  images,
  compilation = null,
  runtime = null,
  imageId,
  source,
  lane = 'neutral',
  skipRuntimeEnsure = false,
} = {}) {
  const effectiveImages = images ?? runtime?.images;
  const effectiveCompilation = resolveCompilation(effectiveImages, compilation ?? runtime?.compilation ?? null);
  requiredText(imageId, 'image id');
  assertMethodLane(lane);

  if (!skipRuntimeEnsure) {
    await installCommonLispRuntime({
      images: effectiveImages,
      compilation: effectiveCompilation,
      imageId,
      lane,
    });
  }

  const kernel = await findSmalltalkKernel({images: effectiveImages, imageId});
  const forms = typeof source === 'string' ? readCommonLispSource(source) : source;

  // Pre-seed all DEFUN and DEFPARAMETER/DEFVAR global bindings so recursive and mutually recursive
  // functions can reference one another regardless of declaration order.
  for (const form of forms) {
    const defun = parseTopLevelDefun(form);
    if (defun) {
      const bindingId = commonLispFunctionBindingId(defun.name);
      const existing = await resolveGlobal({
        images: effectiveImages,
        imageId,
        name: defun.name,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
      });
      if (!existing) {
        await publishGlobal({
          images: effectiveImages,
          imageId,
          namespaceId: COMMON_LISP_NAMESPACE_ID,
          name: defun.name,
          bindingId,
          value: kernel.nil,
        });
      }
      continue;
    }
    const defvar = parseTopLevelDefvar(form);
    if (defvar) {
      const bindingId = commonLispVariableBindingId(defvar.name);
      const existing = await resolveGlobal({
        images: effectiveImages,
        imageId,
        name: defvar.name,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
      });
      if (!existing) {
        await publishGlobal({
          images: effectiveImages,
          imageId,
          namespaceId: COMMON_LISP_NAMESPACE_ID,
          name: defvar.name,
          bindingId,
          value: kernel.nil,
        });
      }
    }
  }

  const compileContext = await collectCommonLispCompileContext({images: effectiveImages, imageId});
  const functions = {};
  const variables = {};
  const expressions = [];

  for (const form of forms) {
    const defun = parseTopLevelDefun(form);
    if (defun) {
      const baseId = commonLispFunctionBlockId(defun.name);
      const existingBlock = await effectiveImages.getBlock(imageId, baseId);
      const revisionKey = existingBlock
        ? base64urlEncode(utf8Encode(`${lane}:${JSON.stringify(defun.parameters)}:${JSON.stringify(defun.bodyForms)}`))
        : null;
      const blockId = existingBlock ? commonLispFunctionBlockId(defun.name, revisionKey) : baseId;
      const installed = await installCommonLispBlock({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        source: defun.bodyForms,
        id: blockId,
        parameters: defun.parameters,
        lane,
        metadata: {commonLisp: 'defun', functionName: defun.name},
        compileContext,
      });
      const blockRef = objectRef(imageId, installed.block.id);
      const bindingRef = await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: defun.name,
        bindingId: commonLispFunctionBindingId(defun.name),
        value: blockRef,
      });
      functions[defun.name] = Object.freeze({
        name: defun.name,
        blockRef,
        bindingRef,
        installed,
      });
      continue;
    }

    const defvar = parseTopLevelDefvar(form);
    if (defvar) {
      let initValue = kernel.nil;
      if (runtime?.invocations && runtime?.executor) {
        const initBlock = await installCommonLispBlock({
          images: effectiveImages,
          compilation: effectiveCompilation,
          imageId,
          source: [defvar.valueForm],
          lane,
          compileContext,
        });
        const activation = await runtime.invocations.invokeBlock(
          objectRef(imageId, initBlock.block.id),
          [],
        );
        initValue = await runtime.executor.execute(activation);
      } else if (defvar.valueForm.kind === 'integer') {
        initValue = integerValue(BigInt(defvar.valueForm.value));
      } else if (defvar.valueForm.kind === 'string') {
        initValue = textValue(defvar.valueForm.value);
      }
      const bindingRef = await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: defvar.name,
        bindingId: commonLispVariableBindingId(defvar.name),
        value: initValue,
      });
      variables[defvar.name] = Object.freeze({
        name: defvar.name,
        bindingRef,
        value: initValue,
      });
      continue;
    }

    expressions.push(form);
  }

  return Object.freeze({
    functions: Object.freeze(functions),
    variables: Object.freeze(variables),
    expressions: Object.freeze(expressions),
    compileContext,
  });
}

async function evaluateCommonLispSource({
  runtime,
  imageId,
  source,
  arguments: args = [],
  parameters = [],
  captures = {},
  lane = 'neutral',
} = {}) {
  if (!runtime?.images || !runtime?.invocations || !runtime?.executor) {
    throw new TypeError('runtime with images, invocations and executor is required');
  }
  const programResult = await installCommonLispProgram({
    images: runtime.images,
    compilation: runtime.compilation ?? null,
    runtime,
    imageId,
    source,
    lane,
  });

  if (programResult.expressions.length === 0) {
    const fnNames = Object.keys(programResult.functions);
    if (fnNames.length > 0) {
      return programResult.functions[fnNames[fnNames.length - 1]].blockRef;
    }
    const varNames = Object.keys(programResult.variables);
    if (varNames.length > 0) {
      return programResult.variables[varNames[varNames.length - 1]].value;
    }
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
    return kernel.nil;
  }

  const installed = await installCommonLispBlock({
    images: runtime.images,
    compilation: runtime.compilation ?? null,
    imageId,
    source: programResult.expressions,
    parameters,
    captures,
    lane,
    compileContext: programResult.compileContext,
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef(installed.block.imageId, installed.block.id),
    args,
  );
  return await runtime.executor.execute(activation);
}

async function attachCommonLispMethod({
  images,
  compilation,
  imageId,
  classRef,
  selector,
  functionName = null,
  blockRef = null,
  passSelf = false,
  lane = 'neutral',
} = {}) {
  requiredText(imageId, 'image id');
  let targetBlockRef = blockRef;
  if (!targetBlockRef) {
    requiredText(functionName, 'Common Lisp functionName');
    const canonical = functionName.toUpperCase();
    const resolved = await resolveGlobal({
      images,
      imageId,
      name: canonical,
      namespaceId: COMMON_LISP_NAMESPACE_ID,
    });
    if (!resolved) {
      throw new TypeError(`Common Lisp function ${canonical} is not defined in image ${imageId}`);
    }
    const bindingRecord = await images.getObject(imageId, resolved.objectId);
    targetBlockRef = bindingRecord?.slots?.['global-binding-value'] ?? null;
  }
  return await definePolyglotMethodBridge({
    images,
    compilation,
    imageId,
    classRef,
    selector,
    callableBlockRef: targetBlockRef,
    passSelf,
    lane,
  });
}

async function commonLispListToArray({images, imageId, value}) {
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const result = [];
  let cursor = canonicalizeValue(value);
  while (!sameRef(cursor, kernel.nil)) {
    if (!isObjectRef(cursor)) {
      throw new TypeError(`expected a Common Lisp Cons list or nil, got ${cursor.kind}`);
    }
    const record = await images.getObject(cursor.imageId, cursor.objectId);
    if (!record || record.shape?.objectId !== CONS_SHAPE_ID || !Array.isArray(record.indexed)) {
      throw new TypeError(`object ${cursor.imageId}/${cursor.objectId} is not a Common Lisp Cons cell`);
    }
    result.push(record.indexed[0]);
    cursor = record.indexed[1];
  }
  return result;
}

export {
  BLOCK_CLOSURE_CLASS_NAME,
  CL_NIL_BINDING_ID,
  CL_T_BINDING_ID,
  COMMON_LISP,
  COMMON_LISP_ID,
  COMMON_LISP_NAMESPACE_ID,
  COMMON_LISP_SOURCE_V0,
  COMMON_LISP_SYNTAX_V0,
  CONS_CLASS_NAME,
  CONS_SHAPE_ID,
  RUNTIME_BLOCK_IDS,
  attachCommonLispMethod,
  commonLispFunctionBindingId,
  commonLispFunctionBlockId,
  commonLispListToArray,
  commonLispVariableBindingId,
  compileCommonLispBlock,
  compileCommonLispSemanticProgram,
  evaluateCommonLispSource,
  installCommonLispBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  readCommonLispSource,
  tokenizeCommonLispSource,
};
