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
  ensureClassFromDeclaration,
  ensureNamedClass,
  ensureSmalltalkShape,
} from './smalltalk-class-builder.js';
import {
  installSmalltalkCharacterProtocol,
} from './smalltalk-character.js';
import {
  CONDITION_CLASSES,
  installSmalltalkConditionProtocol,
  installSmalltalkExceptionAccessors,
} from './smalltalk-conditions.js';
import {installSmalltalkControlFlow} from './smalltalk-control-flow.js';
import {
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
} from './smalltalk-dictionary.js';
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
import {
  EMPTY_SHAPE_ID,
  findSmalltalkKernel,
  installSmalltalkKernel,
} from './smalltalk-kernel.js';
import {sameRef} from './smalltalk-lookup.js';
import {executableTargetFor, installNestedPrototypes} from './smalltalk-nested-blocks.js';
import {
  SYMBOL_CLASS_NAME,
  SYMBOL_SHAPE_ID,
  SYMBOL_SPELLING_SLOT,
  symbolObjectId,
} from './smalltalk-primitives-symbol.js';
import {installSmalltalkSymbolProtocol} from './smalltalk-symbol.js';
import {installSmalltalkTextByteArrayProtocol} from './smalltalk-text-bytearray.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

const COMMON_LISP_ID = 'common-lisp';
const COMMON_LISP_SOURCE_V0 = 'common-lisp/source-v0';
const COMMON_LISP_SYNTAX_V0 = 'common-lisp/syntax-v0';
const COMMON_LISP_MACRO_V0 = 'common-lisp/macro-v0';
const COMMON_LISP_STRUCT_V0 = 'common-lisp/struct-v0';
const COMMON_LISP_SIGNATURE_V0 = 'common-lisp/signature-v0';
const COMMON_LISP_NAMESPACE_ID = 'common-lisp/namespace/v1';
const CONS_CLASS_NAME = 'Cons';
const CONS_SHAPE_ID = 'smalltalk/cons-instance-shape/v1';
const BLOCK_CLOSURE_CLASS_NAME = 'BlockClosure';
const BLOCK_EXIT_CLASS_NAME = 'BlockExit';
const COMMON_LISP_TOMBSTONE_ID = 'common-lisp/hash-table-tombstone/v1';
const COMMON_LISP_UNSUPPLIED_ID = 'common-lisp/unsupplied/v1';

const COMMON_LISP = Object.freeze({
  id: COMMON_LISP_ID,
  name: 'Common Lisp',
  version: '0.2.0',
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
  CHARACTERP: 'common-lisp/runtime/characterp',
  VECTORP: 'common-lisp/runtime/vectorp',
  HASH_TABLE_P: 'common-lisp/runtime/hash-table-p',
  NULL: 'common-lisp/runtime/null',
  EQ: 'common-lisp/runtime/eq',
  EQL: 'common-lisp/runtime/eql',
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
  BLOCK_RETURN: 'common-lisp/runtime/block-return',
  UNSUPPLIED: 'common-lisp/runtime/unsupplied',
  UNSUPPLIED_P: 'common-lisp/runtime/unsupplied-p',
  TOMBSTONE_P: 'common-lisp/runtime/tombstone-p',
  MAKE_ARRAY: 'common-lisp/runtime/make-array',
  AREF: 'common-lisp/runtime/aref',
  SET_AREF: 'common-lisp/runtime/set-aref',
  VECTOR_LENGTH: 'common-lisp/runtime/vector-length',
  STRING_LENGTH: 'common-lisp/runtime/string-length',
  CHAR: 'common-lisp/runtime/char',
  CHAR_CODE: 'common-lisp/runtime/char-code',
  CODE_CHAR: 'common-lisp/runtime/code-char',
  MAKE_HASH_TABLE: 'common-lisp/runtime/make-hash-table',
  GETHASH: 'common-lisp/runtime/gethash',
  SET_GETHASH: 'common-lisp/runtime/set-gethash',
  REMHASH: 'common-lisp/runtime/remhash',
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
  CHARACTERP: RUNTIME_BLOCK_IDS.CHARACTERP,
  VECTORP: RUNTIME_BLOCK_IDS.VECTORP,
  ARRAYP: RUNTIME_BLOCK_IDS.VECTORP,
  'HASH-TABLE-P': RUNTIME_BLOCK_IDS.HASH_TABLE_P,
  NULL: RUNTIME_BLOCK_IDS.NULL,
  NOT: RUNTIME_BLOCK_IDS.NULL,
  EQ: RUNTIME_BLOCK_IDS.EQ,
  EQL: RUNTIME_BLOCK_IDS.EQL,
  '%EQL': RUNTIME_BLOCK_IDS.EQL,
  'STRING=': RUNTIME_BLOCK_IDS.EQL,
  'CHAR=': RUNTIME_BLOCK_IDS.EQL,
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
  '%BLOCK-RETURN': RUNTIME_BLOCK_IDS.BLOCK_RETURN,
  '%UNSUPPLIED': RUNTIME_BLOCK_IDS.UNSUPPLIED,
  '%UNSUPPLIED-P': RUNTIME_BLOCK_IDS.UNSUPPLIED_P,
  '%TOMBSTONE-P': RUNTIME_BLOCK_IDS.TOMBSTONE_P,
  '%MAKE-ARRAY': RUNTIME_BLOCK_IDS.MAKE_ARRAY,
  AREF: RUNTIME_BLOCK_IDS.AREF,
  SVREF: RUNTIME_BLOCK_IDS.AREF,
  '%SET-AREF': RUNTIME_BLOCK_IDS.SET_AREF,
  '%SET-SVREF': RUNTIME_BLOCK_IDS.SET_AREF,
  '%VECTOR-LENGTH': RUNTIME_BLOCK_IDS.VECTOR_LENGTH,
  '%STRING-LENGTH': RUNTIME_BLOCK_IDS.STRING_LENGTH,
  CHAR: RUNTIME_BLOCK_IDS.CHAR,
  'CHAR-CODE': RUNTIME_BLOCK_IDS.CHAR_CODE,
  'CODE-CHAR': RUNTIME_BLOCK_IDS.CODE_CHAR,
  '%MAKE-HASH-TABLE': RUNTIME_BLOCK_IDS.MAKE_HASH_TABLE,
  GETHASH: RUNTIME_BLOCK_IDS.GETHASH,
  '%SET-GETHASH': RUNTIME_BLOCK_IDS.SET_GETHASH,
  REMHASH: RUNTIME_BLOCK_IDS.REMHASH,
});

const STANDARD_LIBRARY_SOURCE = `
(defun second (list) (car (cdr list)))
(defun third (list) (car (cdr (cdr list))))
(defun caar (x) (car (car x)))
(defun cadr (x) (car (cdr x)))
(defun cdar (x) (cdr (car x)))
(defun cddr (x) (cdr (cdr x)))

(defun equal (a b)
  (if (%eql a b)
      t
      (if (and (consp a) (consp b))
          (and (equal (car a) (car b))
               (equal (cdr a) (cdr b)))
          nil)))

(defun %list-length (list)
  (if (null list)
      0
      (+ 1 (%list-length (cdr list)))))

(defun length (seq)
  (cond
    ((null seq) 0)
    ((consp seq) (%list-length seq))
    ((vectorp seq) (%vector-length seq))
    ((stringp seq) (%string-length seq))
    (t (send seq :size))))

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

(defun %set-nth (n list val)
  (if (<= n 0)
      (progn (rplaca list val) val)
      (%set-nth (- n 1) (cdr list) val)))

(defun elt (seq index)
  (cond
    ((vectorp seq) (aref seq index))
    ((stringp seq) (char seq index))
    (t (nth index seq))))

(defun %set-elt (seq index val)
  (if (vectorp seq)
      (%set-aref seq index val)
      (%set-nth index seq val)))

(defun %fill-array (arr idx size val)
  (if (>= idx size)
      arr
      (progn
        (%set-aref arr idx val)
        (%fill-array arr (+ idx 1) size val))))

(defun %make-array-init (size val)
  (%fill-array (%make-array size) 0 size val))

(defun %copy-vec-into (arr seq idx size)
  (if (>= idx size)
      arr
      (progn
        (%set-aref arr idx (aref seq idx))
        (%copy-vec-into arr seq (+ idx 1) size))))

(defun %copy-list-into (arr cur idx size)
  (if (or (>= idx size) (null cur))
      arr
      (progn
        (%set-aref arr idx (car cur))
        (%copy-list-into arr (cdr cur) (+ idx 1) size))))

(defun %make-array-contents (size seq)
  (let ((arr (%make-array size)))
    (if (vectorp seq)
        (%copy-vec-into arr seq 0 size)
        (%copy-list-into arr seq 0 size))))

(defun %list-subseq (list start end idx)
  (if (or (null list) (and end (>= idx end)))
      nil
      (if (< idx start)
          (%list-subseq (cdr list) start end (+ idx 1))
          (cons (car list) (%list-subseq (cdr list) start end (+ idx 1))))))

(defun %copy-subvec (out vec start idx len)
  (if (>= idx len)
      out
      (progn
        (%set-aref out idx (aref vec (+ start idx)))
        (%copy-subvec out vec start (+ idx 1) len))))

(defun %vector-subseq (vec start end)
  (let* ((limit (if end end (%vector-length vec)))
         (len (- limit start)))
    (%copy-subvec (%make-array len) vec start 0 len)))

(defun %copy-byte-array-into (buf bytes offset idx count)
  (if (>= idx count)
      buf
      (progn
        (%set-aref buf (+ offset idx) (send bytes :at: (+ idx 1)))
        (%copy-byte-array-into buf bytes offset (+ idx 1) count))))

(defun %string-append (s1 s2)
  (let* ((b1 (send s1 :utf8Bytes))
         (b2 (send s2 :utf8Bytes))
         (n1 (send b1 :size))
         (n2 (send b2 :size))
         (buf (%make-array (+ n1 n2))))
    (%copy-byte-array-into buf b1 0 0 n1)
    (%copy-byte-array-into buf b2 n1 0 n2)
    (send (send ByteArray :fromArray: buf) :utf8Text)))

(defun subseq (seq start &optional end)
  (if (vectorp seq)
      (%vector-subseq seq start end)
      (%list-subseq seq start end 0)))

(defun %plist-has-key (plist key)
  (if (null plist)
      nil
      (if (eq (car plist) key)
          t
          (%plist-has-key (cdr (cdr plist)) key))))

(defun %plist-get (plist key default)
  (if (null plist)
      default
      (if (eq (car plist) key)
          (car (cdr plist))
          (%plist-get (cdr (cdr plist)) key default))))

(defun maphash (fn table)
  (send table :keysAndValuesDo:
        (lambda (k v)
          (unless (%tombstone-p v)
            (funcall fn k v))))
  nil)

(defun hash-table-count (table)
  (let ((count 0))
    (maphash (lambda (k v) (setq count (+ count 1))) table)
    count))

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

function commonLispMacroBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp macro name').toUpperCase();
  return `common-lisp/macro-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispMacroArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp macro name').toUpperCase();
  const base = `common-lisp/macro/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispStructBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp struct name').toUpperCase();
  return `common-lisp/struct-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispStructArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp struct name').toUpperCase();
  const base = `common-lisp/struct/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispSignatureBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp function signature name').toUpperCase();
  return `common-lisp/signature-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispSignatureArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp function signature name').toUpperCase();
  const base = `common-lisp/signature/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
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
    if (ch === '#' && source[index + 1] === '(') {
      tokens.push({type: '#(', value: '#('});
      index += 2;
      continue;
    }
    if (ch === '#' && source[index + 1] === '\\') {
      index += 2;
      if (index >= length) throw new SyntaxError('unterminated #\\ character literal in Common Lisp source');
      const firstChar = source[index];
      index += 1;
      let restChars = '';
      while (index < length && !isDelimiter(source[index])) {
        restChars += source[index];
        index += 1;
      }
      const charSpec = firstChar + restChars;
      let codePoint;
      if (charSpec.length === 1) {
        codePoint = charSpec.codePointAt(0);
      } else {
        const upper = charSpec.toUpperCase();
        if (upper === 'SPACE') codePoint = 32;
        else if (upper === 'NEWLINE' || upper === 'LINEFEED') codePoint = 10;
        else if (upper === 'TAB') codePoint = 9;
        else if (upper === 'RETURN') codePoint = 13;
        else if (upper === 'NULL' || upper === 'NUL') codePoint = 0;
        else if (upper === 'BACKSPACE') codePoint = 8;
        else if (upper === 'PAGE') codePoint = 12;
        else if (upper === 'ESCAPE' || upper === 'ESC') codePoint = 27;
        else throw new SyntaxError(`unknown Common Lisp character name: #\\${charSpec}`);
      }
      tokens.push({type: 'char', value: String(codePoint)});
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
      case 'char':
        return makeListNode([
          makeSymbolNode('CODE-CHAR'),
          Object.freeze({kind: 'integer', value: token.value}),
        ]);
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
      case '#(': {
        const elements = [];
        while (cursor < tokens.length && tokens[cursor].type !== ')') {
          elements.push(makeListNode([makeSymbolNode('QUOTE'), readForm()]));
        }
        if (cursor >= tokens.length || tokens[cursor].type !== ')') {
          throw new SyntaxError('unterminated #(...) vector literal in Common Lisp source');
        }
        cursor += 1;
        return makeListNode([makeSymbolNode('VECTOR'), ...elements]);
      }
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
// Pre-Compilation Macroexpander & Lambda-List Destructuring
// -----------------------------------------------------------------------------

function isNilSymbol(form) {
  return Boolean(form && form.kind === 'symbol' && form.name === 'NIL');
}

function isTSymbol(form) {
  return Boolean(form && form.kind === 'symbol' && form.name === 'T');
}

const NIL_NODE = makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
const T_NODE = makeSymbolNode('T', {spelling: 't', keyword: false});

function makeIntNode(val) {
  return Object.freeze({kind: 'integer', value: BigInt(val).toString(10)});
}

function astBool(cond) {
  return cond ? T_NODE : NIL_NODE;
}

function astEqual(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'integer' || a.kind === 'string') return a.value === b.value;
  if (a.kind === 'symbol') return a.name === b.name;
  if (a.kind === 'list') {
    if (a.elements.length !== b.elements.length) return false;
    for (let i = 0; i < a.elements.length; i += 1) {
      if (!astEqual(a.elements[i], b.elements[i])) return false;
    }
    if (a.dottedTail === null && b.dottedTail === null) return true;
    return astEqual(a.dottedTail, b.dottedTail);
  }
  return false;
}

