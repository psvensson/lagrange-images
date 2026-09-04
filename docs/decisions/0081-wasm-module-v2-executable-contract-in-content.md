# ADR 0081: the compiled WASM module's executable contract lives in identity-bearing content (wasm-module/v2)

Status: implemented
Proven by: test/wasm-module-contract.test.js, test/wasm-module-v2-persistence.test.js, test/wasm-module-v2-portable-release.test.js

## Problem

`wasm-module/v1` kept its entire executable contract — ABI, literals, the exported function table
(`entry`, `memberIndex`, `parameters`, `captures`, `cellBindings`, site indices), send/closure/effect
sites — in code-artifact `metadata`, with the compiled bytes as content. ADR 0074 strips metadata
from the portable graph bundle, so a captured and installed module could not be validated or
executed: the same defect class ADR 0079 fixed for `logicalPath`, under a different owner (bead
`lagrange-images-bop`; the module half is `lagrange-images-ygi`). Four executors also each
re-interpreted the metadata schema on their own.

## Decision

1. **`wasm-module/v1` is frozen** (ADR 0035 precedent: a named durable representation is versioned,
   never mutated). Existing durable v1 artifacts stay readable and executable in-image through the
   canonical accessor's frozen decoder — including the oldest v1 sub-form without a `functions`
   table, whose single entry the decoder synthesizes from the top-level mirrors exactly as the
   executors used to. No compiler produces v1; a request for that target is
   `CodeCompilerNotFoundError`. There is no dual-write.

2. **`wasm-module/v2` is the canonical compiled form — Shape 2, a descriptor referencing bytes.**
   The Value model has no structured kind, so the contract is the canonical JSON text
   `{abi, literals, functions[], sendSites, closureSites, effectSites}` in the artifact's
   identity-bearing content, and the exact compiled bytes are their own `wasm-binary/v1` artifact
   referenced through exactly one `role: implementation` dependency — the pattern
   `wasm-callable-interface/v1` already uses. The implementation reference has one authority (the
   edge); it is not repeated in the JSON. `contentIdentity` follows dependency edges, so identical
   contract + different bytes have different identity and identical contract + identical bytes
   share it, with no change to generic identity (proven empirically before building).

3. **`wasm-binary/v1` is the neutral raw-byte owner**, not a foreign-only representation: its
   constant, assertion and the implementation role live in the language-neutral
   `src/code/wasm-artifacts.js` (no `node:*` imports) and `foreign-artifacts.js` re-exports them.
   The foreign callable lane is not widened.

4. **`cellBindings` is contract, per ABI.** The lexical-cell ABIs require it on every function
   descriptor and the v0 ABIs require its absence (both executor families check exact keys), so the
   v2 normalizer preserves it exactly as emitted. The old top-level `entry/parameters/captures/
   cellBindings` mirrors on single-function results were semantic duplicates of `functions[0]` and
   are gone.

5. **`instanceReuse` is provenance.** With only valid contracts, `stateless-v0` and absence denote
   identical observable results (absence is fresh-per-activation, always correct), so it is an
   optimization property, stays in metadata, may disappear on install, and never enters identity.
   `continuations`, `semanticRepresentation`, `groupPolicyId` and `physicalLayout` are likewise
   provenance: no executor consumes them.

6. **One accessor.** `src/wasm/module-contract.js` is the sole decoder of both versions:
   `readModuleContract` (bytes + contract, resolving the implementation for v2),
   `readModuleDescriptor` (contract only, synchronous), `moduleFunctionOf` / `soleModuleEntry`
   (the one function-table lookup). The four executors, the module cache (bytes-only, no
   representation fallback), the instance pool, function assembly, both tree installers and the
   Smalltalk class builder read through it. Outside this module's frozen v1 decoder, zero consumers
   recover module executable semantics from provenance metadata.

7. **The compilation persistence owner materializes the pair; compilers state facts.** The eight
   WASM compiler entries return `{bytes, contract, metadata}` plus `languageId` where the compiler
   knows it (single-source entries; group entries state none and the service derives the members'
   common language, as before). `CompilationService` gained a
   generic **result graph**: a compiler result may be `{primary, artifacts: [{key, representation,
   content, dependencies, metadata}]}` with sibling keys as dependency targets; ids derive from the
   requested id (`<id>` primary, `<id>:<key>` siblings), caller/cache metadata ride on the primary,
   and the graph is persisted by `ensureCodeArtifacts` through ONE insert-only `createRecords` batch
   (absent -> create, identical -> reuse, otherwise conflict), so a descriptor is never durably
   visible without its implementation. The module-contract owner describes the v2 graph once
   (`describeWasmModuleV2Result`, refusing any contract field or semantic mirror in provenance); no
   compiler, installer or executor knows the graph shape, and the service has no WASM branch.

8. **Canonical serialization is load-bearing, on write and on read.** Descriptor bytes come from a
   key-sorted canonical JSON at every depth (non-finite numbers refused), never `JSON.stringify`
   insertion order; and a v2 artifact whose content is not the canonical serialization of its own
   normalized contract is refused by the accessor, so the same meaning can never carry two
   identities. Executors read the descriptor synchronously and hand the module cache a bytes thunk
   that is invoked only on a cache miss.

## Consequences

- A compiled module survives capture -> bundle -> managed install -> fresh runtime: the fresh
  runtime recovers the descriptor and its implementation edge into the target image, with metadata
  absent, and executes the module with the compiler stubbed out and every semantic source read
  refused. The frozen v1 flow reproduces the broken installed graph (the motivating falsifier).
- An installed **Block** over compiled WASM still cannot dispatch: `wasm-function/v1` carries
  `abi/entry/parameters/captures` in stripped metadata. That is the next slice (bead
  `lagrange-images-o8a`: `wasm-function/v2` = module reference + entry selection in content), after
  which the release proof becomes Block-level.
- The portable static closure grows by exactly `src/wasm/module-contract.js` (109 -> 110).
- Derivation reuse keys on the descriptor (primary); v1 artifacts carry the old compiler identities
  and are never offered as v2 results.

## Not in scope

`wasm-function/v2` (o8a); any change to the Value-handle ABIs or the executors' semantics; a
structured Value kind; install-time recompilation; a new callable-interface lane.
