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
  reconcileMethodsFromSource,
} from './smalltalk-instance-variables.js';
import {installSmalltalkIntegerProtocol} from './smalltalk-integer.js';
import {
  EMPTY_SHAPE_ID,
  findSmalltalkKernel,
  installSmalltalkKernel,
  readBehavior,
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
const COMMON_LISP_CLASS_V0 = 'common-lisp/class-v0';
const COMMON_LISP_GENERIC_V0 = 'common-lisp/generic-v0';
const COMMON_LISP_PACKAGE_V0 = 'common-lisp/package-v0';
const COMMON_LISP_SYSTEM_V0 = 'common-lisp/system-v0';
const COMMON_LISP_SIGNATURE_V0 = 'common-lisp/signature-v0';
const COMMON_LISP_SETF_V0 = 'common-lisp/setf-v0';
const COMMON_LISP_READER_MACRO_V0 = 'common-lisp/reader-macro-v0';
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
  version: '0.3.0',
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
  '%GETHASH-RAW': RUNTIME_BLOCK_IDS.GETHASH,
  '%SET-GETHASH': RUNTIME_BLOCK_IDS.SET_GETHASH,
  REMHASH: RUNTIME_BLOCK_IDS.REMHASH,
});

const STANDARD_LIBRARY_SOURCE = `
(defvar %mv-list '%single-value)
(defvar %mv-primary nil)

(defun %values (vals)
  (setq %mv-list vals)
  (setq %mv-primary (car vals))
  (car vals))

(defun values-list (vals)
  (%values vals))

(defun %capture-mv (thunk)
  (setq %mv-list '%single-value)
  (setq %mv-primary nil)
  (let ((primary (funcall thunk)))
    (let ((vals (if (and (not (eq %mv-list '%single-value))
                         (eql primary %mv-primary))
                    %mv-list
                    (list primary))))
      (setq %mv-list '%single-value)
      (setq %mv-primary nil)
      vals)))

(defun %gethash-with-mv (key table default)
  (let* ((sentinel (%unsupplied))
         (raw (%gethash-raw key table sentinel)))
    (if (eq raw sentinel)
        (%values (list default nil))
        (%values (list raw t)))))

(defun second (list) (car (cdr list)))
(defun third (list) (car (cdr (cdr list))))
(defun caar (x) (car (car x)))
(defun cadr (x) (car (cdr x)))
(defun cdar (x) (cdr (car x)))
(defun cddr (x) (cdr (cdr x)))

(defun evenp (n) (= (mod n 2) 0))
(defun oddp (n) (/= (mod n 2) 0))
(defun abs (n) (if (< n 0) (- 0 n) n))
(defun min (a b) (if (< a b) a b))
(defun max (a b) (if (> a b) a b))

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

(defun %char-to-string (ch)
  (let ((arr (%make-array 1)))
    (%set-aref arr 0 (char-code ch))
    (send (send ByteArray :fromArray: arr) :utf8Text)))

(defun %string-subseq (str start end)
  (let* ((limit (if end end (%string-length str)))
         (out "")
         (idx start))
    (%while (< idx limit)
      (setq out (%string-append out (%char-to-string (char str idx))))
      (setq idx (+ idx 1)))
    out))

(defun subseq (seq start &optional end)
  (cond
    ((vectorp seq) (%vector-subseq seq start end))
    ((stringp seq) (%string-subseq seq start end))
    (t (%list-subseq seq start end 0))))

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

(defvar %active-restarts nil)

(defun %apply-list (fn args)
  (let ((len (%list-length args)))
    (cond
      ((= len 0) (funcall fn))
      ((= len 1) (funcall fn (car args)))
      ((= len 2) (funcall fn (car args) (cadr args)))
      ((= len 3) (funcall fn (car args) (cadr args) (third args)))
      ((= len 4) (funcall fn (car args) (cadr args) (third args) (nth 3 args)))
      ((= len 5) (funcall fn (car args) (cadr args) (third args) (nth 3 args) (nth 4 args)))
      ((= len 6) (funcall fn (car args) (cadr args) (third args) (nth 3 args) (nth 4 args) (nth 5 args)))
      ((= len 7) (funcall fn (car args) (cadr args) (third args) (nth 3 args) (nth 4 args) (nth 5 args) (nth 6 args)))
      (t (funcall fn (car args) (cadr args) (third args) (nth 3 args) (nth 4 args) (nth 5 args) (nth 6 args) (nth 7 args))))))

(defun find-restart (name)
  (let ((entry (assoc name %active-restarts)))
    (if entry (car entry) nil)))

(defun invoke-restart (name &rest args)
  (let ((entry (assoc name %active-restarts)))
    (if entry
        (%apply-list (cdr entry) args)
        (error "restart not active"))))

(defun intern (str)
  (send str :asSymbol))

(defun %and2 (a b)
  (if a b nil))

(defun %or2 (a b)
  (if a a b))

(defun %cons-if (flag item list)
  (if flag (cons item list) list))

(defun keywordp (x)
  (cond
    ((null x) nil)
    ((eq x t) nil)
    ((symbolp x)
     (let ((s (send x :asString)))
       (if (> (%string-length s) 1)
           (if (= (char-code (char s 0)) 58) t nil)
           nil)))
    (t nil)))

(defun symbol-name (sym)
  (cond
    ((null sym) "NIL")
    ((eq sym t) "T")
    ((symbolp sym)
     (let ((s (send sym :asString)))
       (if (> (%string-length s) 1)
           (if (= (char-code (char s 0)) 58)
               (%string-subseq s 1 nil)
               s)
           s)))
    (t (error "not a symbol"))))

(defun %char-downcase-code (code)
  (if (>= code 65)
      (if (<= code 90) (+ code 32) code)
      code))

(defun %char-upcase-code (code)
  (if (>= code 97)
      (if (<= code 122) (- code 32) code)
      code))

(defun %lisp-slot-to-camel (str)
  (let ((len (%string-length str))
        (cap-next nil)
        (out ""))
    (dotimes (idx len)
      (let ((code (char-code (char str idx))))
        (if (= code 45)
            (setq cap-next t)
            (let ((next-ch (%char-to-string
                             (code-char (if cap-next
                                            (%char-upcase-code code)
                                            (%char-downcase-code code))))))
              (setq out (%string-append out next-ch))
              (setq cap-next nil)))))
    out))

(defun %slot-value (obj slot-sym)
  (let ((sel (send (%lisp-slot-to-camel (symbol-name slot-sym)) :asSymbol)))
    (send obj :perform: sel)))

(defun %set-slot-value (obj slot-sym val)
  (let ((sel (send (%string-append (%lisp-slot-to-camel (symbol-name slot-sym)) ":") :asSymbol)))
    (send obj :perform:with: sel val)
    val))

(defun class-of (x)
  (if (functionp x)
      BlockClosure
      (send x :class)))

(defun class-name (cls)
  (if (symbolp cls)
      cls
      (send (send cls :clClassName) :asSymbol)))

(defun type-of (x)
  (cond
    ((null x) 'null)
    ((eq x t) 'boolean)
    ((integerp x) 'integer)
    ((stringp x) 'string)
    ((characterp x) 'character)
    ((keywordp x) 'keyword)
    ((symbolp x) 'symbol)
    ((consp x) 'cons)
    ((vectorp x) 'vector)
    ((hash-table-p x) 'hash-table)
    ((functionp x) 'function)
    (t (send (send x :clTypeName) :asSymbol))))

(defun %primitive-value-p (x)
  (cond
    ((null x) t)
    ((eq x t) t)
    ((integerp x) t)
    ((stringp x) t)
    ((characterp x) t)
    ((symbolp x) t)
    ((consp x) t)
    ((vectorp x) t)
    ((hash-table-p x) t)
    ((functionp x) t)
    (t nil)))

(defun %typep (x tp)
  (cond
    ((eq tp t) t)
    ((null tp) nil)
    ((consp tp)
     (if (eq (car tp) 'eql)
         (eql x (car (cdr tp)))
         nil))
    ((eq tp 'null) (null x))
    ((eq tp 'cons) (consp x))
    ((eq tp 'list) (listp x))
    ((eq tp 'atom) (atom x))
    ((eq tp 'symbol) (symbolp x))
    ((eq tp 'keyword) (keywordp x))
    ((eq tp 'integer) (integerp x))
    ((eq tp 'number) (integerp x))
    ((eq tp 'fixnum) (integerp x))
    ((eq tp 'string) (stringp x))
    ((eq tp 'character) (characterp x))
    ((eq tp 'vector) (vectorp x))
    ((eq tp 'array) (vectorp x))
    ((eq tp 'hash-table) (hash-table-p x))
    ((eq tp 'function) (functionp x))
    ((%primitive-value-p x) nil)
    ((eq tp 'standard-object) t)
    ((symbolp tp)
     (if (send x :perform: (send (%string-append "isClClass_" (symbol-name tp)) :asSymbol))
         t
         nil))
    (t nil)))

(defun initialize-instance (inst &rest initargs)
  inst)

(defun %positive-int-to-string (n acc)
  (if (= n 0)
      acc
      (let ((digit (mod n 10))
            (rest (floor n 10)))
        (%positive-int-to-string
          rest
          (%string-append (%char-to-string (code-char (+ 48 digit))) acc)))))

(defun %int-to-string (n)
  (if (= n 0)
      "0"
      (if (< n 0)
          (%string-append "-" (%positive-int-to-string (- 0 n) ""))
          (%positive-int-to-string n ""))))

(defun %format-list-tail (cur readable)
  (cond
    ((null cur) ")")
    ((consp cur)
     (let ((elem-str (if readable (prin1-to-string (car cur)) (princ-to-string (car cur)))))
       (%string-append " "
         (%string-append elem-str (%format-list-tail (cdr cur) readable)))))
    (t
     (let ((elem-str (if readable (prin1-to-string cur) (princ-to-string cur))))
       (%string-append " . "
         (%string-append elem-str ")"))))))

(defun %format-vector (vec readable)
  (let ((len (%vector-length vec))
        (out "#("))
    (dotimes (idx len)
      (let* ((sep (if (> idx 0) " " ""))
             (el (aref vec idx))
             (s (if readable (prin1-to-string el) (princ-to-string el))))
        (setq out (%string-append out (%string-append sep s)))))
    (%string-append out ")")))

(defun princ-to-string (x)
  (cond
    ((null x) "NIL")
    ((eq x t) "T")
    ((integerp x) (%int-to-string x))
    ((stringp x) x)
    ((characterp x) (%char-to-string x))
    ((symbolp x) (symbol-name x))
    ((consp x)
     (%string-append "("
       (%string-append (princ-to-string (car x))
                       (%format-list-tail (cdr x) nil))))
    ((vectorp x) (%format-vector x nil))
    (t (%string-append "#<" (%string-append (send x :clTypeName) ">")))))

(defun prin1-to-string (x)
  (cond
    ((null x) "NIL")
    ((eq x t) "T")
    ((integerp x) (%int-to-string x))
    ((stringp x) (%string-append "\\"" (%string-append x "\\"")))
    ((characterp x)
     (let ((code (char-code x)))
       (cond
         ((= code 32) "#\\\\Space")
         ((= code 10) "#\\\\Newline")
         ((= code 9) "#\\\\Tab")
         (t (%string-append "#\\\\" (%char-to-string x))))))
    ((symbolp x) (send x :asString))
    ((consp x)
     (%string-append "("
       (%string-append (prin1-to-string (car x))
                       (%format-list-tail (cdr x) t))))
    ((vectorp x) (%format-vector x t))
    (t (%string-append "#<" (%string-append (send x :clTypeName) ">")))))

(defun make-string-output-stream ()
  (cons '%string-stream ""))

(defun %string-stream-p (stream)
  (if (consp stream)
      (eq (car stream) '%string-stream)
      nil))

(defun write-string (str &optional stream)
  (if (%string-stream-p stream)
      (progn (rplacd stream (%string-append (cdr stream) str)) str)
      str))

(defun write-char (ch &optional stream)
  (write-string (%char-to-string ch) stream)
  ch)

(defun terpri (&optional stream)
  (write-string "\\n" stream)
  nil)

(defun princ (obj &optional stream)
  (write-string (princ-to-string obj) stream)
  obj)

(defun prin1 (obj &optional stream)
  (write-string (prin1-to-string obj) stream)
  obj)

(defun get-output-stream-string (stream)
  (if (%string-stream-p stream)
      (let ((res (cdr stream)))
        (rplacd stream "")
        res)
      ""))

(defun %format-directive-kind (dir)
  (let ((c (char-code dir)))
    (cond
      ((= c 65) 'a)
      ((= c 97) 'a)
      ((= c 68) 'a)
      ((= c 100) 'a)
      ((= c 83) 's)
      ((= c 115) 's)
      ((= c 37) 'newline)
      ((= c 126) 'tilde)
      (t 'other))))

(defun %format-walk (ctrl idx len args acc)
  (if (>= idx len)
      acc
      (let ((ch (char ctrl idx)))
        (if (char= ch #\\~)
            (if (< (+ idx 1) len)
                (let* ((dir (char ctrl (+ idx 1)))
                       (kind (%format-directive-kind dir)))
                  (cond
                    ((eq kind 'a)
                     (%format-walk ctrl (+ idx 2) len (cdr args)
                                   (%string-append acc (princ-to-string (car args)))))
                    ((eq kind 's)
                     (%format-walk ctrl (+ idx 2) len (cdr args)
                                   (%string-append acc (prin1-to-string (car args)))))
                    ((eq kind 'newline)
                     (%format-walk ctrl (+ idx 2) len args
                                   (%string-append acc "\\n")))
                    ((eq kind 'tilde)
                     (%format-walk ctrl (+ idx 2) len args
                                   (%string-append acc "~")))
                    (t
                     (%format-walk ctrl (+ idx 2) len args
                                   (%string-append acc (%char-to-string dir))))))
                (%format-walk ctrl (+ idx 1) len args
                              (%string-append acc "~")))
            (%format-walk ctrl (+ idx 1) len args
                          (%string-append acc (%char-to-string ch)))))))

(defun format (dest control-string &rest args)
  (let ((rendered (%format-walk control-string 0 (%string-length control-string) args "")))
    (cond
      ((null dest) rendered)
      ((%string-stream-p dest)
       (write-string rendered dest)
       nil)
      (t nil))))
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

function commonLispClassBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp class name').toUpperCase();
  return `common-lisp/class-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispClassArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp class name').toUpperCase();
  const base = `common-lisp/class/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispGenericBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp generic function name').toUpperCase();
  return `common-lisp/generic-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispGenericArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp generic function name').toUpperCase();
  const base = `common-lisp/generic/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispPackageBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp package name').toUpperCase();
  return `common-lisp/package-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispPackageArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp package name').toUpperCase();
  const base = `common-lisp/package/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispPackageNamespaceId(name) {
  const canonical = requiredText(name, 'Common Lisp package name').toUpperCase();
  return `common-lisp/package-namespace/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispSystemBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp system name').toUpperCase();
  return `common-lisp/system-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispSystemArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp system name').toUpperCase();
  const base = `common-lisp/system/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispSystemComponentArtifactId(systemName, componentPath, sourceText = null) {
  const canonical = requiredText(systemName, 'Common Lisp system name').toUpperCase();
  const pathPart = requiredText(componentPath, 'Common Lisp system component path');
  const base = `common-lisp/system-component/${base64urlEncode(utf8Encode(`${canonical}:${pathPart}`))}`;
  return sourceText ? `${base}/${base64urlEncode(utf8Encode(sourceText))}` : base;
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

function commonLispSetfBindingId(name) {
  const canonical = requiredText(name, 'Common Lisp setf expander name').toUpperCase();
  return `common-lisp/setf-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispSetfArtifactId(name, serialized = null) {
  const canonical = requiredText(name, 'Common Lisp setf expander name').toUpperCase();
  const base = `common-lisp/setf/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispReaderMacroBindingId(key) {
  const canonical = requiredText(key, 'Common Lisp reader macro key');
  return `common-lisp/reader-macro-binding/${base64urlEncode(utf8Encode(canonical))}`;
}

function commonLispReaderMacroArtifactId(key, serialized = null) {
  const canonical = requiredText(key, 'Common Lisp reader macro key');
  const base = `common-lisp/reader-macro/${base64urlEncode(utf8Encode(canonical))}`;
  return serialized ? `${base}/${base64urlEncode(utf8Encode(serialized))}` : base;
}

function commonLispFunctionBlockId(name, revisionKey = null) {
  const canonical = requiredText(name, 'Common Lisp function name').toUpperCase();
  const base = `common-lisp/function/${base64urlEncode(utf8Encode(canonical))}`;
  return revisionKey ? `${base}/rev/${revisionKey}` : base;
}

function parseSetfFunctionName(node) {
  if (
    node?.kind === 'list'
    && node.elements.length === 2
    && node.elements[0]?.kind === 'symbol'
    && stripPackagePrefix(node.elements[0].name) === 'SETF'
    && node.elements[1]?.kind === 'symbol'
    && !isNilSymbol(node.elements[1])
    && !isTSymbol(node.elements[1])
    && !node.elements[1].keyword
  ) {
    return node.elements[1].name;
  }
  return null;
}

function canonicalSetfFunctionName(readerName) {
  return `%SETF-FN:${String(readerName).toUpperCase()}`;
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
    if (ch === '#' && source[index + 1] === ':') {
      index += 2;
      let rawChars = '';
      let canonicalChars = '';
      while (index < length && !isDelimiter(source[index])) {
        rawChars += source[index];
        canonicalChars += source[index].toUpperCase();
        index += 1;
      }
      if (canonicalChars.length === 0) {
        throw new SyntaxError('invalid Common Lisp #: uninterned symbol literal');
      }
      tokens.push({
        type: 'symbol',
        name: canonicalChars,
        spelling: rawChars,
        keyword: false,
        uninterned: true,
        escaped: false,
      });
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

function makeCharAstNode(chOrCodePoint) {
  const cp = typeof chOrCodePoint === 'number'
    ? chOrCodePoint
    : String(chOrCodePoint).codePointAt(0);
  return makeListNode([
    makeSymbolNode('CODE-CHAR'),
    Object.freeze({kind: 'integer', value: String(cp)}),
  ]);
}

function extractCharFromAst(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'char') {
    const cp = Number(node.codePoint ?? node.value);
    return {char: String.fromCodePoint(cp), codePoint: cp};
  }
  if (
    node.kind === 'list'
    && node.elements.length === 2
    && node.elements[0]?.kind === 'symbol'
    && stripPackagePrefix(node.elements[0].name) === 'CODE-CHAR'
    && node.elements[1]?.kind === 'integer'
  ) {
    const cp = Number(node.elements[1].value);
    return {char: String.fromCodePoint(cp), codePoint: cp};
  }
  if (node.kind === 'string' && node.value.length === 1) {
    return {char: node.value, codePoint: node.value.codePointAt(0)};
  }
  return null;
}

function requireCharStringFromAst(node, context = 'character') {
  const info = extractCharFromAst(node);
  if (!info) {
    throw new SyntaxError(`expected a Common Lisp ${context}`);
  }
  return info.char;
}

function createCommonLispReadtable(initialReaderMacros = {}) {
  const macroCharacters = new Map();
  const dispatchMacroCharacters = new Map();
  dispatchMacroCharacters.set('#', new Map());
  const table = {
    macroCharacters,
    dispatchMacroCharacters,
  };
  if (initialReaderMacros instanceof Map) {
    for (const entry of initialReaderMacros.values()) {
      registerReaderMacroDescriptorInTable(table, entry);
    }
  } else if (initialReaderMacros && typeof initialReaderMacros === 'object') {
    for (const entry of Object.values(initialReaderMacros)) {
      registerReaderMacroDescriptorInTable(table, entry);
    }
  }
  return table;
}

function registerReaderMacroDescriptorInTable(table, descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return;
  if (descriptor.kind === 'macro-char' || descriptor.kind === 'closing-delimiter') {
    const ch = descriptor.char ?? String.fromCodePoint(Number(descriptor.codePoint));
    table.macroCharacters.set(ch, descriptor);
  } else if (descriptor.kind === 'dispatch-macro-char') {
    const disp = descriptor.dispChar ?? '#';
    const sub = String(descriptor.subChar).toUpperCase();
    if (!table.dispatchMacroCharacters.has(disp)) {
      table.dispatchMacroCharacters.set(disp, new Map());
    }
    table.dispatchMacroCharacters.get(disp).set(sub, descriptor);
  }
}

function isClosingParenGetMacroCharacterForm(form) {
  if (
    form?.kind === 'list'
    && form.elements.length >= 2
    && form.elements[0]?.kind === 'symbol'
    && stripPackagePrefix(form.elements[0].name) === 'GET-MACRO-CHARACTER'
  ) {
    const chInfo = extractCharFromAst(form.elements[1]);
    return Boolean(chInfo && chInfo.char === ')');
  }
  return false;
}

function parseTopLevelReaderMacroForm(form, macroContext = null) {
  if (form?.kind !== 'list' || form.elements.length < 3 || form.elements[0]?.kind !== 'symbol') {
    return null;
  }
  const headName = stripPackagePrefix(form.elements[0].name);
  const snapshotFunctions = {};
  if (macroContext?.userFunctions instanceof Map) {
    for (const [fnName, fnDef] of macroContext.userFunctions.entries()) {
      snapshotFunctions[fnName] = fnDef;
    }
  }
  if (headName === 'SET-MACRO-CHARACTER') {
    const [, charForm, handlerForm, nonTermForm] = form.elements;
    const chInfo = extractCharFromAst(charForm);
    if (!chInfo) {
      throw new SyntaxError('Common Lisp SET-MACRO-CHARACTER requires a character designator');
    }
    const key = `CHAR:${chInfo.codePoint}`;
    if (isClosingParenGetMacroCharacterForm(handlerForm)) {
      return Object.freeze({
        kind: 'closing-delimiter',
        key,
        char: chInfo.char,
        codePoint: chInfo.codePoint,
        nonTerminatingP: false,
        handlerForm: null,
        helperFunctions: snapshotFunctions,
      });
    }
    return Object.freeze({
      kind: 'macro-char',
      key,
      char: chInfo.char,
      codePoint: chInfo.codePoint,
      nonTerminatingP: Boolean(nonTermForm && !isNilSymbol(nonTermForm)),
      handlerForm,
      helperFunctions: snapshotFunctions,
    });
  }
  if (headName === 'SET-DISPATCH-MACRO-CHARACTER') {
    if (form.elements.length < 4) {
      throw new SyntaxError('Common Lisp SET-DISPATCH-MACRO-CHARACTER requires disp-char, sub-char, and handler');
    }
    const [, dispCharForm, subCharForm, handlerForm] = form.elements;
    const dispInfo = extractCharFromAst(dispCharForm);
    const subInfo = extractCharFromAst(subCharForm);
    if (!dispInfo || !subInfo) {
      throw new SyntaxError('Common Lisp SET-DISPATCH-MACRO-CHARACTER requires character designators');
    }
    const subUpper = subInfo.char.toUpperCase();
    const key = `DISP:${dispInfo.codePoint}:${subUpper.codePointAt(0)}`;
    return Object.freeze({
      kind: 'dispatch-macro-char',
      key,
      dispChar: dispInfo.char,
      dispCodePoint: dispInfo.codePoint,
      subChar: subUpper,
      subCodePoint: subUpper.codePointAt(0),
      nonTerminatingP: false,
      handlerForm,
      helperFunctions: snapshotFunctions,
    });
  }
  return null;
}

function invokeReaderMacroHandler(descriptor, argNodes, macroContext) {
  if (descriptor.kind === 'closing-delimiter') {
    throw new SyntaxError(`unexpected ${descriptor.char} in Common Lisp source`);
  }
  if (typeof descriptor.handler === 'function') {
    return descriptor.handler(...argNodes);
  }
  if (descriptor.helperFunctions && macroContext?.userFunctions instanceof Map) {
    for (const [fnName, fnDef] of Object.entries(descriptor.helperFunctions)) {
      if (!macroContext.userFunctions.has(fnName)) {
        macroContext.userFunctions.set(fnName, fnDef);
      }
    }
  }
  const env = new Map();
  let fnForm = descriptor.handlerForm;
  if (
    fnForm?.kind === 'list'
    && fnForm.elements.length === 2
    && fnForm.elements[0]?.kind === 'symbol'
    && (fnForm.elements[0].name === 'FUNCTION' || fnForm.elements[0].name === 'QUOTE')
  ) {
    fnForm = fnForm.elements[1];
  }
  if (fnForm?.kind === 'symbol') {
    return evalMacroCallByName(fnForm.name, argNodes, env, macroContext);
  }
  const closure = evalMacroForm(fnForm, env, macroContext);
  if (closure && typeof closure.invoke === 'function') {
    return closure.invoke(argNodes);
  }
  throw new SyntaxError('invalid Common Lisp reader macro handler function');
}

function applyTopLevelReaderMacroRegistrations(form, readtable, macroContext) {
  if (!form || form.kind !== 'list' || form.elements.length === 0 || form.elements[0]?.kind !== 'symbol') {
    return;
  }
  const headName = stripPackagePrefix(form.elements[0].name);
  if (headName === 'PROGN' || headName === 'EVAL-WHEN') {
    const startIdx = headName === 'EVAL-WHEN' ? 2 : 1;
    for (let i = startIdx; i < form.elements.length; i += 1) {
      applyTopLevelReaderMacroRegistrations(form.elements[i], readtable, macroContext);
    }
    return;
  }
  if (headName === 'DEFMACRO' && form.elements.length >= 3 && form.elements[1]?.kind === 'symbol') {
    const defmacro = parseTopLevelDefmacro(form);
    if (defmacro && macroContext?.userMacros instanceof Map) {
      macroContext.userMacros.set(defmacro.name, defmacro);
    }
    return;
  }
  if (headName === 'DEFUN' && form.elements.length >= 3 && form.elements[1]?.kind === 'symbol') {
    if (macroContext?.userFunctions instanceof Map) {
      macroContext.userFunctions.set(form.elements[1].name, {
        name: form.elements[1].name,
        lambdaList: form.elements[2],
        bodyForms: form.elements.slice(3),
      });
    }
    return;
  }
  const rm = parseTopLevelReaderMacroForm(form, macroContext);
  if (rm) {
    registerReaderMacroDescriptorInTable(readtable, rm);
    if (macroContext?.readerMacros instanceof Map) {
      macroContext.readerMacros.set(rm.key, rm);
    }
  }
}

function parseCharacterSpecCodePoint(charSpec) {
  if (charSpec.length === 1) {
    return charSpec.codePointAt(0);
  }
  const upper = charSpec.toUpperCase();
  if (upper === 'SPACE') return 32;
  if (upper === 'NEWLINE' || upper === 'LINEFEED') return 10;
  if (upper === 'TAB') return 9;
  if (upper === 'RETURN') return 13;
  if (upper === 'NULL' || upper === 'NUL') return 0;
  if (upper === 'BACKSPACE') return 8;
  if (upper === 'PAGE') return 12;
  if (upper === 'ESCAPE' || upper === 'ESC') return 27;
  throw new SyntaxError(`unknown Common Lisp character name: #\\${charSpec}`);
}

function readCommonLispSource(source, options = {}) {
  if (typeof source !== 'string') {
    throw new SyntaxError('Common Lisp source must be a string');
  }
  const macroContext = options?.userMacros instanceof Map
    ? options
    : options?.macroContext?.userMacros instanceof Map
      ? options.macroContext
      : createMacroContext(options);
  const readtable = options?.readtable
    ?? macroContext.readtable
    ?? createCommonLispReadtable(options?.readerMacros ?? macroContext.readerMacros ?? {});
  macroContext.readtable = readtable;

  let index = 0;
  const length = source.length;
  const unreadStack = [];
  const activeDelimiters = new Set();

  function peekRawChar() {
    if (unreadStack.length > 0) return unreadStack[unreadStack.length - 1];
    return index < length ? source[index] : undefined;
  }

  function peekSecondRawChar() {
    if (unreadStack.length >= 2) return unreadStack[unreadStack.length - 2];
    if (unreadStack.length === 1) return index < length ? source[index] : undefined;
    return index + 1 < length ? source[index + 1] : undefined;
  }

  function readRawChar() {
    if (unreadStack.length > 0) return unreadStack.pop();
    if (index >= length) return undefined;
    const ch = source[index];
    index += 1;
    return ch;
  }

  function unreadChar(ch) {
    unreadStack.push(ch);
  }

  function isStreamDelimiter(ch) {
    if (isDelimiter(ch) || activeDelimiters.has(ch)) return true;
    const macroEntry = readtable.macroCharacters.get(ch);
    if (macroEntry && !macroEntry.nonTerminatingP) return true;
    return false;
  }

  function skipWhitespaceAndComments() {
    while (peekRawChar() !== undefined) {
      const ch = peekRawChar();
      if (isWhitespace(ch)) {
        readRawChar();
        continue;
      }
      if (ch === ';') {
        while (peekRawChar() !== undefined && peekRawChar() !== '\n') {
          readRawChar();
        }
        continue;
      }
      if (ch === '#' && peekSecondRawChar() === '|') {
        readRawChar();
        readRawChar();
        let depth = 1;
        while (peekRawChar() !== undefined && depth > 0) {
          const c1 = readRawChar();
          if (c1 === '#' && peekRawChar() === '|') {
            readRawChar();
            depth += 1;
          } else if (c1 === '|' && peekRawChar() === '#') {
            readRawChar();
            depth -= 1;
          }
        }
        if (depth > 0) {
          throw new SyntaxError('unterminated Common Lisp #| ... |# block comment');
        }
        continue;
      }
      break;
    }
  }

  const streamAstNode = Object.freeze({
    kind: 'reader-stream',
    readRawChar,
    peekRawChar,
    unreadChar,
    skipWhitespaceAndComments,
    readForm(opts) {
      return readFormInternal(opts);
    },
    readDelimitedList(delimChar) {
      return readDelimitedListInternal(delimChar);
    },
  });

  function readDelimitedListInternal(delimChar) {
    const hadDelim = activeDelimiters.has(delimChar);
    activeDelimiters.add(delimChar);
    const prevStream = macroContext.activeReaderStream;
    macroContext.activeReaderStream = streamAstNode;
    try {
      const elements = [];
      for (;;) {
        skipWhitespaceAndComments();
        const ch = peekRawChar();
        if (ch === undefined) {
          throw new SyntaxError(`unterminated Common Lisp delimited list waiting for ${delimChar}`);
        }
        if (ch === delimChar) {
          readRawChar();
          return makeListNode(elements);
        }
        const item = readFormInternal({allowDotToken: false});
        if (item?.kind === 'macro-no-values') continue;
        elements.push(item);
      }
    } finally {
      if (!hadDelim) activeDelimiters.delete(delimChar);
      macroContext.activeReaderStream = prevStream;
    }
  }

  function readSymbolOrNumberToken() {
    let rawChars = '';
    let canonicalChars = '';
    let hasEscape = false;
    while (peekRawChar() !== undefined && !isStreamDelimiter(peekRawChar())) {
      const cur = readRawChar();
      if (cur === '|') {
        hasEscape = true;
        let closedPipe = false;
        while (peekRawChar() !== undefined) {
          const pc = readRawChar();
          if (pc === '|') {
            closedPipe = true;
            break;
          }
          if (pc === '\\') {
            const esc = readRawChar();
            if (esc === undefined) {
              throw new SyntaxError('unterminated pipe escape in Common Lisp symbol');
            }
            rawChars += esc;
            canonicalChars += esc;
          } else {
            rawChars += pc;
            canonicalChars += pc;
          }
        }
        if (!closedPipe) {
          throw new SyntaxError('unterminated |...| symbol in Common Lisp source');
        }
      } else if (cur === '\\') {
        hasEscape = true;
        const esc = readRawChar();
        if (esc === undefined) {
          throw new SyntaxError('unterminated character escape in Common Lisp symbol');
        }
        rawChars += esc;
        canonicalChars += esc;
      } else {
        rawChars += cur;
        canonicalChars += cur.toUpperCase();
      }
    }
    return {rawChars, canonicalChars, hasEscape};
  }

  function readFormInternal({eofErrorP = true, eofValue = NIL_NODE, allowDotToken = false} = {}) {
    for (;;) {
      skipWhitespaceAndComments();
      const ch = peekRawChar();
      if (ch === undefined) {
        if (eofErrorP) {
          throw new SyntaxError('unexpected end of Common Lisp input');
        }
        return eofValue;
      }

      if (readtable.macroCharacters.has(ch)) {
        readRawChar();
        const entry = readtable.macroCharacters.get(ch);
        const prevStream = macroContext.activeReaderStream;
        macroContext.activeReaderStream = streamAstNode;
        try {
          const result = invokeReaderMacroHandler(
            entry,
            [streamAstNode, makeCharAstNode(ch)],
            macroContext,
          );
          if (result?.kind === 'macro-no-values') continue;
          return result;
        } finally {
          macroContext.activeReaderStream = prevStream;
        }
      }

      if (readtable.dispatchMacroCharacters.has(ch)) {
        const dispChar = readRawChar();
        let numDigits = '';
        while (peekRawChar() !== undefined && /^[0-9]$/.test(peekRawChar())) {
          numDigits += readRawChar();
        }
        const infixArg = numDigits.length > 0 ? makeIntNode(BigInt(numDigits)) : NIL_NODE;
        const subCh = readRawChar();
        if (subCh === undefined) {
          throw new SyntaxError(`unexpected end of Common Lisp input after ${dispChar}`);
        }
        const dispMap = readtable.dispatchMacroCharacters.get(dispChar);
        if (dispMap && dispMap.has(subCh.toUpperCase())) {
          const dispEntry = dispMap.get(subCh.toUpperCase());
          const prevStream = macroContext.activeReaderStream;
          macroContext.activeReaderStream = streamAstNode;
          try {
            const result = invokeReaderMacroHandler(
              dispEntry,
              [streamAstNode, makeCharAstNode(subCh), infixArg],
              macroContext,
            );
            if (result?.kind === 'macro-no-values') continue;
            return result;
          } finally {
            macroContext.activeReaderStream = prevStream;
          }
        }

        if (dispChar === '#') {
          if (subCh === '\'') {
            return makeListNode([makeSymbolNode('FUNCTION'), readFormInternal()]);
          }
          if (subCh === '(') {
            const elements = [];
            for (;;) {
              skipWhitespaceAndComments();
              const nextCh = peekRawChar();
              if (nextCh === undefined) {
                throw new SyntaxError('unterminated #(...) vector literal in Common Lisp source');
              }
              if (nextCh === ')') {
                readRawChar();
                break;
              }
              elements.push(makeListNode([makeSymbolNode('QUOTE'), readFormInternal()]));
            }
            return makeListNode([makeSymbolNode('VECTOR'), ...elements]);
          }
          if (subCh === ':') {
            let rawChars = '';
            let canonicalChars = '';
            while (peekRawChar() !== undefined && !isStreamDelimiter(peekRawChar())) {
              const c = readRawChar();
              rawChars += c;
              canonicalChars += c.toUpperCase();
            }
            if (canonicalChars.length === 0) {
              throw new SyntaxError('invalid Common Lisp #: uninterned symbol literal');
            }
            return makeSymbolNode(canonicalChars, {spelling: rawChars, keyword: false});
          }
          if (subCh === '\\') {
            const firstChar = readRawChar();
            if (firstChar === undefined) {
              throw new SyntaxError('unterminated #\\ character literal in Common Lisp source');
            }
            let restChars = '';
            while (peekRawChar() !== undefined && !isStreamDelimiter(peekRawChar())) {
              restChars += readRawChar();
            }
            const codePoint = parseCharacterSpecCodePoint(firstChar + restChars);
            return makeCharAstNode(codePoint);
          }
          if (/^[xXbBoO]$/.test(subCh)) {
            const radixChar = subCh.toLowerCase();
            const prefix = radixChar === 'x' ? '0x' : radixChar === 'b' ? '0b' : '0o';
            let sign = 1n;
            if (peekRawChar() === '+' || peekRawChar() === '-') {
              if (readRawChar() === '-') sign = -1n;
            }
            let digits = '';
            while (peekRawChar() !== undefined && !isStreamDelimiter(peekRawChar())) {
              digits += readRawChar();
            }
            if (digits.length === 0) {
              throw new SyntaxError(`invalid Common Lisp #${radixChar} integer literal`);
            }
            let parsed;
            try {
              parsed = sign * BigInt(`${prefix}${digits}`);
            } catch (error) {
              throw new SyntaxError(`invalid Common Lisp #${radixChar}${digits} integer literal`, {cause: error});
            }
            return Object.freeze({kind: 'integer', value: parsed.toString(10)});
          }
        }
        throw new SyntaxError(`unknown Common Lisp dispatch character: ${dispChar}${numDigits}${subCh}`);
      }

      if (ch === '\'') {
        readRawChar();
        return makeListNode([makeSymbolNode('QUOTE'), readFormInternal()]);
      }
      if (ch === '`') {
        readRawChar();
        return expandQuasiquote(readFormInternal());
      }
      if (ch === ',') {
        readRawChar();
        if (peekRawChar() === '@') {
          readRawChar();
          return Object.freeze({kind: 'unquote-splicing', expr: readFormInternal()});
        }
        return Object.freeze({kind: 'unquote', expr: readFormInternal()});
      }
      if (ch === '"') {
        readRawChar();
        let chars = '';
        let closed = false;
        while (peekRawChar() !== undefined) {
          const cur = readRawChar();
          if (cur === '"') {
            closed = true;
            break;
          }
          if (cur === '\\') {
            const esc = readRawChar();
            if (esc === undefined) {
              throw new SyntaxError('unterminated string escape in Common Lisp source');
            }
            if (esc === 'n') chars += '\n';
            else if (esc === 't') chars += '\t';
            else if (esc === 'r') chars += '\r';
            else chars += esc;
          } else {
            chars += cur;
          }
        }
        if (!closed) {
          throw new SyntaxError('unterminated string literal in Common Lisp source');
        }
        return Object.freeze({kind: 'string', value: chars});
      }
      if (ch === '(') {
        readRawChar();
        const elements = [];
        let dottedTail = null;
        for (;;) {
          skipWhitespaceAndComments();
          const nextCh = peekRawChar();
          if (nextCh === undefined) {
            throw new SyntaxError('unterminated list in Common Lisp source');
          }
          if (nextCh === ')') {
            readRawChar();
            break;
          }
          const item = readFormInternal({allowDotToken: true});
          if (item?.kind === 'macro-no-values') continue;
          if (item?.kind === 'dot-token') {
            if (elements.length === 0) {
              throw new SyntaxError('Common Lisp dotted pair cannot begin with .');
            }
            dottedTail = readFormInternal({allowDotToken: false});
            skipWhitespaceAndComments();
            if (peekRawChar() !== ')') {
              throw new SyntaxError('Common Lisp dotted pair must have exactly one form after .');
            }
            readRawChar();
            break;
          }
          elements.push(item);
        }
        return makeListNode(elements, dottedTail);
      }
      if (ch === ')') {
        readRawChar();
        throw new SyntaxError('unexpected ) in Common Lisp source');
      }

      const {rawChars, canonicalChars, hasEscape} = readSymbolOrNumberToken();
      if (!hasEscape && rawChars === '.') {
        if (allowDotToken) {
          return Object.freeze({kind: 'dot-token'});
        }
        throw new SyntaxError('unexpected . in Common Lisp source');
      }
      if (!hasEscape && /^[+-]?[0-9]+$/.test(rawChars)) {
        return Object.freeze({kind: 'integer', value: BigInt(rawChars).toString(10)});
      }
      const isKeyword = canonicalChars.startsWith(':') && canonicalChars.length > 1;
      const spelling = isKeyword ? rawChars.slice(1) : rawChars;
      return makeSymbolNode(canonicalChars, {spelling, keyword: isKeyword});
    }
  }

  const forms = [];
  for (;;) {
    skipWhitespaceAndComments();
    if (peekRawChar() === undefined) break;
    const form = readFormInternal({eofErrorP: false, eofValue: null});
    if (form === null || form?.kind === 'macro-no-values') continue;
    if (form.kind === 'unquote' || form.kind === 'unquote-splicing') {
      throw new SyntaxError('Common Lisp unquote (, or ,@) outside backquote');
    }
    applyTopLevelReaderMacroRegistrations(form, readtable, macroContext);
    forms.push(form);
  }
  return Object.freeze(forms);
}

function formatCommonLispForm(form) {
  if (!form || typeof form !== 'object') return 'NIL';
  switch (form.kind) {
    case 'integer':
      return String(form.value);
    case 'string':
      return JSON.stringify(String(form.value));
    case 'symbol':
      return form.name;
    case 'list': {
      const elems = (form.elements ?? []).map(formatCommonLispForm);
      if (form.dottedTail) {
        return `(${elems.join(' ')} . ${formatCommonLispForm(form.dottedTail)})`;
      }
      return `(${elems.join(' ')})`;
    }
    default:
      return 'NIL';
  }
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
          keyword: `:${stripPackagePrefix(item.name)}`,
          initForm: NIL_NODE,
          suppliedP: null,
        });
      } else if (item?.kind === 'list' && item.elements.length >= 1) {
        const first = item.elements[0];
        let varName;
        let kwName;
        if (first?.kind === 'symbol') {
          varName = first.name;
          kwName = `:${stripPackagePrefix(first.name)}`;
        } else if (
          first?.kind === 'list'
          && first.elements.length === 2
          && first.elements[0]?.kind === 'symbol'
          && first.elements[1]?.kind === 'symbol'
        ) {
          kwName = first.elements[0].name.startsWith(':')
            ? first.elements[0].name
            : `:${stripPackagePrefix(first.elements[0].name)}`;
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

function stripPackagePrefix(rawName) {
  const s = String(rawName);
  const dbl = s.indexOf('::');
  if (dbl >= 0) return s.slice(dbl + 2);
  const sgl = s.indexOf(':');
  if (sgl > 0) return s.slice(sgl + 1);
  return s;
}

function createMacroContext({
  macros = {},
  structs = {},
  classes = {},
  functionSignatures = {},
  setfExpanders = {},
  readerMacros = {},
  userFunctions = {},
  localSetfFunctions = new Set(),
  readtable = null,
  activeReaderStream = null,
} = {}) {
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
  const classMap = new Map();
  for (const [k, v] of Object.entries(classes)) {
    classMap.set(k.toUpperCase(), v);
  }
  const sigMap = new Map();
  for (const [k, v] of Object.entries(functionSignatures)) {
    sigMap.set(k.toUpperCase(), v);
  }
  const setfMap = new Map();
  for (const [k, v] of Object.entries(setfExpanders)) {
    setfMap.set(k.toUpperCase(), v);
  }
  const fnMap = new Map();
  for (const [k, v] of Object.entries(userFunctions)) {
    fnMap.set(k.toUpperCase(), v);
  }
  const effectiveReadtable = readtable ?? createCommonLispReadtable(readerMacros);
  let gensymCounter = 0;
  return {
    userMacros,
    structs: structMap,
    classes: classMap,
    functionSignatures: sigMap,
    setfExpanders: setfMap,
    userFunctions: fnMap,
    localSetfFunctions: localSetfFunctions instanceof Set ? new Set(localSetfFunctions) : new Set(),
    readtable: effectiveReadtable,
    activeReaderStream,
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

function normalizeFunctionDefinition(name, paramForm, bodyForms, ctx, blockName = name) {
  const parsed = parseLambdaList(paramForm);
  let wrappedBody = [...bodyForms];
  if (blockName && containsReturnFrom(wrappedBody, blockName)) {
    wrappedBody = [makeListNode([makeSymbolNode('BLOCK'), makeSymbolNode(blockName), ...wrappedBody])];
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
    case 'DECLARE':
      return NIL_NODE;
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
    case 'FLET':
    case 'LABELS': {
      const [defsForm, ...bodyForms] = args;
      const defs = isNilSymbol(defsForm) ? [] : defsForm?.kind === 'list' ? defsForm.elements : [];
      const childEnv = new Map(env);
      const closureEnv = head.name === 'LABELS' ? childEnv : env;
      for (const def of defs) {
        if (def?.kind === 'list' && def.elements.length >= 2 && def.elements[0]?.kind === 'symbol') {
          const [fnSym, paramForm, ...fnBody] = def.elements;
          childEnv.set(fnSym.name, {
            kind: 'macro-closure',
            invoke(callArgs) {
              const callEnv = new Map(closureEnv);
              bindMacroLambdaList(paramForm, callArgs, callEnv, ctx);
              return evalMacroSequence(fnBody, callEnv, ctx);
            },
          });
        }
      }
      return evalMacroSequence(bodyForms, childEnv, ctx);
    }
    case 'BLOCK': {
      const [blockSym, ...bodyForms] = args;
      const blockName = blockSym?.kind === 'symbol' ? blockSym.name : 'NIL';
      try {
        return evalMacroSequence(bodyForms, env, ctx);
      } catch (err) {
        if (err && err.__clMacroReturnFrom && err.blockName === blockName) {
          return err.value;
        }
        throw err;
      }
    }
    case 'RETURN-FROM': {
      const [blockSym, valForm = NIL_NODE] = args;
      const blockName = blockSym?.kind === 'symbol' ? blockSym.name : 'NIL';
      const value = evalMacroForm(valForm, env, ctx);
      throw {__clMacroReturnFrom: true, blockName, value};
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
      const setfReader = parseSetfFunctionName(target);
      if (setfReader) {
        const canonName = canonicalSetfFunctionName(setfReader);
        if (env.has(canonName)) return env.get(canonName);
        return {
          kind: 'macro-closure',
          invoke(callArgs) {
            return evalMacroCallByName(canonName, callArgs, env, ctx);
          },
        };
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
  if (ctx?.userFunctions?.has(name)) {
    const fnDef = ctx.userFunctions.get(name);
    const callEnv = new Map();
    bindMacroLambdaList(fnDef.lambdaList ?? fnDef.paramListForm ?? fnDef.paramForm, evalArgs, callEnv, ctx);
    try {
      return evalMacroSequence(fnDef.bodyForms, callEnv, ctx);
    } catch (err) {
      if (err && err.__clMacroReturnFrom && (err.blockName === name || err.blockName === fnDef.blockName)) {
        return err.value;
      }
      throw err;
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
    case 'VALUES': {
      if (evalArgs.length === 0) {
        return {kind: 'macro-no-values', values: []};
      }
      return evalArgs[0];
    }
    case '%VALUES':
    case 'VALUES-LIST': {
      const listArg = evalArgs[0];
      if (!listArg || isNilSymbol(listArg) || (listArg.kind === 'list' && listArg.elements.length === 0)) {
        return {kind: 'macro-no-values', values: []};
      }
      if (listArg.kind === 'list') {
        return listArg.elements[0] ?? NIL_NODE;
      }
      return listArg;
    }
    case 'CONS':
      return astCons(evalArgs[0], evalArgs[1]);
    case 'LIST':
      return makeListNode(evalArgs);
    case 'VECTOR':
      return makeListNode([makeSymbolNode('VECTOR'), ...evalArgs]);
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
    case 'SUBSEQ': {
      const seq = evalArgs[0];
      const start = Number(evalArgs[1]?.value ?? 0);
      const end = evalArgs.length >= 3 && !isNilSymbol(evalArgs[2]) ? Number(evalArgs[2].value) : undefined;
      if (seq?.kind === 'string') {
        return Object.freeze({kind: 'string', value: seq.value.slice(start, end)});
      }
      if (isNilSymbol(seq)) return NIL_NODE;
      if (seq?.kind === 'list') {
        return makeListNode(seq.elements.slice(start, end));
      }
      throw new SyntaxError('SUBSEQ in macro expansion expected a list or string');
    }
    case 'REVERSE': {
      const seq = evalArgs[0];
      if (isNilSymbol(seq)) return NIL_NODE;
      if (seq?.kind === 'list') return makeListNode([...seq.elements].reverse());
      if (seq?.kind === 'string') {
        return Object.freeze({kind: 'string', value: [...seq.value].reverse().join('')});
      }
      throw new SyntaxError('REVERSE in macro expansion expected a list or string');
    }
    case 'MAPCAR': {
      const [fnObj, listArg] = evalArgs;
      if (isNilSymbol(listArg)) return NIL_NODE;
      if (listArg?.kind !== 'list') {
        throw new SyntaxError('MAPCAR in macro expansion requires a list');
      }
      const invokeOne = (el) => {
        if (typeof fnObj?.invoke === 'function') return fnObj.invoke([el]);
        if (fnObj?.kind === 'symbol') return evalMacroCallByName(fnObj.name, [el], env, ctx);
        throw new SyntaxError('MAPCAR in macro expansion requires a function');
      };
      return makeListNode(listArg.elements.map(invokeOne));
    }
    case 'FUNCALL': {
      const [fnObj, ...callArgs] = evalArgs;
      if (typeof fnObj?.invoke === 'function') return fnObj.invoke(callArgs);
      if (fnObj?.kind === 'symbol') return evalMacroCallByName(fnObj.name, callArgs, env, ctx);
      throw new SyntaxError('invalid FUNCALL target in macro expansion');
    }
    case 'APPLY':
    case '%APPLY-LIST': {
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
    case 'CHARACTERP': {
      return astBool(Boolean(extractCharFromAst(evalArgs[0])));
    }
    case 'CODE-CHAR': {
      const code = Number(evalArgs[0]?.value ?? 0);
      return makeCharAstNode(String.fromCodePoint(code));
    }
    case 'CHAR-CODE': {
      const info = extractCharFromAst(evalArgs[0]);
      if (!info) throw new SyntaxError('CHAR-CODE in macro expansion requires a character');
      return makeIntNode(BigInt(info.codePoint));
    }
    case 'CHAR=': {
      const ch1 = extractCharFromAst(evalArgs[0]);
      const ch2 = extractCharFromAst(evalArgs[1]);
      return astBool(Boolean(ch1 && ch2 && ch1.codePoint === ch2.codePoint));
    }
    case 'CHAR': {
      const str = evalArgs[0];
      const idx = Number(evalArgs[1]?.value ?? 0);
      if (str?.kind !== 'string' || idx < 0 || idx >= str.value.length) {
        throw new SyntaxError('CHAR in macro/reader expansion out of bounds');
      }
      return makeCharAstNode(str.value[idx]);
    }
    case '%STRING-APPEND': {
      const s1 = evalArgs[0]?.kind === 'string' ? evalArgs[0].value : '';
      const s2 = evalArgs[1]?.kind === 'string' ? evalArgs[1].value : '';
      return Object.freeze({kind: 'string', value: `${s1}${s2}`});
    }
    case 'PARSE-INTEGER': {
      const str = evalArgs[0]?.kind === 'string' ? evalArgs[0].value.trim() : '';
      return makeIntNode(BigInt(str));
    }
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
      const chInfo = extractCharFromAst(arg);
      if (chInfo) {
        return Object.freeze({kind: 'string', value: chInfo.char});
      }
      throw new SyntaxError(`${name} in macro expansion expected a symbol, string, or character`);
    }
    case 'INTERN': {
      const str = evalArgs[0];
      const text = str?.kind === 'string' ? str.value : str?.kind === 'symbol' ? str.name : '';
      return makeSymbolNode(text.toUpperCase(), {spelling: text});
    }
    case 'READ-CHAR': {
      const s = (evalArgs[0]?.kind === 'reader-stream' ? evalArgs[0] : null) ?? ctx?.activeReaderStream;
      if (!s) throw new SyntaxError('Common Lisp READ-CHAR requires an active reader stream');
      const eofErrorP = evalArgs.length >= 2 ? !isNilSymbol(evalArgs[1]) : true;
      const eofValue = evalArgs.length >= 3 ? evalArgs[2] : NIL_NODE;
      const ch = s.readRawChar();
      if (ch === undefined) {
        if (eofErrorP) throw new SyntaxError('unexpected EOF in Common Lisp READ-CHAR');
        return eofValue;
      }
      return makeCharAstNode(ch);
    }
    case 'PEEK-CHAR': {
      const peekType = evalArgs[0] ?? NIL_NODE;
      const s = (evalArgs[1]?.kind === 'reader-stream' ? evalArgs[1] : null)
        ?? (evalArgs[0]?.kind === 'reader-stream' ? evalArgs[0] : null)
        ?? ctx?.activeReaderStream;
      if (!s) throw new SyntaxError('Common Lisp PEEK-CHAR requires an active reader stream');
      const skipWs = isTSymbol(peekType);
      const eofErrorP = evalArgs.length >= 3 ? !isNilSymbol(evalArgs[2]) : true;
      const eofValue = evalArgs.length >= 4 ? evalArgs[3] : NIL_NODE;
      if (skipWs) s.skipWhitespaceAndComments();
      const ch = s.peekRawChar();
      if (ch === undefined) {
        if (eofErrorP) throw new SyntaxError('unexpected EOF in Common Lisp PEEK-CHAR');
        return eofValue;
      }
      return makeCharAstNode(ch);
    }
    case 'UNREAD-CHAR': {
      const ch = requireCharStringFromAst(evalArgs[0], 'UNREAD-CHAR argument');
      const s = (evalArgs[1]?.kind === 'reader-stream' ? evalArgs[1] : null) ?? ctx?.activeReaderStream;
      if (!s) throw new SyntaxError('Common Lisp UNREAD-CHAR requires an active reader stream');
      s.unreadChar(ch);
      return NIL_NODE;
    }
    case 'READ': {
      const first = evalArgs[0];
      if (first?.kind === 'string') {
        const parsed = readCommonLispSource(first.value, {
          readtable: ctx?.readtable,
          macroContext: ctx,
        });
        return parsed[0] ?? NIL_NODE;
      }
      const s = (first?.kind === 'reader-stream' ? first : null) ?? ctx?.activeReaderStream;
      if (!s) throw new SyntaxError('Common Lisp READ requires an active reader stream or string');
      return s.readForm();
    }
    case 'READ-DELIMITED-LIST': {
      const delimChar = requireCharStringFromAst(evalArgs[0], 'READ-DELIMITED-LIST delimiter');
      const s = (evalArgs[1]?.kind === 'reader-stream' ? evalArgs[1] : null) ?? ctx?.activeReaderStream;
      if (!s) throw new SyntaxError('Common Lisp READ-DELIMITED-LIST requires an active reader stream');
      return s.readDelimitedList(delimChar);
    }
    case 'GET-MACRO-CHARACTER': {
      const ch = requireCharStringFromAst(evalArgs[0], 'GET-MACRO-CHARACTER argument');
      const entry = ctx?.readtable?.macroCharacters?.get(ch);
      if (!entry) return NIL_NODE;
      return T_NODE;
    }
    case 'GET-DISPATCH-MACRO-CHARACTER': {
      const dispChar = requireCharStringFromAst(evalArgs[0], 'GET-DISPATCH-MACRO-CHARACTER disp-char');
      const subChar = requireCharStringFromAst(evalArgs[1], 'GET-DISPATCH-MACRO-CHARACTER sub-char').toUpperCase();
      const subMap = ctx?.readtable?.dispatchMacroCharacters?.get(dispChar);
      const entry = subMap?.get(subChar);
      if (!entry) return NIL_NODE;
      return T_NODE;
    }
    case 'SET-MACRO-CHARACTER': {
      const chInfo = extractCharFromAst(evalArgs[0]);
      if (!chInfo) throw new SyntaxError('SET-MACRO-CHARACTER requires a character');
      const fnArg = evalArgs[1];
      const nonTerm = evalArgs.length >= 3 && !isNilSymbol(evalArgs[2]);
      let handler = null;
      if (typeof fnArg?.invoke === 'function') {
        handler = (...a) => fnArg.invoke(a);
      }
      if (ctx?.readtable) {
        ctx.readtable.macroCharacters.set(chInfo.char, {
          kind: 'macro-char',
          char: chInfo.char,
          codePoint: chInfo.codePoint,
          nonTerminatingP: nonTerm,
          handler,
          handlerForm: fnArg?.kind === 'symbol' ? makeListNode([makeSymbolNode('FUNCTION'), fnArg]) : null,
        });
      }
      return T_NODE;
    }
    case 'SET-DISPATCH-MACRO-CHARACTER': {
      const dispInfo = extractCharFromAst(evalArgs[0]);
      const subInfo = extractCharFromAst(evalArgs[1]);
      if (!dispInfo || !subInfo) throw new SyntaxError('SET-DISPATCH-MACRO-CHARACTER requires characters');
      const subChar = subInfo.char.toUpperCase();
      const fnArg = evalArgs[2];
      let handler = null;
      if (typeof fnArg?.invoke === 'function') {
        handler = (...a) => fnArg.invoke(a);
      }
      if (ctx?.readtable) {
        if (!ctx.readtable.dispatchMacroCharacters.has(dispInfo.char)) {
          ctx.readtable.dispatchMacroCharacters.set(dispInfo.char, new Map());
        }
        ctx.readtable.dispatchMacroCharacters.get(dispInfo.char).set(subChar, {
          kind: 'dispatch-macro-char',
          dispChar: dispInfo.char,
          subChar,
          nonTerminatingP: false,
          handler,
          handlerForm: fnArg?.kind === 'symbol' ? makeListNode([makeSymbolNode('FUNCTION'), fnArg]) : null,
        });
      }
      return T_NODE;
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
    case 'SLOT-VALUE': {
      const slotForm = args[1];
      if (
        slotForm?.kind === 'list'
        && slotForm.elements.length === 2
        && slotForm.elements[0]?.kind === 'symbol'
        && slotForm.elements[0].name === 'QUOTE'
        && slotForm.elements[1]?.kind === 'symbol'
      ) {
        const recvTemp = ctx.freshGensym('RECV');
        const valTemp = ctx.freshGensym('VAL');
        const varName = toCamelCaseSlotName(stripPackagePrefix(slotForm.elements[1].name));
        return makeListNode([
          makeSymbolNode('LET'),
          makeListNode([
            makeListNode([recvTemp, args[0]]),
            makeListNode([valTemp, valueForm]),
          ]),
          makeListNode([
            makeSymbolNode('SEND'),
            recvTemp,
            Object.freeze({kind: 'string', value: `${varName}:`}),
            valTemp,
          ]),
          valTemp,
        ]);
      }
      return makeListNode([makeSymbolNode('%SET-SLOT-VALUE'), args[0], slotForm, valueForm]);
    }
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
      if (ctx?.localSetfFunctions?.has(head.name)) {
        const bindings = [];
        const canonArgs = args.map((arg, idx) => {
          if (isConstantPlaceArg(arg)) return arg;
          const t = ctx.freshGensym(`SETF_ARG_${idx}`);
          bindings.push(makeListNode([t, arg]));
          return t;
        });
        const valTemp = isConstantPlaceArg(valueForm) && bindings.length === 0
          ? valueForm
          : ctx.freshGensym('SETF_VAL');
        if (valTemp !== valueForm) {
          bindings.push(makeListNode([valTemp, valueForm]));
        }
        const callExpr = makeListNode([
          makeSymbolNode(canonicalSetfFunctionName(head.name)),
          valTemp,
          ...canonArgs,
        ]);
        return bindings.length === 0
          ? callExpr
          : makeListNode([makeSymbolNode('LET*'), makeListNode(bindings), callExpr]);
      }

      const setfExp = ctx?.setfExpanders?.get(head.name);
      if (setfExp) {
        if (setfExp.kind === 'setf-function') {
          const bindings = [];
          const canonArgs = args.map((arg, idx) => {
            if (isConstantPlaceArg(arg)) return arg;
            const t = ctx.freshGensym(`SETF_ARG_${idx}`);
            bindings.push(makeListNode([t, arg]));
            return t;
          });
          const valTemp = isConstantPlaceArg(valueForm) && bindings.length === 0
            ? valueForm
            : ctx.freshGensym('SETF_VAL');
          if (valTemp !== valueForm) {
            bindings.push(makeListNode([valTemp, valueForm]));
          }
          const callExpr = makeListNode([
            makeSymbolNode(setfExp.writerFunctionName),
            valTemp,
            ...canonArgs,
          ]);
          return bindings.length === 0
            ? callExpr
            : makeListNode([makeSymbolNode('LET*'), makeListNode(bindings), callExpr]);
        }
        if (setfExp.kind === 'defsetf-short') {
          const bindings = [];
          const canonArgs = args.map((arg, idx) => {
            if (isConstantPlaceArg(arg)) return arg;
            const t = ctx.freshGensym(`SETF_ARG_${idx}`);
            bindings.push(makeListNode([t, arg]));
            return t;
          });
          const valTemp = isConstantPlaceArg(valueForm) && bindings.length === 0
            ? valueForm
            : ctx.freshGensym('SETF_VAL');
          if (valTemp !== valueForm) {
            bindings.push(makeListNode([valTemp, valueForm]));
          }
          const callExpr = makeListNode([
            makeSymbolNode(setfExp.updateFn),
            ...canonArgs,
            valTemp,
          ]);
          return bindings.length === 0
            ? callExpr
            : makeListNode([makeSymbolNode('LET*'), makeListNode(bindings), callExpr]);
        }
        if (setfExp.kind === 'defsetf-long') {
          const bindings = [];
          const canonArgs = args.map((arg, idx) => {
            if (isConstantPlaceArg(arg)) return arg;
            const t = ctx.freshGensym(`SETF_ARG_${idx}`);
            bindings.push(makeListNode([t, arg]));
            return t;
          });
          const storeTemp = ctx.freshGensym('SETF_STORE');
          bindings.push(makeListNode([storeTemp, valueForm]));
          const env = new Map();
          bindMacroLambdaList(setfExp.lambdaList, canonArgs, env, ctx);
          for (let sIdx = 0; sIdx < setfExp.storeVars.length; sIdx += 1) {
            env.set(setfExp.storeVars[sIdx], sIdx === 0 ? storeTemp : NIL_NODE);
          }
          const expandedBody = evalMacroSequence(setfExp.bodyForms, env, ctx);
          return makeListNode([
            makeSymbolNode('LET*'),
            makeListNode(bindings),
            expandedBody,
          ]);
        }
      }

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

function isConstantPlaceArg(form) {
  if (!form) return false;
  if (form.kind === 'integer' || form.kind === 'string') return true;
  if (form.kind === 'symbol' && (isNilSymbol(form) || isTSymbol(form) || form.keyword)) return true;
  if (
    form.kind === 'list'
    && form.elements.length === 2
    && form.elements[0]?.kind === 'symbol'
    && form.elements[0].name === 'QUOTE'
  ) {
    return true;
  }
  return false;
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
  if (
    !ctx?.localSetfFunctions?.has(head.name)
    && !ctx?.setfExpanders?.has(head.name)
    && head.name !== 'SLOT-VALUE'
    && head.name !== 'SEND'
  ) {
    const expandedPlace = macroexpand1CommonLispForm(normalized, ctx);
    if (expandedPlace.expanded) {
      return withGeneralizedPlace(expandedPlace.form, ctx, buildBody);
    }
  }
  const bindings = [];
  const canonArgs = args.map((arg, idx) => {
    if (isConstantPlaceArg(arg)) return arg;
    const temp = ctx.freshGensym(`PLACE_ARG_${idx}`);
    bindings.push(makeListNode([temp, arg]));
    return temp;
  });
  const canonPlace = makeListNode([head, ...canonArgs]);
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
  APPLY(args) {
    if (args.length < 2) {
      throw new SyntaxError('Common Lisp APPLY requires a function and at least 1 argument');
    }
    const [fnForm, ...restArgs] = args;
    const listArg = restArgs.length === 1
      ? restArgs[0]
      : makeListNode([makeSymbolNode('LIST*'), ...restArgs]);
    return makeListNode([makeSymbolNode('%APPLY-LIST'), fnForm, listArg]);
  },
  '%WHILE'(args, ctx) {
    if (args.length < 1) throw new SyntaxError('Common Lisp %WHILE requires a condition');
    const [condForm, ...bodyForms] = args;
    const loopSym = ctx.freshGensym('WHILE_LOOP');
    return makeListNode([
      makeSymbolNode('LABELS'),
      makeListNode([
        makeListNode([
          loopSym,
          NIL_NODE,
          makeListNode([
            makeSymbolNode('IF'),
            condForm,
            makeListNode([makeSymbolNode('PROGN'), ...bodyForms, makeListNode([loopSym])]),
            NIL_NODE,
          ]),
        ]),
      ]),
      makeListNode([loopSym]),
    ]);
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
  'SLOT-VALUE'(args) {
    if (args.length !== 2) {
      throw new SyntaxError('Common Lisp SLOT-VALUE requires an object and a slot-name');
    }
    const [objForm, slotForm] = args;
    if (
      slotForm?.kind === 'list'
      && slotForm.elements.length === 2
      && slotForm.elements[0]?.kind === 'symbol'
      && slotForm.elements[0].name === 'QUOTE'
      && slotForm.elements[1]?.kind === 'symbol'
    ) {
      const varName = toCamelCaseSlotName(stripPackagePrefix(slotForm.elements[1].name));
      return makeListNode([
        makeSymbolNode('SEND'),
        objForm,
        Object.freeze({kind: 'string', value: varName}),
      ]);
    }
    return makeListNode([makeSymbolNode('%SLOT-VALUE'), objForm, slotForm]);
  },
  'MAKE-INSTANCE'(args) {
    if (args.length < 1) {
      throw new SyntaxError('Common Lisp MAKE-INSTANCE requires a class designator');
    }
    const [classForm, ...initargs] = args;
    if (
      classForm?.kind === 'list'
      && classForm.elements.length === 2
      && classForm.elements[0]?.kind === 'symbol'
      && classForm.elements[0].name === 'QUOTE'
      && classForm.elements[1]?.kind === 'symbol'
    ) {
      const clsName = classForm.elements[1].name;
      return makeListNode([makeSymbolNode(`%MAKE-CLASS-${clsName}`), ...initargs]);
    }
    return makeListNode([
      makeSymbolNode('%CL-MAKE-INSTANCE'),
      classForm,
      makeListNode([makeSymbolNode('LIST'), ...initargs]),
    ]);
  },
  TYPEP(args, ctx) {
    if (args.length !== 2) {
      throw new SyntaxError('Common Lisp TYPEP requires an object and a type-specifier');
    }
    const [objForm, typeForm] = args;
    if (
      typeForm?.kind === 'list'
      && typeForm.elements.length === 2
      && typeForm.elements[0]?.kind === 'symbol'
      && typeForm.elements[0].name === 'QUOTE'
    ) {
      const spec = typeForm.elements[1];
      if (spec?.kind === 'symbol') {
        const tName = stripPackagePrefix(spec.name);
        if (tName === 'T') return makeListNode([makeSymbolNode('PROGN'), objForm, T_NODE]);
        if (tName === 'NIL') return makeListNode([makeSymbolNode('PROGN'), objForm, NIL_NODE]);
        if (tName === 'NULL') return makeListNode([makeSymbolNode('NULL'), objForm]);
        if (tName === 'CONS') return makeListNode([makeSymbolNode('CONSP'), objForm]);
        if (tName === 'LIST') return makeListNode([makeSymbolNode('LISTP'), objForm]);
        if (tName === 'ATOM') return makeListNode([makeSymbolNode('ATOM'), objForm]);
        if (tName === 'SYMBOL') return makeListNode([makeSymbolNode('SYMBOLP'), objForm]);
        if (tName === 'KEYWORD') return makeListNode([makeSymbolNode('KEYWORDP'), objForm]);
        if (tName === 'INTEGER' || tName === 'NUMBER' || tName === 'FIXNUM') {
          return makeListNode([makeSymbolNode('INTEGERP'), objForm]);
        }
        if (tName === 'STRING') return makeListNode([makeSymbolNode('STRINGP'), objForm]);
        if (tName === 'CHARACTER') return makeListNode([makeSymbolNode('CHARACTERP'), objForm]);
        if (tName === 'VECTOR' || tName === 'ARRAY') {
          return makeListNode([makeSymbolNode('VECTORP'), objForm]);
        }
        if (tName === 'HASH-TABLE') return makeListNode([makeSymbolNode('HASH-TABLE-P'), objForm]);
        if (tName === 'FUNCTION') return makeListNode([makeSymbolNode('FUNCTIONP'), objForm]);
        if (tName === 'STANDARD-OBJECT') {
          return makeListNode([makeSymbolNode('%TYPEP'), objForm, typeForm]);
        }
        const tmpSym = ctx.freshGensym('TYPEP_OBJ');
        const selector = ctx?.structs?.has(spec.name)
          ? `isClStruct_${spec.name}`
          : `isClClass_${spec.name}`;
        return makeListNode([
          makeSymbolNode('LET'),
          makeListNode([makeListNode([tmpSym, objForm])]),
          makeListNode([
            makeSymbolNode('IF'),
            makeListNode([makeSymbolNode('FUNCTIONP'), tmpSym]),
            NIL_NODE,
            makeListNode([
              makeSymbolNode('IF'),
              makeListNode([
                makeSymbolNode('SEND'),
                tmpSym,
                Object.freeze({kind: 'string', value: selector}),
              ]),
              T_NODE,
              NIL_NODE,
            ]),
          ]),
        ]);
      }
      if (
        spec?.kind === 'list'
        && spec.elements.length === 2
        && spec.elements[0]?.kind === 'symbol'
        && stripPackagePrefix(spec.elements[0].name) === 'EQL'
      ) {
        return makeListNode([
          makeSymbolNode('EQL'),
          objForm,
          makeListNode([makeSymbolNode('QUOTE'), spec.elements[1]]),
        ]);
      }
    }
    return makeListNode([makeSymbolNode('%TYPEP'), objForm, typeForm]);
  },
  'RESTART-CASE'(args, ctx) {
    if (args.length < 1) {
      throw new SyntaxError('Common Lisp RESTART-CASE requires a restartable form');
    }
    const [protectedForm, ...clauses] = args;
    if (clauses.length === 0) return protectedForm;
    const rcBlock = ctx.freshGensym('RESTART_CASE_BLOCK');
    const savedSym = ctx.freshGensym('SAVED_RESTARTS');
    let restartListExpr = savedSym;
    for (let i = clauses.length - 1; i >= 0; i -= 1) {
      const clause = clauses[i];
      if (clause?.kind !== 'list' || clause.elements.length < 2 || clause.elements[0]?.kind !== 'symbol') {
        throw new SyntaxError('Common Lisp RESTART-CASE clause must be (restart-name (params...) body...)');
      }
      const [restartSym, paramList, ...restClause] = clause.elements;
      let bodyStart = 0;
      while (
        bodyStart + 1 < restClause.length
        && restClause[bodyStart]?.kind === 'symbol'
        && (restClause[bodyStart].name === ':REPORT'
          || restClause[bodyStart].name === ':INTERACTIVE'
          || restClause[bodyStart].name === ':TEST')
      ) {
        bodyStart += 2;
      }
      const clauseBody = restClause.slice(bodyStart);
      const bodyExpr = clauseBody.length > 0
        ? makeListNode([makeSymbolNode('PROGN'), ...clauseBody])
        : NIL_NODE;
      const pairExpr = makeListNode([
        makeSymbolNode('CONS'),
        makeListNode([makeSymbolNode('QUOTE'), restartSym]),
        makeListNode([
          makeSymbolNode('LAMBDA'),
          paramList,
          makeListNode([makeSymbolNode('RETURN-FROM'), rcBlock, bodyExpr]),
        ]),
      ]);
      restartListExpr = makeListNode([makeSymbolNode('CONS'), pairExpr, restartListExpr]);
    }
    const activeRestartsSym = makeSymbolNode('%ACTIVE-RESTARTS');
    return makeListNode([
      makeSymbolNode('BLOCK'),
      rcBlock,
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([makeListNode([savedSym, activeRestartsSym])]),
        makeListNode([
          makeSymbolNode('UNWIND-PROTECT'),
          makeListNode([
            makeSymbolNode('PROGN'),
            makeListNode([makeSymbolNode('SETQ'), activeRestartsSym, restartListExpr]),
            protectedForm,
          ]),
          makeListNode([makeSymbolNode('SETQ'), activeRestartsSym, savedSym]),
        ]),
      ]),
    ]);
  },
  'WITH-OUTPUT-TO-STRING'(args) {
    if (args.length < 1 || args[0]?.kind !== 'list' || args[0].elements.length < 1 || args[0].elements[0]?.kind !== 'symbol') {
      throw new SyntaxError('Common Lisp WITH-OUTPUT-TO-STRING requires (stream-var) and body');
    }
    const [varSpec, ...bodyForms] = args;
    const streamVar = varSpec.elements[0];
    return makeListNode([
      makeSymbolNode('LET'),
      makeListNode([
        makeListNode([streamVar, makeListNode([makeSymbolNode('MAKE-STRING-OUTPUT-STREAM')])]),
      ]),
      ...bodyForms,
      makeListNode([makeSymbolNode('GET-OUTPUT-STREAM-STRING'), streamVar]),
    ]);
  },
  LOOP(args, ctx) {
    return expandLoopMacro(args, ctx);
  },
  VALUES(args) {
    if (args.length === 0) {
      return makeListNode([makeSymbolNode('%VALUES'), NIL_NODE]);
    }
    return makeListNode([
      makeSymbolNode('%VALUES'),
      makeListNode([makeSymbolNode('LIST'), ...args]),
    ]);
  },
  'VALUES-LIST'(args) {
    if (args.length !== 1) {
      throw new SyntaxError('Common Lisp VALUES-LIST requires 1 list argument');
    }
    return makeListNode([makeSymbolNode('%VALUES'), args[0]]);
  },
  'MULTIPLE-VALUE-LIST'(args) {
    if (args.length !== 1) {
      throw new SyntaxError('Common Lisp MULTIPLE-VALUE-LIST requires 1 form');
    }
    return makeListNode([
      makeSymbolNode('%CAPTURE-MV'),
      makeListNode([makeSymbolNode('LAMBDA'), NIL_NODE, args[0]]),
    ]);
  },
  'MULTIPLE-VALUE-BIND'(args, ctx) {
    if (args.length < 2) {
      throw new SyntaxError('Common Lisp MULTIPLE-VALUE-BIND requires a variable list and values-form');
    }
    const [varsForm, valuesForm, ...bodyForms] = args;
    const varList = isNilSymbol(varsForm)
      ? []
      : varsForm?.kind === 'list'
        ? varsForm.elements
        : null;
    if (!varList) {
      throw new SyntaxError('Common Lisp MULTIPLE-VALUE-BIND variable list must be a list of symbols');
    }
    const mvTemp = ctx.freshGensym('MV_LIST');
    const captureExpr = makeListNode([
      makeSymbolNode('%CAPTURE-MV'),
      makeListNode([makeSymbolNode('LAMBDA'), NIL_NODE, valuesForm]),
    ]);
    if (varList.length === 0) {
      return makeListNode([makeSymbolNode('PROGN'), captureExpr, ...bodyForms]);
    }
    const bindings = [makeListNode([mvTemp, captureExpr])];
    varList.forEach((varSym, idx) => {
      if (varSym?.kind !== 'symbol' || isNilSymbol(varSym) || isTSymbol(varSym) || varSym.keyword) {
        throw new SyntaxError('Common Lisp MULTIPLE-VALUE-BIND variables must be ordinary symbols');
      }
      let extractExpr;
      if (idx === 0) {
        extractExpr = makeListNode([makeSymbolNode('CAR'), mvTemp]);
      } else if (idx === 1) {
        extractExpr = makeListNode([makeSymbolNode('CADR'), mvTemp]);
      } else if (idx === 2) {
        extractExpr = makeListNode([makeSymbolNode('THIRD'), mvTemp]);
      } else {
        extractExpr = makeListNode([makeSymbolNode('NTH'), makeIntNode(BigInt(idx)), mvTemp]);
      }
      bindings.push(makeListNode([varSym, extractExpr]));
    });
    return makeListNode([
      makeSymbolNode('LET*'),
      makeListNode(bindings),
      ...bodyForms,
    ]);
  },
  'MULTIPLE-VALUE-CALL'(args, ctx) {
    if (args.length < 1) {
      throw new SyntaxError('Common Lisp MULTIPLE-VALUE-CALL requires a function form');
    }
    const [fnForm, ...valueForms] = args;
    if (valueForms.length === 0) {
      return makeListNode([makeSymbolNode('FUNCALL'), fnForm]);
    }
    const listForms = valueForms.map((vf) =>
      makeListNode([
        makeSymbolNode('%CAPTURE-MV'),
        makeListNode([makeSymbolNode('LAMBDA'), NIL_NODE, vf]),
      ]),
    );
    let combinedListExpr = listForms[listForms.length - 1];
    for (let i = listForms.length - 2; i >= 0; i -= 1) {
      combinedListExpr = makeListNode([makeSymbolNode('APPEND'), listForms[i], combinedListExpr]);
    }
    if (
      fnForm?.kind === 'list' &&
      fnForm.elements.length === 2 &&
      fnForm.elements[0]?.kind === 'symbol' &&
      (fnForm.elements[0].name === 'FUNCTION' || fnForm.elements[0].name === 'QUOTE') &&
      fnForm.elements[1]?.kind === 'symbol'
    ) {
      const targetName = fnForm.elements[1].name;
      if (targetName === 'LIST') {
        return combinedListExpr;
      }
      if (targetName === 'VALUES') {
        return makeListNode([makeSymbolNode('%VALUES'), combinedListExpr]);
      }
      if (targetName === '+') {
        return makeListNode([
          makeSymbolNode('REDUCE'),
          makeListNode([makeSymbolNode('FUNCTION'), makeSymbolNode('+')]),
          combinedListExpr,
          makeIntNode(0n),
        ]);
      }
      if (targetName === '*') {
        return makeListNode([
          makeSymbolNode('REDUCE'),
          makeListNode([makeSymbolNode('FUNCTION'), makeSymbolNode('*')]),
          combinedListExpr,
          makeIntNode(1n),
        ]);
      }
    }
    const fnTemp = ctx.freshGensym('MVC_FN');
    return makeListNode([
      makeSymbolNode('LET'),
      makeListNode([makeListNode([fnTemp, fnForm])]),
      makeListNode([makeSymbolNode('%APPLY-LIST'), fnTemp, combinedListExpr]),
    ]);
  },
  'NTH-VALUE'(args) {
    if (args.length !== 2) {
      throw new SyntaxError('Common Lisp NTH-VALUE requires an index and a form');
    }
    const [indexForm, valueForm] = args;
    return makeListNode([
      makeSymbolNode('NTH'),
      indexForm,
      makeListNode([
        makeSymbolNode('%CAPTURE-MV'),
        makeListNode([makeSymbolNode('LAMBDA'), NIL_NODE, valueForm]),
      ]),
    ]);
  },
  'MULTIPLE-VALUE-PROG1'(args, ctx) {
    if (args.length < 1) {
      throw new SyntaxError('Common Lisp MULTIPLE-VALUE-PROG1 requires at least 1 form');
    }
    if (args.length === 1) {
      return args[0];
    }
    const [firstForm, ...restForms] = args;
    const mvTemp = ctx.freshGensym('MVP1_LIST');
    return makeListNode([
      makeSymbolNode('LET'),
      makeListNode([
        makeListNode([
          mvTemp,
          makeListNode([
            makeSymbolNode('%CAPTURE-MV'),
            makeListNode([makeSymbolNode('LAMBDA'), NIL_NODE, firstForm]),
          ]),
        ]),
      ]),
      ...restForms,
      makeListNode([makeSymbolNode('%VALUES'), mvTemp]),
    ]);
  },
  'SET-MACRO-CHARACTER'(args) {
    if (args.length < 2) {
      throw new SyntaxError('Common Lisp SET-MACRO-CHARACTER requires a character and a function');
    }
    return T_NODE;
  },
  'SET-DISPATCH-MACRO-CHARACTER'(args) {
    if (args.length < 3) {
      throw new SyntaxError('Common Lisp SET-DISPATCH-MACRO-CHARACTER requires disp-char, sub-char, and function');
    }
    return T_NODE;
  },
  'GET-MACRO-CHARACTER'(args, ctx) {
    if (args.length < 1) {
      throw new SyntaxError('Common Lisp GET-MACRO-CHARACTER requires a character');
    }
    const ch = requireCharStringFromAst(args[0], 'GET-MACRO-CHARACTER argument');
    const entry = ctx?.readtable?.macroCharacters?.get(ch);
    if (!entry) {
      return makeListNode([makeSymbolNode('VALUES'), NIL_NODE, NIL_NODE]);
    }
    return makeListNode([
      makeSymbolNode('VALUES'),
      T_NODE,
      entry.nonTerminatingP ? T_NODE : NIL_NODE,
    ]);
  },
  'GET-DISPATCH-MACRO-CHARACTER'(args, ctx) {
    if (args.length < 2) {
      throw new SyntaxError('Common Lisp GET-DISPATCH-MACRO-CHARACTER requires disp-char and sub-char');
    }
    const dispChar = requireCharStringFromAst(args[0], 'GET-DISPATCH-MACRO-CHARACTER disp-char');
    const subChar = requireCharStringFromAst(args[1], 'GET-DISPATCH-MACRO-CHARACTER sub-char').toUpperCase();
    const subMap = ctx?.readtable?.dispatchMacroCharacters?.get(dispChar);
    const entry = subMap?.get(subChar);
    if (!entry) return NIL_NODE;
    return T_NODE;
  },
});

const TOP_LOOP_KEYWORDS = new Set([
  'NAMED',
  'WITH',
  'INITIALLY',
  'FINALLY',
  'FOR',
  'AS',
  'REPEAT',
  'WHILE',
  'UNTIL',
  'ALWAYS',
  'NEVER',
  'THEREIS',
  'DO',
  'DOING',
  'RETURN',
  'COLLECT',
  'COLLECTING',
  'APPEND',
  'APPENDING',
  'NCONC',
  'NCONCING',
  'SUM',
  'SUMMING',
  'COUNT',
  'COUNTING',
  'MAXIMIZE',
  'MAXIMIZING',
  'MINIMIZE',
  'MINIMIZING',
  'WHEN',
  'IF',
  'UNLESS',
]);

function loopKey(node) {
  if (!node || node.kind !== 'symbol' || isNilSymbol(node) || isTSymbol(node)) return null;
  const raw = node.name.startsWith(':') ? node.name.slice(1) : node.name;
  return stripPackagePrefix(raw);
}

function isTopLoopKeyword(node) {
  const k = loopKey(node);
  return k !== null && TOP_LOOP_KEYWORDS.has(k);
}

function expandLoopMacro(args, ctx) {
  if (args.length === 0 || args[0]?.kind === 'list') {
    return makeListNode([
      makeSymbolNode('BLOCK'),
      NIL_NODE,
      makeListNode([makeSymbolNode('%WHILE'), T_NODE, ...args]),
    ]);
  }

  let blockName = NIL_NODE;
  const outerBindings = [];
  const declaredVars = new Set();
  const initiallyForms = [];
  const finallyForms = [];
  const preChecks = [];
  const bodyStatements = [];
  const postUpdates = [];
  let defaultAccSym = null;
  const bodyExitSym = ctx.freshGensym('LOOP_BODY_EXIT');

  function declareOuter(varSym, initForm) {
    if (!declaredVars.has(varSym.name)) {
      declaredVars.add(varSym.name);
      outerBindings.push(makeListNode([varSym, initForm]));
    }
  }

  function ensureAcc(intoVar, mode) {
    const defaultInit = mode === 'sum' || mode === 'count'
      ? makeIntNode(0n)
      : mode === 'always' || mode === 'never'
        ? T_NODE
        : NIL_NODE;
    if (intoVar) {
      declareOuter(intoVar, defaultInit);
      return intoVar;
    }
    if (!defaultAccSym) {
      defaultAccSym = ctx.freshGensym('LOOP_ACC');
      declareOuter(defaultAccSym, defaultInit);
    }
    return defaultAccSym;
  }

  let i = 0;

  function parseForSingle() {
    const varSym = args[i];
    if (!varSym || varSym.kind !== 'symbol') {
      throw new SyntaxError('Common Lisp LOOP FOR requires a variable symbol');
    }
    i += 1;
    const subKey = loopKey(args[i]);
    if (subKey === 'IN' || subKey === 'ON') {
      const isOn = subKey === 'ON';
      const listForm = args[i + 1];
      i += 2;
      let stepFnForm = null;
      if (loopKey(args[i]) === 'BY') {
        stepFnForm = args[i + 1];
        i += 2;
      }
      const curSym = ctx.freshGensym('LOOP_LIST');
      declareOuter(curSym, listForm);
      declareOuter(varSym, NIL_NODE);
      preChecks.push(
        makeListNode([
          makeSymbolNode('WHEN'),
          makeListNode([makeSymbolNode('NULL'), curSym]),
          makeListNode([makeSymbolNode('RETURN-FROM'), bodyExitSym, NIL_NODE]),
        ]),
      );
      preChecks.push(
        makeListNode([
          makeSymbolNode('SETQ'),
          varSym,
          isOn ? curSym : makeListNode([makeSymbolNode('CAR'), curSym]),
        ]),
      );
      postUpdates.push(
        makeListNode([
          makeSymbolNode('SETQ'),
          curSym,
          stepFnForm
            ? makeListNode([makeSymbolNode('FUNCALL'), stepFnForm, curSym])
            : makeListNode([makeSymbolNode('CDR'), curSym]),
        ]),
      );
      return;
    }
    if (subKey === 'ACROSS') {
      const seqForm = args[i + 1];
      i += 2;
      const seqSym = ctx.freshGensym('LOOP_SEQ');
      const idxSym = ctx.freshGensym('LOOP_IDX');
      const lenSym = ctx.freshGensym('LOOP_LEN');
      declareOuter(seqSym, seqForm);
      declareOuter(idxSym, makeIntNode(0n));
      declareOuter(lenSym, makeListNode([makeSymbolNode('LENGTH'), seqSym]));
      declareOuter(varSym, NIL_NODE);
      preChecks.push(
        makeListNode([
          makeSymbolNode('WHEN'),
          makeListNode([makeSymbolNode('>='), idxSym, lenSym]),
          makeListNode([makeSymbolNode('RETURN-FROM'), bodyExitSym, NIL_NODE]),
        ]),
      );
      preChecks.push(
        makeListNode([
          makeSymbolNode('SETQ'),
          varSym,
          makeListNode([makeSymbolNode('ELT'), seqSym, idxSym]),
        ]),
      );
      postUpdates.push(
        makeListNode([
          makeSymbolNode('SETQ'),
          idxSym,
          makeListNode([makeSymbolNode('1+'), idxSym]),
        ]),
      );
      return;
    }
    if (subKey === '=') {
      const initExpr = args[i + 1];
      i += 2;
      if (loopKey(args[i]) === 'THEN') {
        const thenExpr = args[i + 1];
        i += 2;
        const firstSym = ctx.freshGensym('LOOP_FIRST');
        declareOuter(firstSym, T_NODE);
        declareOuter(varSym, NIL_NODE);
        preChecks.push(
          makeListNode([
            makeSymbolNode('IF'),
            firstSym,
            makeListNode([
              makeSymbolNode('PROGN'),
              makeListNode([makeSymbolNode('SETQ'), varSym, initExpr]),
              makeListNode([makeSymbolNode('SETQ'), firstSym, NIL_NODE]),
            ]),
            makeListNode([makeSymbolNode('SETQ'), varSym, thenExpr]),
          ]),
        );
      } else {
        declareOuter(varSym, NIL_NODE);
        preChecks.push(makeListNode([makeSymbolNode('SETQ'), varSym, initExpr]));
      }
      return;
    }

    // Numeric stepping: [FROM|UPFROM|DOWNFROM start] [TO|UPTO|BELOW|DOWNTO|ABOVE limit] [BY step]
    let startForm = makeIntNode(0n);
    let limitForm = null;
    let limitKind = null;
    let stepForm = makeIntNode(1n);
    let downward = false;
    while (i < args.length) {
      const nk = loopKey(args[i]);
      if (nk === 'FROM' || nk === 'UPFROM') {
        startForm = args[i + 1];
        i += 2;
      } else if (nk === 'DOWNFROM') {
        startForm = args[i + 1];
        downward = true;
        i += 2;
      } else if (nk === 'TO' || nk === 'UPTO') {
        limitForm = args[i + 1];
        limitKind = 'TO';
        i += 2;
      } else if (nk === 'BELOW') {
        limitForm = args[i + 1];
        limitKind = 'BELOW';
        i += 2;
      } else if (nk === 'DOWNTO') {
        limitForm = args[i + 1];
        limitKind = 'DOWNTO';
        downward = true;
        i += 2;
      } else if (nk === 'ABOVE') {
        limitForm = args[i + 1];
        limitKind = 'ABOVE';
        downward = true;
        i += 2;
      } else if (nk === 'BY') {
        stepForm = args[i + 1];
        i += 2;
      } else {
        break;
      }
    }
    declareOuter(varSym, startForm);
    if (limitForm !== null) {
      const limSym = ctx.freshGensym('LOOP_LIM');
      declareOuter(limSym, limitForm);
      const stopOp = limitKind === 'TO'
        ? '>'
        : limitKind === 'BELOW'
          ? '>='
          : limitKind === 'DOWNTO'
            ? '<'
            : '<=';
      preChecks.push(
        makeListNode([
          makeSymbolNode('WHEN'),
          makeListNode([makeSymbolNode(stopOp), varSym, limSym]),
          makeListNode([makeSymbolNode('RETURN-FROM'), bodyExitSym, NIL_NODE]),
        ]),
      );
    }
    const stepSym = ctx.freshGensym('LOOP_STEP');
    declareOuter(stepSym, stepForm);
    postUpdates.push(
      makeListNode([
        makeSymbolNode('SETQ'),
        varSym,
        makeListNode([makeSymbolNode(downward ? '-' : '+'), varSym, stepSym]),
      ]),
    );
  }

  function parseActionClause() {
    const kw = loopKey(args[i]);
    if (kw === 'DO' || kw === 'DOING') {
      i += 1;
      const doForms = [];
      while (i < args.length && !isTopLoopKeyword(args[i]) && loopKey(args[i]) !== 'AND' && loopKey(args[i]) !== 'ELSE' && loopKey(args[i]) !== 'END') {
        doForms.push(args[i]);
        i += 1;
      }
      return makeListNode([makeSymbolNode('PROGN'), ...doForms]);
    }
    if (kw === 'RETURN') {
      const valForm = args[i + 1];
      i += 2;
      return makeListNode([makeSymbolNode('RETURN-FROM'), blockName, valForm]);
    }
    if (kw === 'COLLECT' || kw === 'COLLECTING') {
      const valForm = args[i + 1];
      i += 2;
      let intoVar = null;
      if (loopKey(args[i]) === 'INTO') {
        intoVar = args[i + 1];
        i += 2;
      }
      const accSym = ensureAcc(intoVar, 'list');
      return makeListNode([
        makeSymbolNode('SETQ'),
        accSym,
        makeListNode([
          makeSymbolNode('APPEND'),
          accSym,
          makeListNode([makeSymbolNode('LIST'), valForm]),
        ]),
      ]);
    }
    if (kw === 'APPEND' || kw === 'APPENDING' || kw === 'NCONC' || kw === 'NCONCING') {
      const valForm = args[i + 1];
      i += 2;
      let intoVar = null;
      if (loopKey(args[i]) === 'INTO') {
        intoVar = args[i + 1];
        i += 2;
      }
      const accSym = ensureAcc(intoVar, 'list');
      return makeListNode([
        makeSymbolNode('SETQ'),
        accSym,
        makeListNode([makeSymbolNode('APPEND'), accSym, valForm]),
      ]);
    }
    if (kw === 'SUM' || kw === 'SUMMING') {
      const valForm = args[i + 1];
      i += 2;
      let intoVar = null;
      if (loopKey(args[i]) === 'INTO') {
        intoVar = args[i + 1];
        i += 2;
      }
      const accSym = ensureAcc(intoVar, 'sum');
      return makeListNode([
        makeSymbolNode('SETQ'),
        accSym,
        makeListNode([makeSymbolNode('+'), accSym, valForm]),
      ]);
    }
    if (kw === 'COUNT' || kw === 'COUNTING') {
      const valForm = args[i + 1];
      i += 2;
      let intoVar = null;
      if (loopKey(args[i]) === 'INTO') {
        intoVar = args[i + 1];
        i += 2;
      }
      const accSym = ensureAcc(intoVar, 'count');
      return makeListNode([
        makeSymbolNode('WHEN'),
        valForm,
        makeListNode([
          makeSymbolNode('SETQ'),
          accSym,
          makeListNode([makeSymbolNode('1+'), accSym]),
        ]),
      ]);
    }
    if (kw === 'MAXIMIZE' || kw === 'MAXIMIZING' || kw === 'MINIMIZE' || kw === 'MINIMIZING') {
      const isMax = kw.startsWith('MAX');
      const valForm = args[i + 1];
      i += 2;
      let intoVar = null;
      if (loopKey(args[i]) === 'INTO') {
        intoVar = args[i + 1];
        i += 2;
      }
      const accSym = ensureAcc(intoVar, isMax ? 'max' : 'min');
      const vSym = ctx.freshGensym('LOOP_EXT');
      return makeListNode([
        makeSymbolNode('LET'),
        makeListNode([makeListNode([vSym, valForm])]),
        makeListNode([
          makeSymbolNode('WHEN'),
          makeListNode([
            makeSymbolNode('OR'),
            makeListNode([makeSymbolNode('NULL'), accSym]),
            makeListNode([makeSymbolNode(isMax ? '>' : '<'), vSym, accSym]),
          ]),
          makeListNode([makeSymbolNode('SETQ'), accSym, vSym]),
        ]),
      ]);
    }
    if (kw === 'WHEN' || kw === 'IF' || kw === 'UNLESS') {
      const isUnless = kw === 'UNLESS';
      const testForm = args[i + 1];
      i += 2;
      const thenActions = [parseActionClause()];
      while (loopKey(args[i]) === 'AND') {
        i += 1;
        thenActions.push(parseActionClause());
      }
      const elseActions = [];
      if (loopKey(args[i]) === 'ELSE') {
        i += 1;
        elseActions.push(parseActionClause());
        while (loopKey(args[i]) === 'AND') {
          i += 1;
          elseActions.push(parseActionClause());
        }
      }
      if (loopKey(args[i]) === 'END') {
        i += 1;
      }
      const thenExpr = makeListNode([makeSymbolNode('PROGN'), ...thenActions]);
      const elseExpr = elseActions.length > 0
        ? makeListNode([makeSymbolNode('PROGN'), ...elseActions])
        : NIL_NODE;
      return makeListNode([
        makeSymbolNode('IF'),
        testForm,
        isUnless ? elseExpr : thenExpr,
        isUnless ? thenExpr : elseExpr,
      ]);
    }
    throw new SyntaxError(`unsupported Common Lisp LOOP clause: ${args[i]?.name ?? JSON.stringify(args[i])}`);
  }

  while (i < args.length) {
    const kw = loopKey(args[i]);
    if (kw === 'NAMED') {
      blockName = args[i + 1];
      i += 2;
      continue;
    }
    if (kw === 'WITH') {
      i += 1;
      for (;;) {
        const varSym = args[i];
        i += 1;
        let initForm = NIL_NODE;
        if (loopKey(args[i]) === '=') {
          initForm = args[i + 1];
          i += 2;
        }
        declareOuter(varSym, initForm);
        if (loopKey(args[i]) === 'AND') {
          i += 1;
        } else {
          break;
        }
      }
      continue;
    }
    if (kw === 'INITIALLY') {
      i += 1;
      while (i < args.length && !isTopLoopKeyword(args[i])) {
        initiallyForms.push(args[i]);
        i += 1;
      }
      continue;
    }
    if (kw === 'FINALLY') {
      i += 1;
      if (loopKey(args[i]) === 'DO' || loopKey(args[i]) === 'DOING') {
        i += 1;
      }
      if (loopKey(args[i]) === 'RETURN') {
        finallyForms.push(makeListNode([makeSymbolNode('RETURN-FROM'), blockName, args[i + 1]]));
        i += 2;
      } else {
        while (i < args.length && !isTopLoopKeyword(args[i])) {
          finallyForms.push(args[i]);
          i += 1;
        }
      }
      continue;
    }
    if (kw === 'FOR' || kw === 'AS') {
      i += 1;
      parseForSingle();
      while (loopKey(args[i]) === 'AND') {
        i += 1;
        parseForSingle();
      }
      continue;
    }
    if (kw === 'REPEAT') {
      const countForm = args[i + 1];
      i += 2;
      const repSym = ctx.freshGensym('LOOP_REP');
      declareOuter(repSym, countForm);
      preChecks.push(
        makeListNode([
          makeSymbolNode('WHEN'),
          makeListNode([makeSymbolNode('<='), repSym, makeIntNode(0n)]),
          makeListNode([makeSymbolNode('RETURN-FROM'), bodyExitSym, NIL_NODE]),
        ]),
      );
      postUpdates.push(
        makeListNode([
          makeSymbolNode('SETQ'),
          repSym,
          makeListNode([makeSymbolNode('1-'), repSym]),
        ]),
      );
      continue;
    }
    if (kw === 'WHILE') {
      const testForm = args[i + 1];
      i += 2;
      bodyStatements.push(
        makeListNode([
          makeSymbolNode('UNLESS'),
          testForm,
          makeListNode([makeSymbolNode('RETURN-FROM'), bodyExitSym, NIL_NODE]),
        ]),
      );
      continue;
    }
    if (kw === 'UNTIL') {
      const testForm = args[i + 1];
      i += 2;
      bodyStatements.push(
        makeListNode([
          makeSymbolNode('WHEN'),
          testForm,
          makeListNode([makeSymbolNode('RETURN-FROM'), bodyExitSym, NIL_NODE]),
        ]),
      );
      continue;
    }
    if (kw === 'ALWAYS') {
      const testForm = args[i + 1];
      i += 2;
      ensureAcc(null, 'always');
      bodyStatements.push(
        makeListNode([
          makeSymbolNode('UNLESS'),
          testForm,
          makeListNode([makeSymbolNode('RETURN-FROM'), blockName, NIL_NODE]),
        ]),
      );
      continue;
    }
    if (kw === 'NEVER') {
      const testForm = args[i + 1];
      i += 2;
      ensureAcc(null, 'never');
      bodyStatements.push(
        makeListNode([
          makeSymbolNode('WHEN'),
          testForm,
          makeListNode([makeSymbolNode('RETURN-FROM'), blockName, NIL_NODE]),
        ]),
      );
      continue;
    }
    if (kw === 'THEREIS') {
      const testForm = args[i + 1];
      i += 2;
      ensureAcc(null, 'thereis');
      const itSym = ctx.freshGensym('LOOP_IT');
      bodyStatements.push(
        makeListNode([
          makeSymbolNode('LET'),
          makeListNode([makeListNode([itSym, testForm])]),
          makeListNode([
            makeSymbolNode('WHEN'),
            itSym,
            makeListNode([makeSymbolNode('RETURN-FROM'), blockName, itSym]),
          ]),
        ]),
      );
      continue;
    }
    bodyStatements.push(parseActionClause());
  }

  return makeListNode([
    makeSymbolNode('BLOCK'),
    blockName,
    makeListNode([
      makeSymbolNode('LET*'),
      makeListNode(outerBindings),
      ...initiallyForms,
      makeListNode([
        makeSymbolNode('BLOCK'),
        bodyExitSym,
        makeListNode([
          makeSymbolNode('%WHILE'),
          T_NODE,
          ...preChecks,
          ...bodyStatements,
          ...postUpdates,
        ]),
      ]),
      ...finallyForms,
      defaultAccSym ?? NIL_NODE,
    ]),
  ]);
}

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
    case 'FUNCTION': {
      if (
        args.length === 1 &&
        args[0]?.kind === 'list' &&
        args[0].elements[0]?.kind === 'symbol' &&
        args[0].elements[0].name === 'LAMBDA'
      ) {
        return makeListNode([
          head,
          expandAllMacrosInForm(args[0], ctx, shadowedFunctions, localSignatures),
        ]);
      }
      return form;
    }
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
      const addedSetfReaders = [];
      for (const def of defs) {
        if (def?.kind === 'list') {
          const setfReader = parseSetfFunctionName(def.elements[0]);
          const fnName = setfReader
            ? canonicalSetfFunctionName(setfReader)
            : def.elements[0]?.kind === 'symbol'
              ? def.elements[0].name
              : null;
          if (setfReader) {
            addedSetfReaders.push(setfReader);
          }
          if (fnName) {
            nextShadowed.add(fnName);
            const parsed = parseLambdaList(def.elements[1] ?? NIL_NODE);
            if (!parsed.isSimple) {
              nextSigs.set(fnName, {
                name: fnName,
                requiredCount: parsed.required.length,
                optionalCount: parsed.optional.length,
                hasRestOrKey: Boolean(parsed.rest !== null || parsed.keys.length > 0),
              });
            } else {
              nextSigs.delete(fnName);
            }
          }
        }
      }
      const savedLocalSetf = new Set(ctx.localSetfFunctions ?? []);
      if (head.name === 'LABELS') {
        for (const r of addedSetfReaders) ctx.localSetfFunctions.add(r);
      }
      const defShadow = head.name === 'LABELS' ? nextShadowed : shadowedFunctions;
      const defSigs = head.name === 'LABELS' ? nextSigs : localSignatures;
      const expandedDefs = defs.map((def) => {
        if (def?.kind !== 'list' || def.elements.length < 2) return def;
        const [rawFnSpec, paramForm, ...fnBody] = def.elements;
        const setfReader = parseSetfFunctionName(rawFnSpec);
        const fnSym = setfReader
          ? makeSymbolNode(canonicalSetfFunctionName(setfReader))
          : rawFnSpec;
        const blockName = setfReader ?? fnSym.name;
        const expFnBody = fnBody.map((b) => expandAllMacrosInForm(b, ctx, defShadow, defSigs));
        const norm = normalizeFunctionDefinition(fnSym.name, paramForm, expFnBody, ctx, blockName);
        return makeListNode([fnSym, norm.paramListForm, ...norm.bodyForms]);
      });
      for (const r of addedSetfReaders) ctx.localSetfFunctions.add(r);
      try {
        return makeListNode([
          head,
          makeListNode(expandedDefs),
          ...bodyForms.map((b) => expandAllMacrosInForm(b, ctx, nextShadowed, nextSigs)),
        ]);
      } finally {
        ctx.localSetfFunctions = savedLocalSetf;
      }
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
        if (b?.kind === 'list') {
          const setfReader = parseSetfFunctionName(b.elements[0]);
          if (setfReader) {
            mutated.add(canonicalSetfFunctionName(setfReader));
          } else if (b.elements[0]?.kind === 'symbol') {
            mutated.add(b.elements[0].name);
          }
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
  classes = {},
  functionSignatures = {},
  setfExpanders = {},
  readerMacros = {},
  userFunctions = {},
  readtable = null,
  alreadyExpanded = false,
} = {}) {
  if (!Array.isArray(rawForms)) {
    throw new TypeError('compileCommonLispSemanticProgram forms must be an array');
  }
  const macroContext = createMacroContext({
    macros,
    structs,
    classes,
    functionSignatures,
    setfExpanders,
    readerMacros,
    userFunctions,
    readtable,
  });
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

  const specialVariablesDeclared = new Map();

  function createScope({parent = null, paramNames = []} = {}) {
    const scope = {
      parent,
      params: new Map(),
      locals: new Map(),
      specialVars: new Set(),
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

  function isSpecialInScope(scope, canonicalName) {
    if (varBindingMap.has(canonicalName)) return true;
    let cursor = scope;
    while (cursor) {
      if (cursor.specialVars?.has(canonicalName)) return true;
      cursor = cursor.parent;
    }
    return false;
  }

  function ensureSpecialVariableBinding(canonicalName) {
    if (!varBindingMap.has(canonicalName)) {
      const id = commonLispVariableBindingId(canonicalName);
      varBindingMap.set(canonicalName, id);
      specialVariablesDeclared.set(canonicalName, id);
    }
    return varBindingMap.get(canonicalName);
  }

  function lookupLexical(scope, canonicalName) {
    let cursor = scope;
    const crossedScopes = [];
    while (cursor) {
      if (cursor.specialVars?.has(canonicalName)) {
        return null;
      }
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

  function extractBodyDeclarations(exprs) {
    const declaredSpecials = new Set();
    let idx = 0;
    while (idx < exprs.length) {
      const form = exprs[idx];
      if (
        form?.kind === 'list'
        && form.elements[0]?.kind === 'symbol'
        && form.elements[0].name === 'DECLARE'
      ) {
        for (let i = 1; i < form.elements.length; i += 1) {
          const spec = form.elements[i];
          if (spec?.kind === 'list' && spec.elements[0]?.kind === 'symbol') {
            if (spec.elements[0].name === 'SPECIAL') {
              for (let j = 1; j < spec.elements.length; j += 1) {
                const sym = spec.elements[j];
                if (sym?.kind === 'symbol' && !isNilSymbol(sym) && !isTSymbol(sym) && !sym.keyword) {
                  declaredSpecials.add(sym.name);
                  ensureSpecialVariableBinding(sym.name);
                }
              }
            }
          }
        }
        idx += 1;
        continue;
      }
      break;
    }
    return {
      declaredSpecials,
      declareForms: exprs.slice(0, idx),
      executableForms: exprs.slice(idx),
    };
  }

  function compileSequence(scope, exprs) {
    const {declaredSpecials, executableForms} = extractBodyDeclarations(exprs);
    const savedSpecials = new Set(scope.specialVars);
    for (const s of declaredSpecials) {
      scope.specialVars.add(s);
    }
    try {
      if (executableForms.length === 0) return refNil(scope);
      if (executableForms.length === 1) return compileForm(scope, executableForms[0]);
      return {
        op: 'sequence',
        statements: executableForms.map((e) => compileForm(scope, e)),
      };
    } finally {
      scope.specialVars = savedSpecials;
    }
  }

  function isTBindingExpr(expr) {
    return expr?.op === 'binding' && expr.id === CL_T_BINDING_ID;
  }

  function isNilBindingExpr(expr) {
    return expr?.op === 'binding' && expr.id === CL_NIL_BINDING_ID;
  }

  function compileTruthBranch(scope, testExpr, thenExpr, elseExpr) {
    if (testExpr?.op === 'if') {
      if (isTBindingExpr(testExpr.then) && isNilBindingExpr(testExpr.else)) {
        return {
          op: 'if',
          condition: testExpr.condition,
          then: thenExpr,
          else: elseExpr,
        };
      }
      if (isNilBindingExpr(testExpr.then) && isTBindingExpr(testExpr.else)) {
        return {
          op: 'if',
          condition: testExpr.condition,
          then: elseExpr,
          else: thenExpr,
        };
      }
    }
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

  function compileFunctionRef(scope, rawTarget) {
    const setfReader = parseSetfFunctionName(rawTarget);
    const target = setfReader
      ? makeSymbolNode(canonicalSetfFunctionName(setfReader))
      : rawTarget;
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

        const {declaredSpecials, executableForms} = extractBodyDeclarations(bodyForms);

        // Evaluate all initializers in the prior lexical visibility, then bind
        const evaluated = bindingItems.map((item) => {
          if (item.kind === 'symbol') {
            if (isNilSymbol(item) || isTSymbol(item) || item.keyword) {
              throw new SyntaxError('Common Lisp LET variable must be an ordinary symbol');
            }
            const isSpecial = isSpecialInScope(scope, item.name) || declaredSpecials.has(item.name);
            if (isSpecial) ensureSpecialVariableBinding(item.name);
            return {name: item.name, initExpr: refNil(scope), isSpecial};
          }
          if (item.kind === 'list' && (item.elements.length === 1 || item.elements.length === 2)) {
            const varSym = item.elements[0];
            if (varSym?.kind !== 'symbol' || isNilSymbol(varSym) || isTSymbol(varSym) || varSym.keyword) {
              throw new SyntaxError('Common Lisp LET variable must be an ordinary symbol');
            }
            const isSpecial = isSpecialInScope(scope, varSym.name) || declaredSpecials.has(varSym.name);
            if (isSpecial) ensureSpecialVariableBinding(varSym.name);
            const initExpr = item.elements.length === 2 ? compileForm(scope, item.elements[1]) : refNil(scope);
            return {name: varSym.name, initExpr, isSpecial};
          }
          throw new SyntaxError('invalid Common Lisp LET binding specification');
        });

        const hasSpecialBinding = evaluated.some((b) => b.isSpecial);
        const savedLocals = new Map(scope.locals);
        const savedSpecials = new Set(scope.specialVars);
        for (const s of declaredSpecials) {
          scope.specialVars.add(s);
        }

        try {
          if (!hasSpecialBinding) {
            const statements = [];
            for (const {name, initExpr} of evaluated) {
              const local = declareLocal(scope, name);
              statements.push({op: 'binding-write', id: local.id, value: initExpr});
              scope.locals.set(name, local);
            }
            const bodyExpr = compileSequence(scope, executableForms);
            return {op: 'sequence', statements: [...statements, bodyExpr]};
          }

          const statements = [];
          const specialEntries = [];
          for (const {name, initExpr, isSpecial} of evaluated) {
            if (!isSpecial) {
              const local = declareLocal(scope, name);
              statements.push({op: 'binding-write', id: local.id, value: initExpr});
              scope.locals.set(name, local);
            } else {
              const bindingId = ensureSpecialVariableBinding(name);
              globalBindingIdsUsed.add(bindingId);
              const initSymName = `__CL_LET_INIT_${nextTempId + 1}__`;
              const initLocal = declareLocal(scope, initSymName);
              statements.push({op: 'binding-write', id: initLocal.id, value: initExpr});
              scope.locals.set(initSymName, initLocal);

              const oldSymName = `__CL_LET_OLD_${nextTempId + 1}__`;
              const oldLocal = declareLocal(scope, oldSymName);
              const bindingExpr = requireRootCapture(scope, bindingId, name);
              statements.push({
                op: 'binding-write',
                id: oldLocal.id,
                value: {
                  op: 'send',
                  languageId: SYMMETRIC_SMALLTALK_ID,
                  receiver: bindingExpr,
                  message: textValue('value'),
                  arguments: [],
                },
              });
              scope.locals.set(oldSymName, oldLocal);
              scope.specialVars.add(name);
              specialEntries.push({name, initSymName, oldSymName});
            }
          }

          const setNewForms = specialEntries.map(({name, initSymName}) =>
            makeListNode([makeSymbolNode('SETQ'), makeSymbolNode(name), makeSymbolNode(initSymName)]),
          );
          const restoreOldForms = [...specialEntries].reverse().map(({name, oldSymName}) =>
            makeListNode([makeSymbolNode('SETQ'), makeSymbolNode(name), makeSymbolNode(oldSymName)]),
          );
          const protectedForm = makeListNode([
            makeSymbolNode('PROGN'),
            ...setNewForms,
            ...(executableForms.length > 0 ? executableForms : [NIL_NODE]),
          ]);
          const unwindForm = makeListNode([
            makeSymbolNode('UNWIND-PROTECT'),
            protectedForm,
            ...restoreOldForms,
          ]);
          const bodyExpr = compileForm(scope, unwindForm);
          return {op: 'sequence', statements: [...statements, bodyExpr]};
        } finally {
          scope.locals = savedLocals;
          scope.specialVars = savedSpecials;
        }
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

        const {declaredSpecials, declareForms, executableForms} = extractBodyDeclarations(bodyForms);
        const hasAnySpecial = declaredSpecials.size > 0 || bindingItems.some((item) => {
          const sym = item?.kind === 'symbol' ? item : item?.kind === 'list' ? item.elements[0] : null;
          return sym?.kind === 'symbol' && (isSpecialInScope(scope, sym.name) || declaredSpecials.has(sym.name));
        });

        if (hasAnySpecial) {
          let nested = makeListNode([
            makeSymbolNode('LET'),
            makeListNode([bindingItems[bindingItems.length - 1]]),
            ...declareForms,
            ...executableForms,
          ]);
          for (let i = bindingItems.length - 2; i >= 0; i -= 1) {
            nested = makeListNode([
              makeSymbolNode('LET'),
              makeListNode([bindingItems[i]]),
              ...declareForms,
              nested,
            ]);
          }
          return compileForm(scope, nested);
        }

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
          if (lexical) {
            statements.push({
              op: 'binding-write',
              id: lexical.id,
              value: compileForm(scope, valForm),
            });
            continue;
          }
          if (varBindingMap.has(target.name)) {
            const bindingId = varBindingMap.get(target.name);
            globalBindingIdsUsed.add(bindingId);
            const bindingExpr = requireRootCapture(scope, bindingId, target.name);
            statements.push({
              op: 'send',
              languageId: SYMMETRIC_SMALLTALK_ID,
              receiver: bindingExpr,
              message: textValue('clSetValue:'),
              arguments: [compileForm(scope, valForm)],
            });
            continue;
          }
          throw new SyntaxError(`unbound Common Lisp variable in SETQ: ${target.name}`);
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
      case 'READ':
      case 'READ-CHAR':
      case 'PEEK-CHAR':
      case 'UNREAD-CHAR':
      case 'READ-DELIMITED-LIST': {
        if (args.length === 0) return refNil(scope);
        return {
          op: 'sequence',
          statements: [...args.map((a) => compileForm(scope, a)), refNil(scope)],
        };
      }
      case 'GETHASH': {
        if (args.length < 2 || args.length > 3) {
          throw new SyntaxError('Common Lisp GETHASH requires 2 or 3 arguments');
        }
        const defaultExpr = args.length === 3 ? compileForm(scope, args[2]) : refNil(scope);
        if (fnBindingMap.has('%GETHASH-WITH-MV')) {
          const mvHelperId = fnBindingMap.get('%GETHASH-WITH-MV');
          globalBindingIdsUsed.add(mvHelperId);
          const bindingExpr = requireRootCapture(scope, mvHelperId, '%GETHASH-WITH-MV');
          return {
            op: 'apply',
            callee: {
              op: 'send',
              languageId: SYMMETRIC_SMALLTALK_ID,
              receiver: bindingExpr,
              message: textValue('value'),
              arguments: [],
            },
            arguments: [compileForm(scope, args[0]), compileForm(scope, args[1]), defaultExpr],
          };
        }
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
                op: 'literal',
                value: textValue(tagVarName),
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
        if (clauses.length === 0) return compileForm(scope, protectedForm);
        const emptyList = makeSymbolNode('NIL', {spelling: 'nil', keyword: false});
        const thunkSymName = `__CL_HC_THUNK_${nextTempId + 1}__`;
        const resSymName = `__CL_HC_RES_${nextTempId + 1}__`;
        const savedLocals = new Map(scope.locals);
        try {
          const thunkLocal = declareLocal(scope, thunkSymName, {forceMutated: true});
          const resLocal = declareLocal(scope, resSymName);
          scope.locals.set(thunkSymName, thunkLocal);
          scope.locals.set(resSymName, resLocal);

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
            const setThunkBody = [
              makeListNode([
                makeSymbolNode('SETQ'),
                makeSymbolNode(thunkSymName),
                makeListNode([
                  makeSymbolNode('LAMBDA'),
                  emptyList,
                  ...(handlerBody.length > 0 ? handlerBody : [emptyList]),
                ]),
              ]),
              emptyList,
            ];
            const handlerBlock = compileLambdaExpr(scope, paramList, setThunkBody, 'handler_case');
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

          const followUpExpr = compileForm(
            scope,
            makeListNode([
              makeSymbolNode('IF'),
              makeSymbolNode(thunkSymName),
              makeListNode([makeSymbolNode('FUNCALL'), makeSymbolNode(thunkSymName)]),
              makeSymbolNode(resSymName),
            ]),
          );

          return {
            op: 'sequence',
            statements: [
              {op: 'binding-write', id: thunkLocal.id, value: refNil(scope)},
              {op: 'binding-write', id: resLocal.id, value: currentExpr},
              followUpExpr,
            ],
          };
        } finally {
          scope.locals = savedLocals;
        }
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
          const condSym = makeSymbolNode(`__CL_HB_COND_${nextTempId + 1}__`);
          const wrapperBody = [
            makeListNode([makeSymbolNode('FUNCALL'), handlerForm, condSym]),
            makeListNode([makeSymbolNode('SIGNAL'), condSym]),
          ];
          const handlerBlock = compileLambdaExpr(
            scope,
            makeListNode([condSym]),
            wrapperBody,
            'handler_bind_handler',
          );
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
    specialVariablesDeclared: Object.freeze(Object.fromEntries(specialVariablesDeclared)),
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

  const existingCarBlock = await images.getBlock(imageId, RUNTIME_BLOCK_IDS.CAR);
  if (existingCarBlock && existingCarBlock.metadata?.lane === lane) {
    const existingNs = await findNamespace({images, imageId, namespaceId: COMMON_LISP_NAMESPACE_ID});
    if (existingNs?.entries.has('MAPCAR') && existingNs?.entries.has('FORMAT')) {
      const kernel = await findSmalltalkKernel({images, imageId});
      const tRef = await ensureInternedSymbol(images, imageId, 'T');
      return Object.freeze({
        imageId,
        consClass: objectRef(imageId, `smalltalk/class/${CONS_CLASS_NAME}`),
        blockClosureClass: objectRef(imageId, `smalltalk/class/${BLOCK_CLOSURE_CLASS_NAME}`),
        nil: kernel.nil,
        t: tRef,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
      });
    }
  }

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
  await defineMethodsFromSource({
    images,
    compilation: compiler,
    imageId,
    lane,
    classRef: objectRef(imageId, 'smalltalk/class/GlobalBinding'),
    allowRedefinition: true,
    methods: [{selector: 'clSetValue:', source: '[ :v | value := v. ^ v ]'}],
  });

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
    methods: [
      {selector: 'isCons', source: '[ ^false ]'},
      {selector: 'clTypeName', source: "[ ^ 'OBJECT' ]"},
    ],
  });
  await defineMethodsFromSource({
    images,
    compilation: compiler,
    imageId,
    lane,
    classRef: kernel.classClass,
    allowRedefinition: true,
    methods: [{selector: 'clClassName', source: "[ ^ 'STANDARD-OBJECT' ]"}],
  });
  const {classRef: blockClosureClassRef} = await ensureNamedClass({
    images,
    imageId,
    name: BLOCK_CLOSURE_CLASS_NAME,
    superclassRef: kernel.objectClass,
  });

  for (const [clsName, clName] of [
    ['Object', 'STANDARD-OBJECT'],
    ['Integer', 'INTEGER'],
    ['Text', 'STRING'],
    [CONS_CLASS_NAME, 'CONS'],
    ['Symbol', 'SYMBOL'],
    ['UndefinedObject', 'NULL'],
    ['Array', 'VECTOR'],
    ['Character', 'CHARACTER'],
    ['Dictionary', 'HASH-TABLE'],
    [BLOCK_CLOSURE_CLASS_NAME, 'FUNCTION'],
  ]) {
    await defineMethodsFromSource({
      images,
      compilation: compiler,
      imageId,
      lane,
      classRef: objectRef(imageId, `smalltalk/metaclass/${clsName}`),
      allowRedefinition: true,
      methods: [{selector: 'clClassName', source: `[ ^ '${clName}' ]`}],
    });
  }

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
  if (!ns?.entries.has('MAPCAR') || !ns?.entries.has('FORMAT') || !ns?.entries.has('%CAPTURE-MV')) {
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
  const classes = {};
  const generics = {};
  const packages = {};
  const systems = {};
  const functionSignatures = {};
  const setfExpanders = {};
  const readerMacros = {};
  const userFunctions = {};

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
    } else if (bindingId.startsWith('common-lisp/class-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        classes[parsed.name] = parsed;
      }
    } else if (bindingId.startsWith('common-lisp/generic-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        generics[parsed.name] = parsed;
      }
    } else if (bindingId.startsWith('common-lisp/package-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        packages[parsed.name] = parsed;
      }
    } else if (bindingId.startsWith('common-lisp/system-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        systems[parsed.name] = parsed;
      }
    } else if (bindingId.startsWith('common-lisp/signature-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        functionSignatures[parsed.name] = parsed;
      }
    } else if (bindingId.startsWith('common-lisp/setf-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        setfExpanders[parsed.name] = parsed;
      }
    } else if (bindingId.startsWith('common-lisp/reader-macro-binding/')) {
      const record = await images.getObject(imageId, bindingId);
      const val = record?.slots?.['global-binding-value'];
      if (val?.kind === VALUE_KIND.TEXT) {
        const parsed = JSON.parse(val.value);
        readerMacros[parsed.key] = parsed;
      }
    }
  }

  // When custom reader macros or defmacro helpers exist in the image, load user function ASTs
  // so compile-time/read-time macro expansion can invoke previously defined helper functions.
  if (Object.keys(readerMacros).length > 0 || Object.keys(macros).length > 0) {
    for (const [fnName, bindingId] of Object.entries(functionBindings)) {
      if (fnName.startsWith('%') || CL_SPECIAL_AND_STD_SYMBOLS.has(fnName)) continue;
      const bindingRec = await images.getObject(imageId, bindingId);
      const blockRef = bindingRec?.slots?.['global-binding-value'];
      if (!isObjectRef(blockRef)) continue;
      const srcArtifact = await images.getCodeArtifact(blockRef.imageId, `${blockRef.objectId}:source`);
      if (srcArtifact?.content?.kind === VALUE_KIND.TEXT) {
        try {
          const parsedForms = readCommonLispSource(srcArtifact.content.value);
          const defForm = parsedForms[0];
          if (defForm?.kind === 'list' && defForm.elements[0]?.name === 'DEFUN' && defForm.elements.length >= 3) {
            userFunctions[fnName] = {
              name: fnName,
              blockName: fnName,
              paramForm: defForm.elements[2],
              bodyForms: defForm.elements.slice(3),
            };
          }
        } catch {
          // Ignore unparseable helper source
        }
      }
    }
  }

  return {
    globals,
    functionBindings,
    variableBindings,
    macros,
    structs,
    classes,
    generics,
    packages,
    systems,
    functionSignatures,
    setfExpanders,
    readerMacros,
    userFunctions,
  };
}

async function installCommonLispBlock({
  images,
  compilation = null,
  imageId,
  source,
  sourceText: explicitSourceText = null,
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
  const forms = typeof source === 'string' ? readCommonLispSource(source, ctx) : source;
  const {
    syntax,
    semanticProgram,
    representation,
    globalBindingIdsUsed,
    runtimeBlocksUsed,
    internedSymbolsUsed,
    specialVariablesDeclared,
  } = compileCommonLispSemanticProgram(forms, {
    parameters,
    captures,
    globals: ctx.globals,
    functionBindings: ctx.functionBindings,
    variableBindings: ctx.variableBindings,
    macros: ctx.macros ?? {},
    structs: ctx.structs ?? {},
    classes: ctx.classes ?? {},
    functionSignatures: ctx.functionSignatures ?? {},
    setfExpanders: ctx.setfExpanders ?? {},
    readerMacros: ctx.readerMacros ?? {},
    userFunctions: ctx.userFunctions ?? {},
    readtable: ctx.readtable ?? null,
    alreadyExpanded,
  });

  if (specialVariablesDeclared && Object.keys(specialVariablesDeclared).length > 0) {
    const kernel = await findSmalltalkKernel({images, imageId});
    for (const [varName, bindingId] of Object.entries(specialVariablesDeclared)) {
      const existing = await resolveGlobal({
        images,
        imageId,
        name: varName,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
      });
      if (!existing) {
        await publishGlobal({
          images,
          imageId,
          namespaceId: COMMON_LISP_NAMESPACE_ID,
          name: varName,
          bindingId,
          value: kernel.nil,
        });
      }
      ctx.variableBindings[varName] = bindingId;
      ctx.globals[varName] = bindingId;
    }
  }

  // Ensure any quoted symbols referenced via symbol-intern have their Symbol protocol ready
  for (const symSpelling of internedSymbolsUsed) {
    await ensureInternedSymbol(images, imageId, symSpelling);
  }

  const sourceText = typeof explicitSourceText === 'string'
    ? explicitSourceText
    : typeof source === 'string'
      ? source
      : forms.map(formatCommonLispForm).join(' ');
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
  const [, nameSpec, paramForm, ...rawBodyForms] = form.elements;
  const setfReader = parseSetfFunctionName(nameSpec);
  let fnName;
  let blockName;
  let setfDescriptor = null;
  if (setfReader) {
    fnName = canonicalSetfFunctionName(setfReader);
    blockName = setfReader;
    setfDescriptor = Object.freeze({
      name: setfReader,
      kind: 'setf-function',
      writerFunctionName: fnName,
    });
    macroContext.setfExpanders.set(setfReader, setfDescriptor);
  } else if (nameSpec?.kind === 'symbol' && !isNilSymbol(nameSpec) && !isTSymbol(nameSpec) && !nameSpec.keyword) {
    fnName = nameSpec.name;
    blockName = nameSpec.name;
  } else {
    throw new SyntaxError('Common Lisp DEFUN name must be an ordinary symbol or (SETF <reader>)');
  }
  // Register self-signature in macroContext before expanding body so recursive calls with &optional/&key work
  const parsedParams = parseLambdaList(paramForm);
  let selfSig = null;
  if (!parsedParams.isSimple) {
    selfSig = Object.freeze({
      name: fnName,
      requiredCount: parsedParams.required.length,
      optionalCount: parsedParams.optional.length,
      hasRestOrKey: Boolean(parsedParams.rest !== null || parsedParams.keys.length > 0),
    });
    macroContext.functionSignatures.set(fnName, selfSig);
  }
  const expandedBody = rawBodyForms.map((b) => expandAllMacrosInForm(b, macroContext));
  const norm = normalizeFunctionDefinition(fnName, paramForm, expandedBody, macroContext, blockName);
  return {
    name: fnName,
    blockName,
    setfReader,
    setfDescriptor,
    parameters: norm.paramNames,
    bodyForms: norm.bodyForms,
    signature: norm.signature,
  };
}

function parseTopLevelDefsetf(form) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFSETF') {
    return null;
  }
  if (form.elements.length < 3) {
    throw new SyntaxError('Common Lisp DEFSETF requires an access-fn and an update-fn or expander specification');
  }
  const [, accessSym, third, ...rest] = form.elements;
  if (accessSym?.kind !== 'symbol' || isNilSymbol(accessSym) || isTSymbol(accessSym) || accessSym.keyword) {
    throw new SyntaxError('Common Lisp DEFSETF access-fn must be an ordinary symbol');
  }
  // Short form: (defsetf access-fn update-fn [documentation])
  if (third?.kind === 'symbol' && !isNilSymbol(third)) {
    return Object.freeze({
      name: accessSym.name,
      kind: 'defsetf-short',
      updateFn: third.name,
    });
  }
  // Long form: (defsetf access-fn (lambda-list...) (store-vars...) body...)
  if (rest.length < 2) {
    throw new SyntaxError('Common Lisp long-form DEFSETF requires (lambda-list) (store-vars) and body');
  }
  const [storeVarsForm, ...rawBodyForms] = rest;
  const storeVarElems = isNilSymbol(storeVarsForm)
    ? []
    : storeVarsForm?.kind === 'list'
      ? storeVarsForm.elements
      : null;
  if (!storeVarElems || storeVarElems.length === 0 || storeVarElems.some((s) => s?.kind !== 'symbol')) {
    throw new SyntaxError('Common Lisp long-form DEFSETF requires a non-empty list of store variable symbols');
  }
  // Strip optional docstring if followed by at least one body form
  const bodyForms = rawBodyForms.length > 1 && rawBodyForms[0]?.kind === 'string'
    ? rawBodyForms.slice(1)
    : rawBodyForms;
  return Object.freeze({
    name: accessSym.name,
    kind: 'defsetf-long',
    lambdaList: third,
    storeVars: Object.freeze(storeVarElems.map((s) => s.name)),
    bodyForms,
  });
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
        const bareSlot = stripPackagePrefix(sf.name);
        return {
          name: bareSlot,
          varName: toCamelCaseSlotName(bareSlot),
          defaultForm: NIL_NODE,
        };
      }
      if (sf?.kind === 'list' && sf.elements[0]?.kind === 'symbol') {
        const bareSlot = stripPackagePrefix(sf.elements[0].name);
        return {
          name: bareSlot,
          varName: toCamelCaseSlotName(bareSlot),
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
          makeListNode([makeSymbolNode('FUNCTIONP'), xSym]),
          NIL_NODE,
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

function computeClassPrecedenceList(className, directSuperclasses, existingClasses = {}) {
  const result = [className];
  const seen = new Set([className]);
  function visit(name) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
    const cls = existingClasses[name];
    if (cls && Array.isArray(cls.superclasses)) {
      for (const sup of cls.superclasses) {
        visit(sup);
      }
    }
  }
  for (const sup of directSuperclasses) {
    visit(sup);
  }
  return result;
}

function parseTopLevelDefclass(form, existingClasses = {}) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFCLASS') {
    return null;
  }
  if (form.elements.length < 4) {
    throw new SyntaxError('Common Lisp DEFCLASS requires a name, superclasses list, and slot-specs list');
  }
  const [, nameSym, supersForm, slotsForm] = form.elements;
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError('Common Lisp DEFCLASS name must be an ordinary symbol');
  }
  const classNameSym = nameSym.name;
  const className = toPascalCaseIdentifier(nameSym.spelling || classNameSym);

  let directSuperclasses = [];
  if (supersForm?.kind === 'list') {
    directSuperclasses = supersForm.elements.map((s) => {
      if (s?.kind !== 'symbol' || isNilSymbol(s) || isTSymbol(s) || s.keyword) {
        throw new SyntaxError(`invalid superclass in Common Lisp DEFCLASS ${classNameSym}`);
      }
      return s.name;
    });
  } else if (!isNilSymbol(supersForm)) {
    throw new SyntaxError(`Common Lisp DEFCLASS ${classNameSym} superclasses must be a list`);
  }

  for (const sup of directSuperclasses) {
    if (!existingClasses[sup]) {
      throw new SyntaxError(`Common Lisp DEFCLASS ${classNameSym} inherits from unknown class ${sup}`);
    }
  }

  const rawSlotSpecs = isNilSymbol(slotsForm)
    ? []
    : slotsForm?.kind === 'list'
      ? slotsForm.elements
      : null;
  if (!rawSlotSpecs) {
    throw new SyntaxError(`Common Lisp DEFCLASS ${classNameSym} slots must be a list`);
  }

  const localSlots = rawSlotSpecs.map((spec) => {
    if (spec?.kind === 'symbol') {
      const bare = stripPackagePrefix(spec.name);
      return {
        name: bare,
        rawName: spec.name,
        varName: toCamelCaseSlotName(bare),
        initarg: null,
        initform: NIL_NODE,
        readers: [],
        writers: [],
        accessors: [],
      };
    }
    if (spec?.kind === 'list' && spec.elements.length >= 1 && spec.elements[0]?.kind === 'symbol') {
      const sSym = spec.elements[0];
      const bare = stripPackagePrefix(sSym.name);
      let initarg = null;
      let initform = NIL_NODE;
      const readers = [];
      const writers = [];
      const accessors = [];
      for (let i = 1; i + 1 < spec.elements.length; i += 2) {
        const optKey = spec.elements[i];
        const optVal = spec.elements[i + 1];
        if (optKey?.kind !== 'symbol') continue;
        const k = optKey.name.startsWith(':') ? optKey.name : `:${stripPackagePrefix(optKey.name)}`;
        if (k === ':INITARG' && optVal?.kind === 'symbol') {
          initarg = optVal.name.startsWith(':') ? optVal.name : `:${stripPackagePrefix(optVal.name)}`;
        } else if (k === ':INITFORM') {
          initform = optVal ?? NIL_NODE;
        } else if (k === ':READER' && optVal?.kind === 'symbol') {
          readers.push(optVal.name);
        } else if (k === ':WRITER' && optVal?.kind === 'symbol') {
          writers.push(optVal.name);
        } else if (k === ':ACCESSOR' && optVal?.kind === 'symbol') {
          accessors.push(optVal.name);
        }
      }
      return {
        name: bare,
        rawName: sSym.name,
        varName: toCamelCaseSlotName(bare),
        initarg,
        initform,
        readers,
        writers,
        accessors,
      };
    }
    throw new SyntaxError(`invalid slot specification in Common Lisp DEFCLASS ${classNameSym}`);
  });

  const cpl = computeClassPrecedenceList(classNameSym, directSuperclasses, existingClasses);

  // Merge slots along CPL (from most general to most specific so child slot options override parent defaults)
  const slotMap = new Map();
  for (const ancestorName of [...cpl].reverse()) {
    const ancestorSlots = ancestorName === classNameSym
      ? localSlots
      : existingClasses[ancestorName]?.localSlots ?? [];
    for (const s of ancestorSlots) {
      const prev = slotMap.get(s.name);
      if (!prev) {
        slotMap.set(s.name, {...s});
      } else {
        slotMap.set(s.name, {
          name: s.name,
          rawName: s.rawName ?? prev.rawName,
          varName: prev.varName,
          initarg: s.initarg ?? prev.initarg,
          initform: s.initform !== NIL_NODE ? s.initform : prev.initform,
          readers: [...new Set([...prev.readers, ...s.readers])],
          writers: [...new Set([...prev.writers, ...s.writers])],
          accessors: [...new Set([...prev.accessors, ...s.accessors])],
        });
      }
    }
  }

  const allSlots = [...slotMap.values()];
  const primaryParent = directSuperclasses.length > 0 ? existingClasses[directSuperclasses[0]] : null;
  const primaryParentSlotNames = new Set((primaryParent?.slots ?? []).map((s) => s.name));
  // Backing Smalltalk class inherits instance variables from primaryParent; any slots from secondary
  // superclasses (multiple inheritance) or newly declared on this class become local instance variables.
  const backingLocalSlots = allSlots.filter((s) => !primaryParentSlotNames.has(s.name));

  return Object.freeze({
    name: classNameSym,
    className,
    superclasses: directSuperclasses,
    cpl,
    parentClassName: primaryParent ? primaryParent.className : null,
    localSlots,
    backingLocalSlots,
    slots: allSlots,
  });
}

function buildDefclassProgramForms(cls) {
  const generated = [];
  const classSym = makeSymbolNode(cls.className, {spelling: cls.className});
  const instSym = makeSymbolNode('%INST');
  const valSym = makeSymbolNode('%VAL');

  // 1. Class constructor (%MAKE-CLASS-<NAME> &rest %initargs &key ...)
  const keySpecs = [];
  const slotInitAssigns = [];
  for (const s of cls.slots) {
    const paramSym = makeSymbolNode(`%SLOT_${s.name}`);
    if (s.initarg) {
      const kwSym = makeSymbolNode(s.initarg, {spelling: s.initarg, keyword: true});
      keySpecs.push(makeListNode([makeListNode([kwSym, paramSym]), s.initform]));
    } else {
      const dummyKw = makeSymbolNode(`:%UNEXPOSED_${s.name}`, {
        spelling: `:%UNEXPOSED_${s.name}`,
        keyword: true,
      });
      keySpecs.push(makeListNode([makeListNode([dummyKw, paramSym]), s.initform]));
    }
    slotInitAssigns.push(
      makeListNode([
        makeSymbolNode('SEND'),
        instSym,
        Object.freeze({kind: 'string', value: `${s.varName}:`}),
        paramSym,
      ]),
    );
  }

  const initargsRestSym = makeSymbolNode('%INITARGS');
  generated.push(
    makeListNode([
      makeSymbolNode('DEFUN'),
      makeSymbolNode(`%MAKE-CLASS-${cls.name}`),
      makeListNode([
        makeSymbolNode('&REST'),
        initargsRestSym,
        makeSymbolNode('&KEY'),
        ...keySpecs,
      ]),
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([
            instSym,
            makeListNode([makeSymbolNode('SEND'), classSym, Object.freeze({kind: 'string', value: 'basicNew'})]),
          ]),
        ]),
        ...slotInitAssigns,
        makeListNode([
          makeSymbolNode('FUNCALL'),
          makeListNode([makeSymbolNode('FUNCTION'), makeSymbolNode('INITIALIZE-INSTANCE')]),
          instSym,
          initargsRestSym,
        ]),
        instSym,
      ]),
    ]),
  );

  // 2. Readers, writers, and accessors (using polymorphic Smalltalk selectors so unrelated classes can share reader/accessor names)
  for (const s of cls.localSlots) {
    for (const readerName of [...s.readers, ...s.accessors]) {
      const cleanR = stripPackagePrefix(readerName);
      generated.push(
        makeListNode([
          makeSymbolNode('DEFUN'),
          makeSymbolNode(readerName),
          makeListNode([instSym]),
          makeListNode([
            makeSymbolNode('SEND'),
            instSym,
            Object.freeze({kind: 'string', value: `clAcc_${cleanR}`}),
          ]),
        ]),
      );
    }
    for (const accName of s.accessors) {
      const cleanA = stripPackagePrefix(accName);
      generated.push(
        makeListNode([
          makeSymbolNode('DEFUN'),
          makeSymbolNode(`%SET-${accName}`),
          makeListNode([instSym, valSym]),
          makeListNode([
            makeSymbolNode('SEND'),
            instSym,
            Object.freeze({kind: 'string', value: `clSetAcc_${cleanA}:`}),
            valSym,
          ]),
          valSym,
        ]),
      );
    }
    for (const writerName of s.writers) {
      const cleanW = stripPackagePrefix(writerName);
      generated.push(
        makeListNode([
          makeSymbolNode('DEFUN'),
          makeSymbolNode(writerName),
          makeListNode([valSym, instSym]),
          makeListNode([
            makeSymbolNode('SEND'),
            instSym,
            Object.freeze({kind: 'string', value: `clWriter_${cleanW}:`}),
            valSym,
          ]),
          valSym,
        ]),
      );
    }
  }

  return generated;
}

function buildDynamicMakeInstanceDefun(allClasses = {}) {
  const clsSym = makeSymbolNode('%CLS');
  const argsSym = makeSymbolNode('%ARGS');
  const nameSym = makeSymbolNode('%NAME');
  const clauses = Object.values(allClasses).map((cls) =>
    makeListNode([
      makeListNode([
        makeSymbolNode('EQ'),
        nameSym,
        makeListNode([makeSymbolNode('QUOTE'), makeSymbolNode(cls.name)]),
      ]),
      makeListNode([
        makeSymbolNode('FUNCALL'),
        makeListNode([makeSymbolNode('FUNCTION'), makeSymbolNode(`%MAKE-CLASS-${cls.name}`)]),
        argsSym,
      ]),
    ]),
  );
  clauses.push(
    makeListNode([
      T_NODE,
      makeListNode([
        makeSymbolNode('ERROR'),
        Object.freeze({kind: 'string', value: 'unknown CLOS class in MAKE-INSTANCE'}),
      ]),
    ]),
  );
  return makeListNode([
    makeSymbolNode('DEFUN'),
    makeSymbolNode('%CL-MAKE-INSTANCE'),
    makeListNode([clsSym, argsSym]),
    makeListNode([
      makeSymbolNode('LET'),
      makeListNode([
        makeListNode([nameSym, makeListNode([makeSymbolNode('CLASS-NAME'), clsSym])]),
      ]),
      makeListNode([makeSymbolNode('COND'), ...clauses]),
    ]),
  ]);
}

function parseTopLevelDefgeneric(form) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFGENERIC') {
    return null;
  }
  if (form.elements.length < 3 || form.elements[2]?.kind !== 'list') {
    throw new SyntaxError('Common Lisp DEFGENERIC requires a name and lambda-list');
  }
  const [, nameSym, lambdaListForm] = form.elements;
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError('Common Lisp DEFGENERIC name must be an ordinary symbol');
  }
  const params = [];
  for (const el of lambdaListForm.elements) {
    if (el?.kind !== 'symbol') break;
    if (el.name.startsWith('&')) break;
    params.push(el.name);
  }
  return Object.freeze({
    name: nameSym.name,
    parameters: params,
  });
}

function parseTopLevelDefmethod(form) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFMETHOD') {
    return null;
  }
  if (form.elements.length < 3) {
    throw new SyntaxError('Common Lisp DEFMETHOD requires a name, specialized lambda-list, and body');
  }
  const [, nameSym, third, ...rest] = form.elements;
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError('Common Lisp DEFMETHOD name must be an ordinary symbol');
  }
  let qualifier = 'PRIMARY';
  let specListForm;
  let bodyForms;
  if (third?.kind === 'symbol' && third.keyword) {
    const q = third.name.slice(1);
    if (q !== 'BEFORE' && q !== 'AFTER' && q !== 'AROUND') {
      throw new SyntaxError(`unsupported Common Lisp DEFMETHOD qualifier: ${third.name}`);
    }
    qualifier = q;
    [specListForm, ...bodyForms] = rest;
  } else {
    specListForm = third;
    bodyForms = rest;
  }
  if (specListForm?.kind !== 'list' && !isNilSymbol(specListForm)) {
    throw new SyntaxError(`Common Lisp DEFMETHOD ${nameSym.name} requires a specialized lambda-list`);
  }
  const rawElements = isNilSymbol(specListForm) ? [] : specListForm.elements;
  const parameters = [];
  const specializers = [];
  for (const item of rawElements) {
    if (item?.kind === 'symbol') {
      if (item.name.startsWith('&')) break;
      parameters.push(item.name);
      specializers.push({kind: 'type', typeName: 'T'});
    } else if (item?.kind === 'list' && item.elements.length === 2 && item.elements[0]?.kind === 'symbol') {
      const pName = item.elements[0].name;
      const spec = item.elements[1];
      parameters.push(pName);
      if (spec?.kind === 'symbol') {
        specializers.push({kind: 'type', typeName: spec.name});
      } else if (
        spec?.kind === 'list'
        && spec.elements.length === 2
        && spec.elements[0]?.kind === 'symbol'
        && stripPackagePrefix(spec.elements[0].name) === 'EQL'
      ) {
        specializers.push({kind: 'eql', valueForm: spec.elements[1]});
      } else {
        throw new SyntaxError(`invalid parameter specializer in Common Lisp DEFMETHOD ${nameSym.name}`);
      }
    } else {
      throw new SyntaxError(`invalid parameter in Common Lisp DEFMETHOD ${nameSym.name}`);
    }
  }
  const specKey = `${qualifier}:${specializers
    .map((s) => (s.kind === 'eql' ? `(EQL ${formatCommonLispForm(s.valueForm)})` : s.typeName))
    .join(',')}`;
  return Object.freeze({
    name: nameSym.name,
    qualifier,
    parameters,
    specializers,
    specKey,
    bodyForms,
  });
}

