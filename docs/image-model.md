# Image model

An image is a logical durable object graph, not a byte-for-byte heap dump.

The current graph representation is defined in [value-model.md](value-model.md). Every durable graph record has stable `(imageId, objectId)` identity independent of memory address, backend row location and current version.

## Records

The substrate currently has two record kinds:

- immutable `shape` records describing physical slot layout
- `object` records containing a shape ref, optional behavior ref and `slot-id -> Value` state

Both share one identity namespace. Generic objects do not contain Smalltalk-specific `classId` or generic `source` fields.

## Shape evolution

A structural change creates a new shape identity. Stable slot IDs can survive renames and compatible evolution. Migrating an object to another shape changes its state/version, not its object identity.

## References and history

Ordinary refs name evolving object identities. `pinned-ref` adds an opaque historical revision. Backend `_version` remains concurrency metadata and is not identity.

`referencesOfRecord()` walks explicit shape, behavior and slot edges. Metadata may not hide refs.

The mock backend materializes current state and appends a history spine. Its snapshots still copy the materialized records; a Lagrange backend should eventually represent snapshots as logical root/revision frontiers where possible.

## Projects

Projects should be ordinary graph structures containing or relating code, notes, tests, data, work items and other projects. Git/files remain useful interoperability views rather than the canonical model.

## Language boundary

The image layer knows values, refs, shapes, identity and history. It does not define classes, Lisp packages, `nil`, method syntax, closure calling convention or message lookup. Language personalities own those semantics.
