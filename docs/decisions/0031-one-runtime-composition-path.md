# 0031 — One runtime and image-service composition path

## Status

Accepted.

## Context

The repository had accumulated two independent bootstrap paths.

`src/runtime.js` composed the language-neutral graph `ImageService`, compilation, toolchains, dispatch, activation execution and foreign runtimes. The package root and current examples used that path.

A historical `src/index.js` still constructed a smaller runtime over a second image service. That service stored arbitrary host slot data and exposed `classId` and `source` shortcuts on generic objects. A duplicate HTTP server, demo and test continued to exercise it even though those semantics contradicted the current graph model.

Keeping both paths made a deep import capable of selecting different object identity, validation and runtime capabilities from the published package.

## Decision

`src/runtime.js` is the sole runtime composition root.

`src/index.js` remains only as a source-level compatibility re-export of `runtime.js`; it owns no service construction or semantics.

There is one `ImageService`, implemented by `src/image/graph-image-service.js`. Generic objects therefore always use explicit shape and optional behavior refs plus tagged Value slots. Language source remains a CodeArtifact concern rather than a generic object field.

`src/server.js` is the sole HTTP server. It imports the canonical runtime directly and exposes images, shapes, objects, records, history and snapshots through that graph service. Request-only concurrency metadata such as `expectedVersion` is separated from the object record before validation.

The historical image service, graph server, legacy demo and legacy test are removed. Runtime-entrypoint tests require the compatibility export and canonical export to resolve to the same constructors/functions, and exercise the HTTP boundary against the graph representation.

## Consequences

- Every supported construction path has the full compilation/execution/toolchain/runtime services.
- Generic-object invariants can no longer be bypassed through the historical source entrypoint or server.
- The server remains a thin projection over the image service; it does not define a second graph model.
- This change adds no durability or backend transaction guarantee. Atomic state/history mutation remains subsequent backend work.