function specializerSpecificityRank(spec, existingClasses = {}) {
  if (spec.kind === 'eql') return 1000;
  const t = spec.typeName;
  if (t === 'T') return 0;
  const cls = existingClasses[t];
  if (cls && Array.isArray(cls.cpl)) {
    return 100 + cls.cpl.length;
  }
  // Built-in types (INTEGER, STRING, CONS, SYMBOL, VECTOR, etc.)
  const stripped = stripPackagePrefix(t);
  if (stripped === 'NULL' || stripped === 'CONS' || stripped === 'KEYWORD') return 60;
  if (stripped === 'LIST' || stripped === 'SYMBOL' || stripped === 'INTEGER') return 50;
  if (stripped === 'NUMBER' || stripped === 'STRING' || stripped === 'VECTOR') return 45;
  if (stripped === 'ATOM' || stripped === 'STANDARD-OBJECT') return 20;
  return 40;
}

function compareMethodsBySpecificity(mA, mB, existingClasses = {}) {
  const len = Math.min(mA.specializers.length, mB.specializers.length);
  for (let i = 0; i < len; i += 1) {
    const sA = mA.specializers[i];
    const sB = mB.specializers[i];
    if (sA.kind === 'type' && sB.kind === 'type' && sA.typeName !== sB.typeName) {
      const clsA = existingClasses[sA.typeName];
      const clsB = existingClasses[sB.typeName];
      if (clsA?.cpl?.includes(sB.typeName)) return -1;
      if (clsB?.cpl?.includes(sA.typeName)) return 1;
    }
    const rA = specializerSpecificityRank(sA, existingClasses);
    const rB = specializerSpecificityRank(sB, existingClasses);
    if (rA !== rB) return rB - rA;
  }
  return 0;
}

