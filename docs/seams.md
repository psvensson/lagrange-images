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
| `neutral-expression/v1` | — (built by language personalities) | `neutralExpressionV1Executor`; adds temporaries, sequences and assignment |
| `wasm-function/v1` | `installWasmBlockTree()` | `createWasmFunctionV1Executor()` |
| `wasm-callable-interface/v1` | `installWasmScalarCallable()` | `createWasmCallableInterfaceV1Executor()` |
| `foreign-runtime-callable-interface/v1` | `installForeignRuntimeCallable()` | `createForeignRuntimeCallableInterfaceV1Executor()` |
| `wasm-component-binding/v1` | `installWasmComponentBinding()` | `createWasmComponentBindingV1Executor()` |
| `wasm-component-binding/v2` | `installWasmComponentBindingV2()` | same executor; adds declared host imports |
| `foreign-runtime-binding/v1` | `installForeignRuntimeBinding()` | `createForeignRuntimeBindingV1Executor()` |
| `image-projection-binding/v1` | `installImageProjectionBinding()` | `createImageProjectionBindingV1Executor()` |
| `image-mutation-binding/v1` | `installImageMutationBinding()` | `createImageMutationBindingV1Executor()` |
| `image-creation-binding/v1` | `installImageCreationBinding()` | `createImageCreationBindingV1Executor()` |
| `image-creation-batch-binding/v1` | `installImageCreationBatchBinding()` | `createImageCreationBatchBindingV1Executor()` |
| `image-versioned-projection-binding/v1` | `installImageVersionedProjectionBinding()` | `createImageVersionedProjectionBindingV1Executor()` |
| `image-object-read-binding/v1` | `installImageObjectReadBinding()` | `createImageObjectReadBindingV1Executor()` |
| `image-observation-binding/v1` | `installImageObservationBinding()` | `createImageObservationBindingV1Executor()` |
| `smalltalk-kernel-primitive/v1` | `installSmalltalkAllocationProtocol()`, `installSmalltalkIndexedProtocol()` | `createSmalltalkKernelPrimitiveV1Executor()`, registered by `createRuntime()` |

The foreign-runtime executors are registered only when `createRuntime()` receives foreign
runtime definitions, runtimes and definition bindings together. The Component binding
executor is always registered, but needs a `componentRuntime` to execute anything.

`smalltalk-kernel-primitive/v1` is the one representation *not* registered by
`createDefaultCodeExecutorRegistry()`. It is language-owned, and `src/language` already imports
`src/execution`, so registering it there would close a dependency cycle. `createRuntime()` registers
it instead, the same way it supplies `createSmalltalkTemporaryInitializer()` — language-owned
execution policy enters through composition, and execution never depends on language (ADR 0046
decision 2a). "Registered" in the table above therefore means *registered by the assembled runtime*.
ADR 0047 extends this existing primitive family with `basic-new-sized`, `indexed-size`, `indexed-at`
and `indexed-at-put`; it does not add an executor representation or a dispatcher/compiler ABI.

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
| `lagrange-code/v0` | language-neutral semantic code; **frozen** — a closed grammar, so new semantics get a new version |
| `lagrange-code/v1` | adds temporaries, statement sequences, assignment, and captures carrying a `snapshot`/`cell` mode |

The semantic representation is chosen per compilation unit from what the program needs, and
applies to the whole nested tree: `selectSemanticRepresentation()` returns `lagrange-code/v0`
unless the source declares a temporary, sequences more than one statement, or assigns. Source
needing none of that still compiles to exactly the `lagrange-code/v0` artifact it always did.
`lagrange-code/v1` runs on both lanes. `installWasmBlockTree()` dispatches on the root semantic
representation: v0 keeps the original installer untouched, v1 uses a sibling planner that emits the
`wasm-nested-block-tree/v1` group policy. There is no second "does this need mutable state?"
analysis at install time — the representation is the source of truth.

## Generic object layout

A Shape may declare `indexed: none | values`. Absence is the pre-ADR-0047 form and means `none`;
reading an old Shape or Object does not materialize a new field. An Object whose Shape declares
`values` carries an `indexed` array of canonical Values, possibly empty, and a Shape declaring
`none` forbids one. Named slots and the indexed part are both durable graph state: refs and pinned
refs in either place are graph edges and must be visited by `referencesOfRecord()`.

