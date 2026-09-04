# ADR 0085: Progressive native import is the primary language-convergence path

Status: accepted

## Context

Lagrange Images has now proved enough horizontal substrate to stop treating additional foreign-runtime demonstrations as a goal in themselves.

The platform can already:

- represent durable language-neutral objects, refs, Shapes, artifacts, Blocks, Projects and history;
- compile image-native semantic code to Lagrange WASM;
- reuse existing toolchains without making them image owners;
- run long-lived foreign runtimes behind ordinary callable interfaces;
- build and run real OpenSmalltalkVM/Cuis package graphs;
- export deterministic Cuis package/class/method semantics without leaking Spur heap identity;
- run real SBCL through the unchanged generic foreign-runtime contracts (ADR 0084).

Those proofs established the compatibility escape hatches and falsified language-specific leakage in the generic layers. They do not by themselves reach the product goal: importing an existing application so that its classes, methods, objects and authoritative state become Lagrange-native and can use Lagrange storage, history, placement and execution directly.

Continuing to deepen runtime-specific proofs would therefore optimize an intermediate state. The next pressure must be vertical convergence from an existing ecosystem into the native image model.

## Decision

### 1. Progressive native import is the main path

The primary language-integration destination is:

```text
existing application source/package graph
        |
        v
language-owned semantic import
        |
        v
native image structures
Projects / namespaces / classes / Shapes / methods / Blocks / roots
        |
        v
native language semantics
        |
        v
lagrange-code
        |
        v
Lagrange WASM
        |
        v
Lagrange objects + storage + history + placement
```

After a successfully native-imported application is installed, its ordinary execution and persistent domain state must not require the original language VM or heap.

Source/package artifacts remain durable provenance and rebuild/import inputs. They are not required to remain the runtime representation of successfully imported code.

### 2. Cuis is the first forcing ecosystem

Cuis is the single primary ecosystem for proving the path because both sides already exist:

```text
Cuis side                         native Lagrange side
packages                          Projects/artifacts
classes                           Behavior/Class/Metaclass
instance-variable declarations    Shapes/slots
methods/source                    native methods/Blocks
collections                       native Smalltalk library
application objects               Lagrange objects/ObjectRefs
                                  lagrange-code -> Lagrange WASM
```

ADR 0072's `smalltalk/cuis-semantic-export-v1` becomes the bootstrap semantic-import input, not the final representation of an imported application. Its current `CuisExportPackage`/`CuisExportClass`/`CuisExportMethod` materialization remains useful for inspection and deterministic proof, but an instance of `CuisExportClass` is not the native class produced by this convergence path.

Extend the export only when the next native-import milestone requires additional semantic facts. Do not broaden it speculatively into arbitrary heap introspection.

### 3. Native import must route through existing owners

The importer owns translation from Cuis semantic facts into calls on existing language/image owners. It must not create a second executable class/object model.

Examples:

```text
Cuis class declaration
    -> Symmetric Smalltalk class/Shape builders

Cuis method source
    -> Smalltalk semantic compiler
    -> existing compilation/WASM owners

Cuis package/application relationship
    -> existing artifact/Project owners

Cuis application instance
    -> existing allocation/residency/ObjectRef owners
```

If a missing semantic concept is exposed, repair or extend the owner responsible for that concept. Do not hide the gap in an importer-local object model or a provider-specific side table.

### 4. OpenSmalltalkVM is support machinery, not the destination

OpenSmalltalkVM/Cuis keeps three explicit roles:

1. **Importer/toolchain** — use real Cuis package/compiler machinery to resolve the ecosystem and extract canonical semantic input.
2. **Reference oracle** — run the same source in real Cuis when useful to falsify native semantic compatibility.
3. **Explicit foreign-service escape hatch** — retain code behind a declared foreign boundary when a native implementation is deliberately out of scope, for example a concrete FFI dependency.

There is no implicit or silent fallback from failed native import/compilation to the live Cuis runtime. Unsupported semantics must fail explicitly so progress is measurable and ownership gaps remain visible.

```text
native import unsupported
    != silently execute in Cuis
```

### 5. Native state has one authority

Once an application object/state domain is native-imported, Lagrange image state is authoritative for it.

Do not mirror mutable authoritative state between a Spur heap and Lagrange objects. A foreign runtime may have its own explicitly bounded foreign state, but crossing that boundary is a service/interface interaction, not transparent dual persistence.

For native application state:

```text
identity       -> ObjectRef
layout         -> Shape
slots/edges    -> Lagrange Values/refs
persistence    -> image/backend
history        -> image history
execution      -> Blocks/Lagrange WASM
placement      -> Lagrange policy
```

### 6. Milestones are irreversible steps toward native execution

#### M1 — native class import

Extend semantic export with only the class-layout facts required by the native class owner, beginning with instance-variable definitions and any immediately required class-side layout facts.

Acceptance:

- import an unchanged multi-class Cuis package;
- create executable native classes/metaclasses through the existing class/Shape owners;
- instantiate an imported class as an ordinary Lagrange Smalltalk object;
- its instance slots are ordinary durable image state;
- no OpenSmalltalkVM participates in construction or access after import.

#### M2 — native method compilation

Compile imported method source through the existing Smalltalk semantic/compiler path.

Acceptance:

