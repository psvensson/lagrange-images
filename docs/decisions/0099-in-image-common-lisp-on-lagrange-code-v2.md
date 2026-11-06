# 0099. In-image Common Lisp subset compiler targeting `lagrange-code/v2` and neutral frames

Status: implemented
Proven by: test/common-lisp-in-image.test.js, test/steering-docs.test.js

## Context

ADR 0084 integrated Common Lisp via an external SBCL foreign-runtime process (`common-lisp/sbcl-runtime-definition-v1`), where Lisp heaps stay foreign runtime state outside the image graph. Meanwhile, ADR 0098 introduced `lagrange-code/v2` and `neutral-expression/v2` with direct callable Block application (`{op: 'apply', callee, arguments}` and `context.invokeBlock`), and `InvocationService` / `ActivationExecutor` gained language-neutral `{environment, metadata}` execution frames alongside object-oriented `{self, definingBehavior}` frames.

To make Common Lisp usable as an image-native language personality whose functions, closures, cons cells, symbols, globals, and condition handlers live directly in the durable image graph and compile to both the neutral interpreter (`neutral-expression/v2`) and the Lagrange WASM lane (`wasm-module/v2` / `wasm-function/v2`), we need an in-image Common Lisp compiler and runtime owner (`src/language/common-lisp.js`) that shares the same image substrate as Symmetric Smalltalk without duplicating storage, global-binding, closure, or condition machinery.

## Decision

