# ADR 0062: portable WASM graphics use explicit host capabilities

Status: accepted — architectural direction; no graphics runtime behavior is implemented here.

## Problem

Portable 2D/3D rendering is now plausible through WebAssembly Components rather than only through browser-specific WASM applications. In particular, the emerging `wasi:webgpu` proposal expresses GPU access as WIT interfaces, while the `wasi-gfx` ecosystem is developing surface/frame-buffer interfaces and native/browser hosts around the Component Model.

That is a strong fit for the existing foreign-Component and capability model, but it creates a boundary hazard. A tempting implementation would add a Lagrange-specific scene graph, GPU ABI, window abstraction or graphics object kind to the image substrate. That would duplicate a rapidly developing external interface family and contradict ADR 0058, which moved drawing, input, rendering, composition and surfaces to Lagrange Object Environment.

The useful question for this repository is narrower:

```text
How may an ordinary Component declare and receive a graphics capability
without making graphics semantics, authority or host resources part of the image model?
```

## Decision

### 1. Graphics is a use of the existing Component host-import mechanism

Lagrange Images does not gain a separate graphics execution model.

A renderer is an ordinary artifact/Component whose binding explicitly declares the host interfaces it was designed to import. ADR 0038 remains the contract:

```text
durable declaration  -> which interfaces may be wired
current execution     -> which concrete operations are authorized
runtime-local host    -> which provider implements an interface here
```

Graphics therefore composes with the existing artifact graph, Component/WIT lane, activation lifetime and transient authority model instead of bypassing them.

### 2. Prefer ecosystem interfaces over a Lagrange GPU ABI

The preferred low-level direction is the versioned `wasi:webgpu` interface family, currently an active WASI proposal. For presentation surfaces, the preferred experimental direction is the independently versioned `wasi-gfx` interface family.

Do **not** introduce a universal `lagrange:graphics`, `lagrange:gpu` or image-level scene ABI merely to shield code from those projects while they evolve.

The exact imported WIT package/version is part of the explicit artifact/binding contract. Upstream churn is contained by normal versioning and runtime-local provider adapters rather than by teaching the durable image model graphics concepts.

```text
stable Lagrange rule: explicit versioned host imports
replaceable realization: wasi:webgpu / wasi-gfx / later compatible interfaces
```

### 3. No ambient WASI and no authority shortcut

Graphics imports obey ADRs 0037 and 0038 exactly.

- undeclared graphics imports are unavailable at linking/instantiation
- declared imports may be wired only when a runtime-local provider exists
- each protected concrete operation is checked at use time through `require`
- the provider receives check-only authority plumbing, never grants/principals/enumeration
- GPU access does not imply image-object access
- image-object access does not imply GPU access
- revocation remains live; no authorization decision is cached in a GPU/device/surface resource

A future graphics provider may define its own demand/resource vocabulary, but it must do so as an explicit host-capability contract rather than as ambient process authority.

### 4. GPU, device, queue, surface and frame resources are transient host resources

Native/browser GPU handles, adapters, devices, queues, command encoders, surfaces and frame buffers are not image refs and are not durable Values.

They belong to the runtime/session that provides the imported interface. If an upstream WIT interface represents them as `resource` handles, those handles follow the lifetime rules of that host interface and must not be silently promoted into durable image identity.

Durable state is instead represented by ordinary image/artifact data where appropriate:

- renderer Component artifacts and their explicit dependencies
- shaders, textures, meshes, GLB/glTF data and other assets
- semantic object state being presented
- durable presentation intention owned above this repository when appropriate

The existence of a transient GPU resource never creates a new object kind in the image.

### 5. Surface ownership stays above Lagrange Images

ADR 0058 remains strict: surfaces/windows/composition/input belong to Lagrange Object Environment and its renderer adapters.

The Object Environment may create or acquire a host surface and arrange for a Component presentation to receive an appropriate versioned surface/GPU interface. Lagrange Images supplies only the generic Component declaration/execution/authority machinery needed to make that safe.

```text
Lagrange Images
  artifact + binding + explicit imports + execution authority
        |
        v
Lagrange Object Environment / renderer host
  surface lifecycle + compositor + concrete GPU/WIT provider
        |
        v
renderer Component
```

The cross-repository UI adapter remains owned above this repository. This ADR does not create a second graphics host inside Lagrange Images.

