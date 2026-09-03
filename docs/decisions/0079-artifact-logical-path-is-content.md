# ADR 0079: an artifact's materialization path is content, promoted to a canonical field

Status: implemented
Proven by: test/artifact-logical-path.test.js, test/graph-bundle.test.js

## Problem

ADR 0074 defines a portable graph bundle and states that a record's `metadata` is stripped provenance
that does not enter `contentIdentity`. That is correct for bookkeeping. But two artifact kinds had
been storing *semantic build/runtime input* in `metadata`:

- a Cuis image/changes/sources/package named its guest file in `metadata.fileName`
  (ADRs 0026, 0027);
- a Rust source and Cargo vendor file named its workspace path in `metadata.path`
  (ADRs 0018, 0019).

Both are the same concern under two names: the **materialization-relative path** at which the
artifact's bytes are laid down when a consumer materializes it. Because it lived in `metadata`, a
portable release round-trip silently dropped it — a captured Cuis image installed into a fresh
target could no longer start (`runtime image ... must be a non-empty string`), and the same latent
loss applied to every Rust source path. The falsifying proof was the mixed-language Project vertical
test (bead lagrange-images-gxa); the defect is bead lagrange-images-9kg.

## Decision

Keep ADR 0074 exactly as it is: `metadata` is stripped, non-identity provenance. The defect was
never the bundle rule — it was putting semantic content in the provenance namespace.

Promote the materialization path to one canonical CodeArtifact field, `logicalPath`, owned and
validated by the CodeArtifact record owner (`src/execution/model.js`):

- optional, `null` when absent;
- a portable relative POSIX path: no absolute path, backslash, NUL, empty segment, `.` or `..`;
- consumers apply their own stricter rules on top (a Cuis name is a single-segment path with a
  required extension; a Cargo path may nest and must avoid the manifest/lock/config/vendor
  reserved layout).

Because it is a real top-level record field, the graph bundle carries it with **zero bundle
change** — `projectRecord` already preserves every non-forbidden field — and `contentIdentity`
covers it. The image service allows it on write (`RECORD_INPUT_FIELDS`), and the toolchain artifact
snapshot / foreign-runtime definition snapshot include it so a provider sees it and it enters the
toolchain derivation key. `metadata` is untouched: still stripped, still non-identity.

One canonical concern owner, not representation-specific names: `fileName` and `path` genuinely
coincide, so there is one field, not two. The Cuis and Cargo providers read `artifact.logicalPath`
and stop reading `metadata.fileName` / `metadata.path`. Toolchain-produced Cuis images set
`logicalPath` on their outputs; cross-artifact companion names (a changes file's sibling image)
remain relational metadata.

## Supersession

This ADR supersedes, and only, the specific statements in ADRs 0018 §"Workspace materialization" /
0019 §"Why vendor files" and 0026 / 0027 that place the guest filename or source path in `metadata`.
Those ADRs otherwise stand as written; their decisions about closed inputs, host-path transience and
identity are unchanged. The value moved from `metadata` to `logicalPath`; nothing else about them
moves.

## Proof

`test/artifact-logical-path.test.js`:

- the CodeArtifact owner validates `logicalPath` and round-trips it through storage; unsafe paths
  (`..`, absolute, backslash, empty segment, `./`) are refused at put time;
- **A/B identity**: identical bytes at different `logicalPath` produce different `contentIdentity`,
  and identical bytes at the *same* `logicalPath` in a different image/id produce the *same*
  identity (so it is content+path, not artifact identity, that moved the hash);
- **provenance preserved**: two artifacts identical but for `metadata` still collide — ADR 0074's
  rule holds for the provenance subset, checked for a code artifact that also carries a
  `logicalPath`;
- **round-trip**: a Cuis image (`fileName`) and a Rust source (`path`) each survive capture →
  managed install → restart with `logicalPath` intact.

`test/graph-bundle.test.js` continues to prove metadata-only changes do not move `contentIdentity`.

## Not in scope

Other semantic values still carried in `metadata` are a different concern each and have no failing
round-trip proof yet: a Cuis package's `identity`, and a WASM module's `abi` / `effectSites`. They
are the same *class* of latent defect (semantic value in the provenance namespace) and belong to the
same CodeArtifact owner, to be promoted when an artifact carrying them must survive a portable
release. Recorded as bead lagrange-images-mol.