function astCons(head, tail) {
  if (isNilSymbol(tail)) return makeListNode([head]);
  if (tail?.kind === 'list') {
    return makeListNode([head, ...tail.elements], tail.dottedTail);
  }
  return makeListNode([head], tail);
}

function astCar(node) {
  if (isNilSymbol(node)) return NIL_NODE;
  if (node?.kind === 'list') return node.elements[0] ?? NIL_NODE;
  throw new SyntaxError(`Common Lisp CAR in macro expansion expected a list, got ${node?.kind}`);
}

function astCdr(node) {
  if (isNilSymbol(node)) return NIL_NODE;
  if (node?.kind === 'list') {
    if (node.elements.length > 1) {
      return makeListNode(node.elements.slice(1), node.dottedTail);
    }
    return node.dottedTail ?? NIL_NODE;
  }
  throw new SyntaxError(`Common Lisp CDR in macro expansion expected a list, got ${node?.kind}`);
}

function astAppend(lists) {
  if (lists.length === 0) return NIL_NODE;
  const collected = [];
  for (let i = 0; i < lists.length - 1; i += 1) {
    const item = lists[i];
    if (isNilSymbol(item)) continue;
    if (item?.kind !== 'list') {
      throw new SyntaxError('Common Lisp APPEND in macro expansion expected a list');
    }
    collected.push(...item.elements);
  }
  const last = lists[lists.length - 1];
  if (isNilSymbol(last)) return makeListNode(collected);
  if (last?.kind === 'list') {
    return makeListNode([...collected, ...last.elements], last.dottedTail);
  }
  return makeListNode(collected, last);
}

function parseLambdaList(paramForm) {
  if (isNilSymbol(paramForm)) {
    return {
      isSimple: true,
      required: [],
      optional: [],
      rest: null,
      keys: [],
    };
  }
  if (paramForm?.kind === 'symbol') {
    return {
      isSimple: false,
      required: [],
      optional: [],
      rest: paramForm,
      keys: [],
    };
  }
  if (paramForm?.kind !== 'list') {
    throw new SyntaxError('Common Lisp parameter list must be a list');
  }
  const required = [];
  const optional = [];
  let rest = paramForm.dottedTail ?? null;
  const keys = [];
  let mode = 'required';

  for (let i = 0; i < paramForm.elements.length; i += 1) {
    const item = paramForm.elements[i];
    if (item?.kind === 'symbol' && item.name.startsWith('&')) {
      if (item.name === '&OPTIONAL') {
        mode = 'optional';
        continue;
      }
      if (item.name === '&REST' || item.name === '&BODY') {
        if (i + 1 >= paramForm.elements.length) {
          throw new SyntaxError(`Common Lisp ${item.name} must be followed by a parameter pattern`);
        }
        rest = paramForm.elements[i + 1];
        i += 1;
        mode = 'after-rest';
        continue;
      }
      if (item.name === '&KEY') {
        mode = 'key';
        continue;
      }
      if (item.name === '&ALLOW-OTHER-KEYS') {
        continue;
      }
    }

    if (mode === 'required') {
      required.push(item);
    } else if (mode === 'optional') {
      if (item?.kind === 'symbol') {
        optional.push({name: item.name, initForm: NIL_NODE, suppliedP: null});
      } else if (item?.kind === 'list' && item.elements.length >= 1 && item.elements[0]?.kind === 'symbol') {
        optional.push({
          name: item.elements[0].name,
          initForm: item.elements[1] ?? NIL_NODE,
          suppliedP: item.elements[2]?.kind === 'symbol' ? item.elements[2].name : null,
        });
      } else {
        throw new SyntaxError('invalid Common Lisp &optional parameter specification');
      }
    } else if (mode === 'key') {
      if (item?.kind === 'symbol') {
        keys.push({
          name: item.name,
          keyword: `:${item.name}`,
          initForm: NIL_NODE,
          suppliedP: null,
        });
      } else if (item?.kind === 'list' && item.elements.length >= 1) {
        const first = item.elements[0];
        let varName;
        let kwName;
        if (first?.kind === 'symbol') {
          varName = first.name;
          kwName = `:${first.name}`;
        } else if (
          first?.kind === 'list'
          && first.elements.length === 2
          && first.elements[0]?.kind === 'symbol'
          && first.elements[1]?.kind === 'symbol'
        ) {
          kwName = first.elements[0].name.startsWith(':') ? first.elements[0].name : `:${first.elements[0].name}`;
          varName = first.elements[1].name;
        } else {
          throw new SyntaxError('invalid Common Lisp &key parameter specification');
        }
        keys.push({
          name: varName,
          keyword: kwName,
          initForm: item.elements[1] ?? NIL_NODE,
          suppliedP: item.elements[2]?.kind === 'symbol' ? item.elements[2].name : null,
        });
      } else {
        throw new SyntaxError('invalid Common Lisp &key parameter specification');
      }
    } else {
      throw new SyntaxError(`unexpected parameter after &rest/&body in Common Lisp lambda list`);
    }
  }

  const allRequiredSimple = required.every(
    (p) => p?.kind === 'symbol' && !isNilSymbol(p) && !isTSymbol(p) && !p.keyword,
  );
  const isSimple = allRequiredSimple && optional.length === 0 && rest === null && keys.length === 0;
  return {isSimple, required, optional, rest, keys};
}

function createMacroContext({macros = {}, structs = {}, functionSignatures = {}} = {}) {
  const userMacros = new Map();
  for (const [k, v] of Object.entries(macros)) {
    userMacros.set(k.toUpperCase(), v);
  }
  const structMap = new Map();
  for (const [k, v] of Object.entries(structs)) {
    structMap.set(k.toUpperCase(), v);
    if (v?.constructorName) {
      userMacros.set(v.constructorName.toUpperCase(), {
        kind: 'struct-constructor',
        struct: v,
      });
    }
  }
  const sigMap = new Map();
  for (const [k, v] of Object.entries(functionSignatures)) {
    sigMap.set(k.toUpperCase(), v);
  }
  let gensymCounter = 0;
  return {
    userMacros,
    structs: structMap,
    functionSignatures: sigMap,
    freshGensym(prefix = 'G') {
      gensymCounter += 1;
      const clean = String(prefix).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      return makeSymbolNode(`%G_${clean}_${gensymCounter}`, {
        spelling: `%G_${clean}_${gensymCounter}`,
        keyword: false,
      });
    },
  };
}

function buildDestructuringLetBindings(patternForm, valueForm, ctx, outBindings) {
  if (isNilSymbol(patternForm)) {
    return;
  }
  if (patternForm?.kind === 'symbol') {
    outBindings.push(makeListNode([patternForm, valueForm]));
    return;
  }
  const parsed = parseLambdaList(patternForm);
  const cursorSym = ctx.freshGensym('DB_CUR');
  outBindings.push(makeListNode([cursorSym, valueForm]));

  for (const reqPattern of parsed.required) {
    const headVal = makeListNode([makeSymbolNode('CAR'), cursorSym]);
    buildDestructuringLetBindings(reqPattern, headVal, ctx, outBindings);
    outBindings.push(makeListNode([cursorSym, makeListNode([makeSymbolNode('CDR'), cursorSym])]));
  }

  for (const optSpec of parsed.optional) {
    const hasElem = makeListNode([makeSymbolNode('CONSP'), cursorSym]);
    if (optSpec.suppliedP) {
      outBindings.push(
        makeListNode([
          makeSymbolNode(optSpec.suppliedP),
          makeListNode([makeSymbolNode('IF'), hasElem, T_NODE, NIL_NODE]),
        ]),
      );
    }
    outBindings.push(
      makeListNode([
        makeSymbolNode(optSpec.name),
        makeListNode([
          makeSymbolNode('IF'),
          hasElem,
          makeListNode([makeSymbolNode('CAR'), cursorSym]),
          optSpec.initForm,
        ]),
      ]),
    );
    outBindings.push(makeListNode([cursorSym, makeListNode([makeSymbolNode('CDR'), cursorSym])]));
  }

  if (parsed.rest) {
    buildDestructuringLetBindings(parsed.rest, cursorSym, ctx, outBindings);
  }

  for (const keySpec of parsed.keys) {
    const kwNode = makeSymbolNode(keySpec.keyword, {
      spelling: keySpec.keyword.slice(1),
      keyword: true,
    });
    const hasKeyExpr = makeListNode([makeSymbolNode('%PLIST-HAS-KEY'), cursorSym, kwNode]);
    const hasKeySym = keySpec.suppliedP ? makeSymbolNode(keySpec.suppliedP) : ctx.freshGensym('HAS_KEY');
    outBindings.push(makeListNode([hasKeySym, hasKeyExpr]));
    outBindings.push(
      makeListNode([
        makeSymbolNode(keySpec.name),
        makeListNode([
          makeSymbolNode('IF'),
          hasKeySym,
          makeListNode([makeSymbolNode('%PLIST-GET'), cursorSym, kwNode, NIL_NODE]),
          keySpec.initForm,
        ]),
      ]),
    );
  }
}

function normalizeFunctionDefinition(name, paramForm, bodyForms, ctx) {
  const parsed = parseLambdaList(paramForm);
  let wrappedBody = [...bodyForms];
  if (name && containsReturnFrom(wrappedBody, name)) {
    wrappedBody = [makeListNode([makeSymbolNode('BLOCK'), makeSymbolNode(name), ...wrappedBody])];
  }
  if (parsed.isSimple) {
    const paramNames = parsed.required.map((p) => p.name);
    return {
      paramListForm: makeListNode(parsed.required),
      paramNames,
      bodyForms: wrappedBody,
      signature: null,
    };
  }

  const flatParamSyms = [];
  const letStarBindings = [];

  for (const reqItem of parsed.required) {
    if (reqItem?.kind === 'symbol') {
      flatParamSyms.push(reqItem);
    } else {
      const reqTemp = ctx.freshGensym('REQ');
      flatParamSyms.push(reqTemp);
      buildDestructuringLetBindings(reqItem, reqTemp, ctx, letStarBindings);
    }
  }

  for (const optSpec of parsed.optional) {
    const optParamSym = ctx.freshGensym(`OPT_${optSpec.name}`);
    flatParamSyms.push(optParamSym);
    const suppliedExpr = makeListNode([
      makeSymbolNode('NOT'),
      makeListNode([makeSymbolNode('%UNSUPPLIED-P'), optParamSym]),
    ]);
    const suppliedSym = optSpec.suppliedP
      ? makeSymbolNode(optSpec.suppliedP)
      : ctx.freshGensym(`SUP_${optSpec.name}`);
    letStarBindings.push(makeListNode([suppliedSym, suppliedExpr]));
    const initExpr = expandAllMacrosInForm(optSpec.initForm, ctx);
    letStarBindings.push(
      makeListNode([
        makeSymbolNode(optSpec.name),
        makeListNode([makeSymbolNode('IF'), suppliedSym, optParamSym, initExpr]),
      ]),
    );
  }

  const hasRestOrKey = Boolean(parsed.rest !== null || parsed.keys.length > 0);
  if (hasRestOrKey) {
    const restParamSym = ctx.freshGensym('REST_ARGS');
    flatParamSyms.push(restParamSym);
    if (parsed.rest) {
      buildDestructuringLetBindings(parsed.rest, restParamSym, ctx, letStarBindings);
    }
    for (const keySpec of parsed.keys) {
      const kwNode = makeSymbolNode(keySpec.keyword, {
        spelling: keySpec.keyword.slice(1),
        keyword: true,
      });
      const suppliedExpr = makeListNode([makeSymbolNode('%PLIST-HAS-KEY'), restParamSym, kwNode]);
      const suppliedSym = keySpec.suppliedP
        ? makeSymbolNode(keySpec.suppliedP)
        : ctx.freshGensym(`KEY_SUP_${keySpec.name}`);
      const initExpr = expandAllMacrosInForm(keySpec.initForm, ctx);
      letStarBindings.push(makeListNode([suppliedSym, suppliedExpr]));
      letStarBindings.push(
        makeListNode([
          makeSymbolNode(keySpec.name),
          makeListNode([
            makeSymbolNode('IF'),
            suppliedSym,
            makeListNode([makeSymbolNode('%PLIST-GET'), restParamSym, kwNode, NIL_NODE]),
            initExpr,
          ]),
        ]),
      );
    }
  }

  const finalBody = letStarBindings.length > 0
    ? [makeListNode([makeSymbolNode('LET*'), makeListNode(letStarBindings), ...wrappedBody])]
    : wrappedBody;

  const signature = Object.freeze({
    name: name ? name.toUpperCase() : null,
    requiredCount: parsed.required.length,
    optionalCount: parsed.optional.length,
    hasRestOrKey,
  });

  return {
    paramListForm: makeListNode(flatParamSyms),
    paramNames: flatParamSyms.map((s) => s.name),
    bodyForms: finalBody,
    signature,
  };
}

function adaptCallArguments(args, signature) {
  if (!signature) return args;
  const {requiredCount, optionalCount, hasRestOrKey} = signature;
  if (args.length < requiredCount) {
    throw new SyntaxError(
      `Common Lisp function ${signature.name ?? ''} expected at least ${requiredCount} arguments, got ${args.length}`,
    );
  }
  const adapted = [];
  for (let i = 0; i < requiredCount; i += 1) {
    adapted.push(args[i]);
  }
  for (let j = 0; j < optionalCount; j += 1) {
    const idx = requiredCount + j;
    if (idx < args.length) {
      adapted.push(args[idx]);
    } else {
      adapted.push(makeListNode([makeSymbolNode('%UNSUPPLIED')]));
    }
  }
  if (hasRestOrKey) {
    const restSlice = args.slice(requiredCount + optionalCount);
    adapted.push(
      restSlice.length === 0
        ? NIL_NODE
        : makeListNode([makeSymbolNode('LIST'), ...restSlice]),
    );
  } else if (args.length > requiredCount + optionalCount) {
    throw new SyntaxError(
      `Common Lisp function ${signature.name ?? ''} expected at most ${requiredCount + optionalCount} arguments, got ${args.length}`,
    );
  }
  return adapted;
}

