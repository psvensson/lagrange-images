# ADR 0025: Existing Cuis package compatibility proof

Status: implemented — the first upstream-package compatibility proof.
Proven by: test/opensmalltalk-cuis-real.test.js

## Problem

ADR 0024 proved that a pinned OpenSmalltalkVM + Cuis image can run as a managed foreign runtime and execute a small service compiled inside the image. That still left an important gap: the bridge service itself was authored specifically for Lagrange Images.

The next pressure test is whether an existing Cuis package can be loaded and used unchanged through the same runtime boundary.

## Chosen package

The first package is Cuis' upstream JSON package:

```text
repository: Cuis-Smalltalk/Cuis-Smalltalk-Dev
commit: 6bcee3f38ce037c9714b997ccd3b5b3ff62965c8
path: Packages/Features/JSON.pck.st
git blob: 47fab65d0d9017d706aa07d39ab0451619488ccd
provides: JSON 1 29
requires: Cuis-Base
```

It is useful for this proof because it is a normal `.pck.st` package, uses no external native plugin or UI dependency, and exercises real package loading plus nontrivial parser/renderer code.

## Package loading contract

The OpenSmalltalk/Cuis provider start spec may contain explicit package installation inputs:

```js
{
  packages: [{
    path: '/local/install/JSON.pck.st',
    identity: 'cuis-package/JSON/.../gitblob:47fab65...'
  }]
}
```

Three things are deliberately separate:

```text
host path       transient deployment location
safe basename   guest-visible Cuis package filename
identity        immutable package identity
```

The provider copies each package into its private runtime workspace while preserving its validated `.pck.st` basename, then installs it with Cuis' own package API:

```smalltalk
CodePackageFile installPackage:
  DirectoryEntry currentDirectory // 'JSON.pck.st'.
```

Host directory paths never enter the guest script or runtime metadata. Runtime metadata records package identity plus the guest-visible safe basename.

The foreign runtime service itself remains language-neutral. It does not learn about `.pck.st`, Cuis features or package installation semantics.

## Bootstrap ordering discovered by the real proof

The first attempts installed the package before compiling the fixed Lagrange bridge. The package installation itself completed, but subsequent bridge compilation did not reliably reach readiness.

The working ordering is:

```text
pristine Cuis image
  -> compile provider-owned bridge/control plane
  -> instantiate bridge service
  -> install explicit guest packages
  -> READY
  -> package-backed calls
```

This is also the cleaner architectural boundary: provider control-plane code is established against the known base image before guest/application packages are allowed to modify the live Smalltalk environment.

Package installation is therefore application/runtime state, not part of provider implementation identity.

## Why copy packages into the private workspace

The running Cuis image should not receive arbitrary caller filesystem paths. The provider materializes explicit inputs first:

```text
caller host path
  -> provider-private workspace
  -> validated original basename
  -> Cuis package loader
```

The basename is preserved because the real Cuis package machinery treats package filenames as meaningful documents. The directory path is not.

## Package proof service

The existing bridge stays whitelisted. No generic package API, eval or selector dispatch is added.

A new explicit proof endpoint is:

```text
json/package-proof
```

Inside the running image it obtains the installed `Json` class, parses a nested JSON document, renders it, parses the rendered result again, and verifies nested dictionary/array/boolean/string content. The result crosses the foreign-runtime boundary as one canonical boolean Value.

This proves:

```text
real pinned Cuis image
  -> real CodePackageFile package installation
  -> unchanged upstream JSON package
  -> package parser + renderer
  -> persistent foreign runtime service
  -> canonical Lagrange Value
```

The bridge wire itself remains integer/boolean-only. Rich text transport should be designed as an interface/ABI concern rather than smuggled in merely for this test.

## Real CI proof

The OpenSmalltalk integration job downloads the pinned JSON package and verifies its Git blob identity before starting the runtime.

The authoritative test then:

1. starts the pinned OpenSmalltalkVM + Cuis image;
2. compiles the fixed provider bridge in the pristine image;
3. supplies and installs the JSON package as an explicit start-spec package;
4. reaches bridge readiness;
5. proves the original `proof/add` call still works;
6. calls `json/package-proof` and requires canonical `true` after parse/render/reparse;
7. proves another normal call still works afterward;
8. shuts the runtime down cleanly.

The package is therefore not merely accepted by the loader: real upstream package code executes successfully inside the persistent managed runtime.

## Bootstrap diagnostics

The provider emits narrowly scoped transient `BOOT` progress markers while starting. They identify bridge compilation and package-install start/done boundaries and are consumed by the provider for startup diagnostics.

They are not runtime metadata, durable state or callable application output.

The markers were useful enough during this proof to keep as runtime diagnostics: they distinguished a successful package installation from a later bootstrap compiler interaction without exposing arbitrary guest stdout as an interface.

## Boundaries deliberately not generalized yet

This proof does not yet define:

- durable `CodeArtifact` conventions for Smalltalk package files;
- dependency resolution between several Cuis packages;
- Feature discovery/download;
- package version solving;
- arbitrary package-provided service discovery;
- generic Smalltalk selector dispatch;
- text/bytes/record wire Values for the runtime bridge;
- package mutation/saving back into durable image artifacts;
- OpenSmalltalkVM/Cuis as a `ToolchainService` provider.

Those should be driven by larger real packages rather than inferred from one fixture.

## Guardrails

```text
package path != package basename
package basename != package identity
package identity != provider identity
installed package != Lagrange image object graph
package loading != ambient eval
package class/object != durable ObjectRef
runtime interface != arbitrary Smalltalk selector
provider bridge bootstrap != guest package state
```

## Consequence

The compatibility claim is now stronger than "a Cuis image can run": an unmodified upstream Cuis package can be installed with Cuis' own package machinery and its real parser/renderer code can be exercised through the common foreign-runtime boundary.

The next useful Smalltalk step can therefore move in either of two concrete directions:

1. load a larger third-party Cuis package with explicit package dependencies, or
2. reuse the same VM/image/package machinery as a real `ToolchainService` compiler host and produce a derived runnable image/package artifact.