function buildSpecializerCheckForm(argSym, spec) {
  if (spec.kind === 'eql') {
    return makeListNode([makeSymbolNode('EQL'), argSym, spec.valueForm]);
  }
  if (spec.typeName === 'T') {
    return T_NODE;
  }
  return makeListNode([
    makeSymbolNode('%TYPEP'),
    argSym,
    makeListNode([makeSymbolNode('QUOTE'), makeSymbolNode(spec.typeName)]),
  ]);
}

function buildMethodApplicabilityTest(paramSyms, method) {
  const checks = [];
  for (let i = 0; i < method.specializers.length; i += 1) {
    const chk = buildSpecializerCheckForm(paramSyms[i], method.specializers[i]);
    if (chk !== T_NODE) checks.push(chk);
  }
  if (checks.length === 0) return T_NODE;
  if (checks.length === 1) return checks[0];
  return checks.slice(1).reduce(
    (acc, c) => makeListNode([makeSymbolNode('%AND2'), acc, c]),
    checks[0],
  );
}

function buildDefgenericProgramForms(generic, existingClasses = {}) {
  const generated = [];
  const paramSyms = generic.parameters.map((_, i) => makeSymbolNode(`%GF_ARG_${i}`));
  const nextFnSym = makeSymbolNode('%NEXT_FN');
  const methods = generic.methods ?? [];

  const sortedWithIdx = methods.map((m, idx) => ({m, idx, fnName: `%GF-M-${generic.name}-${idx}`}));

  // 1. Emit a helper DEFUN for each method body
  // Primary and :around methods receive (%NEXT_FN p1 p2 ...) and bind CALL-NEXT-METHOD / NEXT-METHOD-P via FLET
  // :before and :after methods receive (p1 p2 ...) and check applicability at top of their own body (tail-position IF)
  for (const {m, fnName} of sortedWithIdx) {
    const mParamSyms = m.parameters.map((p) => makeSymbolNode(p));
    if (m.qualifier === 'PRIMARY' || m.qualifier === 'AROUND') {
      const cnmArgsSym = makeSymbolNode('%CNM_ARGS');
      generated.push(
        makeListNode([
          makeSymbolNode('DEFUN'),
          makeSymbolNode(fnName),
          makeListNode([nextFnSym, ...mParamSyms]),
          makeListNode([
            makeSymbolNode('FLET'),
            makeListNode([
              makeListNode([
                makeSymbolNode('NEXT-METHOD-P'),
                NIL_NODE,
                makeListNode([makeSymbolNode('IF'), nextFnSym, T_NODE, NIL_NODE]),
              ]),
              makeListNode([
                makeSymbolNode('CALL-NEXT-METHOD'),
                makeListNode([makeSymbolNode('&REST'), cnmArgsSym]),
                makeListNode([
                  makeSymbolNode('IF'),
                  nextFnSym,
                  makeListNode([
                    makeSymbolNode('IF'),
                    makeListNode([makeSymbolNode('NULL'), cnmArgsSym]),
                    makeListNode([makeSymbolNode('FUNCALL'), nextFnSym, ...mParamSyms]),
                    makeListNode([makeSymbolNode('APPLY'), nextFnSym, cnmArgsSym]),
                  ]),
                  makeListNode([
                    makeSymbolNode('ERROR'),
                    Object.freeze({kind: 'string', value: `no next method in ${generic.name}`}),
                  ]),
                ]),
              ]),
            ]),
            ...m.bodyForms,
          ]),
        ]),
      );
    } else {
      const appTest = buildMethodApplicabilityTest(mParamSyms, m);
      generated.push(
        makeListNode([
          makeSymbolNode('DEFUN'),
          makeSymbolNode(fnName),
          makeListNode(mParamSyms),
          appTest === T_NODE
            ? makeListNode([makeSymbolNode('PROGN'), ...m.bodyForms])
            : makeListNode([makeSymbolNode('WHEN'), appTest, ...m.bodyForms]),
        ]),
      );
    }
  }

  const primaries = sortedWithIdx
    .filter((x) => x.m.qualifier === 'PRIMARY')
    .sort((a, b) => compareMethodsBySpecificity(a.m, b.m, existingClasses));
  const befores = sortedWithIdx
    .filter((x) => x.m.qualifier === 'BEFORE')
    .sort((a, b) => compareMethodsBySpecificity(a.m, b.m, existingClasses));
  const afters = sortedWithIdx
    .filter((x) => x.m.qualifier === 'AFTER')
    .sort((a, b) => compareMethodsBySpecificity(b.m, a.m, existingClasses)); // least-specific first!
  const arounds = sortedWithIdx
    .filter((x) => x.m.qualifier === 'AROUND')
    .sort((a, b) => compareMethodsBySpecificity(a.m, b.m, existingClasses));

  // Build chain of applicable primary methods dynamically at dispatch time using flat %CONS-IF calls
  // so there are no non-tail IF branches in the dispatcher sequence.
  const primChainSym = makeSymbolNode('%PRIM_CHAIN');
  const primPushForms = [...primaries].reverse().map(({m, fnName}) =>
    makeListNode([
      makeSymbolNode('SETQ'),
      primChainSym,
      makeListNode([
        makeSymbolNode('%CONS-IF'),
        buildMethodApplicabilityTest(paramSyms, m),
        makeListNode([makeSymbolNode('FUNCTION'), makeSymbolNode(fnName)]),
        primChainSym,
      ]),
    ]),
  );

  const runPrimSym = makeSymbolNode('%RUN_PRIM');
  const chainParamSym = makeSymbolNode('%CHAIN');
  const cArgsSyms = generic.parameters.map((_, i) => makeSymbolNode(`%CA_${i}`));
  const nArgsSyms = generic.parameters.map((_, i) => makeSymbolNode(`%NA_${i}`));

  const coreCallSym = makeSymbolNode('%CORE_FN');
  const beforeForms = befores.map(({fnName}) =>
    makeListNode([makeSymbolNode(fnName), ...cArgsSyms]),
  );
  const afterForms = afters.map(({fnName}) =>
    makeListNode([makeSymbolNode(fnName), ...cArgsSyms]),
  );

  const primaryResultSym = makeSymbolNode('%PRIM_RES');
  const coreBody = makeListNode([
    makeSymbolNode('PROGN'),
    ...beforeForms,
    makeListNode([
      makeSymbolNode('IF'),
      makeListNode([makeSymbolNode('NULL'), primChainSym]),
      makeListNode([
        makeSymbolNode('ERROR'),
        Object.freeze({kind: 'string', value: `no applicable primary method for ${generic.name}`}),
      ]),
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([
            primaryResultSym,
            makeListNode([makeSymbolNode(runPrimSym.name), primChainSym, ...cArgsSyms]),
          ]),
        ]),
        ...afterForms,
        primaryResultSym,
      ]),
    ]),
  ]);

  const aroundChainSym = makeSymbolNode('%AROUND_CHAIN');
  const aroundPushForms = [...arounds].reverse().map(({m, fnName}) =>
    makeListNode([
      makeSymbolNode('SETQ'),
      aroundChainSym,
      makeListNode([
        makeSymbolNode('%CONS-IF'),
        buildMethodApplicabilityTest(paramSyms, m),
        makeListNode([makeSymbolNode('FUNCTION'), makeSymbolNode(fnName)]),
        aroundChainSym,
      ]),
    ]),
  );
  const runAroundSym = makeSymbolNode('%RUN_AROUND');
  const aChainParamSym = makeSymbolNode('%ACHAIN');

  generated.push(
    makeListNode([
      makeSymbolNode('DEFUN'),
      makeSymbolNode(generic.name),
      makeListNode(paramSyms),
      makeListNode([
        makeSymbolNode('LET'),
        makeListNode([
          makeListNode([primChainSym, NIL_NODE]),
          makeListNode([aroundChainSym, NIL_NODE]),
        ]),
        ...primPushForms,
        ...aroundPushForms,
        makeListNode([
          makeSymbolNode('LABELS'),
          makeListNode([
            makeListNode([
              runPrimSym,
              makeListNode([chainParamSym, ...cArgsSyms]),
              makeListNode([
                makeSymbolNode('FUNCALL'),
                makeListNode([makeSymbolNode('CAR'), chainParamSym]),
                makeListNode([
                  makeSymbolNode('IF'),
                  makeListNode([
                    makeSymbolNode('NULL'),
                    makeListNode([makeSymbolNode('CDR'), chainParamSym]),
                  ]),
                  NIL_NODE,
                  makeListNode([
                    makeSymbolNode('LAMBDA'),
                    makeListNode(nArgsSyms),
                    makeListNode([
                      runPrimSym,
                      makeListNode([makeSymbolNode('CDR'), chainParamSym]),
                      ...nArgsSyms,
                    ]),
                  ]),
                ]),
                ...cArgsSyms,
              ]),
            ]),
            makeListNode([
              coreCallSym,
              makeListNode(cArgsSyms),
              coreBody,
            ]),
            makeListNode([
              runAroundSym,
              makeListNode([aChainParamSym, ...cArgsSyms]),
              makeListNode([
                makeSymbolNode('IF'),
                makeListNode([makeSymbolNode('NULL'), aChainParamSym]),
                makeListNode([coreCallSym, ...cArgsSyms]),
                makeListNode([
                  makeSymbolNode('FUNCALL'),
                  makeListNode([makeSymbolNode('CAR'), aChainParamSym]),
                  makeListNode([
                    makeSymbolNode('LAMBDA'),
                    makeListNode(nArgsSyms),
                    makeListNode([
                      runAroundSym,
                      makeListNode([makeSymbolNode('CDR'), aChainParamSym]),
                      ...nArgsSyms,
                    ]),
                  ]),
                  ...cArgsSyms,
                ]),
              ]),
            ]),
          ]),
          makeListNode([runAroundSym, aroundChainSym, ...paramSyms]),
        ]),
      ]),
    ]),
  );

  return generated;
}