function bindMacroLambdaList(lambdaListForm, argForms, env, ctx) {
  if (isNilSymbol(lambdaListForm)) {
    if (argForms.length > 0) {
      throw new SyntaxError(`Common Lisp macro expected 0 arguments, got ${argForms.length}`);
    }
    return;
  }
  if (lambdaListForm?.kind === 'symbol') {
    env.set(lambdaListForm.name, makeListNode(argForms));
    return;
  }
  const parsed = parseLambdaList(lambdaListForm);
  let cursor = 0;
  for (const reqPattern of parsed.required) {
    if (cursor >= argForms.length) {
      throw new SyntaxError(
        `Common Lisp macro expected at least ${parsed.required.length} arguments, got ${argForms.length}`,
      );
    }
    const argVal = argForms[cursor];
    cursor += 1;
    if (reqPattern?.kind === 'symbol') {
      env.set(reqPattern.name, argVal);
    } else if (reqPattern?.kind === 'list') {
      const subElems = isNilSymbol(argVal) ? [] : argVal?.kind === 'list' ? argVal.elements : null;
      if (subElems === null) {
        throw new SyntaxError('Common Lisp macro destructuring pattern expected a list argument');
      }
      bindMacroLambdaList(reqPattern, subElems, env, ctx);
    }
  }

  for (const optSpec of parsed.optional) {
    const supplied = cursor < argForms.length;
    const val = supplied ? argForms[cursor] : evalMacroForm(optSpec.initForm, env, ctx);
    if (supplied) cursor += 1;
    env.set(optSpec.name, val);
    if (optSpec.suppliedP) {
      env.set(optSpec.suppliedP, astBool(supplied));
    }
  }

  const remaining = argForms.slice(cursor);
  if (parsed.rest) {
    if (parsed.rest.kind === 'symbol') {
      env.set(parsed.rest.name, makeListNode(remaining));
    } else {
      bindMacroLambdaList(parsed.rest, remaining, env, ctx);
    }
  }

  if (parsed.keys.length > 0) {
    const kvMap = new Map();
    for (let i = 0; i + 1 < remaining.length; i += 2) {
      const k = remaining[i];
      if (k?.kind === 'symbol') {
        const kwName = k.name.startsWith(':') ? k.name : `:${k.name}`;
        if (!kvMap.has(kwName)) kvMap.set(kwName, remaining[i + 1]);
      }
    }
    for (const keySpec of parsed.keys) {
      const supplied = kvMap.has(keySpec.keyword);
      const val = supplied ? kvMap.get(keySpec.keyword) : evalMacroForm(keySpec.initForm, env, ctx);
      env.set(keySpec.name, val);
      if (keySpec.suppliedP) {
        env.set(keySpec.suppliedP, astBool(supplied));
      }
    }
  }
}

function evalMacroSequence(forms, env, ctx) {
  if (forms.length === 0) return NIL_NODE;
  let last = NIL_NODE;
  for (const f of forms) {
    last = evalMacroForm(f, env, ctx);
  }
  return last;
}

function evalMacroForm(form, env, ctx) {
  if (!form || typeof form !== 'object') return NIL_NODE;
  if (form.kind === 'integer' || form.kind === 'string') return form;
  if (form.kind === 'symbol') {
    if (isNilSymbol(form) || isTSymbol(form) || form.keyword) return form;
    if (env.has(form.name)) return env.get(form.name);
    throw new SyntaxError(`unbound variable ${form.name} during Common Lisp macro expansion`);
  }
  if (form.kind !== 'list') return form;
  const [head, ...args] = form.elements;

  if (head?.kind === 'list' && head.elements[0]?.kind === 'symbol' && head.elements[0].name === 'LAMBDA') {
    const [, paramForm, ...bodyForms] = head.elements;
    const callArgs = args.map((a) => evalMacroForm(a, env, ctx));
    const childEnv = new Map(env);
    bindMacroLambdaList(paramForm, callArgs, childEnv, ctx);
    return evalMacroSequence(bodyForms, childEnv, ctx);
  }

  if (head?.kind !== 'symbol') {
    throw new SyntaxError('invalid compound form in Common Lisp macro body');
  }

  switch (head.name) {
    case 'QUOTE':
      return args[0] ?? NIL_NODE;
    case 'PROGN':
      return evalMacroSequence(args, env, ctx);
    case 'PROG1': {
      const first = evalMacroForm(args[0], env, ctx);
      evalMacroSequence(args.slice(1), env, ctx);
      return first;
    }
    case 'PROG2': {
      evalMacroForm(args[0], env, ctx);
      const second = evalMacroForm(args[1], env, ctx);
      evalMacroSequence(args.slice(2), env, ctx);
      return second;
    }
    case 'IF': {
      const testVal = evalMacroForm(args[0], env, ctx);
      if (!isNilSymbol(testVal)) return evalMacroForm(args[1], env, ctx);
      return args.length >= 3 ? evalMacroForm(args[2], env, ctx) : NIL_NODE;
    }
    case 'WHEN': {
      const testVal = evalMacroForm(args[0], env, ctx);
      return !isNilSymbol(testVal) ? evalMacroSequence(args.slice(1), env, ctx) : NIL_NODE;
    }
    case 'UNLESS': {
      const testVal = evalMacroForm(args[0], env, ctx);
      return isNilSymbol(testVal) ? evalMacroSequence(args.slice(1), env, ctx) : NIL_NODE;
    }
    case 'COND': {
      for (const clause of args) {
        if (clause?.kind !== 'list' || clause.elements.length === 0) continue;
        const [testForm, ...bodyForms] = clause.elements;
        if (isTSymbol(testForm)) {
          return bodyForms.length > 0 ? evalMacroSequence(bodyForms, env, ctx) : T_NODE;
        }
        const testVal = evalMacroForm(testForm, env, ctx);
        if (!isNilSymbol(testVal)) {
          return bodyForms.length > 0 ? evalMacroSequence(bodyForms, env, ctx) : testVal;
        }
      }
      return NIL_NODE;
    }
    case 'AND': {
      let last = T_NODE;
      for (const a of args) {
        last = evalMacroForm(a, env, ctx);
        if (isNilSymbol(last)) return NIL_NODE;
      }
      return last;
    }
    case 'OR': {
      for (const a of args) {
        const val = evalMacroForm(a, env, ctx);
        if (!isNilSymbol(val)) return val;
      }
      return NIL_NODE;
    }
    case 'LET': {
      const [bindingsForm, ...bodyForms] = args;
      const items = isNilSymbol(bindingsForm) ? [] : bindingsForm.elements ?? [];
      const pairs = items.map((item) => {
        if (item.kind === 'symbol') return [item.name, NIL_NODE];
        const varSym = item.elements[0];
        const val = item.elements.length >= 2 ? evalMacroForm(item.elements[1], env, ctx) : NIL_NODE;
        return [varSym.name, val];
      });
      const childEnv = new Map(env);
      for (const [k, v] of pairs) childEnv.set(k, v);
      return evalMacroSequence(bodyForms, childEnv, ctx);
    }
    case 'LET*': {
      const [bindingsForm, ...bodyForms] = args;
      const items = isNilSymbol(bindingsForm) ? [] : bindingsForm.elements ?? [];
      const childEnv = new Map(env);
      for (const item of items) {
        if (item.kind === 'symbol') {
          childEnv.set(item.name, NIL_NODE);
        } else {
          const varSym = item.elements[0];
          const val = item.elements.length >= 2 ? evalMacroForm(item.elements[1], childEnv, ctx) : NIL_NODE;
          childEnv.set(varSym.name, val);
        }
      }
      return evalMacroSequence(bodyForms, childEnv, ctx);
    }
    case 'SETQ': {
      let last = NIL_NODE;
      for (let i = 0; i < args.length; i += 2) {
        const sym = args[i];
        last = evalMacroForm(args[i + 1], env, ctx);
        env.set(sym.name, last);
      }
      return last;
    }
    case 'DESTRUCTURING-BIND': {
      const [patternForm, exprForm, ...bodyForms] = args;
      const exprVal = evalMacroForm(exprForm, env, ctx);
      const listElems = isNilSymbol(exprVal) ? [] : exprVal?.kind === 'list' ? exprVal.elements : [];
      const childEnv = new Map(env);
      bindMacroLambdaList(patternForm, listElems, childEnv, ctx);
      return evalMacroSequence(bodyForms, childEnv, ctx);
    }
    case 'LAMBDA': {
      const [paramForm, ...bodyForms] = args;
      return {
        kind: 'macro-closure',
        invoke(callArgs) {
          const childEnv = new Map(env);
          bindMacroLambdaList(paramForm, callArgs, childEnv, ctx);
          return evalMacroSequence(bodyForms, childEnv, ctx);
        },
      };
    }
    case 'FUNCTION': {
      const target = args[0];
      if (target?.kind === 'list' && target.elements[0]?.name === 'LAMBDA') {
        return evalMacroForm(target, env, ctx);
      }
      if (target?.kind === 'symbol') {
        if (env.has(target.name)) return env.get(target.name);
        return {
          kind: 'macro-closure',
          invoke(callArgs) {
            return evalMacroCallByName(target.name, callArgs, env, ctx);
          },
        };
      }
      throw new SyntaxError('unsupported FUNCTION designator in Common Lisp macro body');
    }
    default: {
      // Check if head is itself a macro before evaluating args
      const macroAttempt = macroexpand1CommonLispForm(form, ctx);
      if (macroAttempt.expanded) {
        return evalMacroForm(macroAttempt.form, env, ctx);
      }
      const evalArgs = args.map((a) => evalMacroForm(a, env, ctx));
      return evalMacroCallByName(head.name, evalArgs, env, ctx);
    }
  }
}

function evalMacroCallByName(name, evalArgs, env, ctx) {
  if (env.has(name)) {
    const fn = env.get(name);
    if (fn && typeof fn.invoke === 'function') {
      return fn.invoke(evalArgs);
    }
  }
  switch (name) {
    case 'GENSYM': {
      const prefix = evalArgs[0]?.kind === 'string'
        ? evalArgs[0].value
        : evalArgs[0]?.kind === 'symbol'
          ? evalArgs[0].name
          : 'G';
      return ctx.freshGensym(prefix);
    }
    case 'CONS':
      return astCons(evalArgs[0], evalArgs[1]);
    case 'LIST':
      return makeListNode(evalArgs);
    case 'LIST*': {
      if (evalArgs.length === 1) return evalArgs[0];
      let acc = evalArgs[evalArgs.length - 1];
      for (let i = evalArgs.length - 2; i >= 0; i -= 1) {
        acc = astCons(evalArgs[i], acc);
      }
      return acc;
    }
    case 'APPEND':
      return astAppend(evalArgs);
    case 'CAR':
    case 'FIRST':
      return astCar(evalArgs[0]);
    case 'CDR':
    case 'REST':
      return astCdr(evalArgs[0]);
    case 'CAAR':
      return astCar(astCar(evalArgs[0]));
    case 'CADR':
    case 'SECOND':
      return astCar(astCdr(evalArgs[0]));
    case 'CDAR':
      return astCdr(astCar(evalArgs[0]));
    case 'CDDR':
      return astCdr(astCdr(evalArgs[0]));
    case 'THIRD':
      return astCar(astCdr(astCdr(evalArgs[0])));
    case 'NTH': {
      let cur = evalArgs[1];
      let n = Number(evalArgs[0]?.value ?? 0);
      while (n > 0) {
        cur = astCdr(cur);
        n -= 1;
      }
      return astCar(cur);
    }
    case 'LENGTH': {
      const seq = evalArgs[0];
      if (isNilSymbol(seq)) return makeIntNode(0n);
      if (seq?.kind === 'list') return makeIntNode(BigInt(seq.elements.length));
      if (seq?.kind === 'string') return makeIntNode(BigInt(seq.value.length));
      throw new SyntaxError('LENGTH in macro expansion expected a list or string');
    }
    case 'REVERSE': {
      const seq = evalArgs[0];
      if (isNilSymbol(seq)) return NIL_NODE;
      if (seq?.kind === 'list') return makeListNode([...seq.elements].reverse());
      throw new SyntaxError('REVERSE in macro expansion expected a list');
    }
    case 'MAPCAR': {
      const [fnObj, listArg] = evalArgs;
      if (isNilSymbol(listArg)) return NIL_NODE;
      if (listArg?.kind !== 'list' || typeof fnObj?.invoke !== 'function') {
        throw new SyntaxError('MAPCAR in macro expansion requires a function and a list');
      }
      return makeListNode(listArg.elements.map((el) => fnObj.invoke([el])));
    }
    case 'FUNCALL': {
      const [fnObj, ...callArgs] = evalArgs;
      if (typeof fnObj?.invoke === 'function') return fnObj.invoke(callArgs);
      if (fnObj?.kind === 'symbol') return evalMacroCallByName(fnObj.name, callArgs, env, ctx);
      throw new SyntaxError('invalid FUNCALL target in macro expansion');
    }
    case 'APPLY': {
      const [fnObj, ...rest] = evalArgs;
      const last = rest[rest.length - 1];
      const tailElems = isNilSymbol(last) ? [] : last?.kind === 'list' ? last.elements : [];
      const callArgs = [...rest.slice(0, -1), ...tailElems];
      if (typeof fnObj?.invoke === 'function') return fnObj.invoke(callArgs);
      if (fnObj?.kind === 'symbol') return evalMacroCallByName(fnObj.name, callArgs, env, ctx);
      throw new SyntaxError('invalid APPLY target in macro expansion');
    }
    case 'NULL':
    case 'NOT':
      return astBool(isNilSymbol(evalArgs[0]));
    case 'CONSP':
      return astBool(evalArgs[0]?.kind === 'list');
    case 'ATOM':
      return astBool(evalArgs[0]?.kind !== 'list');
    case 'LISTP':
      return astBool(isNilSymbol(evalArgs[0]) || evalArgs[0]?.kind === 'list');
    case 'SYMBOLP':
      return astBool(evalArgs[0]?.kind === 'symbol');
    case 'KEYWORDP':
      return astBool(Boolean(evalArgs[0]?.kind === 'symbol' && evalArgs[0].keyword));
    case 'INTEGERP':
    case 'NUMBERP':
      return astBool(evalArgs[0]?.kind === 'integer');
    case 'STRINGP':
      return astBool(evalArgs[0]?.kind === 'string');
    case 'EQ':
    case 'EQL':
    case 'EQUAL':
    case '=':
      return astBool(astEqual(evalArgs[0], evalArgs[1]));
    case '/=':
      return astBool(!astEqual(evalArgs[0], evalArgs[1]));
    case '+':
      return makeIntNode(evalArgs.reduce((acc, a) => acc + BigInt(a.value), 0n));
    case '-': {
      if (evalArgs.length === 1) return makeIntNode(-BigInt(evalArgs[0].value));
      return makeIntNode(
        evalArgs.slice(1).reduce((acc, a) => acc - BigInt(a.value), BigInt(evalArgs[0].value)),
      );
    }
    case '*':
      return makeIntNode(evalArgs.reduce((acc, a) => acc * BigInt(a.value), 1n));
    case '1+':
      return makeIntNode(BigInt(evalArgs[0].value) + 1n);
    case '1-':
      return makeIntNode(BigInt(evalArgs[0].value) - 1n);
    case '<':
      return astBool(BigInt(evalArgs[0].value) < BigInt(evalArgs[1].value));
    case '>':
      return astBool(BigInt(evalArgs[0].value) > BigInt(evalArgs[1].value));
    case '<=':
      return astBool(BigInt(evalArgs[0].value) <= BigInt(evalArgs[1].value));
    case '>=':
      return astBool(BigInt(evalArgs[0].value) >= BigInt(evalArgs[1].value));
    case 'ZEROP':
      return astBool(BigInt(evalArgs[0].value) === 0n);
    case 'PLUSP':
      return astBool(BigInt(evalArgs[0].value) > 0n);
    case 'MINUSP':
      return astBool(BigInt(evalArgs[0].value) < 0n);
    case 'SYMBOL-NAME':
    case 'STRING': {
      const arg = evalArgs[0];
      if (arg?.kind === 'string') return arg;
      if (arg?.kind === 'symbol') return Object.freeze({kind: 'string', value: arg.name});
      throw new SyntaxError(`${name} in macro expansion expected a symbol or string`);
    }
    case 'INTERN': {
      const str = evalArgs[0];
      const text = str?.kind === 'string' ? str.value : str?.kind === 'symbol' ? str.name : '';
      return makeSymbolNode(text.toUpperCase(), {spelling: text});
    }
    case 'MACROEXPAND-1':
      return macroexpand1CommonLispForm(evalArgs[0], ctx).form;
    case 'MACROEXPAND':
      return macroexpandCommonLispForm(evalArgs[0], ctx).form;
    default:
      throw new SyntaxError(`unsupported function ${name} inside Common Lisp compile-time macro expansion`);
  }
}

