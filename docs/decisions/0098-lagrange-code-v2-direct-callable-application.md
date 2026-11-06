# 0098. `lagrange-code/v2` and `neutral-expression/v2` direct callable application

Status: implemented
Proven by: test/lagrange-code-v2.test.js, test/failure-conformance.test.js, test/steering-docs.test.js

## Context

In `lagrange-code/v0` and `lagrange-code/v1`, invoking another Block from semantic code is only expressible as `{op: 'send', languageId, receiver, message, arguments}` (for example, sending `'value'` or `'value:'` under `symmetric-smalltalk`). While message dispatch is the right model for object-oriented method invocation, requiring every direct Block application in a functional or procedural guest language (Scheme, ML, Rust/WASM glue, or a language-neutral combinator) to synthesize a `languageId` and a selector string couples direct function/closure application to a language dispatcher.

Per ADR 0035 and ADR 0043, named semantic and executable representations are closed grammars: `lagrange-code/v0`, `lagrange-code/v1`, `neutral-expression/v0`, and `neutral-expression/v1` remain frozen so existing artifacts never change meaning.

## Decision

1. **`lagrange-code/v2` and `neutral-expression/v2` representations (`src/code/lagrange-code-v1.js`, `src/execution/neutral-expression-v1.js`)**:
   - Introduce `LAGRANGE_CODE_V2 = 'lagrange-code/v2'` and `NEUTRAL_EXPRESSION_V2 = 'neutral-expression/v2'`.
   - `lagrange-code/v1` and `neutral-expression/v1` remain frozen and continue to reject `op: 'apply'`.
   - `lagrange-code/v2` and `neutral-expression/v2` support all `v1` operations (`literal`, `argument`, `receiver`, `binding`, `binding-write`, `sequence`, `integer-add`, `equals`, `if`, `send`, `block` / `make-block`) plus direct callable application:
     `{op: 'apply', callee: <expression>, arguments: [<expression>, ...]}`.
   - Evaluation order is left-to-right: `callee` is evaluated first, followed by each entry of `arguments` in order, before invoking the target Block.

2. **`ActivationExecutor` `context.invokeBlock(blockRef, args)` (`src/execution/activation-executor.js`)**:
   - Expose `invokeBlock(blockRef, args = [], {attenuate = null} = {})` on the active execution context alongside `sendMessage` and `invokeResolvedMethod`.
   - `invokeBlock` enforces the activation depth limit (`MAX_ACTIVATION_DEPTH`), prepares a direct Block activation via `InvocationService.prepareActivation({block: blockRef, arguments: args, images: view})` with `receiver: null` and `dispatch: null`, and executes it in the shared lexical cell arena and condition runtime with inherited (or attenuated) authority and `dispatchImage: nestedActivation.block.imageId`.
   - Because `receiver` is `null` and no `invocationFrame` or `inheritedFrame` is passed:
     - `assertBlockApplicationReceiver` accepts the activation as a legitimate direct Block invocation for all callable bindings (WASM, foreign-runtime, image projection/mutation/creation/observation, and non-loop kernel primitives), while loop primitives (`assertLoopBlock`) still refuse direct un-dispatched application.
     - An arbitrary Block invoked via `apply` inside a method never borrows the caller method's `self`/`definingBehavior` frame, whereas a lexical closure created inside a framed activation still restores its own creation frame from the arena (`arena.frameFor(activation.block)` per ADR 0050).

3. **Interpreter and WASM compilation and execution (`src/compilation/index.js`, `src/wasm/compiler-v1.js`, `src/wasm/resumable-compiler-v2.js`, `src/wasm/executor-v1.js`, `src/wasm/resumable-executor-v2.js`, `src/wasm/tree-installer.js`, `src/wasm/tree-installer-v1.js`)**:
   - Register `(LAGRANGE_CODE_V2, NEUTRAL_EXPRESSION_V2)` and `(LAGRANGE_CODE_V2, WASM_MODULE_V2)` in `createDefaultCodeCompilerRegistry()`, and register `NEUTRAL_EXPRESSION_V2` in `createDefaultCodeExecutorRegistry()` and `createPortableCodeExecutorRegistry()`.
   - In the WASM backends (`WASM_VALUE_HANDLE_ABI_V1` for tail-only modules and `WASM_RESUMABLE_VALUE_HANDLE_ABI_V2` for resumable modules), an `apply` site is recorded in `sendSites` as `{kind: 'apply', arity}` and invoked through `send_site_<i>` with `1 + arity` Value handles (`callee` followed by `arguments`), suspending with `{kind: 'apply', request: {callee, arguments}}` and re-entering `context.invokeBlock(callee, arguments)`.

## Consequences

- Functional and polyglot guest compilers targeting `lagrange-code/v2`—as well as `polyglotMethodBridgeDescriptor` / `definePolyglotMethodBridge` in `src/language/smalltalk-class-builder.js` (ADR 0095)—apply closures, WASM callables, foreign-runtime callables, and image bindings directly by Block reference via `op: 'apply'` without routing through a language message dispatcher or `value:` selector string.
- Both the neutral interpreter (`neutral-expression/v2`) and the WASM lane (`wasm-module/v2`) execute `apply` with identical left-to-right evaluation, frame isolation, authority propagation, and failure conformance when `callee` is not an unpinned Block reference.