function designatorName(node) {
  if (!node) throw new SyntaxError('missing package/symbol designator');
  if (node.kind === 'string') return node.value.toUpperCase();
  if (node.kind === 'symbol') {
    return node.name.startsWith(':') ? node.name.slice(1) : stripPackagePrefix(node.name);
  }
  if (
    node.kind === 'list'
    && node.elements.length === 2
    && node.elements[0]?.kind === 'symbol'
    && node.elements[0].name === 'QUOTE'
    && node.elements[1]?.kind === 'symbol'
  ) {
    return stripPackagePrefix(node.elements[1].name);
  }
  throw new SyntaxError('invalid Common Lisp package/symbol designator');
}

function parseTopLevelDefpackage(form) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'DEFPACKAGE') {
    return null;
  }
  if (form.elements.length < 2) {
    throw new SyntaxError('Common Lisp DEFPACKAGE requires a package name');
  }
  const pkgName = designatorName(form.elements[1]);
  const uses = [];
  const exports = [];
  for (let i = 2; i < form.elements.length; i += 1) {
    const opt = form.elements[i];
    if (opt?.kind === 'list' && opt.elements[0]?.kind === 'symbol') {
      const key = opt.elements[0].name.startsWith(':')
        ? opt.elements[0].name
        : `:${stripPackagePrefix(opt.elements[0].name)}`;
      if (key === ':USE') {
        for (const u of opt.elements.slice(1)) {
          uses.push(designatorName(u));
        }
      } else if (key === ':EXPORT') {
        for (const e of opt.elements.slice(1)) {
          exports.push(designatorName(e));
        }
      }
    }
  }
  return Object.freeze({
    name: pkgName,
    uses,
    exports,
  });
}

