# Architecture

## Core idea

An image is a long-lived graph of objects with stable identity, code, state and history. It may be active on one machine, spread across a cluster, asleep, snapshotted, branched or inspected without changing what an object *is*.

The architecture separates four concerns:

1. **image semantics** — identity, references, roots, history, snapshots, projects
2. **language semantics** — syntax, parsing, compilation/evaluation, debugging, compatibility layers
3. **execution** — message sends, activation, scheduling, local/remote dispatch, capabilities
4. **substrate** — durable records, transactions, placement, replication and compute

Only the fourth layer should know it is running on Lagrange.

## Layers

```text
+-------------------------------------------------------+
| tools / REPL / browser / graphical shell / HTTP       |
+-------------------------------------------------------+
| language personalities                               |
| Symmetric Smalltalk | Cuis bridge | Lisp | ...       |
+-------------------------------------------------------+
| language-neutral runtime                             |
| objects | messages | blocks | projects | debugging   |
+-------------------------------------------------------+
| image service                                        |
| identity | graph | history | snapshots | namespaces  |
+-------------------------------------------------------+
| backend contract                                     |
| mock                         | Lagrange adapter        |
+-------------------------------------------------------+
|                              | Lagrange               |
|                              | data + distributed WASM|
+-------------------------------------------------------+
```

The repository currently implements the bottom half of the image-service slice and a language registry. The runtime above it is deliberately thin until the object and block semantics are nailed down.

## Image service

The `ImageService` is the first stable boundary. It deals in images and language-neutral object records. The current representation is intentionally JSON-shaped so the mock is transparent and tests remain easy to read.

This is not a claim that final object storage will be JSON blobs. The Lagrange adapter is free to normalize hot fields, references, source, history and indexes into separate tables while preserving the same semantics.

## Backend contract

The current backend has seven operations:

- `start()` / `stop()`
- `get(collection, key)`
- `put(collection, key, value, {expectedVersion})`
- `scan(collection, {prefix})`
- `append(stream, event)`
- `readStream(stream, {afterRevision})`

This is a bootstrap interface, not a new database API. It exists so image semantics can move now. When the Lagrange mapping is understood, it can be replaced by a more precise repository interface without leaking storage details into languages.

## Active execution

Persistence and execution should not be fused too early.

A likely later shape is:

```text
message send
    |
object locator
    |---- local activation
    |
    +---- distributed activation ----> ctx.call / placed WASM
```

A caller should send a message to an object. Whether the receiver is already local, has to be activated, or is deliberately placed by Lagrange is runtime policy.

That does **not** mean every object send becomes a network RPC. Ordinary local sends need to stay ordinary and cheap. The distributed boundary should be visible to policy/capability machinery even when it is syntactically pleasant.

## Projects live inside the model

Source trees should not become the organizing primitive just because Git is familiar. A project can itself be an object graph containing code, notes, data, quests/work items, tests and links to other projects. Each constituent object has identity and history.

Git export/import can then be a projection for interoperability, backup, review and external tooling rather than the canonical form of the system.

## Graphical shell later

The graphical system should follow the same layering rule: drawing/input primitives low down, reusable widgets and surfaces above them, and a replaceable window-manager/shell policy at the top. The image should own inspectable UI objects; the window manager should not become the object model.

That deserves its own vertical slice after the object/runtime semantics work.
