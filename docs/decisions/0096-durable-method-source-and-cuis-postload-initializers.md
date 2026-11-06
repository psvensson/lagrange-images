# ADR 0096: Durable native method source and Cuis post-load initializers

Status: implemented
Proven by: test/smalltalk-authorized-browse.test.js, test/smalltalk-builder-recovery.test.js, test/cuis-native-import.test.js

## Context

1. **Durable native method source (`lagrange-images-jtz.1`).** Under ADR 0087 decision 6, `authorizedDescribeSmalltalkMethod` reported `source: null` because `installMethods` in `src/language/smalltalk-class-builder.js` persisted only `<methodId>:semantic` and the method Block, whereas standalone Blocks (`installSymmetricSmalltalkBlock`) persisted `<id>:source` (`symmetric-smalltalk/source-v0`). Meanwhile, ADR 0087 explicitly rejected walking `CodeArtifact.derivedFrom` inside `src/language/smalltalk-browse.js` (which would create a second `CodeArtifact` decoder), and ADR 0088 required unretained replacements to keep reporting `source: null`.
2. **Cuis post-load class initialization.** Real Cuis packages (such as YAXO `XMLTokenizer initialize!`) include top-level post-load class initialization chunks that initialize declared class variables after classes and methods are installed. Previously, callers importing such packages had to invoke `ClassName initialize` manually after `importCuisNativePackage`.

## Decision

1. **Class-builder-owned durable method source (`<methodId>:source` and `methodSource`).**
   - `defineMethods` and `reconcileMethods` in `src/language/smalltalk-class-builder.js` accept an optional `source` text property on each method descriptor. When `source` is provided (including via `retainSource: true` on `defineMethodsFromSource`, `reconcileMethodsFromSource`, `importCuisNativePackage`, `authorizedImportCuisPackage`, or `authorizedReplaceSmalltalkMethod`), `installMethods` persists a deterministic `<methodId>:source` `CodeArtifact` (`languageId: 'symmetric-smalltalk'`, `representation: 'symmetric-smalltalk/source-v0'`) before `<methodId>:semantic`, links `<methodId>:semantic`'s `derivedFrom` to `[objectRef(imageId, '<methodId>:source')]`, and includes `source` in revision identity (`methodRevisionId`) and convergence checks (`isSameInstalledMethod`).
   - `src/language/smalltalk-class-builder.js` owns and exports `methodSource({images, imageId, blockRef})`, which verifies that `blockRef` names a native method Block (`metadata.smalltalk === 'method'`) and reads `<blockId>:source` (`symmetric-smalltalk/source-v0`), returning the stored source text or `null` when absent.
   - `src/language/smalltalk-browse.js` calls `methodSource({images, imageId, blockRef: binding.method})` only after both `object/read` on the Class/Metaclass and `smalltalk-method/read` on the logical method position have succeeded. It never walks `CodeArtifact.derivedFrom` or decodes executable representations itself.
   - Because `<methodId>:source` is keyed by the immutable revision Block id (`blockRef.objectId`), an unretained method or an unretained replacement revision has no `<revisionId>:source` artifact and truthfully reports `source: null` (never leaking stale source from an earlier revision).

2. **Explicit Cuis post-load class initializers (`extractCuisPackagePostLoadInitializers` and `postLoadInitializers`).**
   - `src/language/cuis-native-import.js` exports `extractCuisPackagePostLoadInitializers(packageName, pckSource)` to parse top-level post-load `<ClassName> initialize!` chunks from Cuis `.pck.st` chunk-format text into canonical `cuis-class/<packageName>/<ClassName>` identities while rejecting arbitrary DoIt expressions.
   - `planCuisNativeImport` and `importCuisNativePackage` (and `authorizedImportCuisPackage`) accept optional `postLoadInitializers` (on the manifest or options). Every entry must name an in-scope imported class (or `<ClassName> initialize`) that declares a covered class-side `initialize` method (`cuis-method/<pkg>/<Class>/class/initialize`); any other selector or expression is refused before the first native write with `CuisNativeImportError`.
   - Planned post-load initializers are ordered deterministically by package dependency topological order (`manifest.packages` `requires`) and class inheritance topological order (`plan.ordered`), and are dispatched as unary `initialize` sends to each resolved `classRef` after all classes, class-variable bindings, globals, and method groups have been installed.

## Consequences

- Callers that opt into `retainSource: true` (or supply `source` to `defineMethods` / `reconcileMethods`) get durable, restart-safe `symmetric-smalltalk/source-v0` method source visible through `authorizedDescribeSmalltalkMethod` and `authorizedReadSmalltalkMethodForUpdate` without turning `smalltalk-browse.js` into a `CodeArtifact` decoder.
- Existing callers and E1/E3 proofs that do not request `retainSource: true` continue to write zero extra artifacts and observe `source: null`.
- Cuis packages with `ClassName initialize!` post-load initializers can execute their class-side initializers deterministically as part of native import while arbitrary load-time DoIt expressions remain refused.