function normalizeCompoundPlace(placeForm) {
  if (placeForm?.kind !== 'list' || placeForm.elements.length === 0) return placeForm;
  const [head, ...args] = placeForm.elements;
  if (head?.kind !== 'symbol') return placeForm;
  switch (head.name) {
    case 'FIRST':
      return makeListNode([makeSymbolNode('CAR'), ...args]);
    case 'REST':
      return makeListNode([makeSymbolNode('CDR'), ...args]);
    case 'SECOND':
    case 'CADR':
      return makeListNode([makeSymbolNode('CAR'), makeListNode([makeSymbolNode('CDR'), args[0]])]);
    case 'THIRD':
      return makeListNode([
        makeSymbolNode('CAR'),
        makeListNode([makeSymbolNode('CDR'), makeListNode([makeSymbolNode('CDR'), args[0]])]),
      ]);
    case 'CAAR':
      return makeListNode([makeSymbolNode('CAR'), makeListNode([makeSymbolNode('CAR'), args[0]])]);
    case 'CDAR':
      return makeListNode([makeSymbolNode('CDR'), makeListNode([makeSymbolNode('CAR'), args[0]])]);
    case 'CDDR':
      return makeListNode([makeSymbolNode('CDR'), makeListNode([makeSymbolNode('CDR'), args[0]])]);
    default:
      return placeForm;
  }
}

function expandSetfSingle(placeForm, valueForm, ctx) {
  if (placeForm?.kind === 'symbol') {
    return makeListNode([makeSymbolNode('SETQ'), placeForm, valueForm]);
  }
  const normalized = normalizeCompoundPlace(placeForm);
  if (normalized?.kind !== 'list' || normalized.elements.length === 0 || normalized.elements[0]?.kind !== 'symbol') {
    throw new SyntaxError('Common Lisp SETF place must be a variable or compound place form');
  }
  const [head, ...args] = normalized.elements;
  switch (head.name) {
    case 'CAR': {
      const cellTemp = ctx.freshGensym('CELL');
      const valTemp = ctx.freshGensym('VAL');
      return makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([cellTemp, args[0]]),
          makeListNode([valTemp, valueForm]),
        ]),
        makeListNode([makeSymbolNode('RPLACA'), cellTemp, valTemp]),
        valTemp,
      ]);
    }
    case 'CDR': {
      const cellTemp = ctx.freshGensym('CELL');
      const valTemp = ctx.freshGensym('VAL');
      return makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([cellTemp, args[0]]),
          makeListNode([valTemp, valueForm]),
        ]),
        makeListNode([makeSymbolNode('RPLACD'), cellTemp, valTemp]),
        valTemp,
      ]);
    }
    case 'NTH':
      return makeListNode([makeSymbolNode('%SET-NTH'), args[0], args[1], valueForm]);
    case 'AREF':
    case 'SVREF':
      return makeListNode([makeSymbolNode('%SET-AREF'), args[0], args[1], valueForm]);
    case 'ELT':
      return makeListNode([makeSymbolNode('%SET-ELT'), args[0], args[1], valueForm]);
    case 'GETHASH':
      return makeListNode([makeSymbolNode('%SET-GETHASH'), args[0], args[1], valueForm]);
    case 'SEND': {
      const recvTemp = ctx.freshGensym('RECV');
      const valTemp = ctx.freshGensym('VAL');
      const rawSel = extractSelectorSpellingStatic(args[1]);
      const setterSel = rawSel.endsWith(':') ? rawSel : `${rawSel}:`;
      return makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([recvTemp, args[0]]),
          makeListNode([valTemp, valueForm]),
        ]),
        makeListNode([
          makeSymbolNode('SEND'),
          recvTemp,
          Object.freeze({kind: 'string', value: setterSel}),
          valTemp,
        ]),
        valTemp,
      ]);
    }
    default: {
      // Check if place is a macro call first
      const expandedPlace = macroexpand1CommonLispForm(normalized, ctx);
      if (expandedPlace.expanded) {
        return expandSetfSingle(expandedPlace.form, valueForm, ctx);
      }
      // Struct slot or custom %SET-<READER> writer function
      return makeListNode([makeSymbolNode(`%SET-${head.name}`), ...args, valueForm]);
    }
  }
}

function extractSelectorSpellingStatic(selectorForm) {
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

function withGeneralizedPlace(placeForm, ctx, buildBody) {
  if (placeForm?.kind === 'symbol') {
    return buildBody(
      placeForm,
      (newVal) => makeListNode([makeSymbolNode('SETQ'), placeForm, newVal]),
    );
  }
  const normalized = normalizeCompoundPlace(placeForm);
  if (normalized?.kind !== 'list' || normalized.elements.length === 0 || normalized.elements[0]?.kind !== 'symbol') {
    throw new SyntaxError('invalid Common Lisp generalized place');
  }
  const [head, ...args] = normalized.elements;
  const argTemps = args.map((_, idx) => ctx.freshGensym(`PLACE_ARG_${idx}`));
  const bindings = args.map((arg, idx) => makeListNode([argTemps[idx], arg]));
  const canonPlace = makeListNode([head, ...argTemps]);
  const inner = buildBody(
    canonPlace,
    (newVal) => expandSetfSingle(canonPlace, newVal, ctx),
  );
  return bindings.length === 0
    ? inner
    : makeListNode([makeSymbolNode('LET'), makeListNode(bindings), inner]);
}

function expandStructConstructorCall(descriptor, args, ctx) {
  const struct = descriptor.struct;
  const ctorFnSym = makeSymbolNode(struct.internalConstructorName);
  if (args.length === 0) {
    return makeListNode([
      ctorFnSym,
      ...struct.slots.map((s) => s.defaultForm),
    ]);
  }
  const firstArg = args[0];
  if (firstArg?.kind === 'symbol' && firstArg.keyword) {
    if (args.length % 2 !== 0) {
      throw new SyntaxError(`Common Lisp ${struct.constructorName} keyword argument list must have even length`);
    }
    const bindings = [];
    const suppliedBySlot = new Map();
    for (let i = 0; i < args.length; i += 2) {
      const kw = args[i];
      const valForm = args[i + 1];
      if (kw?.kind !== 'symbol' || !kw.keyword) {
        throw new SyntaxError(`Common Lisp ${struct.constructorName} expected keyword argument at position ${i}`);
      }
      const slotName = kw.name.slice(1);
      const slotSpec = struct.slots.find((s) => s.name === slotName);
      if (!slotSpec) {
        throw new SyntaxError(`unknown slot ${kw.name} for Common Lisp struct ${struct.name}`);
      }
      const tempSym = ctx.freshGensym(`SLOT_${slotName}`);
      bindings.push(makeListNode([tempSym, valForm]));
      if (!suppliedBySlot.has(slotName)) {
        suppliedBySlot.set(slotName, tempSym);
      }
    }
    const callArgs = struct.slots.map((s) => suppliedBySlot.get(s.name) ?? s.defaultForm);
    return makeListNode([
      makeSymbolNode('LET'),
      makeListNode(bindings),
      makeListNode([ctorFnSym, ...callArgs]),
    ]);
  }
  // Positional construction
  if (args.length > struct.slots.length) {
    throw new SyntaxError(
      `Common Lisp ${struct.constructorName} expected at most ${struct.slots.length} positional arguments, got ${args.length}`,
    );
  }
  const callArgs = struct.slots.map((s, idx) => (idx < args.length ? args[idx] : s.defaultForm));
  return makeListNode([ctorFnSym, ...callArgs]);
}

const BUILT_IN_MACROS = Object.freeze({
  PROG2(args) {
    if (args.length < 2) throw new SyntaxError('Common Lisp PROG2 requires at least 2 forms');
    return makeListNode([
      makeSymbolNode('PROGN'),
      args[0],
      makeListNode([makeSymbolNode('PROG1'), args[1], ...args.slice(2)]),
    ]);
  },
  RETURN(args) {
    if (args.length > 1) throw new SyntaxError('Common Lisp RETURN accepts at most 1 value');
    return makeListNode([makeSymbolNode('RETURN-FROM'), NIL_NODE, args[0] ?? NIL_NODE]);
  },
  DOLIST(args, ctx) {
    if (args.length < 1 || args[0]?.kind !== 'list' || args[0].elements.length < 2) {
      throw new SyntaxError('Common Lisp DOLIST requires (var list-form [result-form])');
    }
    const [specForm, ...bodyForms] = args;
    const [varSym, listForm, resultForm = NIL_NODE] = specForm.elements;
    const cursorSym = ctx.freshGensym('DOLIST_CUR');
    const loopSym = ctx.freshGensym('DOLIST_LOOP');
    return makeListNode([
      makeSymbolNode('BLOCK'),
      NIL_NODE,
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([cursorSym, listForm]),
          makeListNode([varSym, NIL_NODE]),
        ]),
        makeListNode([
          makeSymbolNode('LABELS'),
          makeListNode([
            makeListNode([
              loopSym,
              NIL_NODE,
              makeListNode([
                makeSymbolNode('IF'),
                makeListNode([makeSymbolNode('NULL'), cursorSym]),
                makeListNode([
                  makeSymbolNode('PROGN'),
                  makeListNode([makeSymbolNode('SETQ'), varSym, NIL_NODE]),
                  resultForm,
                ]),
                makeListNode([
                  makeSymbolNode('PROGN'),
                  makeListNode([makeSymbolNode('SETQ'), varSym, makeListNode([makeSymbolNode('CAR'), cursorSym])]),
                  makeListNode([makeSymbolNode('SETQ'), cursorSym, makeListNode([makeSymbolNode('CDR'), cursorSym])]),
                  ...bodyForms,
                  makeListNode([loopSym]),
                ]),
              ]),
            ]),
          ]),
          makeListNode([loopSym]),
        ]),
      ]),
    ]);
  },
  DOTIMES(args, ctx) {
    if (args.length < 1 || args[0]?.kind !== 'list' || args[0].elements.length < 2) {
      throw new SyntaxError('Common Lisp DOTIMES requires (var count-form [result-form])');
    }
    const [specForm, ...bodyForms] = args;
    const [varSym, countForm, resultForm = NIL_NODE] = specForm.elements;
    const limitSym = ctx.freshGensym('DOTIMES_LIMIT');
    const loopSym = ctx.freshGensym('DOTIMES_LOOP');
    return makeListNode([
      makeSymbolNode('BLOCK'),
      NIL_NODE,
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([limitSym, countForm]),
          makeListNode([varSym, makeIntNode(0n)]),
        ]),
        makeListNode([
          makeSymbolNode('LABELS'),
          makeListNode([
            makeListNode([
              loopSym,
              NIL_NODE,
              makeListNode([
                makeSymbolNode('IF'),
                makeListNode([makeSymbolNode('>='), varSym, limitSym]),
                resultForm,
                makeListNode([
                  makeSymbolNode('PROGN'),
                  ...bodyForms,
                  makeListNode([
                    makeSymbolNode('SETQ'),
                    varSym,
                    makeListNode([makeSymbolNode('+'), varSym, makeIntNode(1n)]),
                  ]),
                  makeListNode([loopSym]),
                ]),
              ]),
            ]),
          ]),
          makeListNode([loopSym]),
        ]),
      ]),
    ]);
  },
  CASE(args, ctx) {
    if (args.length < 1) throw new SyntaxError('Common Lisp CASE requires a keyform');
    const [keyForm, ...clauses] = args;
    const keySym = ctx.freshGensym('CASE_KEY');
    const condClauses = clauses.map((clause, idx) => {
      if (clause?.kind !== 'list' || clause.elements.length === 0) {
        throw new SyntaxError('Common Lisp CASE clause must be a non-empty list');
      }
      const [keysSpec, ...body] = clause.elements;
      const bodyResult = body.length > 0 ? body : [NIL_NODE];
      if (
        idx === clauses.length - 1
        && keysSpec?.kind === 'symbol'
        && (keysSpec.name === 'T' || keysSpec.name === 'OTHERWISE')
      ) {
        return makeListNode([T_NODE, ...bodyResult]);
      }
      if (isNilSymbol(keysSpec)) {
        return makeListNode([NIL_NODE, ...bodyResult]);
      }
      if (keysSpec?.kind === 'list') {
        const tests = keysSpec.elements.map((k) =>
          makeListNode([makeSymbolNode('EQL'), keySym, makeListNode([makeSymbolNode('QUOTE'), k])]),
        );
        return makeListNode([makeListNode([makeSymbolNode('OR'), ...tests]), ...bodyResult]);
      }
      return makeListNode([
        makeListNode([makeSymbolNode('EQL'), keySym, makeListNode([makeSymbolNode('QUOTE'), keysSpec])]),
        ...bodyResult,
      ]);
    });
    return makeListNode([
      makeSymbolNode('LET'),
      makeListNode([makeListNode([keySym, keyForm])]),
      makeListNode([makeSymbolNode('COND'), ...condClauses]),
    ]);
  },
  ECASE(args, ctx) {
    if (args.length < 1) throw new SyntaxError('Common Lisp ECASE requires a keyform');
    const [keyForm, ...clauses] = args;
    const fallback = makeListNode([
      makeSymbolNode('OTHERWISE'),
      makeListNode([
        makeSymbolNode('ERROR'),
        Object.freeze({kind: 'string', value: 'Common Lisp ECASE key did not match any clause'}),
      ]),
    ]);
    return BUILT_IN_MACROS.CASE([keyForm, ...clauses, fallback], ctx);
  },
  'DESTRUCTURING-BIND'(args, ctx) {
    if (args.length < 2) {
      throw new SyntaxError('Common Lisp DESTRUCTURING-BIND requires a lambda-list and expression');
    }
    const [patternForm, exprForm, ...bodyForms] = args;
    const bindings = [];
    buildDestructuringLetBindings(patternForm, exprForm, ctx, bindings);
    return makeListNode([
      makeSymbolNode('LET*'),
      makeListNode(bindings),
      ...bodyForms,
    ]);
  },
  SETF(args, ctx) {
    if (args.length === 0 || args.length % 2 !== 0) {
      throw new SyntaxError('Common Lisp SETF requires an even number of place/value arguments');
    }
    if (args.length === 2) {
      return expandSetfSingle(args[0], args[1], ctx);
    }
    const steps = [];
    for (let i = 0; i < args.length; i += 2) {
      steps.push(expandSetfSingle(args[i], args[i + 1], ctx));
    }
    return makeListNode([makeSymbolNode('PROGN'), ...steps]);
  },
  INCF(args, ctx) {
    if (args.length < 1 || args.length > 2) {
      throw new SyntaxError('Common Lisp INCF requires a place and optional delta');
    }
    const deltaForm = args[1] ?? makeIntNode(1n);
    return withGeneralizedPlace(args[0], ctx, (readForm, writeBuilder) =>
      writeBuilder(makeListNode([makeSymbolNode('+'), readForm, deltaForm])),
    );
  },
  DECF(args, ctx) {
    if (args.length < 1 || args.length > 2) {
      throw new SyntaxError('Common Lisp DECF requires a place and optional delta');
    }
    const deltaForm = args[1] ?? makeIntNode(1n);
    return withGeneralizedPlace(args[0], ctx, (readForm, writeBuilder) =>
      writeBuilder(makeListNode([makeSymbolNode('-'), readForm, deltaForm])),
    );
  },
  PUSH(args, ctx) {
    if (args.length !== 2) {
      throw new SyntaxError('Common Lisp PUSH requires an item and a place');
    }
    const [itemForm, placeForm] = args;
    const itemTemp = ctx.freshGensym('PUSH_ITEM');
    return makeListNode([
      makeSymbolNode('LET'),
      makeListNode([makeListNode([itemTemp, itemForm])]),
      withGeneralizedPlace(placeForm, ctx, (readForm, writeBuilder) =>
        writeBuilder(makeListNode([makeSymbolNode('CONS'), itemTemp, readForm])),
      ),
    ]);
  },
  POP(args, ctx) {
    if (args.length !== 1) {
      throw new SyntaxError('Common Lisp POP requires 1 place argument');
    }
    const listTemp = ctx.freshGensym('POP_LIST');
    return withGeneralizedPlace(args[0], ctx, (readForm, writeBuilder) =>
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([makeListNode([listTemp, readForm])]),
        makeListNode([
          makeSymbolNode('PROG1'),
          makeListNode([makeSymbolNode('CAR'), listTemp]),
          writeBuilder(makeListNode([makeSymbolNode('CDR'), listTemp])),
        ]),
      ]),
    );
  },
  'MAKE-ARRAY'(args) {
    if (args.length < 1) throw new SyntaxError('Common Lisp MAKE-ARRAY requires a dimensions argument');
    const [sizeForm, ...rest] = args;
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const kw = rest[i];
      const val = rest[i + 1];
      if (kw?.kind === 'symbol' && kw.name === ':INITIAL-ELEMENT') {
        return makeListNode([makeSymbolNode('%MAKE-ARRAY-INIT'), sizeForm, val]);
      }
      if (kw?.kind === 'symbol' && kw.name === ':INITIAL-CONTENTS') {
        return makeListNode([makeSymbolNode('%MAKE-ARRAY-CONTENTS'), sizeForm, val]);
      }
    }
    return makeListNode([makeSymbolNode('%MAKE-ARRAY'), sizeForm]);
  },
  'MAKE-HASH-TABLE'() {
    return makeListNode([makeSymbolNode('%MAKE-HASH-TABLE')]);
  },
  CONCATENATE(args) {
    if (args.length < 1) throw new SyntaxError('Common Lisp CONCATENATE requires a result-type');
    const [typeForm, ...seqs] = args;
    let typeName = null;
    if (
      typeForm?.kind === 'list'
      && typeForm.elements.length === 2
      && typeForm.elements[0]?.name === 'QUOTE'
      && typeForm.elements[1]?.kind === 'symbol'
    ) {
      typeName = typeForm.elements[1].name;
    } else if (typeForm?.kind === 'symbol') {
      typeName = typeForm.name.startsWith(':') ? typeForm.name.slice(1) : typeForm.name;
    }
    if (typeName === 'STRING') {
      if (seqs.length === 0) return Object.freeze({kind: 'string', value: ''});
      if (seqs.length === 1) return seqs[0];
      return seqs.slice(1).reduce(
        (acc, s) => makeListNode([makeSymbolNode('%STRING-APPEND'), acc, s]),
        seqs[0],
      );
    }
    if (typeName === 'LIST') {
      if (seqs.length === 0) return NIL_NODE;
      if (seqs.length === 1) return seqs[0];
      return seqs.slice(1).reduce(
        (acc, s) => makeListNode([makeSymbolNode('APPEND'), acc, s]),
        seqs[0],
      );
    }
    throw new SyntaxError(`unsupported Common Lisp CONCATENATE result-type: ${typeName ?? JSON.stringify(typeForm)}`);
  },
});

