# Architecture

## Core idea

An image is a long-lived graph of objects with stable identity, code, state and history. It may be active on one machine, spread across a cluster, asleep, snapshotted, branched or inspected without changing what an object is.

The architecture separates five concerns:

1. image semantics — values, identity, refs, shapes, roots, history, snapshots, projects
2. language semantics — behavior, syntax, language-specific meaning, debugging, compatibility layers
3. compiler substrate — semantic artifacts, grouping policy, derivation/reuse, executable representations
4. execution — dispatch, activations, scheduling, local/remote execution, capability context
5. substrate — durable records, transactions, placement, replication and compute

Only the fifth layer should know it is running on Lagrange. Compiler grouping and reuse must not assume a particular source language.

## Layers

```text
tools / REPL / browser / graphical shell / HTTP
                    |
language personalities: Smalltalk | Lisp | Java | Rust | ...
                    |
compiler substrate: semantic CodeArtifacts | groups | derivation cache
                    |
language-neutral runtime: callables/Blocks | dispatch | activations
                    |
image graph: Values | refs | shapes | objects | history | roots
                    |
backend contract: mock | Lagrange adapter
                    |
Lagrange: distributed data + WASM compute
```

A language may skip or specialize parts of this stack. Rust does not need Smalltalk lookup semantics; Java may have its own class/interface dispatch; Lisp may retain macro-expanded semantic artifacts. They can still share compiler groups, executable-artifact reuse, activation infrastructure and WASM backends where useful.

## Boundaries worth protecting

**Shape is not behavior.** Shape describes durable physical slots. Behavior is an optional language/runtime ref. Smalltalk can map behavior to Class/Behavior without teaching storage what a class is.

**Reference is not authority.** A ref identifies an object. Read/mutate/invoke rights come from principal/capability context.

**Identity is not revision.** Ordinary refs name evolving objects. Pinned refs add historical revision. Backend row versions are concurrency metadata.

**Semantic code is not executable code.** Interpreters, WASM and future optimized executors are derived products. Removing executable artifacts must not erase the program meaning needed to inspect/rebuild them.

**Compilation group is not a language construct.** The compiler/tooling layer decides whether a useful unit is a Smalltalk Block tree, Lisp compilation unit, Java package/class set, Rust codegen unit or something else. The group does not prescribe one physical module.

**Physical module is not function identity.** Several semantic members may share one `wasm-module/v1`, but each keeps separate semantic provenance, function artifact, Block/callable identity and entry-level effect policy.

**Reuse is compiler-declared.** The substrate only reuses an immutable derived artifact when the compiler explicitly provides a stable compiler identity and deterministic cache key. It does not guess equivalence from names or source-language structure.

**Compiled host module is not durable code identity.** A runtime `WebAssembly.Module` is a host-engine cache of one immutable `wasm-module/v1`, not an image object or source of program meaning.

**Pooled instance is not activation state.** A retained `WebAssembly.Instance` is execution machinery only. It may be reused only under an explicit reset/reuse contract, and every activation must receive fresh Value handles, entry/effect permissions, lexical/prototype context and pending-effect state. Language/image state does not live in the idle pool.

## Compiler substrate

There are parallel registries for single-source and grouped compilation:

```text
source representation + target
  -> CodeCompilerRegistry

group policy + target
  -> CompilationGroupCompilerRegistry
```

Both feed `CompilationService`, use the same derivation-cache contract, and preserve explicit `derivedFrom` provenance.

A group compiler may emit one executable artifact containing several entries. The first implementation maps one nested WASM tree group to one multi-function `wasm-module/v1`; this is policy, not a generic requirement.

The built-in WASM compiler also declares the current `stateless-v0` instance-reuse contract. That declaration is a compiler/runtime promise about generated guest state, not a property of Smalltalk or of compilation groups in general.

## Unified graph identity

Shape and object records share one `(imageId, objectId)` namespace. Refs therefore do not encode backend collection/type routing. Shapes are the bootstrap record kind needed to describe object layout without a meta-shape regress.

## Portable vs execution representation

The durable graph format is explicit and inspectable, but does not dictate runtime layout. A compiler/WASM layer may use unboxed values, tagged words, local handles, eliminated closures and direct calls while preserving graph semantics.

Likewise, two language/image installations may share one immutable compiled module without sharing their function, Block or object identity. One runtime may also reuse a compiled host module or a proven-stateless host instance without making either object durable language state.

## Runtime execution caches

The current WASM executor has two runtime-local reuse layers:

```text
wasm-module/v1
  -> WasmModuleCache -> WebAssembly.Module
  -> WasmInstancePool -> reusable WebAssembly.Instance (only when explicitly allowed)
```

The module cache is safe by immutable artifact identity. Instance pooling is stricter and requires a supported `metadata.instanceReuse` contract.

The current `stateless-v0` path rebinds activation-local imports before a synchronous entry call, unbinds them immediately after a clean result/tail-effect boundary, and retires an instance after traps or host-boundary contract failures.

These caches/pools are not durable graph records and are not replicated image state.

## Backend contract

The mock boundary remains intentionally small: lifecycle, get/put with optimistic version, scan, and append/read history. It exists so image semantics can progress before the Lagrange mapping is settled; it must not grow into a second database API.

Current derivation-cache lookup scans CodeArtifacts. A durable backend can index compiler identity + derivation key later without changing compiler semantics.

## Active execution later

```text
message/call
    |
receiver + capability context
    |
object locator
    |---- local optimized activation
    |
    +---- distributed activation ----> ctx.call / placed WASM
```

Not every object send becomes RPC. Distribution remains runtime policy with explicit failure and authority semantics.

Projects should be object graphs with Git/files as interoperability projections. The graphical system should follow the same layering: drawing/input substrate, widgets/surfaces, then replaceable shell/window-manager policy.
