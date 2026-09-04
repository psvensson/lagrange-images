# ADR 0083: Cuis snapshot bytes are not reproducible; toolchain reuse stays disabled

Status: accepted — a measured negative result; no cacheKey is added, and the revisit conditions below are the only path to one.

## Question

ADR 0026 gave the OpenSmalltalk/Cuis toolchain provider a stable `identity` but no `cacheKey()`,
because closed inputs were established while snapshot byte determinism was not (docs/language-
platform.md). ADR 0020's reuse rule is provider opt-in: reuse is allowed only from a deterministic
cache key, never inferred from semantic similarity. This ADR records the measurement that decides
whether the provider may opt in (bead `lagrange-images-kd1`).

## Measurement

`scripts/measure-cuis-snapshot-reproducibility.mjs` builds one closed input graph — the pinned
OpenSmalltalk VM (release 202606270913), `Cuis7.9-8090.image`/`.changes`, `Cuis7.8.sources` and
`JSON.pck.st` — repeatedly through the real provider and `ToolchainService`, each build in an
independently created workspace root, separated in time, and byte-compares every derived output.
Measured on 2026-09-04 (three raw builds 15s apart; two builds with ASLR disabled via
`setarch -R`; two builds with the ADR 0072 semantic export enabled):

| Output | Result |
| --- | --- |
| `LagrangeDerived.image` (raw) | 19,891,192 B every run, sha256 distinct every run; ~46% of 8-byte words differ, 99.9% of them by ONE constant delta |
| `LagrangeDerived.image` (ASLR disabled) | 404 of 2,486,399 words differ (0.016%): 311 pointer words shifted by 48-272 bytes in 12 clusters, 93 literal words |
| `LagrangeDerived.image` (with semantic export) | lengths differ by exactly 262,144 B between two runs |
| `LagrangeDerived.changes` | 1,622,710 B every run; 14-24 small regions differ, all textual |
| semantic export (ADR 0072) | byte-identical (19,854 B, same sha256) across runs |

Every difference is classified:

1. **Heap-base relocation.** Spur snapshots store absolute object pointers; with address-space
   randomization the whole pointer population differs by the run's heap base. Removed by disabling
   ASLR, which is a host setting outside the provider's contract.
2. **Wall clock.** Class-definition stamps and the save/quit stamp in the changes file
   (`' 4/Sep/2026, 6:35:11 am (UTC)'`, `(4 September 2026 08:35:11)`), and in the image the
   `----STARTUP----` string, `ActiveDelayStartTime`, and a microsecond clock value.
3. **Transient absolute path.** The build workspace path (`/tmp/<root>/lagrange-cuis-toolchain-
   <random>/Cuis7.9-8090.image`) is recorded eleven times in the image and twice in the changes
   trailer. The provider's workspaces are deliberately transient (domain rule), so this is
   nondeterministic by design.
4. **Allocation and heap-segment order downstream of 2 and 3.** With ASLR off, 311 pointers still
   point 48-272 bytes apart across 12 clusters, and a build that does more work (semantic export)
   ends with different heap segment sizes (a 256 KiB length difference): object placement depends
   on clock-driven scheduling and on the strings in 2 and 3.

## Decision

- **Raw snapshot bytes are not reproducible**, so `cacheKey()` stays absent and
  `ToolchainService` reuse stays disabled for this provider. Content-addressing distinct bytes under
  one key would make `derivedFrom` provenance false (ADR 0020, domain rule "never infer cache
  equivalence").
- **No normalization is adopted.** Classes 2 and 3 could be masked textually, but class 4 (pointer
  shifts and segment sizes) cannot be normalized without reinterpreting the Spur object graph —
  which is a re-implementation of the image format, not a normalization — so no
  semantics-preserving normalization is demonstrated. Stripping unexplained bytes is explicitly
  insufficient evidence (bead falsification rule).
- **Semantic-export determinism is separate evidence and stays separate.** ADR 0072's canonical
  export is byte-identical across runs; it identifies the *software structure* of a derived image,
  not its bytes, and must not be used as a proxy cache key for the snapshot.

## Revisit when

Opt-in becomes possible only when a measured build mode yields **zero differing bytes over at
least three independent, time-separated builds**, proven with the script above, and the reused
image still launches and performs the existing package proof. That requires, at minimum: a fixed
heap base under the provider's control (not a host `setarch`), frozen clock inputs inside the
build script (definition stamps, save stamp, `ActiveDelayStartTime`), no recorded workspace path
(or a fixed one the provider owns), and an allocation order proven stable with those held fixed.
Until then the measured cause and this script are the record.

## Not in scope

Any change to the provider, `ToolchainService`, the semantic export, or the runtime-package
proofs; enabling reuse from the semantic export.