function macroexpand1CommonLispForm(inputForm, optionsOrCtx = {}, shadowedFunctions = new Set()) {
  const form = typeof inputForm === 'string' ? readCommonLispSource(inputForm)[0] : inputForm;
  const ctx = optionsOrCtx?.userMacros instanceof Map
    ? optionsOrCtx
    : createMacroContext(optionsOrCtx);

  if (form?.kind !== 'list' || form.elements.length === 0 || form.elements[0]?.kind !== 'symbol') {
    return {form, expanded: false};
  }
  const [head, ...args] = form.elements;
  if (shadowedFunctions.has(head.name)) {
    return {form, expanded: false};
  }

  if (ctx.userMacros.has(head.name)) {
    const entry = ctx.userMacros.get(head.name);
    if (typeof entry === 'function') {
      return {form: entry(args, ctx), expanded: true};
    }
    if (entry?.kind === 'defmacro') {
      const env = new Map();
      bindMacroLambdaList(entry.lambdaList, args, env, ctx);
      return {form: evalMacroSequence(entry.bodyForms, env, ctx), expanded: true};
    }
    if (entry?.kind === 'struct-constructor') {
      return {form: expandStructConstructorCall(entry, args, ctx), expanded: true};
    }
  }

  if (Object.hasOwn(BUILT_IN_MACROS, head.name)) {
    return {form: BUILT_IN_MACROS[head.name](args, ctx), expanded: true};
  }

  return {form, expanded: false};
}

function macroexpandCommonLispForm(inputForm, optionsOrCtx = {}, shadowedFunctions = new Set()) {
  const ctx = optionsOrCtx?.userMacros instanceof Map
    ? optionsOrCtx
    : createMacroContext(optionsOrCtx);
  let current = typeof inputForm === 'string' ? readCommonLispSource(inputForm)[0] : inputForm;
  let anyExpanded = false;
  for (let depth = 0; depth < 500; depth += 1) {
    const step = macroexpand1CommonLispForm(current, ctx, shadowedFunctions);
    if (!step.expanded) return {form: current, expanded: anyExpanded};
    current = step.form;
    anyExpanded = true;
  }
  throw new SyntaxError('Common Lisp macro expansion exceeded maximum depth (500)');
}

function expandAllMacrosInForm(form, ctx, shadowedFunctions = new Set(), localSignatures = new Map()) {
  if (!form || typeof form !== 'object' || form.kind !== 'list') return form;
  if (form.elements.length === 0) return form;

  const [rawHead, ...rawArgs] = form.elements;
  if (rawHead?.kind === 'symbol') {
    if (rawHead.name === 'QUOTE') return form;
    if (rawHead.name === 'MACROEXPAND-1' || rawHead.name === 'MACROEXPAND') {
      if (
        rawArgs.length === 1
        && rawArgs[0]?.kind === 'list'
        && rawArgs[0].elements.length === 2
        && rawArgs[0].elements[0]?.name === 'QUOTE'
      ) {
        const quotedTarget = rawArgs[0].elements[1];
        const expanded = rawHead.name === 'MACROEXPAND-1'
          ? macroexpand1CommonLispForm(quotedTarget, ctx, shadowedFunctions).form
          : macroexpandCommonLispForm(quotedTarget, ctx, shadowedFunctions).form;
        return makeListNode([makeSymbolNode('QUOTE'), expanded]);
      }
    }
  }

  const topStep = macroexpandCommonLispForm(form, ctx, shadowedFunctions);
  if (topStep.expanded) {
    return expandAllMacrosInForm(topStep.form, ctx, shadowedFunctions, localSignatures);
  }

  const [head, ...args] = form.elements;
  if (head?.kind === 'list' && head.elements[0]?.kind === 'symbol' && head.elements[0].name === 'LAMBDA') {
    const [, paramForm, ...bodyForms] = head.elements;
    const expandedBody = bodyForms.map((b) => expandAllMacrosInForm(b, ctx, shadowedFunctions, localSignatures));
    const norm = normalizeFunctionDefinition(null, paramForm, expandedBody, ctx);
    const adaptedArgs = adaptCallArguments(
      args.map((a) => expandAllMacrosInForm(a, ctx, shadowedFunctions, localSignatures)),
      norm.signature,
    );
    return makeListNode([
      makeListNode([makeSymbolNode('LAMBDA'), norm.paramListForm, ...norm.bodyForms]),
      ...adaptedArgs,
    ]);
  }

  if (head?.kind !== 'symbol') {
    return makeListNode(
      form.elements.map((e) => expandAllMacrosInForm(e, ctx, shadowedFunctions, localSignatures)),
      form.dottedTail,
    );
  }

  switch (head.name) {
    case 'QUOTE':
      return form;
    case 'LET':
    case 'LET*': {
      const [bindingsForm, ...bodyForms] = args;
      const expandedBindings = bindingsForm?.kind === 'list'
        ? makeListNode(
          bindingsForm.elements.map((item) => {
            if (item?.kind === 'list' && item.elements.length === 2) {
              return makeListNode([
                item.elements[0],
                expandAllMacrosInForm(item.elements[1], ctx, shadowedFunctions, localSignatures),
              ]);
            }
            return item;
          }),
        )
        : bindingsForm;
      return makeListNode([
        head,
        expandedBindings,
        ...bodyForms.map((b) => expandAllMacrosInForm(b, ctx, shadowedFunctions, localSignatures)),
      ]);
    }
    case 'LAMBDA': {
      const [paramForm, ...bodyForms] = args;
      const expandedBody = bodyForms.map((b) => expandAllMacrosInForm(b, ctx, shadowedFunctions, localSignatures));
      const norm = normalizeFunctionDefinition(null, paramForm, expandedBody, ctx);
      return makeListNode([head, norm.paramListForm, ...norm.bodyForms]);
    }
    case 'FLET':
    case 'LABELS': {
      const [defsForm, ...bodyForms] = args;
      const defs = defsForm?.kind === 'list' ? defsForm.elements : [];
      const nextShadowed = new Set(shadowedFunctions);
      const nextSigs = new Map(localSignatures);
      for (const def of defs) {
        if (def?.kind === 'list' && def.elements[0]?.kind === 'symbol') {
          nextShadowed.add(def.elements[0].name);
          const parsed = parseLambdaList(def.elements[1] ?? NIL_NODE);
          if (!parsed.isSimple) {
            nextSigs.set(def.elements[0].name, {
              name: def.elements[0].name,
              requiredCount: parsed.required.length,
              optionalCount: parsed.optional.length,
              hasRestOrKey: Boolean(parsed.rest !== null || parsed.keys.length > 0),
            });
          } else {
            nextSigs.delete(def.elements[0].name);
          }
        }
      }
      const defShadow = head.name === 'LABELS' ? nextShadowed : shadowedFunctions;
      const defSigs = head.name === 'LABELS' ? nextSigs : localSignatures;
      const expandedDefs = defs.map((def) => {
        if (def?.kind !== 'list' || def.elements.length < 2) return def;
        const [fnSym, paramForm, ...fnBody] = def.elements;
        const expFnBody = fnBody.map((b) => expandAllMacrosInForm(b, ctx, defShadow, defSigs));
        const norm = normalizeFunctionDefinition(fnSym.name, paramForm, expFnBody, ctx);
        return makeListNode([fnSym, norm.paramListForm, ...norm.bodyForms]);
      });
      return makeListNode([
        head,
        makeListNode(expandedDefs),
        ...bodyForms.map((b) => expandAllMacrosInForm(b, ctx, nextShadowed, nextSigs)),
      ]);
    }
    case 'COND': {
      const expandedClauses = args.map((clause) => {
        if (clause?.kind !== 'list') return clause;
        return makeListNode(
          clause.elements.map((e) => expandAllMacrosInForm(e, ctx, shadowedFunctions, localSignatures)),
        );
      });
      return makeListNode([head, ...expandedClauses]);
    }
    case 'BLOCK': {
      if (args.length < 1) throw new SyntaxError('Common Lisp BLOCK requires a block name');
      const [blockName, ...bodyForms] = args;
      return makeListNode([
        head,
        blockName,
        ...bodyForms.map((b) => expandAllMacrosInForm(b, ctx, shadowedFunctions, localSignatures)),
      ]);
    }
    case 'RETURN-FROM': {
      if (args.length < 1 || args.length > 2) {
        throw new SyntaxError('Common Lisp RETURN-FROM requires a block name and optional value');
      }
      const [blockName, valForm = NIL_NODE] = args;
      return makeListNode([
        head,
        blockName,
        expandAllMacrosInForm(valForm, ctx, shadowedFunctions, localSignatures),
      ]);
    }
    case 'HANDLER-CASE': {
      if (args.length < 1) return form;
      const [protectedForm, ...clauses] = args;
      return makeListNode([
        head,
        expandAllMacrosInForm(protectedForm, ctx, shadowedFunctions, localSignatures),
        ...clauses.map((c) => {
          if (c?.kind !== 'list' || c.elements.length < 2) return c;
          const [typeSym, varList, ...hBody] = c.elements;
          return makeListNode([
            typeSym,
            varList,
            ...hBody.map((b) => expandAllMacrosInForm(b, ctx, shadowedFunctions, localSignatures)),
          ]);
        }),
      ]);
    }
    case 'HANDLER-BIND': {
      if (args.length < 1) return form;
      const [bindingsForm, ...bodyForms] = args;
      const expBindings = bindingsForm?.kind === 'list'
        ? makeListNode(
          bindingsForm.elements.map((b) => {
            if (b?.kind !== 'list' || b.elements.length !== 2) return b;
            return makeListNode([
              b.elements[0],
              expandAllMacrosInForm(b.elements[1], ctx, shadowedFunctions, localSignatures),
            ]);
          }),
        )
        : bindingsForm;
      return makeListNode([
        head,
        expBindings,
        ...bodyForms.map((b) => expandAllMacrosInForm(b, ctx, shadowedFunctions, localSignatures)),
      ]);
    }
    default: {
      const expandedArgs = args.map((a) => expandAllMacrosInForm(a, ctx, shadowedFunctions, localSignatures));
      const sig = localSignatures.get(head.name)
        ?? (shadowedFunctions.has(head.name) ? null : ctx.functionSignatures.get(head.name));
      const finalArgs = sig ? adaptCallArguments(expandedArgs, sig) : expandedArgs;
      return makeListNode([head, ...finalArgs], form.dottedTail);
    }
  }
}

