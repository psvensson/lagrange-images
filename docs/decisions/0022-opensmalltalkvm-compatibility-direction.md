# ADR 0022: OpenSmalltalkVM compatibility direction

Status: accepted as long-term Smalltalk compatibility direction; implementation has not started.

## Problem

Lagrange Images has two different Smalltalk goals:

1. build Symmetric Smalltalk as an image-native language designed for this platform;
2. reuse the existing Smalltalk ecosystem, especially Cuis/Squeak-compatible code, without reimplementing an entire mature VM/compiler/runtime before useful compatibility exists.

Trying to satisfy both goals with one native compatibility compiler would pull Cuis/OpenSmalltalkVM assumptions into the generic image substrate and would require reproducing VM, primitive, object-memory and compiler behavior unnecessarily.

The artifact/toolchain/foreign-runtime architecture now provides a better route.

## Decision

Smalltalk support should have two complementary paths:

```text
                         Smalltalk
                            |
              +-------------+-------------+
              |                           |
              v                           v
      Symmetric Smalltalk          Cuis/Squeak compatibility
      image-native model                  |
              |                           v
              |                    OpenSmalltalkVM
              |                           |
              +-------------+-------------+
                            |
                            v
                  shared image/project
                     infrastructure
```

Symmetric Smalltalk remains the native language experiment.

OpenSmalltalkVM becomes the preferred first compatibility path for mature Smalltalk code.

The two paths may converge at project/artifact/interface/tooling layers without pretending their object memories or runtime semantics are identical.

## OpenSmalltalkVM has three intended roles

### 1. Foreign compatibility runtime

The first practical role is a real Smalltalk runtime behind an explicit adapter:

```text
image project/interface
        -> Smalltalk runtime adapter
        -> OpenSmalltalkVM
        -> Cuis/Squeak-style Spur image
```

This path prioritizes compatibility with real Smalltalk packages, compiler behavior, primitives and image/runtime conventions.

The foreign runtime may initially run as an OCI-managed process/container.

The durable Lagrange image stores references to runtime/image/package artifacts and explicit callable interfaces; the OpenSmalltalk heap remains foreign runtime state.

### 2. Existing Smalltalk compiler/toolchain

OpenSmalltalkVM should also be usable as a toolchain host for the real Smalltalk compiler rather than requiring Lagrange Images to implement Cuis compilation first.

Conceptually:

```text
Cuis source / package artifacts
        -> OpenSmalltalkVM + Cuis image
        -> real Cuis compiler/tooling
        -> runnable Spur image and/or structured compiled artifacts
```

This follows the same architecture already used for Rust/Cargo: Lagrange Images orchestrates an existing compiler ecosystem instead of replacing it.

The first useful output may simply be a reproducible runnable Smalltalk image artifact. Later toolchain outputs may expose classes, methods, compiled methods, bytecodes, literals, source/package relationships and other structured data.

### 3. Migration/bootstrap engine

The compatibility runtime should eventually help move selected code into the native Lagrange image model.

A real Smalltalk image can export structured semantic information rather than forcing file-level reverse engineering:

```text
OpenSmalltalkVM + Cuis image
        -> structured exporter
        -> class/method/package/compiler artifacts
        +-> continue executing in OpenSmalltalkVM
        `-> lower selected code into native Lagrange representations
```

This permits gradual migration:

```text
foreign Cuis runtime
      -> foreign Cuis + native services
      -> image-visible Cuis classes/methods/packages
      -> selected native compilation
      -> deeper native compatibility where worthwhile
```

There is no requirement that all useful Cuis code eventually become native.

## Foreign heap is not the image graph

The most important boundary is:

```text
Spur object memory != Lagrange image graph
```

Do not use Smalltalk object pointers/oops as durable Lagrange object identity.

Do not replace OpenSmalltalkVM object memory with Lagrange graph storage merely to make the runtime appear native. That would turn compatibility work back into a new VM/object-memory implementation.

If arbitrary foreign objects later need durable handles, use an explicit adapter/handle registry:

```text
Lagrange foreign-object handle
        -> Smalltalk-side stable handle table
        -> current runtime object
```

The first compatibility API should prefer explicitly exported Smalltalk services/interfaces over making every object remotely addressable.

## Interfaces remain separate from authority

The same rule used for foreign WASM applies:

```text
foreign object/interface identity != capability
runtime handle != authority
```

A Smalltalk runtime adapter must receive explicit capability/principal context for operations that cross image/runtime boundaries.

The convenience of Smalltalk message syntax must not erase process, image or authority boundaries.

## OCI runtime and OCI toolchain are different roles

OpenSmalltalkVM may use OCI in both modes, but they are not the same lifecycle:

```text
build/toolchain OCI
  source/packages -> compiler image -> derived artifacts -> container exits

foreign-runtime OCI
  callable/interface -> live Smalltalk runtime -> runtime remains active
```

Do not treat a build image as a persistent Smalltalk runtime or vice versa.

## Longer-term WASM target

A more ambitious compatibility target is a headless OpenSmalltalk interpreter/Spur runtime compiled to WebAssembly and hosted through the foreign/component-WASM execution layer.

Conceptually:

```text
OpenSmalltalk interpreter + Spur runtime
        -> generated/native implementation
        -> WebAssembly
        -> explicit runtime/component interface
        -> Lagrange placement/sandboxing
```

The interpreter-style VM is the preferred first target for such a port. A native-code-generating JIT runtime has substantially different assumptions and should not be required for the first WASM proof.

This goal depends on richer foreign-WASM contracts than `wasm-scalar-call/v0`, including some combination of:

- linear-memory/string/byte interfaces;
- runtime initialization and image loading;
- controlled host callbacks;
- capability-aware services;
- snapshot/export operations;
- async host effects where necessary;
- likely Component/WIT-style interfaces.

This is a long-term optimization/integration path, not a prerequisite for OCI foreign-runtime compatibility.

## Desired end state

The desired end state is not one universal Smalltalk implementation.

It is a continuum:

```text
native Symmetric Smalltalk
          |
          | shared projects/artifacts/interfaces/tools
          |
OpenSmalltalkVM-backed compatible Smalltalk
          |
          +-> native/OCI runtime where compatibility is primary
          +-> WASM-hosted interpreter runtime where placement/sandboxing helps
          `-> selectively migrated native code where integration/performance justifies it
```

Users should be able to keep established Smalltalk code running while incrementally gaining Lagrange image identity/history, project relationships, capabilities, distributed services and native execution where useful.

## Guardrails

```text
Smalltalk compatibility != reimplement OpenSmalltalkVM
foreign Spur heap != Lagrange image graph
Spur oop != durable ObjectRef
foreign runtime != compiler/toolchain lifecycle
runtime handle != capability
compatibility != mandatory migration
```

The generic image/toolchain/runtime substrate must remain usable by Java, Rust, Lisp and other languages; OpenSmalltalkVM integration is a consumer of those boundaries, not a reason to specialize them for Smalltalk.

## Consequence

The earlier idea of beginning Cuis compatibility with a hand-built native compatibility kernel is no longer the preferred first step.

The first compatibility experiment should instead prove that a real OpenSmalltalkVM/Cuis environment can participate through the existing artifact/toolchain/foreign-runtime abstractions. Native compatibility work should then be driven by concrete migration/performance/tooling needs discovered from that proof.