### 6. 2D and 3D are not different substrate categories

At the image/runtime layer, both are Components consuming explicit rendering capabilities.

Higher-level scene graphs, retained-mode drawing toolkits, CAD libraries, game-engine facilities and domain renderers are libraries/components above the low-level capability boundary. They may be stored as artifacts and reused like any other ecosystem code; they do not become canonical image semantics merely because they render.

A future optional `lagrange:scene`-style convenience package is acceptable only as an ordinary higher-level library with concrete pressure. It must not replace the portable low-level boundary.

### 7. Renderer language is irrelevant to the boundary

A renderer may originate in Rust, C/C++, JavaScript, Smalltalk, Lisp or another language/toolchain capable of producing a compatible Component. Lagrange Images must not special-case a rendering language or engine.

This is the same artifact-first rule as ADR 0016: source ecosystem is not the platform boundary.

### 8. Input and semantic commands remain separate from GPU access

`wasi:webgpu` is a rendering/compute capability, not permission to mutate the image. Pointer/keyboard/touch delivery and semantic command invocation belong to the Object Environment.

A renderer may receive presentation-local input through an explicit future interface when useful, but a user action that changes semantic image state still travels through the environment's Command -> authorized image-operation path. A GPU callback must never become a hidden mutation channel.

## Consequences

A future image can contain an ordinary object plus assets and a renderer Component without the image knowing what “3D” means:

```text
semantic object
  + renderer Component artifact
  + asset artifacts
        |
        | imports explicit versioned graphics interfaces
        v
Object Environment renderer host
  + surface
  + wasi:webgpu-style provider
        |
        v
native WebGPU/wgpu/Vulkan/Metal/DX12 or browser WebGPU
```

The same durable renderer can in principle run under different hosts that implement the same imported contract. Headless images acquire no graphics dependency. Upstream interface evolution is isolated behind explicit versions. GPU access remains sandboxed independently of image authority.

The cost is that early integrations must track experimental WIT versions and may need adapter churn. That is preferable to freezing a Lagrange-specific graphics ABI before the external ecosystem settles.

## First proof direction

When implementation pressure reaches this boundary, prefer the smallest falsifiable proof:

1. import one exact version of `wasi:webgpu` through the existing ADR 0038 Component-binding path
2. provide it from a runtime-local host without adding a graphics Value/object/storage kind
3. render or compute through a minimal upstream-compatible example
4. prove an undeclared import cannot link
5. prove a declared-but-ungranted protected operation is refused at use time
6. prove GPU/surface handles disappear with their runtime/session rather than entering durable image state
7. have Lagrange Object Environment supply the presentation surface through its renderer boundary

Do not start by designing a scene graph.

## Ecosystem references (non-normative)

Status snapshot: 2026-08-24. These links motivate the direction but do not become Lagrange contracts by reference.

- [`wasi:webgpu`](https://github.com/WebAssembly/wasi-webgpu) — proposed WASI GPU access expressed through WIT; display/windowing is explicitly out of scope.
- [`wasi-gfx`](https://wasi-gfx.dev/) — Component Model graphics/UI interface ecosystem, including surface/frame-buffer work, native runtime and web shim.
- [`wasi-gfx` direction](https://wasi-gfx.dev/blog/posts/future-of-wasi-gfx/) — surface/frame-buffer interfaces move under the independently versioned `wasi-gfx` namespace while `wasi:webgpu` remains the low-level WASI proposal.
- [`wasi-gfx` examples](https://github.com/wasi-gfx/wasi-gfx-examples) — small Component graphics examples and links to larger examples.
- [`mugl`](https://github.com/andykswong/mugl) — useful prior art for a small WebGPU/WebGL abstraction with a raw WASM/WIT-facing API; not a Lagrange dependency.

## Guardrails

```text
graphics capability != image semantics
graphics import != ambient WASI
declaration != authorization
GPU authority != image authority
host GPU/surface resource != image ref
surface/compositor/input policy belongs above Lagrange Images
exact WIT versions are explicit artifact/binding contracts
prefer wasi:webgpu + wasi-gfx-style interfaces over a Lagrange GPU ABI
higher-level scene/engine APIs are optional libraries/components
2D and 3D share the same substrate boundary
renderer language is not part of the contract
semantic mutation still goes through authorized image operations
```