The indexed part is language-neutral and 0-based. It is not `interface-composite/v0`: composites are
ref-free transient boundary data, while indexed object state exists specifically to hold durable
Values including refs. The v1 projection field map remains named-slot-only. Projection
refuses an indexed object rather than returning a partial view. ADR 0064 opens the indexed part at
the *creation* lane: a binding may declare one indexed field, a ref-free `list` whose elements become
the initial indexed part, each ref element authorized by the existing per-target `object/edge-write`
grant. ADR 0065 opens it at the *mutation* lane: a binding may declare one indexed field, replacing
the indexed part under the same version-token CAS — appending leaf elements (`object/write` alone)
or ref elements (`+ per-target object/edge-write` on each added ref) and reordering, while element
removal stays deferred as edge removal and a shrunk list is refused. Indexed-aware *projection*
remains deferred.

## Symmetric Smalltalk kernel

The object graph ADR 0044 dispatches against. `installSmalltalkKernel({images, imageId})` creates it;
`findSmalltalkKernel({images, imageId})` finds it again from nothing but an image id, because refs
returned by the installer die with the process while the image survives.

| Identifier | Meaning |
| --- | --- |
| `smalltalk-kernel/v1` | both the kernel protocol tag and the well-known object id it lives at |
| `smalltalk/behavior-shape/v1` | the fixed Behavior shape: name, superclass, methods, instanceShape |
| `smalltalk/kernel-shape/v1` | the kernel object's shape: the singletons and the kernel classes |
| `smalltalk/array-instance-shape/v1` | `Array`'s zero-named-slot, indexed-Values instance layout |

A behavior record means what its own shape says it means: a `smalltalk/behavior-shape/v1` object gets
ADR 0044 lookup, anything else is a legacy behavior and keeps selector-as-shape-name lookup.
Installing the kernel reinterprets nothing that already exists.

The same rule now applies to a Behavior's `methods` edge. A `smalltalk/method-dictionary-shape/v1`
object — local Shape, no `behavior`, one `tally` slot, and an indexed part of `hash, selector, method`
triples — gets ADR 0049 hashed lookup: one record read, no Shape fetch, and only the pure built-in
Text hash and equality, so lookup can never re-enter dispatch. Anything else keeps the ADR 0044
selector-as-shape-name path. Classes created now get the hashed form; existing ones change only
through `migrateMethodDictionary()`, which seals the legacy dictionary, builds the hashed one at a
deterministic per-Behavior id, and swaps the `methods` edge with one CAS.

Protocol arrives after identity, per lane, through builders rather than through the bootstrap:

| Installer | Installs |
| --- | --- |
| `defineClass()` | a class and its metaclass, wired by the ADR 0044 chain rule |
| `defineMethods()` | methods from semantic `lagrange-code/v0` programs, optionally with captures |
| `installSmalltalkControlFlow()` | `ifTrue:`, `ifFalse:`, `ifTrue:ifFalse:`, `ifFalse:ifTrue:` on True and False (ADR 0045) |
| `installSmalltalkAllocationProtocol()` | the `class-of`/`basic-new` primitive Blocks, plus `Object >> class`, `Object >> initialize`, `Class >> basicNew` and `Class >> new` (ADR 0046) |
| `installSmalltalkEqualityProtocol()` | the `built-in-equals`/`built-in-hash` primitive Blocks, plus `Object >> =` and `Object >> hash` (ADR 0048) |
| `installSmalltalkDictionaryProtocol()` | the Dictionary/DictionaryTable Shapes, the six Dictionary primitive Blocks, the `Dictionary` class, and `initialize`, `size`, `includesKey:`, `at:`, `at:put:`, `keysAndValuesDo:` (ADR 0048; enumeration snapshots the pairs before the Block runs, re-sends neither `hash` nor `=`, and promises no iteration order) |
| `installSmalltalkInstanceVariableProtocol()` | the `instance-slot-read`/`instance-slot-write` primitive Blocks (ADR 0050) and the `non-local-return` primitive Block (ADR 0055), which the class-scoped binder makes available to `^` through the same reserved-capture seam |
| `installSmalltalkLibrary()` | `Association` and a minimal `OrderedCollection`, written in Smalltalk over the kernel protocols; adds no primitive |
| `migrateMethodDictionary()` | rewrites one Behavior's shape-backed method dictionary into the ADR 0049 hashed form |
| `installSmalltalkIndexedProtocol()` | `Array`, `Class >> basicNew:`, `Array class >> new:`, and `Array >> size`/`at:`/`at:put:` over four more `smalltalk-kernel-primitive/v1` Blocks (ADR 0047) |