1. **In-image Common Lisp personality and compiler owner (`src/language/common-lisp.js`)**:
   - Register `COMMON_LISP` (`id: 'common-lisp'`), `COMMON_LISP_SOURCE_V0 = 'common-lisp/source-v0'`, and `COMMON_LISP_SYNTAX_V0 = 'common-lisp/syntax-v0'` in `createDefaultLanguagePlatform()`.
   - Provide a deterministic S-expression reader (`tokenizeCommonLispSource`, `readCommonLispSource`) supporting `;` line comments, nested `#| ... |#` block comments, radix integers (`#x`, `#b`, `#o`), escaped strings, symbols (case-folded to uppercase for `name` while preserving exact `spelling` for Smalltalk interop, plus `|...|` pipe escapes), keywords (`:kw`), quote `'x`, function quote `#'x`, quasiquote `` `(a ,b ,@c) ``, and dotted pairs `(a . b)`.
   - Compile Common Lisp forms to `lagrange-code/v2` (`compileCommonLispSemanticProgram`, `compileCommonLispBlock`) using `op: 'apply'` for function/callable invocation and `op: 'send'` (under `symmetric-smalltalk`) only when explicitly crossing into Smalltalk methods or primitives (`(send receiver 'selector arg ...)`).

2. **Generalized boolean truthiness over `lagrange-code/v2` (`if` requires canonical booleans)**:
   - In Common Lisp, `NIL` / `()` is canonical `smalltalk/nil` (the single falsy value), `T` is canonical `booleanValue(true)`, and every non-`NIL` value (including `0`, `""`, cons cells, symbols, and functions) is truthy.
   - Because `lagrange-code` `if` branches require a canonical boolean condition, the Common Lisp compiler tests non-guaranteed-boolean conditions via `{op: 'equals', left: expr, right: $nil}` and flips the `then` / `else` arms, emitting zero extra host sends for truthiness checks.

3. **Lexical bindings, mutation cells, and escaping closures**:
   - Unmutated lexical variables (`let`, `let*`, `lambda`, `flet`) capture by `mode: 'snapshot'`, allowing non-mutating closures to escape activations and promote to durable image Blocks in both `neutral` and `wasm` lanes.
   - Lexical variables mutated via `setq` or self/mutually-recursive local functions bound via `labels` use `mode: 'cell'` (`lagrange-code/v2` mutable lexical cells, ADR 0043).

4. **Shared durable graph objects (`Cons`, `Symbol`, `GlobalBinding`, `BlockClosure`)**:
   - `Cons` (`smalltalk/class/Cons`, instance shape `smalltalk/cons-instance-shape/v1` with `indexed: SHAPE_INDEXED.VALUES` of length 2 for `car` and `cdr`) is an ordinary image class installed by `installCommonLispRuntime`. Smalltalk methods `car`, `cdr`, `car:`, `cdr:`, and `isCons` are bridged onto `Cons` (and `Object>>isCons` answering `false`) via `definePolyglotMethodBridge`, so lists constructed in Common Lisp are inspectable and mutable from Smalltalk and vice versa.
   - Common Lisp symbols intern through the image's canonical `Symbol` interner (`smalltalk/symbol-intern-block/v1`).
   - Top-level `defun`, `defparameter`, and `defvar` bind in the dedicated namespace `COMMON_LISP_NAMESPACE_ID = 'common-lisp/namespace/v1'` using the shared `GlobalBinding` owner (`src/language/smalltalk-globals.js`, ADR 0057/0061), pre-seeding bindings before compiling a program so recursive and mutually-recursive `defun` forms resolve at compile time and support live redefinition.
   - `classOf` in `src/language/smalltalk-primitives-objects.js` resolves callable `Block` references (including transient arena closures) to `smalltalk/class/BlockClosure` when present in the image, enabling `(functionp fn)`, `(atom fn)`, and `(consp fn)` to classify functions accurately without a special Value kind.

5. **Shared condition protocol (`unwind-protect`, `handler-case`, `handler-bind`, `ignore-errors`) and lexical non-local exits (`block`, `return-from`, `return`)**:
   - Common Lisp condition handling compiles directly to the existing execution-wide condition primitives (`block-ensure`, `block-on-do`, `condition-signal`, `condition-resume` in `src/language/smalltalk-primitives-control.js` over `src/execution/conditions.js`, ADR 0054).
   - `handler-case` installs a handler that transfers control out of the protected form on match (`return-from-handler`), while `handler-bind` runs the handler in the signalling dynamic extent so `(use-value v c)` resumes the signalling site with `v` across both Common Lisp and Smalltalk frames.
   - Lexical `block`, `return-from`, and `return` (including implicit function blocks on `defun`, `flet`, and `labels`) allocate a unique lexical tag per `block` activation and unwind through `smalltalk/class/BlockExit` and `return-from-handler`, running all intermediate `unwind-protect` cleanups even across nested closures.

6. **Phase 2 practical usability (`defmacro`, lambda-list destructuring, `setf`, `defstruct`, vectors, strings/characters, and hash tables)**:
   - User-defined macros (`defmacro`, `gensym`, `macroexpand-1`, `macroexpand`) persist in `common-lisp/namespace/v1` (`common-lisp/macro-v0`) and support full macro lambda-list destructuring (`&optional`, `&rest`, `&body`, `&key`, and nested lists), alongside built-in macros (`prog2`, `dolist`, `dotimes`, `case`, `ecase`, `destructuring-bind`, `setf`, `incf`, `decf`, `push`, `pop`) and lambda-list keywords (`&optional`, `&rest`, `&key`) on `defun`, `lambda`, `flet`, and `labels`.
   - Native `defstruct` (`common-lisp/struct-v0`) compiles directly to Lagrange Shapes and Classes via `ensureClassFromDeclaration` (supporting `:include` single inheritance, keyword and positional `make-<name>`, `<name>-p`, `copy-<name>`, `<name>-<slot>`, and `(setf (<name>-<slot> ...) ...)`), interoperable with Symmetric Smalltalk.
   - Vectors (`#(...)`, `vector`, `make-array`, `aref`, `svref`, `vectorp`), strings/characters (`#\...`, `char`, `char-code`, `code-char`, `characterp`, `concatenate`), and hash tables (`make-hash-table`, `gethash`, `remhash`, `maphash`, `hash-table-count`, `hash-table-p`) map directly onto image-native `Array`, `Text`/`Character`, and `Dictionary` objects.

## Consequences

- Common Lisp programs compile and execute in-image across both the `neutral` (`neutral-expression/v2`) and `wasm` (`wasm-module/v2` / `wasm-function/v2`) lanes, and the entire compiler and runtime surface ships in the portable module closure with zero Node-only dependencies while keeping `src/portable-runtime.js` and `src/runtime.js` language-neutral.
- Common Lisp and Symmetric Smalltalk interoperate bidirectionally in a single image: Common Lisp invokes Smalltalk methods via `(send ...)`, Smalltalk attaches Common Lisp functions as native methods via `attachCommonLispMethod` / `definePolyglotMethodBridge`, and both languages share `Cons` cells, `Symbol`s, `GlobalBinding`s, and dynamic condition handlers.