- methods installed on M1 classes are ordinary native methods/Blocks;
- application sends execute through native dispatch and Lagrange WASM;
- a create -> mutate -> read flow works using an imported class and imported accessors/domain methods;
- no live Cuis call participates.

#### M3 — compatibility-library closure under application pressure

Use one increasingly realistic existing application/package set to expose missing Cuis base semantics. Add only the mappings/library/kernel behavior required by that application.

Acceptance:

- each added compatibility rule has a real imported consumer;
- equivalence to an existing native class/protocol is explicit and tested rather than inferred from a shared name;
- missing semantics remain explicit import/compile failures.

#### M4 — native application state and restart

Import or establish the application's durable roots, globals/class state and domain object graph using the existing image owners.

Acceptance:

- create a linked domain graph through application code;
- restart the Images process/runtime;
- recover the same durable ObjectRefs, state and relationships;
- resume application behavior without a Cuis snapshot or Spur heap as authoritative persistence.

#### M5 — one real independently authored Cuis application

Choose a nontrivial existing application and import its application source without modifying its core domain source for Lagrange.

Acceptance:

- complete source/package dependency closure is represented in a Project/release;
- install into a fresh Image;
- useful existing application behavior/tests execute natively;
- application domain objects are Lagrange objects;
- ordinary execution does not require OpenSmalltalkVM or a Cuis image;
- unsupported explicitly foreign dependencies, if any, are visible interface boundaries rather than fallback.

#### M6 — distribution without language-level rewrites

Run the same M5 application with application objects placed across Lagrange nodes.

Acceptance:

- the importer and Cuis personality contain no placement branches;
- generic Lagrange owners decide object location/routing/compute placement;
- application-level Smalltalk source does not need to become a hand-written distributed program merely because its object graph is distributed.

### 7. Other language work is sequenced behind the forcing path

ADR 0084 completed the Common Lisp foreign-runtime neutrality falsifier. Substantive Common Lisp native-personality/import work (ASDF import, reader/macroexpansion representation, CLOS mapping, dynamic bindings, multiple values, conditions/restarts) is parked until the Cuis path has proved native objects and authoritative storage at least through M4, preferably against M5 pressure.

Java and additional runtime compatibility spikes are likewise not roadmap priorities unless they expose a concrete generic owner required by the Cuis/native-import path or another immediate product need.

When Common Lisp resumes, reuse the native-import architecture only where the concerns are genuinely shared. Do not generalize the Cuis importer in anticipation of Lisp semantics.

### 8. Object Environment sees the resulting image model

Lagrange Object Environment may present language provenance and Cuis-specific editing/import affordances, but it must navigate/edit native-imported classes, methods and application objects through the ordinary public Images object/language/Project APIs.

It must not preserve a shadow Cuis object database or require runtime-specific identity after native import.

## Ownership

- **OpenSmalltalk/Cuis toolchain provider** owns extraction from real Cuis/package machinery into canonical Cuis semantic artifacts.
- **Cuis native-import personality/adapter** owns translation from those semantic facts into calls on native Smalltalk/image owners. This is a planned owner; it owns no duplicate class, object, storage or compiler semantics.
- **Symmetric Smalltalk personality and its existing builders/compiler** remain the owners of native Smalltalk class, slot, method and semantic compilation rules.
- **Object/graph/image owners** remain the owners of native identity, state, persistence and history.
- **Project/artifact owners** remain the owners of application organization, dependency/provenance and release/install semantics.
- **ForeignRuntimeService/providers** remain the owners of explicitly foreign runtime execution only.
- **Lagrange Object Environment** owns human interaction over the resulting public Images semantics, not import storage or language-runtime identity.

## Consequences

- The roadmap becomes a vertical convergence roadmap rather than a catalogue of ecosystem proofs.
- Cuis runtime/toolchain depth is pursued only when it advances native import, serves as an oracle, or satisfies an explicit foreign-service need.
- Existing foreign-runtime work remains valuable and supported; it is demoted from primary convergence strategy to compatibility infrastructure.
- The deterministic ADR 0072 export gains a concrete downstream purpose: bootstrap input for native import.
- Native import failures become useful pressure signals for the responsible semantic owner.
- The first compelling application proof is no longer "runs in a VM managed by Lagrange" but "ordinary existing source became native Lagrange classes, methods and durable objects."

## Guardrails

```text
semantic import != heap import
CuisExportClass != native imported Class
Spur oop != ObjectRef
foreign runtime != native fallback
importer != second class/object/compiler owner
source/package artifact != required runtime representation
native application state has ONE authority: the Lagrange image graph
language provenance != runtime identity
Project membership != authority
placement != language semantics
```

Do not add arbitrary `perform:`, eval, oop export or heap mirroring merely to make import easier. If an application requires a semantic feature, add it at the language owner or declare an explicit foreign boundary.

## Relationship to earlier ADRs

- **ADR 0022** remains valid for the existence of native and compatibility paths; this ADR decides their strategic relationship: compatibility supports native import rather than competing with it as the main destination.
- **ADR 0072** remains the authoritative Cuis semantic-export identity contract; this ADR makes that export the bootstrap input to progressive native import and rejects its behaviorless materialization as the final executable representation.
- **ADR 0084** remains the completed Common Lisp neutrality proof; this ADR parks additional Lisp-native work until the Cuis forcing path establishes the reusable native-import architecture.