function parseTopLevelInPackage(form) {
  if (form?.kind !== 'list' || form.elements[0]?.kind !== 'symbol' || form.elements[0].name !== 'IN-PACKAGE') {
    return null;
  }
  if (form.elements.length !== 2) {
    throw new SyntaxError('Common Lisp IN-PACKAGE requires 1 package designator');
  }
  return designatorName(form.elements[1]);
}

const CL_CORE_PACKAGES = new Set(['CL', 'COMMON-LISP', 'CL-USER', 'COMMON-LISP-USER']);

const CL_SPECIAL_AND_STD_SYMBOLS = new Set([
  'NIL', 'T', 'QUOTE', 'FUNCTION', 'PROGN', 'PROG1', 'PROG2', 'IF', 'COND', 'WHEN', 'UNLESS',
  'LET', 'LET*', 'FLET', 'LABELS', 'LAMBDA', 'DEFUN', 'DEFMACRO', 'DEFSETF', 'DEFSTRUCT', 'DEFCLASS',
  'DEFGENERIC', 'DEFMETHOD', 'DEFPACKAGE', 'IN-PACKAGE', 'DEFPARAMETER', 'DEFVAR',
  'SETQ', 'SETF', 'INCF', 'DECF', 'PUSH', 'POP', 'AND', 'OR', 'NOT', 'NULL', 'EQ', 'EQL', 'EQUAL',
  'CONS', 'CAR', 'CDR', 'FIRST', 'REST', 'SECOND', 'THIRD', 'NTH', 'NTHCDR', 'LAST', 'BUTLAST',
  'CAAR', 'CADR', 'CDAR', 'CDDR', 'RPLACA', 'RPLACD', 'CONSP', 'ATOM', 'LISTP', 'LIST', 'LIST*',
  'APPEND', 'REVERSE', 'LENGTH', 'SUBSEQ', 'ELT', 'COERCE', 'MAPCAR', 'MAPC', 'REMOVE-IF',
  'REMOVE-IF-NOT', 'REDUCE', 'EVERY', 'SOME', 'MEMBER', 'ASSOC', 'FUNCALL', 'APPLY', 'VALUES',
  'MULTIPLE-VALUE-BIND', 'MULTIPLE-VALUE-LIST', 'MULTIPLE-VALUE-CALL', 'NTH-VALUE',
  'MULTIPLE-VALUE-PROG1', 'VALUES-LIST', 'DESTRUCTURING-BIND',
  'BLOCK', 'RETURN-FROM', 'RETURN', 'CATCH', 'THROW', 'UNWIND-PROTECT', 'HANDLER-CASE',
  'HANDLER-BIND', 'IGNORE-ERRORS', 'RESTART-CASE', 'FIND-RESTART', 'INVOKE-RESTART',
  'SIGNAL', 'ERROR', 'USE-VALUE', 'SEND', 'DOLIST', 'DOTIMES', 'LOOP', 'CASE', 'ECASE',
  'MAKE-ARRAY', 'VECTOR', 'AREF', 'VECTORP', 'STRINGP', 'CHARACTERP', 'CHAR', 'CHAR-CODE',
  'CODE-CHAR', 'CHAR=', 'STRING=', 'STRING<', 'STRING>', 'CONCATENATE', 'MAKE-HASH-TABLE',
  'HASH-TABLE-P', 'GETHASH', 'REMHASH', 'MAPHASH', 'HASH-TABLE-COUNT', 'SYMBOLP', 'KEYWORDP',
  'SYMBOL-NAME', 'INTERN', 'FUNCTIONP', 'INTEGERP', 'NUMBERP', 'ZEROP', 'PLUSP', 'MINUSP',
  'EVENP', 'ODDP', 'ABS', 'MIN', 'MAX', 'MOD', 'REM', 'FLOOR', 'ASH', 'LOGAND', 'LOGIOR',
  'LOGXOR', 'LOGNOT', '1+', '1-', '+', '-', '*', '=', '/=', '<', '>', '<=', '>=',
  'SLOT-VALUE', 'MAKE-INSTANCE', 'INITIALIZE-INSTANCE', 'CLASS-OF', 'CLASS-NAME', 'TYPE-OF',
  'TYPEP', 'CALL-NEXT-METHOD', 'NEXT-METHOD-P', 'FORMAT', 'WITH-OUTPUT-TO-STRING',
  'MAKE-STRING-OUTPUT-STREAM', 'WRITE-STRING', 'WRITE-CHAR', 'TERPRI', 'PRINC', 'PRIN1',
  'GET-OUTPUT-STREAM-STRING', 'PRINC-TO-STRING', 'PRIN1-TO-STRING',
  'SET-MACRO-CHARACTER', 'GET-MACRO-CHARACTER', 'SET-DISPATCH-MACRO-CHARACTER',
  'GET-DISPATCH-MACRO-CHARACTER', 'READ-DELIMITED-LIST', 'READ', 'READ-CHAR', 'PEEK-CHAR',
  'UNREAD-CHAR', 'PARSE-INTEGER',
  '&OPTIONAL', '&REST', '&BODY', '&KEY', 'OTHERWISE',
  ...BUILT_IN_MACROS ? Object.keys(BUILT_IN_MACROS) : [],
]);

