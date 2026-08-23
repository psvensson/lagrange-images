# Object-environment boundary

Lagrange Images is the durable language-neutral object/execution substrate. Human-facing organization and graphical environment semantics live in [Lagrange Object Environment](https://github.com/psvensson/lagrange-object-environment).

The split is intentionally based on semantics, not on whether an object happens to be durable.

## Lagrange Images owns

- canonical Values, refs, Shapes and object identity
- durable graph records, history and pinned revisions
- version-aware atomic mutation and conflict signaling
- CodeArtifacts, Blocks, lexical environments and language/execution substrate
- artifact dependencies, toolchains and foreign-runtime interfaces
- generic graph traversal/export/import primitives
- generic revision/snapshot/diff/branch/merge primitives when they are useful to clients independent of one UI
- transient per-call authority semantics and authorization enforcement
- durable backend/distribution integration

These are useful even to a headless client with no Project, editor or GUI.

## Lagrange Object Environment owns

- Image-as-workspace user model
- Project as semantic organization over ordinary image objects and refs
- code + notes + tests + data + work-item organization
- Project relationships to package/binary/component/runtime artifacts
- Perspective and Session
- presentations and semantic commands
- drawing/input/rendering adapters and composition/world policies
- inspectors, browsers, editors, history views and debugger UI
- working-view/diff/merge/conflict interaction
- Git import/export as a projection
- identity/contact pickers, invitations and sharing UX
- multi-author/presence UX

A Project or Perspective may be persisted *inside an image* without becoming a built-in Lagrange Images record kind. The image substrate sees ordinary objects/refs; the higher-level convention says what they mean.

## History is deliberately split

```text
Lagrange Images
  stable identity
  revisions/history
  pinned refs
  expected-version mutation
  generic revision/diff/branch/merge primitives

Object Environment
  history browser
  working views
  Project/object diffs
  merge/conflict commands and presentation
  Git projection
```

If the Object Environment discovers that it needs a generic branch or diff primitive that would also be useful to a headless client, that pressure belongs here. The UI built over it does not.

## Authority is deliberately split too

`reference != authority` remains an image invariant.

ADR 0037 makes authority transient execution context, not durable program data. Root issuance/revocation/policy belongs to trusted host/control-plane APIs; image execution re-authorizes concrete operations at use time.

The Object Environment owns the user intent and orchestration of sharing, not a second grant model. In particular, a Project edge does not imply transitive authority over the object it references. Current exact-match authority semantics make that distinction explicit.

## Pressure rule

Before adding a concept here, ask:

> Would this still be a useful, language-neutral image primitive if Lagrange Object Environment did not exist?

If yes, it may belong in Lagrange Images.

If the concept is Project, Perspective, presentation, command, window/pane/compositor, invitation, collaboration UX or another way for humans to organize and inhabit the image, it belongs above this repository.
