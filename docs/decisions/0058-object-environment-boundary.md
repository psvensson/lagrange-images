# ADR 0058: split Project semantics from Object Environment interaction

Status: accepted — responsibility boundary; no runtime behavior changes.

## Problem

Before `lagrange-object-environment` existed, this repository's roadmap had to hold every future image-related idea. That left two areas mixed together:

- `Projects and collaborative history`
- `Graphical environment`

The graphical environment has a clear new home. Project is subtler.

A Project is useful even without a GUI: headless agents, compiler/package tooling, Git/file projections and alternate clients all need a common organization model. Moving Project semantics into a UI repository would either force those clients to depend on the UI layer or encourage several incompatible Project models.

At the same time, browsers, working views, diff/merge interaction and collaboration UX are clearly Object Environment concerns.

## Decision

### 1. Lagrange Images stays the semantic substrate

This repository owns concepts useful without a human graphical environment:

- Value/ref/Shape/object identity and graph edges
- durable history, pinned refs and revisions
- version-aware atomic mutation and conflict signaling
- the language-neutral Project model over ordinary image objects/refs/artifacts
- Project history/working-frontier/diff/merge/conflict semantics
- CodeArtifacts, Blocks, language personalities and execution
- artifact/toolchain/foreign-runtime infrastructure
- generic graph traversal/export/import
- headless file/Git projection services when standardized
- transient execution authority and authorization checks
- durable/distributed backend integration

### 2. Project is image-level, but not a storage primitive

A Project may contain or relate code, notes, tests, data, work items, package/binary/component/runtime artifacts and other Projects.

That semantic model belongs here because non-UI clients need it. But it should initially be implemented using ordinary image objects, refs and artifact edges rather than a new backend record/table kind.

```text
image-level semantic convention != storage primitive
```

### 3. Project interaction moves upward

Lagrange Object Environment owns:

- Project browser/navigation/presentation
- interactive creation/editing commands
- working-view/history/diff presentation
- merge/conflict-resolution interaction
- Git/file projection UX
- multi-author activity/collaboration UI

The environment must use public Project/history APIs rather than create a shadow model.

### 4. The graphical environment moves entirely upward

Drawing/input/rendering, presentations, commands, composition, surfaces/windows, world/window-manager policy, inspectors, browsers, editor/debugger UI, Perspectives and Session mechanics belong to `lagrange-object-environment`.

Lagrange Images exposes semantic/runtime/debug metadata those tools consume. It does not own the graphical tools.

### 5. Collaborative history is split at the semantic/UI line

Lagrange Images owns Project revision/branch/working-frontier/diff/merge/conflict **semantics and data** when implemented.

The Object Environment owns how those states are visualized and how humans interact with conflict resolution.

Generic graph/versioning primitives should be preferred when the Project pressure genuinely generalizes beyond Projects.

### 6. Authority does not follow Project structure

ADR 0037 remains unchanged: authority is transient execution context, not durable program data. Current v0 grants are exact-match, and authorized object access does not recursively follow refs.

Therefore a Project edge is organization, not authority inheritance. `lagrange-object-environment` may offer "share this Project" as user intent, but the trusted lower authority layer must explicitly define how that intent becomes enforceable rights.

### 7. Historical ADRs stay here

Existing ADRs about graph identity, authority, object projection/mutation, language/runtime/toolchain semantics and history remain in this repository. They explain substrate decisions and should not be relocated merely because a new consumer now exists.

The Object Environment records its presentation/interaction decisions in its own ADR sequence.

## Consequences

`lagrange-images` becomes clearer without becoming artificially low-level: it owns semantic image concepts usable by machines and humans, including Project, while excluding graphical interaction policy.

`lagrange-object-environment` can evolve Perspective and UI semantics rapidly while consuming one stable Project/history model.

The integration boundary becomes a useful test: if an environment feature requires new semantic state that a headless client would also need, add a public image-level primitive here. If it is only about how a human sees or manipulates existing state, keep it above the line.