function resolveSymbolInPackage(symNode, currentPkg, packages, compileContext) {
  if (!symNode || symNode.kind !== 'symbol') return symNode;
  if (symNode.keyword || symNode.uninterned || isNilSymbol(symNode) || isTSymbol(symNode)) {
    return symNode;
  }
  const raw = symNode.name;
  // Explicit package qualification: PKG::SYM or PKG:SYM
  const dblIdx = raw.indexOf('::');
  if (dblIdx > 0) {
    const pkgPart = raw.slice(0, dblIdx);
    const symPart = raw.slice(dblIdx + 2);
    if (CL_CORE_PACKAGES.has(pkgPart)) {
      return makeSymbolNode(symPart, {spelling: symPart});
    }
    return makeSymbolNode(`${pkgPart}::${symPart}`, {spelling: `${pkgPart}::${symPart}`});
  }
  const sglIdx = raw.indexOf(':');
  if (sglIdx > 0) {
    const pkgPart = raw.slice(0, sglIdx);
    const symPart = raw.slice(sglIdx + 1);
    if (CL_CORE_PACKAGES.has(pkgPart)) {
      return makeSymbolNode(symPart, {spelling: symPart});
    }
    const pkgDef = packages[pkgPart];
    if (!pkgDef) {
      throw new SyntaxError(`Common Lisp package ${pkgPart} is not defined (resolving ${raw})`);
    }
    if (!pkgDef.exports?.includes(symPart)) {
      throw new SyntaxError(`Common Lisp symbol ${symPart} is not exported from package ${pkgPart}`);
    }
    return makeSymbolNode(`${pkgPart}::${symPart}`, {spelling: `${pkgPart}::${symPart}`});
  }

  // Unqualified symbol inside currentPkg
  if (!currentPkg || CL_CORE_PACKAGES.has(currentPkg)) {
    return symNode;
  }
  if (raw.startsWith('%') || raw.startsWith('&') || CL_SPECIAL_AND_STD_SYMBOLS.has(raw)) {
    return symNode;
  }
  // Check if symbol is inherited from a :USE package's exports
  const curPkgDef = packages[currentPkg];
  if (curPkgDef && Array.isArray(curPkgDef.uses)) {
    for (const usedPkgName of curPkgDef.uses) {
      if (CL_CORE_PACKAGES.has(usedPkgName)) continue;
      const usedPkg = packages[usedPkgName];
      if (usedPkg?.exports?.includes(raw)) {
        return makeSymbolNode(`${usedPkgName}::${raw}`, {spelling: `${usedPkgName}::${raw}`});
      }
    }
  }
  // If it resolves to a published Smalltalk class global, keep it unqualified
  if (compileContext?.globals?.[symNode.spelling] || compileContext?.globals?.[raw]) {
    const gId = compileContext.globals[symNode.spelling] ?? compileContext.globals[raw];
    if (typeof gId === 'string' && gId.startsWith('smalltalk/global-binding/')) {
      return symNode;
    }
  }
  return makeSymbolNode(`${currentPkg}::${raw}`, {spelling: `${currentPkg}::${raw}`});
}

