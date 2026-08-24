# Object-environment boundary

Lagrange Images is the durable language-neutral object/language platform. Human-facing presentation and graphical environment semantics live in [Lagrange Object Environment](https://github.com/psvensson/lagrange-object-environment).

The split is intentionally based on semantics, not on whether an object happens to be durable.

## Lagrange Images owns

- canonical Values, refs, Shapes and object identity
- durable graph records, history and pinned revisions
- version-aware atomic mutation and conflict signaling
- the language-neutral Project model and Project relationships, represented with ordinary image objects/refs rather than a special backend record kind
- generic Project/history/working-frontier/diff/merge/conflict semantics useful to headless clients
- CodeArtifacts, Blocks, lexical environments and language/execution substrate
- artifact dependencies, toolchains and foreign-runtime interfaces
- explicit versioned Component host-import declarations and transient use-time authority checks, including the generic machinery a future graphics Component can use
- generic graph traversal/export/import primitives
- file/Git projection services when they are useful independently of one UI
- transient per-call authority semantics and authorization enforcement
- durable backend/distribution integration

These remain useful to headless agents, compilers/tooling, automation clients and alternate frontends.

## Lagrange Object Environment owns

- Image-as-workspace human interaction model
- Perspective and Session
- presentations and semantic commands
- drawing/input/rendering adapters and composition/world policies
- concrete browser/native GPU, device, queue, surface and frame resources
- runtime-local WIT graphics/surface providers for Component-backed presentations
- inspectors, browsers, editors, history views and debugger UI
- Project navigation/editing interaction
- working-view/diff/merge/conflict presentation and resolution UX
- Git/file projection commands and progress UX
- identity/contact pickers, invitations and sharing UX
- multi-author activity/presence UX

A Perspective may be persisted *inside an image* without becoming a built-in Lagrange Images semantic type. Conversely, Project is intentionally image-level even though its representation can remain ordinary objects and refs.

## Portable Component graphics follow the same boundary

ADR 0062 does not move a graphics subsystem into Lagrange Images. It applies the existing Component/capability rules to rendering code.

The preferred low-level direction is explicit versioned ecosystem interfaces—currently `wasi:webgpu` for GPU access and `wasi-gfx`-style interfaces for presentation surfaces—rather than a Lagrange-specific GPU ABI.

```text
Lagrange Images
  renderer/asset artifacts
  explicit Component imports
  generic Component execution
  transient use-time authority
        |
        v
Lagrange Object Environment
  Presentation + Compositor
  RendererAdapter
  concrete surface/GPU/WIT host provider
        |
        v
renderer Component
```

GPU/device/surface resources are transient host/session resources, not image refs or durable Values. 2D and 3D are not different substrate categories: both can be ordinary Presentations backed by Components. Higher-level scene graphs, plotting/CAD/game-engine APIs and similar facilities stay optional libraries above the low-level capability boundary unless concrete pressure proves a reusable abstraction.

Graphics capability is also independent of image authority. Permission to draw to a surface does not grant permission to read or mutate the semantic subject. Semantic changes still cross the ordinary authorized image-operation path.

## Project is the important middle case

The old roadmap mixed Project semantics with Project UX. They should be split rather than moved wholesale.

A Project is not merely a GUI grouping. It should be usable by:

- headless agents
- language/package tooling
- import/export and Git projections
- authorization-policy tooling
- alternate frontends

Therefore its durable semantic model belongs here.

The Object Environment consumes that model and supplies the human experience around it.

## History is deliberately split

```text
Lagrange Images
  stable identity
  revisions/history
  pinned refs
  expected-version mutation
  Project working-frontier semantics
  generic diff / merge / conflict data

Object Environment
  history browser
  working-view presentation
  Project/object diff presentation
  merge/conflict commands and UX
  Git projection interaction
```

If the Object Environment discovers a missing semantic primitive that is also useful to a headless client, that pressure belongs here. The UI built over it does not.

## Authority is deliberately split too

`reference != authority` remains an image invariant.

ADR 0037 makes authority transient execution context, not durable program data. Root issuance/revocation/policy belongs to trusted host/control-plane APIs; image execution re-authorizes concrete operations at use time.

Project structure does not implicitly become an authority tree. Current exact-match grants and non-transitive ref access make that explicit. A future "share Project" operation needs a deliberate lower authority contract.

The Object Environment owns the sharing intent and orchestration, not a second grant model.

## Pressure rule

Before adding a concept here, ask:

> Is this semantic state or behavior useful to a headless image client?

If yes, it may belong in Lagrange Images.

If it is Perspective, presentation, command, pane/window/compositor, inspector/browser UI, invitation workflow, concrete graphics/surface hosting or another way for humans to see and inhabit the image, it belongs above this repository.
