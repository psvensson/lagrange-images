# ADR 0003: code artifacts and closures

Status: accepted — the bootstrap execution substrate.

## Decision

Add three language-neutral durable record kinds.

`code-artifact` is immutable and contains an optional `languageId`, an opaque `representation`, one tagged `content` Value, provenance refs in `derivedFrom`, and metadata. Text, bytes and graph refs cover source, binary code and syntax/IR graphs without putting `source` back on generic objects.

`lexical-environment` has stable identity, an optional parent environment ref, and bindings keyed by stable binding ID. Each binding has a diagnostic name and tagged Value. For one environment identity, parent identity and the set of binding IDs are stable; names and Values may change across versions.

`block` is immutable and consists of a code-artifact ref plus an optional lexical-environment ref. Captured receiver/self and language-specific state belong in the environment or language layer, not as Block substrate fields.

The image service validates the semantic target kinds. Code may live in another image. References remain identity, not authority.

## Runtime consequence

These records define durable semantics only. Non-escaping Blocks/environments may compile away; runtimes may flatten environments, use cells, tag/unbox values, or lower code into WASM/bytecode without changing image semantics.

## Deferred

- invocation/message dispatch
- parameter and calling conventions
- methods/selectors
- activation/debug records
- exception/condition substrate
- executable neutral IR
