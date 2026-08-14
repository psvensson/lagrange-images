# ADR 0025: Existing Cuis package compatibility proof

Status: accepted for the first upstream-package compatibility proof.

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

The OpenSmalltalk/Cuis provider start spec may now contain explicit package installation inputs:

```js
{
  packages: [{
    path: '/local/install/JSON.pck.st',
    identity: 'cuis-package/JSON/.../gitblob:47fab65...'
  }]
}
```

The path is transient deployment information. The identity is the immutable package identity recorded in runtime metadata.

The provider copies every package into its private temporary runtime workspace using generated names and then the Cuis bootstrap script installs them with Cuis' own package API:

```smalltalk
CodePackageFile installPackage:
  DirectoryEntry currentDirectory // 'package-0.pck.st'.
```

The foreign runtime service itself remains language-neutral. It does not learn about `.pck.st`, Cuis features or package installation semantics.

## Why copy packages into the private workspace

The running Cuis image should not receive arbitrary caller filesystem paths as part of its Smalltalk script. Host deployment paths remain outside the guest-visible protocol.

The provider therefore copies explicit inputs into a private workspace first:

```text
caller path
  -> provider-private copy
  -> fixed workspace filename
  -> Cuis package loader
```

Runtime metadata exposes package identities, not local paths.

## Package proof service

The existing bridge stays whitelisted. No generic package API, eval or selector dispatch is added.

A new explicit proof endpoint is:

```text
json/package-proof
```

Inside the already-running image it obtains the installed `Json` class, parses a nested JSON document, renders it, parses the rendered result again, and verifies nested dictionary/array/boolean/string content. The result crosses the foreign-runtime boundary as one canonical boolean Value.

This proves:

```text
real pinned Cuis image
  -> real CodePackageFile package installation
  -> unchanged upstream JSON package
  -> package parser + renderer
  -> persistent foreign runtime service
  -> canonical Lagrange Value
```

The bridge wire itself remains integer/boolean-only for now. Rich text transport should be designed as an interface/ABI concern rather than smuggled in merely for this test.

## Real CI proof

The existing OpenSmalltalk integration job now additionally downloads the pinned JSON package and verifies its Git blob identity before starting the runtime.

The authoritative test then:

1. starts the pinned OpenSmalltalkVM + Cuis image;
2. supplies the JSON package as an explicit start-spec package;
3. waits until package installation and bridge initialization complete;
4. proves the original `proof/add` call still works;
5. calls `json/package-proof` and requires canonical `true`;
6. proves another normal call still works afterward;
7. shuts the runtime down cleanly.

That sequence also proves package installation does not replace the existing persistent runtime/service lifecycle.

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
package path != package identity
package identity != provider identity
installed package != Lagrange image object graph
package loading != ambient eval
package class/object != durable ObjectRef
runtime interface != arbitrary Smalltalk selector
```

## Consequence

The compatibility claim is now stronger than "a Cuis image can run": an unmodified upstream Cuis package can be installed with Cuis' own package machinery and exercised through the common foreign-runtime boundary.

The next useful Smalltalk step can therefore move in either of two concrete directions:

1. load a larger third-party Cuis package with explicit package dependencies, or
2. reuse the same VM/image/package machinery as a real `ToolchainService` compiler host and produce a derived runnable image/package artifact.
