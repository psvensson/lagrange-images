# ADR 0082: a compiled WASM function owns only its entry selection, in identity-bearing content (wasm-function/v2)

Status: implemented
Proven by: test/wasm-function-v2.test.js, test/wasm-module-v2-portable-release.test.js, test/wasm-closure.test.js

## Problem

`wasm-function/v1` mirrored its module's function-table entry — `abi`, `parameters`, `captures`,
`cellBindings` — and carried its closure-prototype binding (`closurePrototypes`) in code-artifact
`metadata`, with the module ref as content. ADR 0074 strips metadata from the portable bundle, so
after ADR 0081 made the *module* survive release, an installed **Block** over compiled WASM still
could not dispatch: the function dispatcher chose an executor by `code.metadata.abi` and the
executors read entry/arity/captures from the function's metadata. Two records also disagreed about
one fact (the executors cross-checked the mirrors against the module on every activation).

## Decision

1. **`wasm-function/v1` is frozen.** Existing durable v1 functions stay executable in-image through
   the function-contract owner's frozen decoder, which cross-checks their mirrors against the module
   exactly as the executors always did. Nothing produces v1.

2. **`wasm-function/v2` owns exactly the function-local facts.** Content is the canonical JSON
   `{entry, closurePrototypes: [{blockId, siteIndex, derivedFromIndex}]}`; the module is reached
   through exactly one `role: module` dependency (one authority, never repeated in JSON). Prototype
   Blocks are named by index into `derivedFrom = [semantic, module, ...prototypes]` because a
   dependency edge must target a code artifact and a prototype is a Block; the bundle preserves
   `derivedFrom`, so the binding survives release. `metadata` is empty provenance.

3. **ABI, arity, captures and cellBindings are the module's.** They are resolved at execution from
   the module's function-table entry through the module accessor (`moduleFunctionOf`), never
   duplicated on the function. The dispatcher chooses the executor by the **module's** ABI after
   resolving the module once and hands it to the chosen executor (no second read).

4. **One owner.** `src/wasm/function-contract.js` is the sole decoder of both versions
   (`readFunctionSelection`, `functionModuleRef`, `resolveFunctionContract`) and the sole describer of
   v2 (`describeWasmFunctionV2`); function assembly (`assembleWasmFunctionArtifact`,
   `assembleWasmV1FunctionArtifact`) and the Smalltalk class builder write through it. Canonical form
   is enforced on read. Outside the frozen v1 decoder, zero consumers recover function executable
   semantics from provenance metadata.

5. **Identity.** Same module + same entry ⇒ same identity; a different entry over the same module ⇒
   different identity; provenance-only differences ⇒ unchanged identity. The module binding enters
   identity through the dependency edge, as for `wasm-module/v2`.

## Consequences

- The ADR 0081 release proof is now **Block-level**: a captured, bundled, managed-installed Project
  executes its Blocks (single-function v0 lane and the lexical-cell nested-Block tree with closure
  prototypes) in a fresh runtime with the compiler stubbed out and semantic source reads refused.
- The executor registry serves `wasm-function/v1` and `wasm-function/v2` with one executor.
- The portable static closure grows by exactly `src/wasm/function-contract.js` (110 -> 111).
- Not merged into `wasm-callable-interface/v1`: that is the foreign lane; the compiled lane keeps
  its own representation owner (no parallel callable lane).

## Not in scope

Changes to the Value-handle ABIs, executor semantics, the neutral-expression lane, or the
foreign callable/component lanes.
