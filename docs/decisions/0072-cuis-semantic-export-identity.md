# ADR 0072: Cuis semantic export identity — semantic Package/Class/Method identities, not heap identity

Status: accepted — investigation outcome; v1 implementation follows this contract

**Decides how Cuis software structure becomes image-visible without ever crossing the heap
boundary.** The invariant is `Spur oop != ObjectRef` (language-platform.md §heap boundary): the
export carries **semantic** Package/Class/Method identities and relationships, never a Spur object
pointer, never a raw global, never a `MethodReference stringVersion`. Two-stage: (1) a canonical
`smalltalk/cuis-semantic-export-v1` derived artifact (a manifest), then (2) materialize it into
ordinary Shapes/objects/refs. **V1 scope:** package requirements, classes, superclass relations, and
method side/selector/source/package. **Deferred:** bytecodes, literals, class comments,
instance-variable definitions, arbitrary heap export, and bidirectional mutation. **No** generic
oop/`perform:`/introspection protocol is added.

This is the workstream-2 follow-on to the multi-package Cuis proof (Bead `d57`, PR #135), and the
first step of the convergence goal: Symmetric Smalltalk and Cuis/OpenSmalltalk both becoming
image-visible classes/methods/packages/projects through common Project/artifact relationships.

## Problem

The compatibility path proves Cuis software *runs* (ADRs 0024–0026, PR #135), but its semantic world
stays opaque inside the Spur heap. To make Cuis software *image-visible* — so the image can reason
about its packages/classes/methods and converge it with native Smalltalk structure — we must export
that structure as ordinary artifacts/objects. Doing this naively would leak heap identity (oops) or
require a generic introspection/perform protocol, both of which violate the substrate boundary.

## Decisions

### 1. Identity model — semantic, package-scoped, never heap

- A **package** has identity `cuis-package/<packageName>`.
- A **class** has identity `cuis-class/<packageName>/<className>`, where `<packageName>` is the
  package that *defines* the class. A base-image class (one no exported package defines) has the
  **reserved** identity `cuis-class/Cuis-Base/<className>`. `Cuis-Base` is a reserved name: no
  exported package may claim it, it is **never materialized** as a package object, and it carries **no
  methods** in v1.
- A **method** has identity `cuis-method/<owningPackage>/<targetClassName>/<side>/<selector>`, and
  carries **two** references: `package` (the *owning* package, from `packageOfMethod:ifNone:`) and
  `class` (the *target* class's `cuis-class` identity — which may be a different package, or a base
  class). `side` ∈ `{instance, class}`. The selector is canonical (keyword selectors joined with no
  spaces).
- A **superclass** relation is always a `cuis-class` ref: to an exported package's class when defined
  there, else to `cuis-class/Cuis-Base/<Name>`.

### 2. Extension methods are first-class (not a special case)

Packages routinely add methods to classes they do **not** define (e.g. `Compression` adds
`ByteArray>>unzipped`, `ReferenceStream class>>…`, `CodePackageFile class>>…`). The manifest therefore
separates **"classes this package defines"** from **"methods this package owns"**: an extension method
is owned by its package but targets a foreign/base class. Attribution uses Cuis's own
method-category prefix-match semantics (`CodePackage >> category:matches:`, the same rule
`packageOfMethod:ifNone:` applies): a category `*<pkg>` or `*<pkg>-<rest>` (case-insensitive) is owned
by `<pkg>`, e.g. `*Compression-ObjectStorage` belongs to `Compression`. Class-side attribution uses
`MethodReference`'s `classIsMeta`.

**Implementation note (accepted deviation from the original `packageOfMethod:ifNone:` text).** The
shipped extractor (`ownerOfSel` in `opensmalltalk-cuis-toolchain-provider.js`) *re-implements* that
prefix match inline rather than calling `CodePackage >> packageOfMethod:ifNone:` per method. This is
deliberate and safe: `packageOfMethod:ifNone:` scans every installed package per method (O(packages ×
methods)), which is prohibitively slow in the headless interpreter across a multi-package cluster,
whereas the inline check resolves ownership against the package being walked in O(1). The replicated
rule is byte-for-byte the `category:matches:` semantics (lowercased prefix, exact match, or next char
`-`), verified against the real cluster categories (`*Compression`, `*Compression-ObjectStorage`,
`*FFI-Kernel-*`, `*Alien-Core`, `*extendedClipboard-Win32`, `*Graphics-Files-Additional`). It is **not**
a new attribution rule — it is the same rule, evaluated without the per-method scan. Out of v1 scope: a
method category claimed by *two* exported packages (would need explicit disambiguation later).

### 3. Canonical export schema (`smalltalk/cuis-semantic-export-v1`)

The manifest is canonical — a pure function of semantic content, not of iteration order:

```text
{ format: 'smalltalk/cuis-semantic-export-v1',
  packages: [ { name, requires: [packageName, ...] }, ... ],              // sorted by name; requires sorted
  classes:  [ { package, name, superclass: <cuis-class identity>, ... } ], // sorted by (package, name)
  methods:  [ { package, class: <cuis-class identity>, side, selector, source }, ... ] // sorted by (package, class, side, selector)
}
```

`source` is the method body text **after canonical normalization** (§5). Everything is sorted; there
are no timestamps, heap addresses, or random ids anywhere in the artifact.

### 4. Extraction is toolchain-stage, in the build script, before `saveAndQuitAs:`

The class/method structure is complete in the saved derived image (`saveAndQuitAs:` with
`clearAllClassState: false` preserves method dictionaries and class structure). So the export runs as
a fixed, provider-owned `.st` script **in the same toolchain build, just before `saveAndQuitAs:`** —
the finite-build seam, same trust level as the existing `buildScript`. It walks classes **inside the
guest** and emits the manifest as **text** (to a file the provider reads), producing a
`smalltalk/cuis-semantic-export-v1` artifact alongside the derived image/changes. It is **not** a
live-bridge operation: the runtime bridge stays a fixed narrow allowlist (`normalizeInterface`), and
no `perform:`/generic-eval/oop crosses the boundary — only selectors, names, and source text leave the
guest. **Extraction does not mutate the image**, so a fresh runtime of the derived image is unaffected.

### 5. Determinism — committed as a tested property, with mandatory normalization

Two equivalent builds (same base + same packages/versions) must yield **byte-identical** export
artifacts. This is **tested, not assumed** (the proof builds twice and compares export bytes), per ADR
0026's discipline that snapshot bytes are not assumed deterministic. Determinism holds only under
these conditions, which the exporter must enforce:

- `sourceCodeAt:` returns the method **body text without** the change stamp (the stamp is a separate
  preamble chunk, not part of the returned source). Source is byte-stable **only after canonical
  normalization**: normalize line endings to LF, trim trailing whitespace per line, trim
  leading/trailing blank lines, and **preserve interior formatting** (no reformatting — that would
  destroy source fidelity).
- `selectorsDo:` order is **hash-dependent** (MethodDictionary `keysDo:`), so methods are sorted by
  the canonical key. `allClassesDo:` is already sorted, but the exporter sorts regardless rather than
  relying on it. Package/`requires` lists are sorted.
- The `saveAndQuitAs:` timestamp is appended **after** the copied changes region, so it does not
  perturb package method source chunks. The toolchain makes `base-sources` an explicit input, so
  `.sources`-backed methods are stable across builds of the same inputs.

### 6. Materialization reuses the authorized creation batch (no new authority)

A host function reads the manifest and creates ordinary image objects — Package, Class (with
superclass + package refs), Method (with class + package refs, side, selector, source) — through the
**authorized atomic creation batch** (ADR 0067), using `local:<name>` intra-batch refs for the
relationships. No new lane, no new authority. `Cuis-Base` superclass/class refs are recorded as the
reserved identity **string**, not materialized into objects.

## Ownership

- The **OpenSmalltalk/Cuis toolchain provider** owns the extraction seam (the export script and the
  `smalltalk/cuis-semantic-export-v1` artifact it emits) — an extension of its existing build-script
  ownership.
- The **image-creation-batch lane** (ADR 0067) owns the manifest→objects materialization interaction;
  the toolchain does not create image objects.
- `docs/ownership.md` gains a row for the `smalltalk/cuis-semantic-export-v1` representation and the
  manifest→batch interaction.

## What this ADR does NOT build

V1 defers: bytecodes/CompiledMethod internals, literals, class comments, instance-variable
definitions, arbitrary heap-object export, and any bidirectional mutation (image→Cuis or live
edit). It adds no generic oop/`perform:`/introspection protocol and no live-bridge export
operation. Those are separate decisions under real pressure.

## Consequences

- Cuis packages/classes/methods become image-visible as ordinary artifacts/objects with stable
  semantic identities — the first concrete step of the Smalltalk convergence (native Symmetric
  Smalltalk and foreign Cuis both visible through common Project/artifact structure).
- The determinism commitment (§5) makes the export a reliable, cacheable derived artifact and gives a
  falsifiable proof (build twice → byte-identical).
- The heap boundary is preserved: no oop ever crosses; only semantic names/source do.
- The multi-package cluster (PR #135) is the proof target: `Compression` appears with the right
  superclass, `FFI` lists `WeakDictionaries` + `Alien-Core` as requirements, and extension methods
  (`ByteArray>>unzipped`) are attributed to `Compression` targeting `cuis-class/Cuis-Base/ByteArray`.

## Guardrails

```text
Spur oop != ObjectRef. The export carries semantic identities only:
  cuis-package/<pkg>
  cuis-class/<pkg>/<class>            (base classes: reserved cuis-class/Cuis-Base/<class>)
  cuis-method/<owningPkg>/<targetClass>/<side>/<selector>   side ∈ {instance, class}
Extension methods are first-class: ownership is attributed by Cuis's method-category prefix-match
  rule (the category:matches: semantics; see the ownerOfSel deviation note in §2); a method carries
  BOTH its owning package AND its (possibly base) target class ref.
Extraction is toolchain-stage, before saveAndQuitAs:, a fixed provider-owned .st script emitting
  TEXT. NOT a live-bridge op; no perform:/generic-eval/oop crosses the boundary.
Determinism is TESTED (build twice -> byte-identical), and holds only after canonical normalization
  (LF, trim trailing whitespace/blank lines, preserve interior) and canonical sorting (selectorsDo:
  is hash-ordered and must be sorted). sourceCodeAt: excludes the change stamp.
Materialization reuses the ADR 0067 atomic creation batch; Cuis-Base refs stay reserved identity
  strings, never materialized. No new authority, no generic introspection protocol.
```