function containsReturnFrom(forms, blockName) {
  const target = String(blockName).toUpperCase();
  function walk(node) {
    if (!node || typeof node !== 'object' || node.kind !== 'list') return false;
    if (node.elements.length === 0) return false;
    const [head, ...rest] = node.elements;
    if (head?.kind === 'symbol') {
      if (head.name === 'QUOTE') return false;
      if (head.name === 'BLOCK' && rest[0]?.kind === 'symbol' && rest[0].name === target) {
        return false;
      }
      if (head.name === 'RETURN-FROM' && rest[0]?.kind === 'symbol' && rest[0].name === target) {
        return true;
      }
    }
    return node.elements.some(walk);
  }
  return Array.isArray(forms) ? forms.some(walk) : walk(forms);
}

// -----------------------------------------------------------------------------
// Semantic Compiler to lagrange-code/v2
// -----------------------------------------------------------------------------

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
  BLOCKEXIT: BLOCK_EXIT_CLASS_NAME,
});

function compileCommonLispSemanticProgram(rawForms, {
  parameters = [],
  captures = {},
  globals = {},
  functionBindings = {},
  variableBindings = {},
  macros = {},
  structs = {},
  functionSignatures = {},
  alreadyExpanded = false,
} = {}) {
  if (!Array.isArray(rawForms)) {
    throw new TypeError('compileCommonLispSemanticProgram forms must be an array');
  }
  const macroContext = createMacroContext({macros, structs, functionSignatures});
  const forms = alreadyExpanded
    ? rawForms
    : rawForms.map((f) => expandAllMacrosInForm(f, macroContext));
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
      case 'VECTOR': {
        const makeArr = refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.MAKE_ARRAY, '$makeArray');
        if (args.length === 0) {
          return {
            op: 'apply',
            callee: makeArr,
            arguments: [{op: 'literal', value: integerValue(0n)}],
          };
        }
        const vecTemp = declareLocal(scope, 'vec');
        const setAref = refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.SET_AREF, '$setAref');
        const statements = [
          {
            op: 'binding-write',
            id: vecTemp.id,
            value: {
              op: 'apply',
              callee: makeArr,
              arguments: [{op: 'literal', value: integerValue(BigInt(args.length))}],
            },
          },
        ];
        for (let i = 0; i < args.length; i += 1) {
          statements.push({
            op: 'apply',
            callee: setAref,
            arguments: [
              {op: 'binding', id: vecTemp.id},
              {op: 'literal', value: integerValue(BigInt(i))},
              compileForm(scope, args[i]),
            ],
          });
        }
        statements.push({op: 'binding', id: vecTemp.id});
        return {op: 'sequence', statements};
      }
      case 'GETHASH': {
        if (args.length < 2 || args.length > 3) {
          throw new SyntaxError('Common Lisp GETHASH requires 2 or 3 arguments');
        }
        const defaultExpr = args.length === 3 ? compileForm(scope, args[2]) : refNil(scope);
        return {
          op: 'apply',
          callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.GETHASH, '$gethash'),
          arguments: [compileForm(scope, args[0]), compileForm(scope, args[1]), defaultExpr],
        };
      }
      case 'BLOCK': {
        if (args.length < 1 || args[0]?.kind !== 'symbol') {
          throw new SyntaxError('Common Lisp BLOCK requires a block name symbol');
        }
        const [blockSym, ...bodyForms] = args;
        const blockName = blockSym.name;
        if (!containsReturnFrom(bodyForms, blockName)) {
          return compileSequence(scope, bodyForms);
        }
        const tagVarName = `__CL_BLOCK_TAG_${blockName}_${nextTempId + 1}__`;
        const blockLexicalKey = `cl:block-tag:${blockName}`;
        const tagLocal = declareLocal(scope, tagVarName);
        const savedBlockEntry = scope.locals.get(blockLexicalKey);
        scope.locals.set(tagVarName, tagLocal);
        scope.locals.set(blockLexicalKey, tagLocal);

        const emptyList = makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
        const protectedBlock = compileLambdaExpr(scope, emptyList, bodyForms, `block_body_${blockName}`);
        const exitSym = makeSymbolNode('__CL_BLOCK_EXIT__');
        const tagRefSym = makeSymbolNode(tagVarName);
        const handlerBodyForm = makeListNode([
          makeSymbolNode('IF'),
          makeListNode([
            makeSymbolNode('EQ'),
            makeListNode([makeSymbolNode('CAR'), exitSym]),
            tagRefSym,
          ]),
          makeListNode([makeSymbolNode('CDR'), exitSym]),
          makeListNode([makeSymbolNode('SIGNAL'), exitSym]),
        ]);
        const handlerBlock = compileLambdaExpr(
          scope,
          makeListNode([exitSym]),
          [handlerBodyForm],
          `block_handler_${blockName}`,
        );

        scope.locals.delete(tagVarName);
        if (savedBlockEntry) {
          scope.locals.set(blockLexicalKey, savedBlockEntry);
        } else {
          scope.locals.delete(blockLexicalKey);
        }

        const blockExitClassExpr = resolveConditionClassExpr(
          scope,
          makeSymbolNode('BLOCKEXIT', {spelling: BLOCK_EXIT_CLASS_NAME}),
        );
        return {
          op: 'sequence',
          statements: [
            {
              op: 'binding-write',
              id: tagLocal.id,
              value: {
                op: 'apply',
                callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.CONS, '$cons'),
                arguments: [compileQuoted(scope, blockSym), refNil(scope)],
              },
            },
            {
              op: 'send',
              languageId: SYMMETRIC_SMALLTALK_ID,
              receiver: protectedBlock,
              message: textValue('on:do:'),
              arguments: [blockExitClassExpr, handlerBlock],
            },
          ],
        };
      }
      case 'RETURN-FROM': {
        if (args.length < 1 || args.length > 2 || args[0]?.kind !== 'symbol') {
          throw new SyntaxError('Common Lisp RETURN-FROM requires a block name symbol and optional value');
        }
        const [blockSym, valForm] = args;
        const blockLexicalKey = `cl:block-tag:${blockSym.name}`;
        const lexicalTag = lookupLexical(scope, blockLexicalKey);
        if (!lexicalTag) {
          throw new SyntaxError(`unknown Common Lisp block in RETURN-FROM: ${blockSym.name}`);
        }
        const valExpr = valForm ? compileForm(scope, valForm) : refNil(scope);
        return {
          op: 'apply',
          callee: refRuntimeBlock(scope, RUNTIME_BLOCK_IDS.BLOCK_RETURN, '$blockReturn'),
          arguments: [{op: 'binding', id: lexicalTag.id}, valExpr],
        };
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

  // 4. Class-based predicates: consp, atom, functionp, integerp, stringp, characterp, vectorp, hash-table-p
  const classPredicates = [
    [RUNTIME_BLOCK_IDS.CONSP, 'smalltalk/class/Cons', false],
    [RUNTIME_BLOCK_IDS.ATOM, 'smalltalk/class/Cons', true],
    [RUNTIME_BLOCK_IDS.FUNCTIONP, `smalltalk/class/${BLOCK_CLOSURE_CLASS_NAME}`, false],
    [RUNTIME_BLOCK_IDS.INTEGERP, 'smalltalk/class/Integer', false],
    [RUNTIME_BLOCK_IDS.STRINGP, 'smalltalk/class/Text', false],
    [RUNTIME_BLOCK_IDS.CHARACTERP, 'smalltalk/class/Character', false],
    [RUNTIME_BLOCK_IDS.VECTORP, 'smalltalk/class/Array', false],
    [RUNTIME_BLOCK_IDS.HASH_TABLE_P, 'smalltalk/class/Dictionary', false],
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

  // 6. null / not, eq, =, /=
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

  // eql(a, b) via built-in-equals (standard library defines recursive equal over %eql and consp)
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.EQL,
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

  // 8. Conditions: signal/error, use-value, return-from-handler, block-return
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

  // block-return(tag, val) -> allocates BlockExit(2), sets [0]=tag, [1]=val, signals it
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.BLOCK_RETURN,
    bindings: {
      'smalltalk/primitive/basic-new-sized': {name: '$basicNewSized', value: ref('smalltalk/primitive/basic-new-sized')},
      'smalltalk/primitive/indexed-at-put': {name: '$indexedAtPut', value: ref('smalltalk/primitive/indexed-at-put')},
      [`smalltalk/class/${BLOCK_EXIT_CLASS_NAME}`]: {
        name: BLOCK_EXIT_CLASS_NAME,
        value: ref(`smalltalk/class/${BLOCK_EXIT_CLASS_NAME}`),
      },
      'smalltalk/primitive/condition-signal': {
        name: '$signal',
        value: ref('smalltalk/primitive/condition-signal'),
      },
    },
    program: {
      parameters: [{id: 'tag', name: 'TAG'}, {id: 'val', name: 'VAL'}],
      temporaries: [{id: 'exit', name: 'EXIT'}],
      captures: [
        {id: 'smalltalk/primitive/basic-new-sized', name: '$basicNewSized', mode: 'snapshot'},
        {id: 'smalltalk/primitive/indexed-at-put', name: '$indexedAtPut', mode: 'snapshot'},
        {id: `smalltalk/class/${BLOCK_EXIT_CLASS_NAME}`, name: BLOCK_EXIT_CLASS_NAME, mode: 'snapshot'},
        {id: 'smalltalk/primitive/condition-signal', name: '$signal', mode: 'snapshot'},
      ],
      body: {
        op: 'sequence',
        statements: [
          {
            op: 'binding-write',
            id: 'exit',
            value: {
              op: 'apply',
              callee: {op: 'binding', id: 'smalltalk/primitive/basic-new-sized'},
              arguments: [
                {op: 'binding', id: `smalltalk/class/${BLOCK_EXIT_CLASS_NAME}`},
                {op: 'literal', value: integerValue(2n)},
              ],
            },
          },
          {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/indexed-at-put'},
            arguments: [
              {op: 'binding', id: 'exit'},
              {op: 'literal', value: integerValue(0n)},
              {op: 'argument', index: 0},
            ],
          },
          {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/indexed-at-put'},
            arguments: [
              {op: 'binding', id: 'exit'},
              {op: 'literal', value: integerValue(1n)},
              {op: 'argument', index: 1},
            ],
          },
          {
            op: 'apply',
            callee: {op: 'binding', id: 'smalltalk/primitive/condition-signal'},
            arguments: [{op: 'binding', id: 'exit'}],
          },
        ],
      },
    },
  });

  // 9. Sentinel helpers: %unsupplied, %unsupplied-p, %tombstone-p
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.UNSUPPLIED,
    bindings: {
      [COMMON_LISP_UNSUPPLIED_ID]: {name: '$unsupplied', value: ref(COMMON_LISP_UNSUPPLIED_ID)},
    },
    program: {
      parameters: [],
      temporaries: [],
      captures: [{id: COMMON_LISP_UNSUPPLIED_ID, name: '$unsupplied', mode: 'snapshot'}],
      body: {op: 'binding', id: COMMON_LISP_UNSUPPLIED_ID},
    },
  });

  for (const [helperId, sentinelId] of [
    [RUNTIME_BLOCK_IDS.UNSUPPLIED_P, COMMON_LISP_UNSUPPLIED_ID],
    [RUNTIME_BLOCK_IDS.TOMBSTONE_P, COMMON_LISP_TOMBSTONE_ID],
  ]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {
        ...boolBindings,
        [sentinelId]: {name: '$sentinel', value: ref(sentinelId)},
      },
      program: {
        parameters: [{id: 'x', name: 'X'}],
        temporaries: [],
        captures: [
          nilCap,
          tCap,
          {id: sentinelId, name: '$sentinel', mode: 'snapshot'},
        ],
        body: {
          op: 'if',
          condition: {
            op: 'equals',
            left: {op: 'argument', index: 0},
            right: {op: 'binding', id: sentinelId},
          },
          then: {op: 'binding', id: CL_T_BINDING_ID},
          else: {op: 'binding', id: CL_NIL_BINDING_ID},
        },
      },
    });
  }

  // 10. Vectors, Strings, Characters: %make-array, aref, %set-aref, %vector-length, %string-length, char, char-code, code-char
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.MAKE_ARRAY,
    bindings: {
      'smalltalk/primitive/basic-new-sized': {name: '$basicNewSized', value: ref('smalltalk/primitive/basic-new-sized')},
      'smalltalk/class/Array': {name: 'Array', value: ref('smalltalk/class/Array')},
    },
    program: {
      parameters: [{id: 'size', name: 'SIZE'}],
      temporaries: [],
      captures: [
        {id: 'smalltalk/primitive/basic-new-sized', name: '$basicNewSized', mode: 'snapshot'},
        {id: 'smalltalk/class/Array', name: 'Array', mode: 'snapshot'},
      ],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'smalltalk/primitive/basic-new-sized'},
        arguments: [
          {op: 'binding', id: 'smalltalk/class/Array'},
          {op: 'argument', index: 0},
        ],
      },
    },
  });

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.AREF,
    bindings: {
      'smalltalk/primitive/indexed-at': {name: '$indexedAt', value: ref('smalltalk/primitive/indexed-at')},
    },
    program: {
      parameters: [{id: 'vec', name: 'VEC'}, {id: 'idx', name: 'IDX'}],
      temporaries: [],
      captures: [{id: 'smalltalk/primitive/indexed-at', name: '$indexedAt', mode: 'snapshot'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'smalltalk/primitive/indexed-at'},
        arguments: [{op: 'argument', index: 0}, {op: 'argument', index: 1}],
      },
    },
  });

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.SET_AREF,
    bindings: {
      'smalltalk/primitive/indexed-at-put': {name: '$indexedAtPut', value: ref('smalltalk/primitive/indexed-at-put')},
    },
    program: {
      parameters: [{id: 'vec', name: 'VEC'}, {id: 'idx', name: 'IDX'}, {id: 'val', name: 'VAL'}],
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
              {op: 'argument', index: 1},
              {op: 'argument', index: 2},
            ],
          },
          {op: 'argument', index: 2},
        ],
      },
    },
  });

  for (const [helperId, primId] of [
    [RUNTIME_BLOCK_IDS.VECTOR_LENGTH, 'smalltalk/primitive/indexed-size'],
    [RUNTIME_BLOCK_IDS.STRING_LENGTH, 'smalltalk/primitive/text-size'],
    [RUNTIME_BLOCK_IDS.CODE_CHAR, 'smalltalk/primitive/character-intern'],
  ]) {
    await installRuntimeHelperBlock({
      images,
      compilation,
      imageId,
      lane,
      id: helperId,
      bindings: {[primId]: {name: primId, value: ref(primId)}},
      program: {
        parameters: [{id: 'x', name: 'X'}],
        temporaries: [],
        captures: [{id: primId, name: primId, mode: 'snapshot'}],
        body: {
          op: 'apply',
          callee: {op: 'binding', id: primId},
          arguments: [{op: 'argument', index: 0}],
        },
      },
    });
  }

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.CHAR,
    bindings: {
      'smalltalk/primitive/text-at-character': {
        name: '$textAtCharacter',
        value: ref('smalltalk/primitive/text-at-character'),
      },
    },
    program: {
      parameters: [{id: 'str', name: 'STR'}, {id: 'idx', name: 'IDX'}],
      temporaries: [],
      captures: [{id: 'smalltalk/primitive/text-at-character', name: '$textAtCharacter', mode: 'snapshot'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'smalltalk/primitive/text-at-character'},
        arguments: [
          {op: 'argument', index: 0},
          {
            op: 'integer-add',
            left: {op: 'argument', index: 1},
            right: {op: 'literal', value: integerValue(1n)},
          },
        ],
      },
    },
  });

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.CHAR_CODE,
    program: {
      parameters: [{id: 'ch', name: 'CH'}],
      temporaries: [],
      captures: [],
      body: {
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: {op: 'argument', index: 0},
        message: textValue('codePoint'),
        arguments: [],
      },
    },
  });

  // 11. Hash Tables (Dictionary): %make-hash-table, gethash, %set-gethash, remhash
  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.MAKE_HASH_TABLE,
    bindings: {
      'smalltalk/class/Dictionary': {name: 'Dictionary', value: ref('smalltalk/class/Dictionary')},
    },
    program: {
      parameters: [],
      temporaries: [],
      captures: [{id: 'smalltalk/class/Dictionary', name: 'Dictionary', mode: 'snapshot'}],
      body: {
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: {op: 'binding', id: 'smalltalk/class/Dictionary'},
        message: textValue('new'),
        arguments: [],
      },
    },
  });

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.GETHASH,
    bindings: {
      'smalltalk/primitive/dictionary-includes-key': {
        name: '$dictIncludesKey',
        value: ref('smalltalk/primitive/dictionary-includes-key'),
      },
      'smalltalk/primitive/dictionary-at': {
        name: '$dictAt',
        value: ref('smalltalk/primitive/dictionary-at'),
      },
      [COMMON_LISP_TOMBSTONE_ID]: {name: '$tombstone', value: ref(COMMON_LISP_TOMBSTONE_ID)},
    },
    program: {
      parameters: [{id: 'key', name: 'KEY'}, {id: 'table', name: 'TABLE'}, {id: 'def', name: 'DEF'}],
      temporaries: [{id: 'val', name: 'VAL'}],
      captures: [
        {id: 'smalltalk/primitive/dictionary-includes-key', name: '$dictIncludesKey', mode: 'snapshot'},
        {id: 'smalltalk/primitive/dictionary-at', name: '$dictAt', mode: 'snapshot'},
        {id: COMMON_LISP_TOMBSTONE_ID, name: '$tombstone', mode: 'snapshot'},
      ],
      body: {
        op: 'if',
        condition: {
          op: 'apply',
          callee: {op: 'binding', id: 'smalltalk/primitive/dictionary-includes-key'},
          arguments: [{op: 'argument', index: 1}, {op: 'argument', index: 0}],
        },
        then: {
          op: 'sequence',
          statements: [
            {
              op: 'binding-write',
              id: 'val',
              value: {
                op: 'apply',
                callee: {op: 'binding', id: 'smalltalk/primitive/dictionary-at'},
                arguments: [{op: 'argument', index: 1}, {op: 'argument', index: 0}],
              },
            },
            {
              op: 'if',
              condition: {
                op: 'equals',
                left: {op: 'binding', id: 'val'},
                right: {op: 'binding', id: COMMON_LISP_TOMBSTONE_ID},
              },
              then: {op: 'argument', index: 2},
              else: {op: 'binding', id: 'val'},
            },
          ],
        },
        else: {op: 'argument', index: 2},
      },
    },
  });

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.SET_GETHASH,
    bindings: {
      'smalltalk/primitive/dictionary-at-put': {
        name: '$dictAtPut',
        value: ref('smalltalk/primitive/dictionary-at-put'),
      },
    },
    program: {
      parameters: [{id: 'key', name: 'KEY'}, {id: 'table', name: 'TABLE'}, {id: 'val', name: 'VAL'}],
      temporaries: [],
      captures: [{id: 'smalltalk/primitive/dictionary-at-put', name: '$dictAtPut', mode: 'snapshot'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'smalltalk/primitive/dictionary-at-put'},
        arguments: [
          {op: 'argument', index: 1},
          {op: 'argument', index: 0},
          {op: 'argument', index: 2},
        ],
      },
    },
  });

  await installRuntimeHelperBlock({
    images,
    compilation,
    imageId,
    lane,
    id: RUNTIME_BLOCK_IDS.REMHASH,
    bindings: {
      ...boolBindings,
      'smalltalk/primitive/dictionary-includes-key': {
        name: '$dictIncludesKey',
        value: ref('smalltalk/primitive/dictionary-includes-key'),
      },
      'smalltalk/primitive/dictionary-at': {
        name: '$dictAt',
        value: ref('smalltalk/primitive/dictionary-at'),
      },
      'smalltalk/primitive/dictionary-at-put': {
        name: '$dictAtPut',
        value: ref('smalltalk/primitive/dictionary-at-put'),
      },
      [COMMON_LISP_TOMBSTONE_ID]: {name: '$tombstone', value: ref(COMMON_LISP_TOMBSTONE_ID)},
    },
    program: {
      parameters: [{id: 'key', name: 'KEY'}, {id: 'table', name: 'TABLE'}],
      temporaries: [{id: 'val', name: 'VAL'}],
      captures: [
        nilCap,
        tCap,
        {id: 'smalltalk/primitive/dictionary-includes-key', name: '$dictIncludesKey', mode: 'snapshot'},
        {id: 'smalltalk/primitive/dictionary-at', name: '$dictAt', mode: 'snapshot'},
        {id: 'smalltalk/primitive/dictionary-at-put', name: '$dictAtPut', mode: 'snapshot'},
        {id: COMMON_LISP_TOMBSTONE_ID, name: '$tombstone', mode: 'snapshot'},
      ],
      body: {
        op: 'if',
        condition: {
          op: 'apply',
          callee: {op: 'binding', id: 'smalltalk/primitive/dictionary-includes-key'},
          arguments: [{op: 'argument', index: 1}, {op: 'argument', index: 0}],
        },
        then: {
          op: 'sequence',
          statements: [
            {
              op: 'binding-write',
              id: 'val',
              value: {
                op: 'apply',
                callee: {op: 'binding', id: 'smalltalk/primitive/dictionary-at'},
                arguments: [{op: 'argument', index: 1}, {op: 'argument', index: 0}],
              },
            },
            {
              op: 'if',
              condition: {
                op: 'equals',
                left: {op: 'binding', id: 'val'},
                right: {op: 'binding', id: COMMON_LISP_TOMBSTONE_ID},
              },
              then: {op: 'binding', id: CL_NIL_BINDING_ID},
              else: {
                op: 'sequence',
                statements: [
                  {
                    op: 'apply',
                    callee: {op: 'binding', id: 'smalltalk/primitive/dictionary-at-put'},
                    arguments: [
                      {op: 'argument', index: 1},
                      {op: 'argument', index: 0},
                      {op: 'binding', id: COMMON_LISP_TOMBSTONE_ID},
                    ],
                  },
                  {op: 'binding', id: CL_T_BINDING_ID},
                ],
              },
            },
          ],
        },
        else: {op: 'binding', id: CL_NIL_BINDING_ID},
      },
    },
  });
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
  await installSmalltalkDictionaryProtocol({images, compilation: compiler, imageId, lane});
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
  await installSmalltalkCharacterProtocol({images, compilation: compiler, imageId, lane});
  await installSmalltalkTextByteArrayProtocol({images, compilation: compiler, imageId, lane});
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

  // Ensure Cons, BlockExit, and BlockClosure classes exist in the image
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
  await ensureNamedClass({
    images,
    imageId,
    name: BLOCK_EXIT_CLASS_NAME,
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

  // Ensure singleton sentinels for hash-table tombstones and unsupplied optional args
  for (const sentinelId of [COMMON_LISP_TOMBSTONE_ID, COMMON_LISP_UNSUPPLIED_ID]) {
    await ensureObject(images, imageId, {
      id: sentinelId,
      shape: objectRef(imageId, EMPTY_SHAPE_ID),
      behavior: kernel.objectClass,
      slots: {},
      metadata: {commonLisp: 'sentinel'},
    });
  }

  await publishSmalltalkClassGlobals({
    images,
    imageId,
    names: [
      'Array',
      'ByteArray',
      'Character',
      'Dictionary',
      'Symbol',
      CONS_CLASS_NAME,
      BLOCK_EXIT_CLASS_NAME,
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
  const macros = {};
  const structs = {};
  const functionSignatures = {};

  for (const [name, bindingId] of Object.entries(globals)) {
    if (bindingId.startsWith('common-lisp/function-binding/')) {
      functionBindings[name] = bindingId;
    } else if (bindingId.startsWith('common-lisp/variable-binding/')) {
      variableBindings[name] = bindingId;
    } else if (bindingId.startsWith('common-lisp/macro-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        macros[parsed.name] = parsed;
      }
    } else if (bindingId.startsWith('common-lisp/struct-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        structs[parsed.name] = parsed;
        if (parsed.constructorName) {
          macros[parsed.constructorName] = {
            kind: 'struct-constructor',
            struct: parsed,
          };
        }
      }
    } else if (bindingId.startsWith('common-lisp/signature-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        functionSignatures[parsed.name] = parsed;
      }
    }
  }
  return {globals, functionBindings, variableBindings, macros, structs, functionSignatures};
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
  alreadyExpanded = false,
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
    structs: ctx.structs ?? {},
    functionSignatures: ctx.functionSignatures ?? {},
    alreadyExpanded,
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

function parseTopLevelDefun(form, macroContext = createMacroContext()) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFUN') {
    return null;
  }
  if (form.elements.length < 3) {
    throw new SyntaxError('Common Lisp DEFUN requires a name, parameter list, and body');
  }
  const [, nameSym, paramForm, ...rawBodyForms] = form.elements;
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError('Common Lisp DEFUN name must be an ordinary symbol');
  }
  // Register self-signature in macroContext before expanding body so recursive calls with &optional/&key work
  const parsedParams = parseLambdaList(paramForm);
  let selfSig = null;
  if (!parsedParams.isSimple) {
    selfSig = Object.freeze({
      name: nameSym.name,
      requiredCount: parsedParams.required.length,
      optionalCount: parsedParams.optional.length,
      hasRestOrKey: Boolean(parsedParams.rest !== null || parsedParams.keys.length > 0),
    });
    macroContext.functionSignatures.set(nameSym.name, selfSig);
  }
  const expandedBody = rawBodyForms.map((b) => expandAllMacrosInForm(b, macroContext));
  const norm = normalizeFunctionDefinition(nameSym.name, paramForm, expandedBody, macroContext);
  return {
    name: nameSym.name,
    parameters: norm.paramNames,
    bodyForms: norm.bodyForms,
    signature: norm.signature,
  };
}

function parseTopLevelDefmacro(form) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFMACRO') {
    return null;
  }
  if (form.elements.length < 3) {
    throw new SyntaxError('Common Lisp DEFMACRO requires a name, lambda-list, and body');
  }
  const [, nameSym, lambdaList, ...bodyForms] = form.elements;
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError('Common Lisp DEFMACRO name must be an ordinary symbol');
  }
  return Object.freeze({
    kind: 'defmacro',
    name: nameSym.name,
    lambdaList,
    bodyForms,
  });
}