A boolean Value dispatches by bridging to that image's `true`/`false` object, which becomes the
send's `effectiveReceiver` — the optional second key of a dispatch resolution. Every other immediate
Value still takes its class from its kind.

A class is instantiable when its `instanceShape` is a Shape ref; `nil` there means not instantiable,
and an empty Shape is a valid zero-slot layout. `defineClass()` still stores `nil` when no
`instanceShapeRef` is supplied, so no class written before ADR 0046 changes meaning.

Nested Block publication is one implementation, in `smalltalk-nested-blocks.js`, shared by
`installSymmetricSmalltalkBlock()` and by `defineMethods()`. A method's nested identities derive from
its own deterministic method id plus the semantic block id, and every write is ensure-exact-or-create
— as are the WASM tree installers and `CompilationService` outputs, so a partial install converges on
an identical retry rather than colliding with its own earlier output. In the WASM lane a method with
nested Blocks is published by `installWasmBlockTree()`, which already plans a shared module and
already dispatches on v0 versus v1.

ADR 0050 adds no executable representation either. `compileSymmetricSmalltalkMethod()` and
`defineMethodsFromSource()` are a class-scoped compilation entry point *beside*
`installSymmetricSmalltalkBlock()`, not above it: a Block still compiles with no class in sight, while
a method resolves its free names against the defining class's visible instance layout and carries the
stable slot **id** rather than the source name. Slot access rides two further
`smalltalk-kernel-primitive/v1` operations, and the primitive proves at execution that the target is
the activation's own `self` *and* that the slot is declared by the method's defining Behavior — the
two facts travelling from dispatch in a transient invocation envelope that reaches no record.

ADR 0048 adds no executable representation: the equality, hash and Dictionary operations are further
`smalltalk-kernel-primitive/v1` primitives reached the same way. A `Dictionary` keeps stable identity
and one `table` ref; a `DictionaryTable` is an internal graph object (no `behavior`) whose indexed
part holds `capacity * 3` bucket Values as `hash, key, value` triples. Published tables are immutable
by language contract — a mutation writes a whole new snapshot and compare-and-sets the single
`table` ref, so a reader sees one complete mapping or the other. General lookup really sends `hash`
and `=`, so user overrides work; the pure helpers in `smalltalk-equality.js` are what a later
Text-only MethodDictionary fast path would use instead. Instance Shapes
are complete inherited layouts: a subclass may add indexed storage, but once an ancestor declares
`indexed: values`, a concrete descendant may not drop it. `Array` is fixed-size: `basicNew` gives its
zero-length form, `basicNew:` establishes the length and fills every element with that image's `nil`.
The object model remains 0-based; ordinary Smalltalk `at:`/`at:put:` methods translate their 1-based
indices before invoking the language-owned primitives.

## ABI and contract identifiers

Not representations — these appear inside artifact content as an `abi` or contract tag.

| Identifier | Meaning |
| --- | --- |
| `wasm-scalar-call/v0` | frozen scalar foreign-WASM ABI: no imports, one scalar result |
| `lagrange-value-handle/v1` | adds synchronous `cell_get`/`cell_set` and snapshot-counted closure sites (ADR 0043) |
| `lagrange-value-handle-resumable/v2` | the same, with cells correct across suspension and resumption |
| `foreign-runtime-value-call/v0` | canonical-Value call into a live foreign runtime |
| `lagrange-value-handle/v0` | internal WASM Value-handle ABI |
| `lagrange-value-handle-resumable/v1` | resumable non-tail effect ABI |
| `lagrange-cuis-stdio/v1` | Cuis provider transport (boolean/integer/float64/text/bytes), below the interface layer; `/v0` was integer/boolean only |
| `cuis-runtime-definition/v0`, `cuis-build/v0` | artifact content contracts |
| `authority-grant/v0` | exact-match `{operation, resource}` grants; execution-time only, never durable |
| `object-resource/v0` | injective authority resource name for an object; build only via `objectResource()` |
| `object-version/v0` | opaque object-scoped optimistic-concurrency token; build only via `objectVersionToken()` |
| `interface-composite/v0` | schema-directed envelope carrying one composite InterfaceValue as bytes; undecodable without the declared interface type. The Component lane unpacks it; the foreign-runtime lane carries the payload alone, with the host owning the header |

## Where things live

```text
src/authority/       transient execution authority; never durable, never a Value
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
