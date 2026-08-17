# Seam map

Where to attach code, and what each representation is called. This exists because the
names are not guessable: the scalar WASM installer is `installWasmScalarCallable`, not
`installWasmCallable`, and it takes `wasm:`, not `module:`.

`test/steering-docs.test.js` checks the executable-representation table below against the
default executor registry, so adding a representation without documenting it fails the
suite.

## Executable representations

A Block's `code` ref points at one of these. The executor registry dispatches on the
artifact's `representation`.

| Representation | Install with | Executed by |
| --- | --- | --- |
| `neutral-expression/v0` | — (built by language personalities) | `neutralExpressionV0Executor` |
| `wasm-function/v1` | `installWasmBlockTree()` | `createWasmFunctionV1Executor()` |
| `wasm-callable-interface/v1` | `installWasmScalarCallable()` | `createWasmCallableInterfaceV1Executor()` |
| `foreign-runtime-callable-interface/v1` | `installForeignRuntimeCallable()` | `createForeignRuntimeCallableInterfaceV1Executor()` |
| `wasm-component-binding/v1` | `installWasmComponentBinding()` | `createWasmComponentBindingV1Executor()` |
| `foreign-runtime-binding/v1` | `installForeignRuntimeBinding()` | `createForeignRuntimeBindingV1Executor()` |

The foreign-runtime executors are registered only when `createRuntime()` receives foreign
runtime definitions, runtimes and definition bindings together. The Component binding
executor is always registered, but needs a `componentRuntime` to execute anything.

## Interface representations

Neither executable nor an implementation. A binding depends on one of these through an
`interface` role edge; the interface never points back.

| Representation | Install with | Holds |
| --- | --- | --- |
| `callable-interface/v1` | `installCallableInterface()` | a callable shape whose every type maps directly to one canonical Value; **frozen** |
| `callable-interface/v2` | `installCallableInterfaceV2()` | the same, plus the composite type grammar: `list<T>` and named records |

`wasm-callable-interface/v1` and `foreign-runtime-callable-interface/v1` predate this and
each embed their own signature. They remain valid for callables already installed through
them; new work uses `callable-interface/v1` with a binding. See ADR 0034.

## Implementation representations

These are never a Block's `code`. They are pointed at through a `dependencies` edge from
an interface or definition artifact.

| Representation | What it holds |
| --- | --- |
| `wasm-binary/v1` | raw imported WASM bytes (Cargo output); not directly executable |
| `wasm-component/v1` | a compiled WASM Component; says nothing about which interfaces it satisfies |
| `wasm-module/v1` | WASM using the Lagrange Value-handle ABI |
| `smalltalk/cuis-image-v1` | a Cuis image |
| `smalltalk/cuis-changes-v1`, `smalltalk/cuis-sources-v1` | Cuis support files |
| `smalltalk/cuis-package-v1` | a `.pck.st` package |
| `smalltalk/cuis-runtime-definition-v1` | durable description of a startable Cuis runtime |
| `rust/cargo-manifest-v1`, `rust/cargo-lock-v1`, `rust/source-v1` | explicit Cargo build inputs |
| `rust/cargo-config-v1`, `rust/cargo-vendor-file-v1` | explicit vendored dependency inputs |

## Semantic representations

| Representation | What it holds |
| --- | --- |
| `symmetric-smalltalk/source-v0` | language source text |
| `symmetric-smalltalk/syntax-v0` | parsed syntax |
| `lagrange-code/v0` | language-neutral semantic code |

## ABI and contract identifiers

Not representations — these appear inside artifact content as an `abi` or contract tag.

| Identifier | Meaning |
| --- | --- |
| `wasm-scalar-call/v0` | frozen scalar foreign-WASM ABI: no imports, one scalar result |
| `foreign-runtime-value-call/v0` | canonical-Value call into a live foreign runtime |
| `lagrange-value-handle/v0` | internal WASM Value-handle ABI |
| `lagrange-value-handle-resumable/v1` | resumable non-tail effect ABI |
| `lagrange-cuis-stdio/v1` | Cuis provider transport (boolean/integer/float64/text/bytes), below the interface layer; `/v0` was integer/boolean only |
| `cuis-runtime-definition/v0`, `cuis-build/v0` | artifact content contracts |
| `interface-composite/v0` | schema-directed envelope carrying one composite InterfaceValue as bytes; undecodable without the declared interface type. The Component lane unpacks it; the foreign-runtime lane carries the payload alone, with the host owning the header |

## Where things live

```text
src/value/           canonical Values; the smallest thing in the repo, keep it that way
src/object/          shapes, generic objects, refs
src/code/            CodeArtifacts and representations
src/execution/       activation model, executor registry, block application
src/language/        Symmetric Smalltalk personality (parser, compiler, dispatch)
src/wasm/            both WASM lanes: internal Value-handle ABI and foreign callables
src/foreign-runtime/ long-lived foreign runtimes, providers, definitions, callables
src/toolchain/       external toolchain providers and deterministic reuse
src/backend/         storage seam: mock and Lagrange backends
src/runtime.js       composition root and the public export barrel
```

Adding a public name means adding it to a module that `src/runtime.js` re-exports with
`export *`. See the barrel trap in [the runbook](runbook.md#traps).
