# Image model

An image is a logical durable object graph, not a byte-for-byte heap dump.

The current graph representation is defined in [value-model.md](value-model.md). Every durable graph record has stable `(imageId, objectId)` identity independent of memory address, backend row location and current version.

## Records

The substrate currently has these durable graph record kinds:

- immutable `shape` records describing physical slot layout
- `object` records containing a shape ref, optional behavior ref and `slot-id -> Value` state
- immutable `code-artifact` records for source, semantic, executable, imported and interface representations
- versioned `lexical-environment` records
- immutable `block` records pairing code with an optional lexical environment

They share one image object-ID namespace. Generic objects do not contain Smalltalk-specific `classId` or generic `source` fields.

## CodeArtifact dependencies and provenance

`CodeArtifact` is currently the bootstrap generic artifact carrier. It has two different explicit relationship kinds:

```text
dependencies:
  role
  artifact ref

derivedFrom:
  reference
```

They are intentionally not interchangeable.

A dependency says an artifact needs or relates to another artifact for a role chosen by language/tooling policy:

```text
application source
  dependency(role=manifest) -> Cargo.toml artifact
  dependency(role=library)  -> imported component/JAR/etc.
```

`derivedFrom` records provenance for an immutable result:

```text
compiled module
  derivedFrom -> application source
  derivedFrom -> manifest
  derivedFrom -> library
```

Dependency roles are not a platform enum. The generic image layer does not know what `library`, `manifest`, `lock`, `runtime` or another role means.

Dependency targets are explicit unpinned refs to existing CodeArtifacts. Metadata may not hide these refs. The graph reference walker includes them, so reachability and later GC/export logic see them naturally.

Older CodeArtifacts with no stored `dependencies` field are treated as having an empty dependency list.

## Callable interfaces are graph objects too

Executable bytes and callable identity are separate artifacts when they need to be.

The first foreign-WASM shape is:

```text
Block
  code -> wasm-callable-interface/v1
             dependency(role=implementation)
                -> wasm-binary/v1
```

The Block points to the interface because the interface is what the runtime knows how to invoke. The implementation edge remains explicit graph state rather than an opaque identifier in metadata.

One implementation may therefore support several interface artifacts/exports without duplicating the binary. Interface identity still grants no authority; capability policy is separate.

## Shape evolution

A structural change creates a new shape identity. Stable slot IDs can survive renames and compatible evolution. Migrating an object to another shape changes its state/version, not its object identity.

## References and history

Ordinary refs name evolving object identities. `pinned-ref` adds an opaque historical revision. Backend `_version` remains concurrency metadata and is not identity.

`referencesOfRecord()` walks explicit shape, behavior, slot, artifact dependency/provenance, lexical-environment and Block edges. Metadata may not hide refs.

The mock backend materializes current state and appends a history spine. Its snapshots still copy the materialized records; a Lagrange backend should eventually represent snapshots as logical root/revision frontiers where possible.

## Projects

Projects should be ordinary graph structures containing or relating code, notes, tests, data, work items and other projects. They should also be able to refer to source, manifests, lock data, imported binary libraries/components and other artifact dependencies without pretending that every dependency is editable source.

Git/files remain useful interoperability views rather than the canonical model.

## Language boundary

The image layer knows values, refs, shapes, identity, artifact relationships and history. It does not define classes, Lisp packages, `nil`, method syntax, closure calling convention, package-manager semantics or message lookup. Language personalities, interface adapters and toolchain providers own those semantics.
