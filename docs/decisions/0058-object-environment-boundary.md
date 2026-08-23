# ADR 0058: move Project and graphical-environment semantics above Lagrange Images

Status: accepted — responsibility boundary; no runtime behavior changes.

## Problem

Before `lagrange-object-environment` existed, this repository's roadmap had to hold every future image-related idea. That left two sections here by default rather than by architecture:

- `Projects and collaborative history`
- `Graphical environment`

The result blurs two different meanings of "lives in an image".

A Project or UI arrangement may be stored durably as ordinary image objects, but that does not mean the generic image substrate must define what a Project, Perspective, pane, window or inspector means.

The same blur appeared in collaboration work. Stable revisions and version-aware mutation are generic image capabilities. A history browser, Git projection and merge-conflict UI are not.

## Decision

### 1. Lagrange Images stays the generic substrate

This repository owns concepts that remain useful without a human object environment:

- Value/ref/Shape/object identity and graph edges
- durable history, pinned refs and revisions
- version-aware atomic mutation and conflict signaling
- CodeArtifacts, Blocks, language personalities and execution
- artifact/toolchain/foreign-runtime infrastructure
- generic graph traversal/export/import
- generic revision/diff/branch/merge primitives if real pressure proves they are broadly reusable
- transient execution authority and authorization checks
- durable/distributed backend integration

### 2. Project is not a new image record kind

Project semantics move to `lagrange-object-environment`.

A Project may still be a durable object graph containing/relating code, notes, tests, data, work items, package/binary/component/runtime artifacts and other Projects. Lagrange Images persists those objects and refs without knowing that they constitute a Project.

This is the same layering rule already used for language/tooling policy: durable representation does not imply generic-substrate semantics.

### 3. The graphical environment moves entirely upward

Drawing/input/rendering, presentations, commands, composition, surfaces/windows, world/window-manager policy, inspectors, browsers, editor/debugger UI and Perspectives belong to `lagrange-object-environment`.

Lagrange Images may expose semantic/runtime/debug metadata those tools consume. It does not own the tools.

### 4. Collaborative history is split at the generic primitive line

Lagrange Images owns stable history/revision primitives.

The Object Environment owns:

- Project working views
- object/Project diff presentation
- merge/conflict interaction
- Git import/export as projection
- multi-author collaboration UI

If the environment needs a branch/diff/merge primitive that is useful to non-UI clients, it should request a public generic primitive here rather than implement a shadow history store.

### 5. Authority does not follow Project structure

ADR 0037 remains unchanged: authority is transient execution context, not durable program data. Current v0 grants are exact-match, and authorized object access does not recursively follow refs.

Therefore a Project edge is organization, not authority inheritance. `lagrange-object-environment` may offer "share this Project" as user intent, but the trusted lower authority layer must explicitly define how that intent becomes enforceable rights.

### 6. Historical ADRs stay here

Existing ADRs about graph identity, authority, object projection/mutation, language/runtime/toolchain semantics and history remain in this repository. They explain substrate decisions and should not be relocated merely because a new consumer now exists.

The new Object Environment records its own Project/UI decisions in its own ADR sequence.

## Consequences

The `lagrange-images` roadmap becomes narrower: language/execution, durable graph/history, authority enforcement, toolchains/runtimes and distribution.

`lagrange-object-environment` can evolve Project, Perspective and UI semantics rapidly without forcing image-substrate changes.

The integration boundary becomes a useful architectural test: when the environment cannot build a feature through public image APIs, decide whether the missing piece is a genuinely generic image primitive. If it is not, keep it above the line.