function qualifyFormForPackage(form, currentPkg, packages, compileContext) {
  if (!form) return form;
  if (form.kind === 'symbol') {
    return resolveSymbolInPackage(form, currentPkg, packages, compileContext);
  }
  if (form.kind !== 'list') return form;
  if (form.elements.length === 0) return form;
  const head = form.elements[0];
  if (head?.kind === 'symbol' && (head.name === 'DEFPACKAGE' || head.name === 'IN-PACKAGE')) {
    return form;
  }
  if (head?.kind === 'symbol' && head.name === 'LOOP') {
    const loopClauseKeywords = new Set([
      'FOR', 'AS', 'FROM', 'DOWNFROM', 'UPFROM', 'TO', 'DOWNTO', 'UPTO', 'BELOW', 'ABOVE', 'BY',
      'IN', 'ON', 'ACROSS', '=', 'THEN', 'REPEAT', 'WITH', 'AND', 'WHILE', 'UNTIL', 'ALWAYS',
      'NEVER', 'THEREIS', 'WHEN', 'UNLESS', 'IF', 'ELSE', 'END', 'DO', 'DOING', 'RETURN',
      'COLLECT', 'COLLECTING', 'APPEND', 'APPENDING', 'NCONC', 'NCONCING', 'SUM', 'SUMMING',
      'COUNT', 'COUNTING', 'MAXIMIZE', 'MAXIMIZING', 'MINIMIZE', 'MINIMIZING', 'INTO',
      'INITIALLY', 'FINALLY',
    ]);
    return makeListNode(
      form.elements.map((el, idx) => {
        if (idx === 0) return head;
        if (el?.kind === 'symbol' && !el.name.includes(':') && loopClauseKeywords.has(el.name)) {
          return el;
        }
        return qualifyFormForPackage(el, currentPkg, packages, compileContext);
      }),
      form.dottedTail ? qualifyFormForPackage(form.dottedTail, currentPkg, packages, compileContext) : null,
    );
  }
  return makeListNode(
    form.elements.map((el) => qualifyFormForPackage(el, currentPkg, packages, compileContext)),
    form.dottedTail ? qualifyFormForPackage(form.dottedTail, currentPkg, packages, compileContext) : null,
  );
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
  if (headSym.name === 'DEFPARAMETER' && form.elements.length < 3) {
    throw new SyntaxError('Common Lisp DEFPARAMETER requires a variable name and initial value');
  }
  if (nameSym?.kind !== 'symbol' || isNilSymbol(nameSym) || isTSymbol(nameSym) || nameSym.keyword) {
    throw new SyntaxError(`Common Lisp ${headSym.name} target must be an ordinary symbol`);
  }
  return {
    kind: headSym.name,
    name: nameSym.name,
    hasValueForm: form.elements.length >= 3,
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
  const compileContext = await collectCommonLispCompileContext({images: effectiveImages, imageId});
  const rawForms = typeof source === 'string' ? readCommonLispSource(source, compileContext) : source;

  // Expand any top-level DEFPACKAGE, IN-PACKAGE, DEFMACRO, DEFSETF, DEFSTRUCT, DEFCLASS, DEFGENERIC, and DEFMETHOD
  // forms first so subsequent DEFUNs and expressions in the same program can use them immediately.
  const expandedTopForms = [];
  const macros = {};
  const structs = {};
  const classes = {};
  const generics = {};
  const packages = {};
  const setfExpanders = {};
  const readerMacros = {};
  const touchedGenerics = new Set();
  let classesModified = false;
  let currentPackage = null;

  const queue = [...rawForms];
  while (queue.length > 0) {
    const nextItem = queue.shift();
    const defpkg = parseTopLevelDefpackage(nextItem);
    if (defpkg) {
      const prevPkg = compileContext.packages[defpkg.name];
      const mergedPkg = Object.freeze({
        name: defpkg.name,
        uses: [...new Set([...(prevPkg?.uses ?? []), ...defpkg.uses])],
        exports: [...new Set([...(prevPkg?.exports ?? []), ...defpkg.exports])],
      });
      const serialized = JSON.stringify(mergedPkg);
      await ensureCodeArtifact(effectiveImages, imageId, {
        id: commonLispPackageArtifactId(mergedPkg.name, serialized),
        languageId: COMMON_LISP_ID,
        representation: COMMON_LISP_PACKAGE_V0,
        content: textValue(serialized),
        metadata: {commonLisp: 'defpackage', packageName: mergedPkg.name},
      });
      await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: `%PACKAGE:${mergedPkg.name}`,
        bindingId: commonLispPackageBindingId(mergedPkg.name),
        value: textValue(serialized),
      });
      const pkgNsId = commonLispPackageNamespaceId(mergedPkg.name);
      const existingPkgNs = await findNamespace({images: effectiveImages, imageId, namespaceId: pkgNsId});
      if (!existingPkgNs) {
        await createNamespace({
          images: effectiveImages,
          imageId,
          namespaceId: pkgNsId,
          parent: COMMON_LISP_NAMESPACE_ID,
        });
      }
      compileContext.packages[mergedPkg.name] = mergedPkg;
      packages[mergedPkg.name] = mergedPkg;
      continue;
    }

    const inPkg = parseTopLevelInPackage(nextItem);
    if (inPkg) {
      if (!CL_CORE_PACKAGES.has(inPkg) && !compileContext.packages[inPkg]) {
        throw new SyntaxError(`Common Lisp IN-PACKAGE unknown package: ${inPkg}`);
      }
      currentPackage = CL_CORE_PACKAGES.has(inPkg) ? null : inPkg;
      continue;
    }

    const rawForm = nextItem?.__packageQualified
      ? nextItem.form
      : qualifyFormForPackage(nextItem, currentPackage, compileContext.packages, compileContext);

    if (
      rawForm?.kind === 'list'
      && rawForm.elements[0]?.kind === 'symbol'
      && rawForm.elements[0].name !== 'DEFMACRO'
      && rawForm.elements[0].name !== 'DEFSETF'
      && rawForm.elements[0].name !== 'SET-MACRO-CHARACTER'
      && rawForm.elements[0].name !== 'SET-DISPATCH-MACRO-CHARACTER'
      && rawForm.elements[0].name !== 'DEFSTRUCT'
      && rawForm.elements[0].name !== 'DEFCLASS'
      && rawForm.elements[0].name !== 'DEFGENERIC'
      && rawForm.elements[0].name !== 'DEFMETHOD'
      && rawForm.elements[0].name !== 'DEFUN'
      && rawForm.elements[0].name !== 'DEFPARAMETER'
      && rawForm.elements[0].name !== 'DEFVAR'
    ) {
      const step = macroexpandCommonLispForm(rawForm, createMacroContext(compileContext));
      if (step.expanded) {
        queue.unshift({__packageQualified: true, form: step.form});
        continue;
      }
      if (rawForm.elements[0].name === 'PROGN') {
        queue.unshift(...rawForm.elements.slice(1).map((f) => ({__packageQualified: true, form: f})));
        continue;
      }
    }

    const rmDesc = parseTopLevelReaderMacroForm(rawForm);
    if (rmDesc) {
      const serialized = JSON.stringify(rmDesc);
      await ensureCodeArtifact(effectiveImages, imageId, {
        id: commonLispReaderMacroArtifactId(rmDesc.key, serialized),
        languageId: COMMON_LISP_ID,
        representation: COMMON_LISP_READER_MACRO_V0,
        content: textValue(serialized),
        metadata: {commonLisp: 'reader-macro', key: rmDesc.key},
      });
      await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: `%READER-MACRO:${rmDesc.key}`,
        bindingId: commonLispReaderMacroBindingId(rmDesc.key),
        value: textValue(serialized),
      });
      compileContext.readerMacros[rmDesc.key] = rmDesc;
      readerMacros[rmDesc.key] = rmDesc;
      continue;
    }

    const defsetf = parseTopLevelDefsetf(rawForm);
    if (defsetf) {
      const serialized = JSON.stringify(defsetf);
      await ensureCodeArtifact(effectiveImages, imageId, {
        id: commonLispSetfArtifactId(defsetf.name, serialized),
        languageId: COMMON_LISP_ID,
        representation: COMMON_LISP_SETF_V0,
        content: textValue(serialized),
        metadata: {commonLisp: 'defsetf', accessFn: defsetf.name},
      });
      await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: `%SETF:${defsetf.name}`,
        bindingId: commonLispSetfBindingId(defsetf.name),
        value: textValue(serialized),
      });
      if (defsetf.name.includes('::')) {
        const [pkgPart, bare] = defsetf.name.split('::');
        await ensureGlobalBindingInNamespace({
          images: effectiveImages,
          imageId,
          namespaceId: commonLispPackageNamespaceId(pkgPart),
          name: `%SETF:${bare}`,
          bindingId: commonLispSetfBindingId(defsetf.name),
          value: textValue(serialized),
        });
      }
      compileContext.setfExpanders[defsetf.name] = defsetf;
      setfExpanders[defsetf.name] = defsetf;
      continue;
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
      if (defmacro.name.includes('::')) {
        const [pkgPart, bare] = defmacro.name.split('::');
        await ensureGlobalBindingInNamespace({
          images: effectiveImages,
          imageId,
          namespaceId: commonLispPackageNamespaceId(pkgPart),
          name: `%MACRO:${bare}`,
          bindingId: commonLispMacroBindingId(defmacro.name),
          value: textValue(serialized),
        });
      }
      compileContext.macros[defmacro.name] = defmacro;
      macros[defmacro.name] = defmacro;
      continue;
    }

    const defstruct = parseTopLevelDefstruct(rawForm, compileContext.structs);
    if (defstruct) {
      const superclassRef = defstruct.parentClassName
        ? objectRef(imageId, `smalltalk/class/${defstruct.parentClassName}`)
        : kernel.objectClass;
      const structSlotDefaults = {};
      for (const s of defstruct.localSlots) {
        const df = s.defaultForm ?? NIL_NODE;
        if (isNilSymbol(df)) {
          structSlotDefaults[s.varName] = kernel.nil;
        } else if (isTSymbol(df)) {
          structSlotDefaults[s.varName] = await ensureInternedSymbol(effectiveImages, imageId, 'T');
        } else if (df.kind === 'integer') {
          structSlotDefaults[s.varName] = integerValue(BigInt(df.value));
        } else if (df.kind === 'string') {
          structSlotDefaults[s.varName] = textValue(df.value);
        } else if (df.kind === 'symbol' && df.keyword) {
          structSlotDefaults[s.varName] = await ensureInternedSymbol(
            effectiveImages,
            imageId,
            df.spelling || df.name,
          );
        } else if (
          df.kind === 'list'
          && df.elements.length === 2
          && df.elements[0]?.kind === 'symbol'
          && df.elements[0].name === 'QUOTE'
          && df.elements[1]?.kind === 'symbol'
        ) {
          structSlotDefaults[s.varName] = await ensureInternedSymbol(
            effectiveImages,
            imageId,
            df.elements[1].spelling || df.elements[1].name,
          );
        } else if (runtime?.invocations && runtime?.executor) {
          const initBlock = await installCommonLispBlock({
            images: effectiveImages,
            compilation: effectiveCompilation,
            imageId,
            source: [df],
            lane,
            compileContext,
          });
          const activation = await runtime.invocations.invokeBlock(
            objectRef(imageId, initBlock.block.id),
            [],
          );
          structSlotDefaults[s.varName] = await runtime.executor.execute(activation);
        } else {
          structSlotDefaults[s.varName] = kernel.nil;
        }
      }
      const {classRef, migrationReceipt: structMigrationReceipt = null} = await ensureClassFromDeclaration({
        images: effectiveImages,
        imageId,
        name: defstruct.className,
        superclassRef,
        instanceVariables: defstruct.localSlots.map((s) => s.varName),
        allowShapeEvolution: true,
        defaultSlotValues: structSlotDefaults,
        defaultSlotValue: kernel.nil,
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
      slotMethods.push({
        selector: `isClClass_${defstruct.name}`,
        source: '[ ^ self ]',
      });
      slotMethods.push({
        selector: 'clTypeName',
        source: `[ ^ '${defstruct.name}' ]`,
      });
      await reconcileMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef,
        methods: slotMethods,
      });
      await reconcileMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef: objectRef(imageId, `smalltalk/metaclass/${defstruct.className}`),
        methods: [{selector: 'clClassName', source: `[ ^ '${defstruct.name}' ]`}],
      });
      await reconcileMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef: kernel.objectClass,
        methods: [
          {selector: `isClStruct_${defstruct.name}`, source: '[ ^ nil ]'},
          {selector: `isClClass_${defstruct.name}`, source: '[ ^ nil ]'},
        ],
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
      if (defstruct.name.includes('::')) {
        const [pkgPart, bare] = defstruct.name.split('::');
        await ensureGlobalBindingInNamespace({
          images: effectiveImages,
          imageId,
          namespaceId: commonLispPackageNamespaceId(pkgPart),
          name: `%STRUCT:${bare}`,
          bindingId: commonLispStructBindingId(defstruct.name),
          value: textValue(serialized),
        });
      }
      compileContext.structs[defstruct.name] = defstruct;
      compileContext.globals[defstruct.className] = `smalltalk/global-binding/${defstruct.className}`;
      if (defstruct.constructorName) {
        compileContext.macros[defstruct.constructorName] = {
          kind: 'struct-constructor',
          struct: defstruct,
        };
      }
      structs[defstruct.name] = Object.freeze({...defstruct, classRef, migrationReceipt: structMigrationReceipt});
      expandedTopForms.push(...buildDefstructProgramForms(defstruct));
      continue;
    }

    const defclass = parseTopLevelDefclass(rawForm, compileContext.classes);
    if (defclass) {
      const superclassRef = defclass.parentClassName
        ? objectRef(imageId, `smalltalk/class/${defclass.parentClassName}`)
        : kernel.objectClass;
      const classSlotDefaults = {};
      for (const s of defclass.backingLocalSlots) {
        const df = s.initform ?? NIL_NODE;
        if (isNilSymbol(df)) {
          classSlotDefaults[s.varName] = kernel.nil;
        } else if (isTSymbol(df)) {
          classSlotDefaults[s.varName] = await ensureInternedSymbol(effectiveImages, imageId, 'T');
        } else if (df.kind === 'integer') {
          classSlotDefaults[s.varName] = integerValue(BigInt(df.value));
        } else if (df.kind === 'string') {
          classSlotDefaults[s.varName] = textValue(df.value);
        } else if (df.kind === 'symbol' && df.keyword) {
          classSlotDefaults[s.varName] = await ensureInternedSymbol(
            effectiveImages,
            imageId,
            df.spelling || df.name,
          );
        } else if (
          df.kind === 'list'
          && df.elements.length === 2
          && df.elements[0]?.kind === 'symbol'
          && df.elements[0].name === 'QUOTE'
          && df.elements[1]?.kind === 'symbol'
        ) {
          classSlotDefaults[s.varName] = await ensureInternedSymbol(
            effectiveImages,
            imageId,
            df.elements[1].spelling || df.elements[1].name,
          );
        } else if (runtime?.invocations && runtime?.executor) {
          const initBlock = await installCommonLispBlock({
            images: effectiveImages,
            compilation: effectiveCompilation,
            imageId,
            source: [df],
            lane,
            compileContext,
          });
          const activation = await runtime.invocations.invokeBlock(
            objectRef(imageId, initBlock.block.id),
            [],
          );
          classSlotDefaults[s.varName] = await runtime.executor.execute(activation);
        } else {
          classSlotDefaults[s.varName] = kernel.nil;
        }
      }
      const {classRef, migrationReceipt: classMigrationReceipt = null} = await ensureClassFromDeclaration({
        images: effectiveImages,
        imageId,
        name: defclass.className,
        superclassRef,
        instanceVariables: defclass.backingLocalSlots.map((s) => s.varName),
        allowShapeEvolution: true,
        defaultSlotValues: classSlotDefaults,
        defaultSlotValue: kernel.nil,
      });
      await publishSmalltalkClassGlobals({
        images: effectiveImages,
        imageId,
        names: [defclass.className],
      });
      const classMethods = [];
      for (const s of defclass.backingLocalSlots) {
        classMethods.push({selector: s.varName, source: `[ ^ ${s.varName} ]`});
        classMethods.push({selector: `${s.varName}:`, source: `[ :v | ${s.varName} := v. ^ self ]`});
        for (const r of [...s.readers, ...s.accessors]) {
          const cleanR = stripPackagePrefix(r);
          classMethods.push({selector: `clAcc_${cleanR}`, source: `[ ^ ${s.varName} ]`});
        }
        for (const a of s.accessors) {
          const cleanA = stripPackagePrefix(a);
          classMethods.push({selector: `clSetAcc_${cleanA}:`, source: `[ :v | ${s.varName} := v. ^ v ]`});
        }
        for (const w of s.writers) {
          const cleanW = stripPackagePrefix(w);
          classMethods.push({selector: `clWriter_${cleanW}:`, source: `[ :v | ${s.varName} := v. ^ v ]`});
        }
      }
      for (const anc of defclass.cpl) {
        classMethods.push({
          selector: `isClClass_${anc}`,
          source: '[ ^ self ]',
        });
      }
      classMethods.push({
        selector: 'clTypeName',
        source: `[ ^ '${defclass.name}' ]`,
      });
      await reconcileMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef,
        methods: classMethods,
      });
      await reconcileMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef: objectRef(imageId, `smalltalk/metaclass/${defclass.className}`),
        methods: [{selector: 'clClassName', source: `[ ^ '${defclass.name}' ]`}],
      });
      await reconcileMethodsFromSource({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        lane,
        classRef: kernel.objectClass,
        methods: [{selector: `isClClass_${defclass.name}`, source: '[ ^ nil ]'}],
      });

      const serialized = JSON.stringify(defclass);
      await ensureCodeArtifact(effectiveImages, imageId, {
        id: commonLispClassArtifactId(defclass.name, serialized),
        languageId: COMMON_LISP_ID,
        representation: COMMON_LISP_CLASS_V0,
        content: textValue(serialized),
        metadata: {commonLisp: 'defclass', className: defclass.name, backingClassName: defclass.className},
      });
      await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: COMMON_LISP_NAMESPACE_ID,
        name: `%CLASS:${defclass.name}`,
        bindingId: commonLispClassBindingId(defclass.name),
        value: textValue(serialized),
      });
      if (defclass.name.includes('::')) {
        const [pkgPart, bare] = defclass.name.split('::');
        await ensureGlobalBindingInNamespace({
          images: effectiveImages,
          imageId,
          namespaceId: commonLispPackageNamespaceId(pkgPart),
          name: `%CLASS:${bare}`,
          bindingId: commonLispClassBindingId(defclass.name),
          value: textValue(serialized),
        });
      }
      compileContext.classes[defclass.name] = defclass;
      compileContext.globals[defclass.className] = `smalltalk/global-binding/${defclass.className}`;
      classes[defclass.name] = Object.freeze({...defclass, classRef, migrationReceipt: classMigrationReceipt});
      classesModified = true;
      expandedTopForms.push(...buildDefclassProgramForms(defclass));
      continue;
    }

    const defgeneric = parseTopLevelDefgeneric(rawForm);
    if (defgeneric) {
      const existingGen = compileContext.generics[defgeneric.name];
      const genRecord = Object.freeze({
        name: defgeneric.name,
        parameters: defgeneric.parameters,
        methods: existingGen?.methods ?? [],
      });
      compileContext.generics[defgeneric.name] = genRecord;
      generics[defgeneric.name] = genRecord;
      touchedGenerics.add(defgeneric.name);
      continue;
    }

    const defmethod = parseTopLevelDefmethod(rawForm);
    if (defmethod) {
      const existingGen = compileContext.generics[defmethod.name];
      const prevMethods = existingGen?.methods ?? [];
      const filteredMethods = prevMethods.filter((m) => m.specKey !== defmethod.specKey);
      const nextMethods = [...filteredMethods, defmethod];
      const genRecord = Object.freeze({
        name: defmethod.name,
        parameters: existingGen?.parameters ?? defmethod.parameters,
        methods: nextMethods,
      });
      compileContext.generics[defmethod.name] = genRecord;
      generics[defmethod.name] = genRecord;
      touchedGenerics.add(defmethod.name);
      continue;
    }

    expandedTopForms.push(rawForm);
  }

  if (classesModified) {
    expandedTopForms.push(buildDynamicMakeInstanceDefun(compileContext.classes));
  }

  for (const genName of touchedGenerics) {
    const genRecord = compileContext.generics[genName];
    const serialized = JSON.stringify(genRecord);
    await ensureCodeArtifact(effectiveImages, imageId, {
      id: commonLispGenericArtifactId(genRecord.name, serialized),
      languageId: COMMON_LISP_ID,
      representation: COMMON_LISP_GENERIC_V0,
      content: textValue(serialized),
      metadata: {commonLisp: 'defgeneric', genericName: genRecord.name},
    });
    await ensureGlobalBindingInNamespace({
      images: effectiveImages,
      imageId,
      namespaceId: COMMON_LISP_NAMESPACE_ID,
      name: `%GENERIC:${genRecord.name}`,
      bindingId: commonLispGenericBindingId(genRecord.name),
      value: textValue(serialized),
    });
    if (genRecord.name.includes('::')) {
      const [pkgPart, bare] = genRecord.name.split('::');
      await ensureGlobalBindingInNamespace({
        images: effectiveImages,
        imageId,
        namespaceId: commonLispPackageNamespaceId(pkgPart),
        name: `%GENERIC:${bare}`,
        bindingId: commonLispGenericBindingId(genRecord.name),
        value: textValue(serialized),
      });
    }
    expandedTopForms.push(...buildDefgenericProgramForms(genRecord, compileContext.classes));
  }

  // Pre-seed all DEFUN (and their signatures) and DEFPARAMETER/DEFVAR global bindings so recursive
  // and mutually recursive functions can reference one another regardless of declaration order.
  const preMacroCtx = createMacroContext(compileContext);
  const preExistingVariables = new Map();
  for (const form of expandedTopForms) {
    if (form?.kind === 'list' && form.elements[0]?.kind === 'symbol' && form.elements[0].name === 'DEFUN') {
      const nameSpec = form.elements[1];
      const paramForm = form.elements[2] ?? NIL_NODE;
      const setfReader = parseSetfFunctionName(nameSpec);
      const fnName = setfReader
        ? canonicalSetfFunctionName(setfReader)
        : nameSpec?.kind === 'symbol'
          ? nameSpec.name
          : null;
      if (setfReader && fnName) {
        const setfDesc = Object.freeze({
          name: setfReader,
          kind: 'setf-function',
          writerFunctionName: fnName,
        });
        const setfJson = JSON.stringify(setfDesc);
        await ensureCodeArtifact(effectiveImages, imageId, {
          id: commonLispSetfArtifactId(setfReader, setfJson),
          languageId: COMMON_LISP_ID,
          representation: COMMON_LISP_SETF_V0,
          content: textValue(setfJson),
          metadata: {commonLisp: 'setf-function', accessFn: setfReader},
        });
        await ensureGlobalBindingInNamespace({
          images: effectiveImages,
          imageId,
          namespaceId: COMMON_LISP_NAMESPACE_ID,
          name: `%SETF:${setfReader}`,
          bindingId: commonLispSetfBindingId(setfReader),
          value: textValue(setfJson),
        });
        compileContext.setfExpanders[setfReader] = setfDesc;
        preMacroCtx.setfExpanders.set(setfReader, setfDesc);
        setfExpanders[setfReader] = setfDesc;
      }
      if (fnName) {
        const bindingId = commonLispFunctionBindingId(fnName);
        const existing = await resolveGlobal({
          images: effectiveImages,
          imageId,
          name: fnName,
          namespaceId: COMMON_LISP_NAMESPACE_ID,
        });
        if (!existing) {
          await publishGlobal({
            images: effectiveImages,
            imageId,
            namespaceId: COMMON_LISP_NAMESPACE_ID,
            name: fnName,
            bindingId,
            value: kernel.nil,
          });
        }
        compileContext.functionBindings[fnName] = bindingId;
        compileContext.globals[fnName] = bindingId;

        const parsedParams = parseLambdaList(paramForm);
        if (!parsedParams.isSimple) {
          const sig = Object.freeze({
            name: fnName,
            requiredCount: parsedParams.required.length,
            optionalCount: parsedParams.optional.length,
            hasRestOrKey: Boolean(parsedParams.rest !== null || parsedParams.keys.length > 0),
          });
          const sigJson = JSON.stringify(sig);
          await ensureCodeArtifact(effectiveImages, imageId, {
            id: commonLispSignatureArtifactId(fnName, sigJson),
            languageId: COMMON_LISP_ID,
            representation: COMMON_LISP_SIGNATURE_V0,
            content: textValue(sigJson),
            metadata: {commonLisp: 'signature', functionName: fnName},
          });
          await ensureGlobalBindingInNamespace({
            images: effectiveImages,
            imageId,
            namespaceId: COMMON_LISP_NAMESPACE_ID,
            name: `%SIG:${fnName}`,
            bindingId: commonLispSignatureBindingId(fnName),
            value: textValue(sigJson),
          });
          if (fnName.includes('::') && !fnName.startsWith('%')) {
            const [pkgPart, bare] = fnName.split('::');
            await ensureGlobalBindingInNamespace({
              images: effectiveImages,
              imageId,
              namespaceId: commonLispPackageNamespaceId(pkgPart),
              name: `%SIG:${bare}`,
              bindingId: commonLispSignatureBindingId(fnName),
              value: textValue(sigJson),
            });
          }
          compileContext.functionSignatures[fnName] = sig;
          preMacroCtx.functionSignatures.set(fnName, sig);
        }
      }
      continue;
    }
    const defvar = parseTopLevelDefvar(form);
    if (defvar) {
      const bindingId = commonLispVariableBindingId(defvar.name);
      if (!preExistingVariables.has(defvar.name)) {
        const existing = await resolveGlobal({
          images: effectiveImages,
          imageId,
          name: defvar.name,
          namespaceId: COMMON_LISP_NAMESPACE_ID,
        });
        if (!existing) {
          preExistingVariables.set(defvar.name, false);
          await publishGlobal({
            images: effectiveImages,
            imageId,
            namespaceId: COMMON_LISP_NAMESPACE_ID,
            name: defvar.name,
            bindingId,
            value: kernel.nil,
          });
        } else {
          preExistingVariables.set(defvar.name, true);
        }
      }
      compileContext.variableBindings[defvar.name] = bindingId;
      compileContext.globals[defvar.name] = bindingId;
    }
  }

  const functions = {};
  const variables = {};
  const expressions = [];
  const initializedVariables = new Set();

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
        sourceText: formatCommonLispForm(form),
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
      if (defun.name.includes('::') && !defun.name.startsWith('%')) {
        const [pkgPart, bare] = defun.name.split('::');
        if (!bare.startsWith('%')) {
          await ensureGlobalBindingInNamespace({
            images: effectiveImages,
            imageId,
            namespaceId: commonLispPackageNamespaceId(pkgPart),
            name: bare,
            bindingId: commonLispFunctionBindingId(defun.name),
            value: blockRef,
          });
        }
      }
      functions[defun.name] = Object.freeze({
        name: defun.name,
        blockRef,
        bindingRef,
        installed,
      });
      if (!defun.name.startsWith('%') && form?.kind === 'list' && form.elements.length >= 3) {
        try {
          const parsedFn = normalizeFunctionDefinition(defun.name, form.elements[2], form.elements.slice(3), 'defun');
          compileContext.userFunctions[defun.name] = parsedFn;
          if (defun.name.includes('::')) {
            const [, bare] = defun.name.split('::');
            if (bare) compileContext.userFunctions[bare] = parsedFn;
          }
        } catch {
          // ignore if complex parameter list
        }
      }
      continue;
    }

    const defvar = parseTopLevelDefvar(form);
    if (defvar) {
      const bindingId = commonLispVariableBindingId(defvar.name);
      const alreadyBound = Boolean(preExistingVariables.get(defvar.name)) || initializedVariables.has(defvar.name);
      if (defvar.kind === 'DEFVAR' && (alreadyBound || !defvar.hasValueForm)) {
        const existingRecord = await effectiveImages.getObject(imageId, bindingId);
        const currentValue = existingRecord?.slots?.['global-binding-value'] ?? kernel.nil;
        const bindingRef = objectRef(imageId, bindingId);
        if (defvar.name.includes('::')) {
          const [pkgPart, bare] = defvar.name.split('::');
          await ensureGlobalBindingInNamespace({
            images: effectiveImages,
            imageId,
            namespaceId: commonLispPackageNamespaceId(pkgPart),
            name: bare,
            bindingId,
            value: currentValue,
          });
        }
        if (defvar.hasValueForm) {
          initializedVariables.add(defvar.name);
        }
        variables[defvar.name] = Object.freeze({
          name: defvar.name,
          bindingRef,
          value: currentValue,
        });
        continue;
      }

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
        bindingId,
        value: initValue,
      });
      if (defvar.name.includes('::')) {
        const [pkgPart, bare] = defvar.name.split('::');
        await ensureGlobalBindingInNamespace({
          images: effectiveImages,
          imageId,
          namespaceId: commonLispPackageNamespaceId(pkgPart),
          name: bare,
          bindingId,
          value: initValue,
        });
      }
      initializedVariables.add(defvar.name);
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
    classes: Object.freeze(classes),
    generics: Object.freeze(generics),
    packages: Object.freeze(packages),
    setfExpanders: Object.freeze(setfExpanders),
    readerMacros: Object.freeze(readerMacros),
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
    const classNames = Object.keys(programResult.classes);
    if (classNames.length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, classNames[classNames.length - 1]);
    }
    const genericNames = Object.keys(programResult.generics);
    if (genericNames.length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, genericNames[genericNames.length - 1]);
    }
    const structNames = Object.keys(programResult.structs);
    if (structNames.length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, structNames[structNames.length - 1]);
    }
    const macroNames = Object.keys(programResult.macros);
    if (macroNames.length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, macroNames[macroNames.length - 1]);
    }
    const pkgNames = Object.keys(programResult.packages);
    if (pkgNames.length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, pkgNames[pkgNames.length - 1]);
    }
    const setfNames = Object.keys(programResult.setfExpanders ?? {});
    if (setfNames.length > 0 && Object.keys(programResult.functions).length === 0) {
      return ensureInternedSymbol(runtime.images, imageId, setfNames[setfNames.length - 1]);
    }
    const fnNames = Object.keys(programResult.functions);
    if (fnNames.length > 0) {
      return programResult.functions[fnNames[fnNames.length - 1]].blockRef;
    }
    const varNames = Object.keys(programResult.variables);
    if (varNames.length > 0) {
      return programResult.variables[varNames[varNames.length - 1]].value;
    }
    if (Object.keys(programResult.readerMacros ?? {}).length > 0) {
      return ensureInternedSymbol(runtime.images, imageId, 'T');
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

async function listCommonLispNamespaceBindings({
  images,
  imageId,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const functions = [];
  const macros = [];
  const structs = [];
  const variables = [];
  const isRootNs = namespaceId === COMMON_LISP_NAMESPACE_ID;
  for (const [entryName, bindingRef] of ns.entries.entries()) {
    const id = bindingRef?.objectId ?? '';
    if (id.startsWith('common-lisp/function-binding/')) {
      if (!entryName.startsWith('%') && (!isRootNs || !entryName.includes('::'))) {
        functions.push(entryName);
      }
    } else if (id.startsWith('common-lisp/macro-binding/') && entryName.startsWith('%MACRO:')) {
      const mName = entryName.slice('%MACRO:'.length);
      if (!isRootNs || !mName.includes('::')) macros.push(mName);
    } else if (id.startsWith('common-lisp/struct-binding/') && entryName.startsWith('%STRUCT:')) {
      const sName = entryName.slice('%STRUCT:'.length);
      if (!isRootNs || !sName.includes('::')) structs.push(sName);
    } else if (id.startsWith('common-lisp/variable-binding/')) {
      if (!entryName.startsWith('%') && (!isRootNs || !entryName.includes('::'))) {
        variables.push(entryName);
      }
    }
  }
  functions.sort((a, b) => a.localeCompare(b));
  macros.sort((a, b) => a.localeCompare(b));
  structs.sort((a, b) => a.localeCompare(b));
  variables.sort((a, b) => a.localeCompare(b));
  return Object.freeze({
    functions: Object.freeze(functions),
    macros: Object.freeze(macros),
    structs: Object.freeze(structs),
    variables: Object.freeze(variables),
  });
}

async function readCommonLispFunctionDefinition({
  images,
  imageId,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const canonical = requiredText(name, 'Common Lisp function name').toUpperCase();
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const bindingRef = ns.entries.get(canonical);
  if (!bindingRef || !bindingRef.objectId.startsWith('common-lisp/function-binding/')) return null;

  const bindingRecord = await images.getObject(bindingRef.imageId, bindingRef.objectId);
  const blockRef = bindingRecord?.slots?.['global-binding-value'];
  if (!isObjectRef(blockRef)) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} has a malformed function binding for ${canonical}`,
    );
  }
  const block = await images.getBlock(blockRef.imageId, blockRef.objectId);
  if (!block) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} binds function ${canonical} to a missing Block: `
      + `${blockRef.imageId}/${blockRef.objectId}`,
    );
  }

  const semanticArtifact = await images.getCodeArtifact(blockRef.imageId, `${blockRef.objectId}:semantic`);
  let parameters = [];
  if (semanticArtifact?.content?.kind === VALUE_KIND.TEXT) {
    const parsed = JSON.parse(semanticArtifact.content.value);
    if (Array.isArray(parsed?.parameters)) {
      parameters = parsed.parameters.map((p) => (typeof p === 'string' ? p : p.name));
    }
  }

  let requiredCount = parameters.length;
  let optionalCount = 0;
  let hasRestOrKey = false;
  const sigBindingRef = ns.entries.get(`%SIG:${canonical}`);
  if (sigBindingRef?.objectId.startsWith('common-lisp/signature-binding/')) {
    const sigRecord = await images.getObject(sigBindingRef.imageId, sigBindingRef.objectId);
    const sigVal = sigRecord?.slots?.['global-binding-value'];
    if (sigVal?.kind === VALUE_KIND.TEXT) {
      const parsedSig = JSON.parse(sigVal.value);
      requiredCount = Number(parsedSig.requiredCount ?? parameters.length);
      optionalCount = Number(parsedSig.optionalCount ?? 0);
      hasRestOrKey = Boolean(parsedSig.hasRestOrKey);
    }
  }

  const sourceArtifact = await images.getCodeArtifact(blockRef.imageId, `${blockRef.objectId}:source`);
  const source = sourceArtifact?.representation === COMMON_LISP_SOURCE_V0
    && sourceArtifact?.content?.kind === VALUE_KIND.TEXT
    ? sourceArtifact.content.value
    : null;

  return Object.freeze({
    name: canonical,
    blockRef,
    signature: Object.freeze({
      parameters: Object.freeze(parameters),
      requiredCount,
      optionalCount,
      hasRestOrKey,
    }),
    source,
  });
}

async function readCommonLispMacroDefinition({
  images,
  imageId,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const canonical = requiredText(name, 'Common Lisp macro name').toUpperCase();
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const bindingRef = ns.entries.get(`%MACRO:${canonical}`);
  if (!bindingRef || !bindingRef.objectId.startsWith('common-lisp/macro-binding/')) return null;

  const record = await images.getObject(bindingRef.imageId, bindingRef.objectId);
  const val = record?.slots?.['global-binding-value'];
  if (val?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} has a malformed macro binding for ${canonical}`,
    );
  }
  const parsed = JSON.parse(val.value);
  const lambdaList = formatCommonLispForm(parsed.lambdaList);
  const source = formatCommonLispForm(
    makeListNode([
      makeSymbolNode('DEFMACRO'),
      makeSymbolNode(parsed.name),
      parsed.lambdaList,
      ...(parsed.bodyForms ?? []),
    ]),
  );
  return Object.freeze({
    name: canonical,
    lambdaList,
    source,
  });
}

async function readCommonLispStructDefinition({
  images,
  imageId,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const canonical = requiredText(name, 'Common Lisp struct name').toUpperCase();
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const bindingRef = ns.entries.get(`%STRUCT:${canonical}`);
  if (!bindingRef || !bindingRef.objectId.startsWith('common-lisp/struct-binding/')) return null;

  const record = await images.getObject(bindingRef.imageId, bindingRef.objectId);
  const val = record?.slots?.['global-binding-value'];
  if (val?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} has a malformed struct binding for ${canonical}`,
    );
  }
  const parsed = JSON.parse(val.value);
  const classRef = objectRef(imageId, `smalltalk/class/${parsed.className}`);
  try {
    await readBehavior(images, classRef);
  } catch (error) {
    throw new TypeError(
      `Common Lisp struct ${canonical} in ${imageId}/${namespaceId} has a missing backing class: `
      + `${classRef.imageId}/${classRef.objectId}`,
      {cause: error},
    );
  }
  return Object.freeze({
    name: canonical,
    classRef,
    className: parsed.className,
    include: parsed.includeName ?? null,
    concName: parsed.concName,
    constructor: parsed.constructorName ?? null,
    predicate: parsed.predicateName ?? null,
    copier: parsed.copierName ?? null,
    slots: Object.freeze((parsed.slots ?? []).map((s) => s.name)),
    localSlots: Object.freeze((parsed.localSlots ?? []).map((s) => s.name)),
  });
}

