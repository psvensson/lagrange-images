# Architecture

## Core idea

An image is a long-lived graph of objects with stable identity, code, state and history. It may be active on one machine, spread across a cluster, asleep, snapshotted, branched or inspected without changing what an object is.

The architecture separates four concerns:

1. image semantics — values, identity, refs, shapes, roots, history, snapshots, projects
2. language semantics — behavior, syntax, compilation/evaluation, debugging, compatibility layers
3. execution — dispatch, activations, scheduling, local/remote execution, capability context
4. substrate — durable records, transactions, placement, replication and compute

Only the fourth layer should know it is running on Lagrange.

## Layers

```text
tools / REPL / browser / graphical shell / HTTP
                    |
language personalities: Smalltalk | Cuis bridge | Lisp | ...
                    |
language-neutral runtime: behavior | blocks | dispatch | debugging
                    |
image graph: Values | refs | shapes | objects | history | roots
                    |
backend contract: mock | Lagrange adapter
                    |
Lagrange: distributed data + WASM compute
```

## Boundaries worth protecting

**Shape is not behavior.** Shape describes durable physical slots. Behavior is an optional language/runtime ref. Smalltalk can map behavior to Class/Behavior without teaching storage what a class is.

**Reference is not authority.** A ref identifies an object. Read/mutate/invoke rights come from principal/capability context.

**Identity is not revision.** Ordinary refs name evolving objects. Pinned refs add historical revision. Backend row versions are concurrency metadata.

## Unified graph identity

Shape and object records share one `(imageId, objectId)` namespace. Refs therefore do not encode backend collection/type routing. Shapes are the bootstrap record kind needed to describe object layout without a meta-shape regress.

## Portable vs execution representation

The durable graph format is explicit and inspectable, but does not dictate runtime layout. A compiler/WASM layer may use unboxed values, tagged words, local handles, eliminated closures and direct calls while preserving graph semantics.

## Backend contract

The mock boundary remains intentionally small: lifecycle, get/put with optimistic version, scan, and append/read history. It exists so image semantics can progress before the Lagrange mapping is settled; it must not grow into a second database API.

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
