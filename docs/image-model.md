# Image model

## Not a memory dump

A classic Smalltalk image is wonderfully direct, but treating the image as an opaque heap file makes distribution, collaboration and partial history awkward. Here an image is a **logical durable object graph**.

The implementation may cache or materialize that graph however it wants. Persistence is semantic, not byte-for-byte process state.

## Identity

Every durable object has a stable object id. Identity does not come from a memory address, table row location or source-file path.

Current bootstrap record:

```js
{
  id: 'counter',
  imageId: 'playground',
  classId: 'Counter',
  slots: {value: 0},
  source: '...',
  metadata: {},
  _version: 1
}
```

References inside `slots` will eventually need an explicit language-neutral encoding instead of relying on arbitrary JSON conventions. A likely representation is a tagged object reference such as `{$ref: objectId}` plus value records for immediates.

## Root and reachability

An image has a named root object. Reachability from roots is important for browsing, snapshots, export and eventually garbage collection, but unreachable objects should not be destroyed merely because one traversal cannot see them. History, branches, debugger state or projects may still refer to them.

## Current state + history

Current object state is materialized for fast access. Changes also append events to an image history stream.

This gives two useful views:

- **now**: load an object directly
- **how did we get here?**: inspect revisions/events

The event stream is not yet a full event-sourced runtime. It is a history spine. We can decide later which transitions need exact replay semantics.

## Versions

Objects carry monotonically increasing versions at the persistence boundary. The mock backend implements compare-and-swap writes through `expectedVersion`.

This is the first building block for safe concurrent editing. It is not yet a branch/merge model.

## Snapshots

A snapshot is a named capture of image metadata plus its currently materialized object set. That is deliberately simple for the mock.

On Lagrange, snapshots should become cheap logical revision markers where possible, not giant duplicated blobs. A future snapshot may be mostly:

```text
image id + root(s) + revision frontier + metadata
```

## Projects

A project should be represented *inside* the image model, not in a parallel filesystem-only hierarchy. A project can contain or relate to:

- packages/modules
- classes, methods and other code objects
- notes and design records
- examples and tests
- datasets and generated artifacts
- quests/epics/work items
- nested or related projects

History belongs to the objects and relationships. A source-tree view can be generated from that model.

## What must stay language-neutral

The image layer may know that something is code, a reference, a project or an object. It should not know how Smalltalk method syntax parses, whether Lisp uses packages, or how a JavaScript closure is represented.

Language personalities own those mappings.