function toPascalCaseIdentifier(rawName) {
  const parts = String(rawName)
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return 'Struct';
  const joined = parts
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join('');
  return /^[A-Z]/.test(joined) ? joined : `S${joined}`;
}

function toCamelCaseSlotName(rawName) {
  const parts = String(rawName)
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return 'slot';
  const first = parts[0].toLowerCase();
  const rest = parts
    .slice(1)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join('');
  const candidate = `${first}${rest}`;
  return /^[a-z]/.test(candidate) ? candidate : `slot_${candidate}`;
}

function parseTopLevelDefstruct(form, existingStructs = {}) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFSTRUCT') {
    return null;
  }
  if (form.elements.length < 2) {
    throw new SyntaxError('Common Lisp DEFSTRUCT requires a name or name-and-options specification');
  }
  const [, nameAndOpts, ...slotForms] = form.elements;
  let nameSym;
  let optionForms = [];
  if (nameAndOpts?.kind === 'symbol') {
    nameSym = nameAndOpts;
  } else if (nameAndOpts?.kind === 'list' && nameAndOpts.elements[0]?.kind === 'symbol') {
    [nameSym, ...optionForms] = nameAndOpts.elements;
  } else {
    throw new SyntaxError('invalid Common Lisp DEFSTRUCT name specification');
  }

  const structName = nameSym.name;
  const className = toPascalCaseIdentifier(nameSym.spelling || structName);
  let concName = `${structName}-`;
  let constructorName = `MAKE-${structName}`;
  let predicateName = `${structName}-P`;
  let copierName = `COPY-${structName}`;
  let includeName = null;

  for (const opt of optionForms) {
    if (opt?.kind === 'list' && opt.elements[0]?.kind === 'symbol') {
      const optKey = opt.elements[0].name;
      const optVal = opt.elements[1];
      if (optKey === ':INCLUDE' && optVal?.kind === 'symbol') {
        includeName = optVal.name;
      } else if (optKey === ':CONC-NAME') {
        if (!optVal || isNilSymbol(optVal)) concName = '';
        else if (optVal.kind === 'symbol') concName = optVal.name.startsWith(':') ? optVal.name.slice(1) : optVal.name;
        else if (optVal.kind === 'string') concName = optVal.value.toUpperCase();
      } else if (optKey === ':CONSTRUCTOR' && optVal?.kind === 'symbol') {
        constructorName = isNilSymbol(optVal) ? null : optVal.name;
      } else if (optKey === ':PREDICATE' && optVal?.kind === 'symbol') {
        predicateName = isNilSymbol(optVal) ? null : optVal.name;
      } else if (optKey === ':COPIER' && optVal?.kind === 'symbol') {
        copierName = isNilSymbol(optVal) ? null : optVal.name;
      }
    }
  }

  const parentStruct = includeName ? existingStructs[includeName] : null;
  if (includeName && !parentStruct) {
    throw new SyntaxError(`Common Lisp DEFSTRUCT ${structName} :include unknown parent struct ${includeName}`);
  }

  const localSlots = slotForms
    .filter((sf) => sf?.kind !== 'string') // skip optional docstring
    .map((sf) => {
      if (sf?.kind === 'symbol') {
        return {
          name: sf.name,
          varName: toCamelCaseSlotName(sf.name),
          defaultForm: NIL_NODE,
        };
      }
      if (sf?.kind === 'list' && sf.elements[0]?.kind === 'symbol') {
        const sName = sf.elements[0].name;
        return {
          name: sName,
          varName: toCamelCaseSlotName(sName),
          defaultForm: sf.elements[1] ?? NIL_NODE,
        };
      }
      throw new SyntaxError(`invalid slot specification in Common Lisp DEFSTRUCT ${structName}`);
    });

  const inheritedSlots = parentStruct ? parentStruct.slots : [];
  const allSlots = [...inheritedSlots, ...localSlots];

  return Object.freeze({
    name: structName,
    className,
    includeName,
    parentClassName: parentStruct ? parentStruct.className : null,
    concName,
    constructorName,
    internalConstructorName: `%MAKE-STRUCT-${structName}`,
    predicateName,
    copierName,
    localSlots,
    slots: allSlots,
  });
}