async function readCommonLispClassDefinition({
  images,
  imageId,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const canonical = requiredText(name, 'Common Lisp class name').toUpperCase();
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const bindingRef = ns.entries.get(`%CLASS:${canonical}`);
  if (!bindingRef || !bindingRef.objectId.startsWith('common-lisp/class-binding/')) return null;

  const record = await images.getObject(bindingRef.imageId, bindingRef.objectId);
  const val = record?.slots?.['global-binding-value'];
  if (val?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} has a malformed class binding for ${canonical}`,
    );
  }
  const parsed = JSON.parse(val.value);
  const classRef = objectRef(imageId, `smalltalk/class/${parsed.className}`);
  try {
    await readBehavior(images, classRef);
  } catch (error) {
    throw new TypeError(
      `Common Lisp class ${canonical} in ${imageId}/${namespaceId} has a missing backing class: `
      + `${classRef.imageId}/${classRef.objectId}`,
      {cause: error},
    );
  }
  return Object.freeze({
    name: canonical,
    classRef,
    className: parsed.className,
    superclasses: Object.freeze([...(parsed.superclasses ?? [])]),
    cpl: Object.freeze([...(parsed.cpl ?? [])]),
    slots: Object.freeze((parsed.slots ?? []).map((s) => s.name)),
    localSlots: Object.freeze((parsed.localSlots ?? []).map((s) => s.name)),
  });
}

async function readCommonLispGenericDefinition({
  images,
  imageId,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const canonical = requiredText(name, 'Common Lisp generic function name').toUpperCase();
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const bindingRef = ns.entries.get(`%GENERIC:${canonical}`);
  if (!bindingRef || !bindingRef.objectId.startsWith('common-lisp/generic-binding/')) return null;

  const record = await images.getObject(bindingRef.imageId, bindingRef.objectId);
  const val = record?.slots?.['global-binding-value'];
  if (val?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} has a malformed generic binding for ${canonical}`,
    );
  }
  const parsed = JSON.parse(val.value);
  return Object.freeze({
    name: canonical,
    parameters: Object.freeze([...(parsed.parameters ?? [])]),
    methods: Object.freeze(
      (parsed.methods ?? []).map((m) =>
        Object.freeze({
          qualifier: m.qualifier,
          specializers: Object.freeze(
            (m.specializers ?? []).map((s) =>
              s.kind === 'eql' ? `(EQL ${formatCommonLispForm(s.valueForm)})` : s.typeName,
            ),
          ),
        }),
      ),
    ),
  });
}

async function readCommonLispVariableDefinition({
  images,
  imageId,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const canonical = requiredText(name, 'Common Lisp variable name').toUpperCase();
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const bindingRef = ns.entries.get(canonical);
  if (!bindingRef || !bindingRef.objectId.startsWith('common-lisp/variable-binding/')) return null;

  const record = await images.getObject(bindingRef.imageId, bindingRef.objectId);
  if (!record || !Object.hasOwn(record.slots ?? {}, 'global-binding-value')) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} has a malformed variable binding for ${canonical}`,
    );
  }
  return Object.freeze({
    name: canonical,
    value: record.slots['global-binding-value'],
  });
}

function designatorSpellingAndName(node) {
  if (!node) throw new SyntaxError('missing Common Lisp designator');
  if (node.kind === 'string') {
    return {spelling: node.value, name: node.value.toUpperCase()};
  }
  if (node.kind === 'symbol') {
    const raw = node.spelling ?? node.name;
    const stripped = raw.startsWith('#:')
      ? raw.slice(2)
      : raw.startsWith(':')
        ? raw.slice(1)
        : stripPackagePrefix(raw);
    return {spelling: stripped.toLowerCase(), name: designatorName(node)};
  }
  if (
    node.kind === 'list'
    && node.elements.length === 2
    && node.elements[0]?.kind === 'symbol'
    && node.elements[0].name === 'QUOTE'
    && node.elements[1]?.kind === 'symbol'
  ) {
    const sym = node.elements[1];
    const stripped = stripPackagePrefix(sym.spelling ?? sym.name);
    return {spelling: stripped.toLowerCase(), name: designatorName(node)};
  }
  throw new SyntaxError('invalid Common Lisp designator');
}

function parseDefsystemComponentTree(specsForm, {
  systemName,
  parentPath = '',
  serial = false,
} = {}) {
  const rawSpecs = isNilSymbol(specsForm)
    ? []
    : specsForm?.kind === 'list'
      ? specsForm.elements
      : null;
  if (!rawSpecs) {
    throw new SyntaxError(`Common Lisp DEFSYSTEM ${systemName} :components must be a list`);
  }

  const parsedNodes = [];
  let prevSiblingName = null;

  for (const spec of rawSpecs) {
    if (spec?.kind !== 'list' || spec.elements.length < 2 || spec.elements[0]?.kind !== 'symbol') {
      throw new SyntaxError(`invalid component specification in Common Lisp DEFSYSTEM ${systemName}`);
    }
    const [kindSym, nameNode, ...plist] = spec.elements;
    const kindKey = kindSym.name.startsWith(':')
      ? kindSym.name
      : `:${stripPackagePrefix(kindSym.name)}`;
    const {spelling, name: canonicalName} = designatorSpellingAndName(nameNode);

    let explicitPathname = null;
    let moduleSerial = false;
    let childComponentsForm = NIL_NODE;
    const explicitDependsOn = [];

    for (let i = 0; i + 1 < plist.length; i += 2) {
      const optKeyNode = plist[i];
      const optValNode = plist[i + 1];
      if (optKeyNode?.kind !== 'symbol') continue;
      const k = optKeyNode.name.startsWith(':')
        ? optKeyNode.name
        : `:${stripPackagePrefix(optKeyNode.name)}`;
      if (k === ':PATHNAME' && optValNode?.kind === 'string') {
        explicitPathname = optValNode.value;
      } else if (k === ':SERIAL') {
        moduleSerial = !isNilSymbol(optValNode);
      } else if (k === ':COMPONENTS') {
        childComponentsForm = optValNode;
      } else if (k === ':DEPENDS-ON') {
        const depItems = isNilSymbol(optValNode)
          ? []
          : optValNode?.kind === 'list'
            ? optValNode.elements
            : null;
        if (!depItems) {
          throw new SyntaxError(`Common Lisp DEFSYSTEM ${systemName} component ${canonicalName} :depends-on must be a list`);
        }
        for (const d of depItems) {
          explicitDependsOn.push(designatorName(d));
        }
      }
    }

    if (serial && prevSiblingName && !explicitDependsOn.includes(prevSiblingName)) {
      explicitDependsOn.unshift(prevSiblingName);
    }
    prevSiblingName = canonicalName;

    const segment = explicitPathname ?? spelling;
    const relPath = parentPath ? `${parentPath}/${segment}` : segment;

    if (kindKey === ':FILE' || kindKey === ':CL-SOURCE-FILE') {
      parsedNodes.push(
        Object.freeze({
          kind: 'file',
          name: canonicalName,
          spelling,
          path: relPath,
          dependsOn: Object.freeze(explicitDependsOn),
        }),
      );
    } else if (kindKey === ':MODULE') {
      const childTree = parseDefsystemComponentTree(childComponentsForm, {
        systemName,
        parentPath: relPath,
        serial: moduleSerial,
      });
      parsedNodes.push(
        Object.freeze({
          kind: 'module',
          name: canonicalName,
          spelling,
          path: relPath,
          serial: moduleSerial,
          dependsOn: Object.freeze(explicitDependsOn),
          components: childTree,
        }),
      );
    } else {
      throw new SyntaxError(`unsupported component kind ${kindKey} in Common Lisp DEFSYSTEM ${systemName}`);
    }
  }

  return Object.freeze(parsedNodes);
}

function resolveSystemComponentLoadOrder(systemName, componentTree) {
  const leafByPath = new Map();
  const leafOrder = [];
  const leafDeps = new Map();

  function collectLeaves(nodes) {
    const siblingMap = new Map();
    for (const node of nodes) {
      if (siblingMap.has(node.name)) {
        throw new SyntaxError(`duplicate component ${node.name} in Common Lisp DEFSYSTEM ${systemName}`);
      }
      if (node.kind === 'file') {
        leafByPath.set(node.path, node);
        leafOrder.push(node.path);
        leafDeps.set(node.path, new Set());
        siblingMap.set(node.name, {node, leafPaths: [node.path]});
      } else {
        const subLeaves = collectLeaves(node.components);
        siblingMap.set(node.name, {node, leafPaths: subLeaves});
      }
    }

    for (const {node, leafPaths} of siblingMap.values()) {
      for (const depSiblingName of node.dependsOn) {
        const target = siblingMap.get(depSiblingName);
        if (!target) {
          throw new SyntaxError(
            `Common Lisp DEFSYSTEM ${systemName} component ${node.name} depends on unknown component ${depSiblingName}`,
          );
        }
        for (const myLeaf of leafPaths) {
          const depSet = leafDeps.get(myLeaf);
          for (const targetLeaf of target.leafPaths) {
            if (myLeaf === targetLeaf) {
              throw new SyntaxError(`cyclic Common Lisp component dependency in system ${systemName}: ${myLeaf}`);
            }
            depSet.add(targetLeaf);
          }
        }
      }
    }

    const allLeaves = [];
    for (const {leafPaths} of siblingMap.values()) {
      allLeaves.push(...leafPaths);
    }
    return allLeaves;
  }

  collectLeaves(componentTree);

  const sorted = [];
  const state = new Map(); // 0 = unvisited, 1 = visiting, 2 = visited

  function visit(path, stack = []) {
    const st = state.get(path) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      const cycle = [...stack, path].join(' -> ');
      throw new SyntaxError(`cyclic Common Lisp component dependency in system ${systemName}: ${cycle}`);
    }
    state.set(path, 1);
    const deps = leafDeps.get(path) ?? new Set();
    for (const depPath of deps) {
      visit(depPath, [...stack, path]);
    }
    state.set(path, 2);
    sorted.push(path);
  }

  for (const path of leafOrder) {
    visit(path, []);
  }

  return Object.freeze(sorted);
}

function parseSingleDefsystemForm(form) {
  if (form?.kind !== 'list' || form.elements.length < 2 || form.elements[0]?.kind !== 'symbol') {
    return null;
  }
  const headBare = stripPackagePrefix(form.elements[0].name);
  if (headBare !== 'DEFSYSTEM') {
    return null;
  }
  const {spelling, name: systemName} = designatorSpellingAndName(form.elements[1]);
  let description = null;
  let version = null;
  let serial = false;
  const dependsOn = [];
  let componentsForm = NIL_NODE;

  const plist = form.elements.slice(2);
  for (let i = 0; i + 1 < plist.length; i += 2) {
    const optKeyNode = plist[i];
    const optValNode = plist[i + 1];
    if (optKeyNode?.kind !== 'symbol') continue;
    const k = optKeyNode.name.startsWith(':')
      ? optKeyNode.name
      : `:${stripPackagePrefix(optKeyNode.name)}`;
    if (k === ':DESCRIPTION' && optValNode?.kind === 'string') {
      description = optValNode.value;
    } else if (k === ':VERSION' && optValNode?.kind === 'string') {
      version = optValNode.value;
    } else if (k === ':SERIAL') {
      serial = !isNilSymbol(optValNode);
    } else if (k === ':DEPENDS-ON') {
      const depItems = isNilSymbol(optValNode)
        ? []
        : optValNode?.kind === 'list'
          ? optValNode.elements
          : null;
      if (!depItems) {
        throw new SyntaxError(`Common Lisp DEFSYSTEM ${systemName} :depends-on must be a list`);
      }
      for (const d of depItems) {
        dependsOn.push(designatorName(d));
      }
    } else if (k === ':COMPONENTS') {
      componentsForm = optValNode;
    }
  }

  const components = parseDefsystemComponentTree(componentsForm, {
    systemName,
    parentPath: '',
    serial,
  });
  const loadOrder = resolveSystemComponentLoadOrder(systemName, components);

  return Object.freeze({
    name: systemName,
    spelling,
    description,
    version,
    serial,
    dependsOn: Object.freeze(dependsOn),
    components,
    loadOrder,
  });
}

function parseCommonLispDefsystem(source, {systemName = null} = {}) {
  const forms = typeof source === 'string'
    ? readCommonLispSource(source)
    : Array.isArray(source)
      ? source
      : [source];
  const parsedSystems = [];
  for (const form of forms) {
    const sys = parseSingleDefsystemForm(form);
    if (sys) parsedSystems.push(sys);
  }
  if (parsedSystems.length === 0) {
    throw new SyntaxError('no Common Lisp DEFSYSTEM form found in source');
  }
  if (systemName !== null) {
    const target = String(systemName).toUpperCase();
    const match = parsedSystems.find((s) => s.name === target);
    if (!match) {
      throw new SyntaxError(`Common Lisp DEFSYSTEM ${target} not found in source`);
    }
    return match;
  }
  return parsedSystems[0];
}

function lookupComponentFileSource(files, componentPath) {
  if (!files || typeof files !== 'object') return null;
  const getEntry = (k) => (files instanceof Map ? files.get(k) : Object.hasOwn(files, k) ? files[k] : undefined);
  const candidates = [
    componentPath,
    `${componentPath}.lisp`,
    `${componentPath}.cl`,
    componentPath.toLowerCase(),
    `${componentPath.toLowerCase()}.lisp`,
    `${componentPath.toLowerCase()}.cl`,
  ];
  for (const c of candidates) {
    const found = getEntry(c);
    if (typeof found === 'string' || Array.isArray(found)) return found;
  }
  const normalizedTarget = componentPath.replace(/\.(lisp|cl)$/i, '').toLowerCase();
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  for (const [k, v] of entries) {
    const normalizedKey = String(k).replace(/^\.\//, '').replace(/\.(lisp|cl)$/i, '').toLowerCase();
    if (normalizedKey === normalizedTarget && (typeof v === 'string' || Array.isArray(v))) {
      return v;
    }
  }
  return null;
}

function lookupDependencySystemSpec(systems, depSysName) {
  if (!systems || typeof systems !== 'object') return null;
  const entries = systems instanceof Map ? [...systems.entries()] : Object.entries(systems);
  const target = String(depSysName).toUpperCase();
  for (const [k, v] of entries) {
    const cleanKey = String(k).replace(/^:/, '').replace(/\.asd$/i, '').toUpperCase();
    if (cleanKey === target) return v;
  }
  return null;
}

async function installCommonLispSystem({
  images,
  compilation = null,
  runtime = null,
  imageId,
  asdSource,
  files = {},
  systems = {},
  systemName = null,
  lane = 'neutral',
  _parsedSysDef = null,
  _visiting = new Set(),
  _installed = new Map(),
} = {}) {
  const effectiveImages = images ?? runtime?.images;
  const effectiveCompilation = resolveCompilation(effectiveImages, compilation ?? runtime?.compilation ?? null);
  requiredText(imageId, 'image id');
  assertMethodLane(lane);

  await installCommonLispRuntime({
    images: effectiveImages,
    compilation: effectiveCompilation,
    imageId,
    lane,
  });

  const sysDef = _parsedSysDef ?? parseCommonLispDefsystem(asdSource, {systemName});
  if (_installed.has(sysDef.name)) {
    return _installed.get(sysDef.name);
  }
  if (_visiting.has(sysDef.name)) {
    throw new SyntaxError(`cyclic Common Lisp system dependency involving ${sysDef.name}`);
  }
  _visiting.add(sysDef.name);

  const dependentSystems = {};
  const artifactDependencies = [];
  for (const depName of sysDef.dependsOn) {
    if (_visiting.has(depName)) {
      throw new SyntaxError(`cyclic Common Lisp system dependency involving ${depName}`);
    }
    if (_installed.has(depName)) {
      const depInstalled = _installed.get(depName);
      dependentSystems[depName] = depInstalled;
      if (depInstalled?.artifact) {
        artifactDependencies.push({
          role: `system:${depName}`,
          artifact: depInstalled.artifact,
        });
      }
      continue;
    }
    const depSpec = lookupDependencySystemSpec(systems, depName);
    if (depSpec) {
      const depAsdSource = typeof depSpec === 'string' || Array.isArray(depSpec)
        ? depSpec
        : depSpec.asdSource ?? depSpec.source;
      const depFiles = (typeof depSpec === 'object' && !Array.isArray(depSpec) && depSpec.files)
        ? depSpec.files
        : files;
      const depResult = await installCommonLispSystem({
        images: effectiveImages,
        compilation: effectiveCompilation,
        runtime,
        imageId,
        asdSource: depAsdSource,
        files: depFiles,
        systems,
        systemName: depName,
        lane,
        _visiting,
        _installed,
      });
      dependentSystems[depName] = depResult;
      artifactDependencies.push({
        role: `system:${depName}`,
        artifact: depResult.artifact,
      });
      continue;
    }
    const existingEntry = await readCommonLispSystemBindingRecord({
      images: effectiveImages,
      imageId,
      name: depName,
    });
    if (!existingEntry) {
      throw new SyntaxError(`Common Lisp system ${sysDef.name} depends on unknown system ${depName}`);
    }
    dependentSystems[depName] = existingEntry.definition;
    artifactDependencies.push({
      role: `system:${depName}`,
      artifact: existingEntry.artifactRef,
    });
  }

  const programs = {};
  const componentArtifacts = {};
  for (const componentPath of sysDef.loadOrder) {
    const fileSource = lookupComponentFileSource(files, componentPath);
    if (fileSource === null) {
      throw new SyntaxError(`Common Lisp system ${sysDef.name} missing source file for component ${componentPath}`);
    }
    const sourceText = typeof fileSource === 'string'
      ? fileSource
      : fileSource.map(formatCommonLispForm).join('\n');
    const componentArtifact = await ensureCodeArtifact(effectiveImages, imageId, {
      id: commonLispSystemComponentArtifactId(sysDef.name, componentPath, sourceText),
      languageId: COMMON_LISP_ID,
      representation: COMMON_LISP_SOURCE_V0,
      logicalPath: `${componentPath}.lisp`,
      content: textValue(sourceText),
      metadata: {
        commonLisp: 'system-component',
        systemName: sysDef.name,
        componentPath,
      },
    });
    const componentRef = objectRef(imageId, componentArtifact.id);
    componentArtifacts[componentPath] = componentRef;
    artifactDependencies.push({
      role: `component:${componentPath}`,
      artifact: componentRef,
    });
    const progResult = await installCommonLispProgram({
      images: effectiveImages,
      compilation: effectiveCompilation,
      runtime,
      imageId,
      source: fileSource,
      lane,
      skipRuntimeEnsure: true,
    });
    if (progResult.expressions.length > 0 && runtime?.invocations && runtime?.executor) {
      const exprBlock = await installCommonLispBlock({
        images: effectiveImages,
        compilation: effectiveCompilation,
        imageId,
        source: progResult.expressions,
        lane,
        compileContext: progResult.compileContext,
      });
      const activation = await runtime.invocations.invokeBlock(
        objectRef(imageId, exprBlock.block.id),
        [],
      );
      await runtime.executor.execute(activation);
    }
    programs[componentPath] = progResult;
  }

  const serialized = JSON.stringify(sysDef);
  const artifact = await ensureCodeArtifact(effectiveImages, imageId, {
    id: commonLispSystemArtifactId(sysDef.name, serialized),
    languageId: COMMON_LISP_ID,
    representation: COMMON_LISP_SYSTEM_V0,
    content: textValue(serialized),
    dependencies: artifactDependencies,
    metadata: {commonLisp: 'defsystem', systemName: sysDef.name},
  });
  const bindingRef = await ensureGlobalBindingInNamespace({
    images: effectiveImages,
    imageId,
    namespaceId: COMMON_LISP_NAMESPACE_ID,
    name: `%SYSTEM:${sysDef.name}`,
    bindingId: commonLispSystemBindingId(sysDef.name),
    value: textValue(serialized),
  });

  _visiting.delete(sysDef.name);
  const result = Object.freeze({
    system: sysDef,
    artifact: objectRef(imageId, artifact.id),
    componentArtifacts: Object.freeze(componentArtifacts),
    bindingRef,
    loadOrder: sysDef.loadOrder,
    programs: Object.freeze(programs),
    dependentSystems: Object.freeze(dependentSystems),
  });
  _installed.set(sysDef.name, result);
  return result;
}

async function installCommonLispSystemFromArtifact({
  images,
  compilation = null,
  runtime = null,
  imageId,
  systemArtifact,
  lane = 'neutral',
  _visiting = new Set(),
  _installed = new Map(),
} = {}) {
  const effectiveImages = images ?? runtime?.images;
  const effectiveCompilation = resolveCompilation(effectiveImages, compilation ?? runtime?.compilation ?? null);
  requiredText(imageId, 'image id');
  assertMethodLane(lane);

  const artifactId = typeof systemArtifact === 'string'
    ? systemArtifact
    : isObjectRef(systemArtifact)
      ? systemArtifact.objectId
      : '';
  requiredText(artifactId, 'Common Lisp system artifact id');
  if (isObjectRef(systemArtifact) && systemArtifact.imageId !== imageId) {
    throw new TypeError(`Common Lisp system artifact ${systemArtifact.imageId}/${artifactId} does not belong to image ${imageId}`);
  }

  const artifact = await effectiveImages.getCodeArtifact(imageId, artifactId);
  if (!artifact || artifact.representation !== COMMON_LISP_SYSTEM_V0 || artifact.content?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(`CodeArtifact ${imageId}/${artifactId} is not a ${COMMON_LISP_SYSTEM_V0} artifact`);
  }

  const rawSysDef = JSON.parse(artifact.content.value);
  const sysDef = Object.freeze({
    name: requiredText(rawSysDef?.name, 'Common Lisp system name').toUpperCase(),
    spelling: rawSysDef?.spelling ?? rawSysDef?.name,
    description: rawSysDef?.description ?? null,
    version: rawSysDef?.version ?? null,
    serial: Boolean(rawSysDef?.serial),
    dependsOn: Object.freeze([...(rawSysDef?.dependsOn ?? [])]),
    components: Object.freeze([...(rawSysDef?.components ?? [])]),
    loadOrder: Object.freeze([...(rawSysDef?.loadOrder ?? [])]),
  });

  if (_installed.has(sysDef.name)) {
    return _installed.get(sysDef.name);
  }
  if (_visiting.has(sysDef.name)) {
    throw new SyntaxError(`cyclic Common Lisp system dependency involving ${sysDef.name}`);
  }

  const depSystemRefs = new Map();
  const files = {};
  for (const dep of artifact.dependencies ?? []) {
    const role = typeof dep?.role === 'string' ? dep.role : '';
    const depRef = dep?.artifact;
    if (!isObjectRef(depRef) || depRef.imageId !== imageId) continue;
    if (role.startsWith('system:')) {
      const depName = role.slice('system:'.length).toUpperCase();
      if (depName.length > 0) {
        depSystemRefs.set(depName, depRef);
      }
    } else if (role.startsWith('component:')) {
      const componentPath = role.slice('component:'.length);
      const compArtifact = await effectiveImages.getCodeArtifact(imageId, depRef.objectId);
      if (!compArtifact || compArtifact.representation !== COMMON_LISP_SOURCE_V0 || compArtifact.content?.kind !== VALUE_KIND.TEXT) {
        throw new TypeError(
          `Common Lisp system ${sysDef.name} component ${componentPath} artifact ${imageId}/${depRef.objectId} is not a ${COMMON_LISP_SOURCE_V0} artifact`,
        );
      }
      files[componentPath] = compArtifact.content.value;
    }
  }

  _visiting.add(sysDef.name);
  for (const depName of sysDef.dependsOn) {
    if (_visiting.has(depName)) {
      throw new SyntaxError(`cyclic Common Lisp system dependency involving ${depName}`);
    }
    if (!_installed.has(depName) && depSystemRefs.has(depName)) {
      await installCommonLispSystemFromArtifact({
        images: effectiveImages,
        compilation: effectiveCompilation,
        runtime,
        imageId,
        systemArtifact: depSystemRefs.get(depName),
        lane,
        _visiting,
        _installed,
      });
    }
  }
  _visiting.delete(sysDef.name);

  return await installCommonLispSystem({
    images: effectiveImages,
    compilation: effectiveCompilation,
    runtime,
    imageId,
    _parsedSysDef: sysDef,
    files,
    lane,
    _visiting,
    _installed,
  });
}

async function readCommonLispSystemBindingRecord({
  images,
  imageId,
  name,
  namespaceId = COMMON_LISP_NAMESPACE_ID,
} = {}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'Common Lisp namespace id');
  const canonical = requiredText(name, 'Common Lisp system name').replace(/^:/, '').toUpperCase();
  const ns = await findNamespace({images, imageId, namespaceId});
  if (!ns) throw new TypeError(`image ${imageId} has no Common Lisp namespace: ${namespaceId}`);
  const bindingRef = ns.entries.get(`%SYSTEM:${canonical}`);
  if (!bindingRef || !bindingRef.objectId.startsWith('common-lisp/system-binding/')) return null;

  const record = await images.getObject(bindingRef.imageId, bindingRef.objectId);
  const val = record?.slots?.['global-binding-value'];
  if (val?.kind !== VALUE_KIND.TEXT) {
    throw new TypeError(
      `Common Lisp namespace ${imageId}/${namespaceId} has a malformed system binding for ${canonical}`,
    );
  }
  const parsed = JSON.parse(val.value);
  const definition = Object.freeze({
    name: canonical,
    description: parsed.description ?? null,
    version: parsed.version ?? null,
    serial: Boolean(parsed.serial),
    dependsOn: Object.freeze([...(parsed.dependsOn ?? [])]),
    components: Object.freeze([...(parsed.components ?? [])]),
    loadOrder: Object.freeze([...(parsed.loadOrder ?? [])]),
  });
  return Object.freeze({
    definition,
    serialized: val.value,
    artifactRef: objectRef(imageId, commonLispSystemArtifactId(canonical, val.value)),
    bindingRef,
  });
}

async function readCommonLispSystemDefinition(options = {}) {
  const entry = await readCommonLispSystemBindingRecord(options);
  return entry ? entry.definition : null;
}

export {
  BLOCK_CLOSURE_CLASS_NAME,
  BLOCK_EXIT_CLASS_NAME,
  CL_NIL_BINDING_ID,
  CL_T_BINDING_ID,
  COMMON_LISP,
  COMMON_LISP_CLASS_V0,
  COMMON_LISP_GENERIC_V0,
  COMMON_LISP_ID,
  COMMON_LISP_MACRO_V0,
  COMMON_LISP_NAMESPACE_ID,
  COMMON_LISP_PACKAGE_V0,
  COMMON_LISP_READER_MACRO_V0,
  COMMON_LISP_SETF_V0,
  COMMON_LISP_SIGNATURE_V0,
  COMMON_LISP_SOURCE_V0,
  COMMON_LISP_STRUCT_V0,
  COMMON_LISP_SYNTAX_V0,
  COMMON_LISP_SYSTEM_V0,
  CONS_CLASS_NAME,
  CONS_SHAPE_ID,
  RUNTIME_BLOCK_IDS,
  attachCommonLispMethod,
  commonLispClassArtifactId,
  commonLispClassBindingId,
  commonLispFunctionBindingId,
  commonLispFunctionBlockId,
  commonLispGenericArtifactId,
  commonLispGenericBindingId,
  commonLispListToArray,
  commonLispMacroArtifactId,
  commonLispMacroBindingId,
  commonLispPackageArtifactId,
  commonLispPackageBindingId,
  commonLispPackageNamespaceId,
  commonLispReaderMacroArtifactId,
  commonLispReaderMacroBindingId,
  commonLispSetfArtifactId,
  commonLispSetfBindingId,
  commonLispStructArtifactId,
  commonLispStructBindingId,
  commonLispSystemArtifactId,
  commonLispSystemBindingId,
  commonLispSystemComponentArtifactId,
  commonLispVariableBindingId,
  compileCommonLispBlock,
  compileCommonLispSemanticProgram,
  evaluateCommonLispSource,
  expandAllMacrosInForm,
  formatCommonLispForm,
  installCommonLispBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  installCommonLispSystem,
  installCommonLispSystemFromArtifact,
  listCommonLispNamespaceBindings,
  macroexpand1CommonLispForm,
  macroexpandCommonLispForm,
  parseCommonLispDefsystem,
  readCommonLispClassDefinition,
  readCommonLispFunctionDefinition,
  readCommonLispGenericDefinition,
  readCommonLispMacroDefinition,
  readCommonLispSource,
  readCommonLispStructDefinition,
  readCommonLispSystemDefinition,
  readCommonLispVariableDefinition,
  tokenizeCommonLispSource,
};
