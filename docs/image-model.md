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

A Project does not need a special backend record kind. The image-level Project model can be implemented as a convention/library over ordinary objects, refs and artifacts. Perspective/window/UI concepts are higher-level Object Environment semantics and likewise do not require new graph record kinds.

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

The mock and Lagrange backends materialize current state and append a history spine. Snapshots still copy the materialized records; a later schema should represent them as logical root/revision frontiers where possible.

Revision-aware reads, Project working-frontier semantics and generic diff/merge/conflict data belong here when implemented because they are useful without any particular UI. History browsers and merge/conflict interaction belong to the Object Environment.

## Projects

Projects are language-neutral image-level structures containing or relating code, notes, tests, data, work items, artifacts and other Projects. They should be usable by headless agents and tooling as well as graphical environments.

A Project should be able to refer to source, manifests, lock data, imported binary libraries/components, runtime definitions and other artifact dependencies without pretending that every dependency is editable source.

Projects should not recreate filesystem assumptions. An object may participate in several Projects or relationships; Project composition need not imply exclusive ownership.

Git/files remain useful interoperability projections rather than canonical identity. A headless projection service may belong at the image/tooling layer; its interactive UI belongs in Lagrange Object Environment.

Project membership is not authority inheritance. Current authority semantics remain exact-match and refs are not traversed as capabilities.

See [object-environment-boundary.md](object-environment-boundary.md) for the Project/UI split.

## Language boundary

The image layer knows values, refs, shapes, identity, artifact relationships, history and the language-neutral Project convention. It does not define Smalltalk classes in the generic graph, Lisp packages, `nil`, method syntax, closure calling convention, package-manager semantics, Perspectives, windows or presentation behavior. Language personalities, interface adapters, toolchain providers and higher-level clients own those meanings.