function buildDefstructProgramForms(struct) {
  const generated = [];
  const classSym = makeSymbolNode(struct.className, {spelling: struct.className});
  const instSym = makeSymbolNode('%INST');

  // 1. Internal positional constructor (%MAKE-STRUCT-<NAME> s1 s2 ...)
  const ctorParams = struct.slots.map((s) => makeSymbolNode(`%SLOT_${s.name}`));
  const setterSends = struct.slots.map((s, idx) =>
    makeListNode([
      makeSymbolNode('SEND'),
      instSym,
      Object.freeze({kind: 'string', value: `${s.varName}:`}),
      ctorParams[idx],
    ]),
  );
  generated.push(
    makeListNode([
      makeSymbolNode('DEFUN'),
      makeSymbolNode(struct.internalConstructorName),
      makeListNode(ctorParams),
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([
            instSym,
            makeListNode([makeSymbolNode('SEND'), classSym, Object.freeze({kind: 'string', value: 'basicNew'})]),
          ]),
        ]),
        ...setterSends,
        instSym,
      ]),
    ]),
  );

  // 2. Public constructor function MAKE-<NAME> (for #'make-<name> and positional/keyword calls)
  if (struct.constructorName) {
    generated.push(
      makeListNode([
        makeSymbolNode('DEFUN'),
        makeSymbolNode(struct.constructorName),
        makeListNode(ctorParams),
        makeListNode([makeSymbolNode(struct.internalConstructorName), ...ctorParams]),
      ]),
    );
  }

  // 3. Type predicate <NAME>-P
  if (struct.predicateName) {
    const xSym = makeSymbolNode('%X');
    generated.push(
      makeListNode([
        makeSymbolNode('DEFUN'),
        makeSymbolNode(struct.predicateName),
        makeListNode([xSym]),
        makeListNode([
          makeSymbolNode('IF'),
          makeListNode([
            makeSymbolNode('SEND'),
            xSym,
            Object.freeze({kind: 'string', value: `isClStruct_${struct.name}`}),
          ]),
          T_NODE,
          NIL_NODE,
        ]),
      ]),
    );
  }

  // 4. Copier COPY-<NAME>
  if (struct.copierName) {
    const readerSends = struct.slots.map((s) =>
      makeListNode([
        makeSymbolNode('SEND'),
        instSym,
        Object.freeze({kind: 'string', value: s.varName}),
      ]),
    );
    generated.push(
      makeListNode([
        makeSymbolNode('DEFUN'),
        makeSymbolNode(struct.copierName),
        makeListNode([instSym]),
        makeListNode([makeSymbolNode(struct.internalConstructorName), ...readerSends]),
      ]),
    );
  }

  // 5. Slot readers <CONC-NAME><SLOT> and writers %SET-<CONC-NAME><SLOT>
  const valSym = makeSymbolNode('%VAL');
  for (const s of struct.slots) {
    const accessorName = `${struct.concName}${s.name}`;
    generated.push(
      makeListNode([
        makeSymbolNode('DEFUN'),
        makeSymbolNode(accessorName),
        makeListNode([instSym]),
        makeListNode([
          makeSymbolNode('SEND'),
          instSym,
          Object.freeze({kind: 'string', value: s.varName}),
        ]),
      ]),
    );
    generated.push(
      makeListNode([
        makeSymbolNode('DEFUN'),
        makeSymbolNode(`%SET-${accessorName}`),
        makeListNode([instSym, valSym]),
        makeListNode([
          makeSymbolNode('SEND'),
          instSym,
          Object.freeze({kind: 'string', value: `${s.varName}:`}),
          valSym,
        ]),
        valSym,
      ]),
    );
  }

  return generated;
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
  const rawForms = typeof source === 'string' ? readCommonLispSource(source) : source;
  const compileContext = await collectCommonLispCompileContext({images: effectiveImages, imageId});

  // Expand any top-level DEFMACRO and DEFSTRUCT forms first so subsequent DEFUNs and expressions
  // in the same program can use them immediately.
  const expandedTopForms = [];
  const macros = {};
  const structs = {};

  const queue = [...rawForms];
  while (queue.length > 0) {
    const rawForm = queue.shift();
    if (
      rawForm?.kind === 'list'
      && rawForm.elements[0]?.kind === 'symbol'
      && rawForm.elements[0].name !== 'DEFMACRO'
      && rawForm.elements[0].name !== 'DEFSTRUCT'
      && rawForm.elements[0].name !== 'DEFUN'
      && rawForm.elements[0].name !== 'DEFPARAMETER'
      && rawForm.elements[0].name !== 'DEFVAR'
    ) {
      const step = macroexpandCommonLispForm(rawForm, createMacroContext(compileContext));
      if (step.expanded) {
        queue.unshift(step.form);
        continue;
      }
      if (rawForm.elements[0].name === 'PROGN') {
        queue.unshift(...rawForm.elements.slice(1));
        continue;
      }
    }

    const defmacro = parseTopLevelDefmacro(rawForm);
    if (defmacro) {
      const serialized = JSON.stringify(defmacro);
      await ensureCodeArtifact(effectiveImages, imageId, {
        id: commonLispMacroArtifactId(defmacro.name, serialized),
        languageId: COMMON_LISP_ID,
        representation: COMMON_LISP_MACRO_V0,
        content: textValue(serialized),
        metadata: {commonLisp: 'defmacro', macroName: defmacro.name},
      });
      await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: `%MACRO:${defmacro.name}`,
        bindingId: commonLispMacroBindingId(defmacro.name),
        value: textValue(serialized),
      });
      compileContext.macros[defmacro.name] = defmacro;
      macros[defmacro.name] = defmacro;
      continue;
    }

    const defstruct = parseTopLevelDefstruct(rawForm, compileContext.structs);
    if (defstruct) {
      const superclassRef = defstruct.parentClassName
        ? objectRef(imageId, `smalltalk/class/${defstruct.parentClassName}`)
        : kernel.objectClass;
      const {classRef} = await ensureClassFromDeclaration({
        images: effectiveImages,
        imageId,
        name: defstruct.className,
        superclassRef,
        instanceVariables: defstruct.localSlots.map((s) => s.varName),
      });
      await publishSmalltalkClassGlobals({
        images: effectiveImages,
        imageId,
        names: [defstruct.className],
      });
      const slotMethods = [];
      for (const s of defstruct.localSlots) {
        slotMethods.push({selector: s.varName, source: `[ ^ ${s.varName} ]`});
        slotMethods.push({selector: `${s.varName}:`, source: `[ :v | ${s.varName} := v. ^ self ]`});
      }
      slotMethods.push({
        selector: `isClStruct_${defstruct.name}`,
        source: '[ ^ self ]',
      });
      await defineMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef,
        allowRedefinition: true,
        methods: slotMethods,
      });
      await defineMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef: kernel.objectClass,
        allowRedefinition: true,
        methods: [{selector: `isClStruct_${defstruct.name}`, source: '[ ^ nil ]'}],
      });

      const serialized = JSON.stringify(defstruct);
      await ensureCodeArtifact(effectiveImages, imageId, {
        id: commonLispStructArtifactId(defstruct.name, serialized),
        languageId: COMMON_LISP_ID,
        representation: COMMON_LISP_STRUCT_V0,
        content: textValue(serialized),
        metadata: {commonLisp: 'defstruct', structName: defstruct.name, className: defstruct.className},
      });
      await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: `%STRUCT:${defstruct.name}`,
        bindingId: commonLispStructBindingId(defstruct.name),
        value: textValue(serialized),
      });
      compileContext.structs[defstruct.name] = defstruct;
      compileContext.globals[defstruct.className] = `smalltalk/global-binding/${defstruct.className}`;
      if (defstruct.constructorName) {
        compileContext.macros[defstruct.constructorName] = {
          kind: 'struct-constructor',
          struct: defstruct,
        };
      }
      structs[defstruct.name] = Object.freeze({...defstruct, classRef});
      expandedTopForms.push(...buildDefstructProgramForms(defstruct));
      continue;
    }

    expandedTopForms.push(rawForm);
  }

  // Pre-seed all DEFUN (and their signatures) and DEFPARAMETER/DEFVAR global bindings so recursive
  // and mutually recursive functions can reference one another regardless of declaration order.
  const preMacroCtx = createMacroContext(compileContext);
  for (const form of expandedTopForms) {
    if (form?.kind === 'list' && form.elements[0]?.kind === 'symbol' && form.elements[0].name === 'DEFUN') {
      const nameSym = form.elements[1];
      const paramForm = form.elements[2] ?? NIL_NODE;
      if (nameSym?.kind === 'symbol') {
        const bindingId = commonLispFunctionBindingId(nameSym.name);
        const existing = await resolveGlobal({
          images: effectiveImages,
          imageId,
          name: nameSym.name,
          namespaceId: COMMON_LISP_NAMESPACE_ID,
        });
        if (!existing) {
          await publishGlobal({
            images: effectiveImages,
            imageId,
            namespaceId: COMMON_LISP_NAMESPACE_ID,
            name: nameSym.name,
            bindingId,
            value: kernel.nil,
          });
        }
        compileContext.functionBindings[nameSym.name] = bindingId;
        compileContext.globals[nameSym.name] = bindingId;

        const parsedParams = parseLambdaList(paramForm);
        if (!parsedParams.isSimple) {
          const sig = Object.freeze({
            name: nameSym.name,
            requiredCount: parsedParams.required.length,
            optionalCount: parsedParams.optional.length,
            hasRestOrKey: Boolean(parsedParams.rest !== null || parsedParams.keys.length > 0),
          });
          const sigJson = JSON.stringify(sig);
          await ensureCodeArtifact(effectiveImages, imageId, {
            id: commonLispSignatureArtifactId(nameSym.name, sigJson),
            languageId: COMMON_LISP_ID,
            representation: COMMON_LISP_SIGNATURE_V0,
            content: textValue(sigJson),
            metadata: {commonLisp: 'signature', functionName: nameSym.name},
          });
          await ensureGlobalBindingInNamespace({
            images: effectiveImages,
            imageId,
            namespaceId: COMMON_LISP_NAMESPACE_ID,
            name: `%SIG:${nameSym.name}`,
            bindingId: commonLispSignatureBindingId(nameSym.name),
            value: textValue(sigJson),
          });
          compileContext.functionSignatures[nameSym.name] = sig;
          preMacroCtx.functionSignatures.set(nameSym.name, sig);
        }
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
      compileContext.variableBindings[defvar.name] = bindingId;
      compileContext.globals[defvar.name] = bindingId;
    }
  }

  const functions = {};
  const variables = {};
  const expressions = [];

  for (const form of expandedTopForms) {
    const defun = parseTopLevelDefun(form, createMacroContext(compileContext));
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
        alreadyExpanded: true,
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
    macros: Object.freeze(macros),
    structs: Object.freeze(structs),
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
    const structNames = Object.keys(programResult.structs);
    if (structNames.length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, structNames[structNames.length - 1]);
    }
    const macroNames = Object.keys(programResult.macros);
    if (macroNames.length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, macroNames[macroNames.length - 1]);
    }
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
  BLOCK_EXIT_CLASS_NAME,
  CL_NIL_BINDING_ID,
  CL_T_BINDING_ID,
  COMMON_LISP,
  COMMON_LISP_ID,
  COMMON_LISP_MACRO_V0,
  COMMON_LISP_NAMESPACE_ID,
  COMMON_LISP_SIGNATURE_V0,
  COMMON_LISP_SOURCE_V0,
  COMMON_LISP_STRUCT_V0,
  COMMON_LISP_SYNTAX_V0,
  CONS_CLASS_NAME,
  CONS_SHAPE_ID,
  RUNTIME_BLOCK_IDS,
  attachCommonLispMethod,
  commonLispFunctionBindingId,
  commonLispFunctionBlockId,
  commonLispListToArray,
  commonLispMacroArtifactId,
  commonLispMacroBindingId,
  commonLispStructArtifactId,
  commonLispStructBindingId,
  commonLispVariableBindingId,
  compileCommonLispBlock,
  compileCommonLispSemanticProgram,
  evaluateCommonLispSource,
  expandAllMacrosInForm,
  installCommonLispBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  macroexpand1CommonLispForm,
  macroexpandCommonLispForm,
  readCommonLispSource,
  tokenizeCommonLispSource,
};
