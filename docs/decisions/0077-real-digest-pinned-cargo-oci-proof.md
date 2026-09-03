# ADR 0077: the Cargo/rustc OCI boundary is proven by a real compiler in CI

Status: implemented
Proven by: test/cargo-rustc-oci-real.test.js, test/cargo-rustc-oci-provider.test.js

ADR 0018 built the Cargo/rustc OCI provider and ADR 0019 extended it to explicit vendored
dependencies, but both closed with the same admission:

> CI still injects the OCI runner, so the repository test does not claim that GitHub Actions
> launched Docker or actually compiled the fixture with rustc.

Everything the repository knew about that boundary therefore came from a fake runner that wrote a
valid WASM header at the path Cargo would have used. That proves the provider builds the right
workspace and the right argv. It cannot show that a real compiler accepts the workspace, that a
real Cargo accepts the vendored source replacement, that the closed-input contract survives contact
with the network being genuinely off, or that the bytes that come back run.

This ADR decides how that boundary is proven, and adds nothing to the provider's semantics.

## Decision 1: the proof is a real build, not a stronger assertion about a fake one

`test/cargo-rustc-oci-real.test.js` runs the production `OciCliRunner` against a digest-pinned
image, compiles the closed graph, and then executes the result through the ordinary
`wasm-scalar-call/v0` callable lane already decided by ADR 0021:

```text
explicit artifact graph
  -> ToolchainService
  -> Cargo/rustc in a digest-pinned OCI image, network none
  -> wasm-binary/v1
  -> wasm-callable-interface/v1 + Block
  -> ActivationExecutor -> integer Value
```

No new provider, importer, representation or execution path exists for the proof. The fixture is
test support (`test/support/cargo-oci-proof-fixture.js`); everything the compiler sees enters as
CodeArtifacts through the existing generic seam.

The lane skips unless `LAGRANGE_CARGO_OCI_INTEGRATION=1`, like every other real proof in this
repository, and CI runs it as the required `cargo-rustc-oci-integration` job. A green `npm test`
still does not mean it ran.

## Decision 2: the executed program is an explicit `--entrypoint`

`buildOciRunArgs` now always emits `--entrypoint <program>` and passes the remaining command
elements as container arguments.

An image's declared `ENTRYPOINT` is undeclared build input. It can wrap, rewrite, prefix or ignore
the command the provider asked for, which would make the recorded `cargo build --frozen ...` a
description of an invocation that never happened. Stating the program explicitly keeps it part of
the closed contract, and has the practical consequence that any digest-pinned image which merely
*contains* Cargo/rustc can serve as the toolchain, whatever it was originally packaged to run.

This is the one behavior change in this ADR. It is falsifiable in the obvious way: reverting it
turns the real proof red, because the pinned image does declare an entrypoint of its own.

## Decision 3: the pinned image, and why this one

```text
cosmwasm/optimizer@sha256:7e0b9229c1a4118d0c9a2af2e7f5d95a91f264c26a2ce5681c779926e74d7f85
    (tag 0.17.0, Alpine, Rust 1.86.0, target wasm32-unknown-unknown, amd64)
```

The pin lives in `scripts/cargo-oci-setup.sh` and nowhere else; `scripts/cargo-oci-env.sh` reads
back the reference that script actually pulled, so no environment can name a digest that was never
fetched.

The constraint that decided this is narrow. The proof needs a Rust toolchain that *already*
contains the `wasm32-unknown-unknown` standard library, because installing a target requires the
network the proof exists to prove it does not use. The official `rust` images ship the host target
only. CosmWasm's optimizer image is built from `rust-lang/docker-rust` and adds exactly
`rustup target add wasm32-unknown-unknown`; the proof uses it as a compiler environment and
overrides its entrypoint, so none of its contract-optimization machinery participates.

Rejected alternatives:

- **`rust:<version>` plus `rustup target add` at build time** — a network fetch inside the build,
  which is the thing under test.
- **Building the toolchain image in CI** — a locally built image has no repository digest, so it
  could only be named by tag or image id. That would mean weakening
  `normalizePinnedOciImage`, trading the proof's central invariant for its convenience. Running a
  throwaway registry to manufacture a digest was rejected as machinery that proves less than the
  pin it simulates.
- **A host-installed Cargo** — already rejected by ADR 0018; it proves no OCI boundary at all.

Revisit the image choice when a maintained image with a Rust toolchain and preinstalled WASM
targets exists under an identity this project would rather depend on, or when the proof needs a
target this one does not carry.

## Decision 4: what the proof asserts, and what would falsify it

The positive proof asserts, on the real invocation's argv and on the persisted artifact:

- exactly one container invocation, running the digest-pinned reference verbatim
- `--network none`, `--entrypoint cargo`, and the workspace as the only mount
- `CARGO_HOME` inside the container, so no ambient host Cargo cache or source is reachable
- the exact `cargo build --frozen --target ... --release` argv
- a real release module (not a bare header) stored as `wasm-binary/v1`
- `derivedFrom` covering every one of the eight graph inputs
- provider identity and output metadata carrying the image digest
- the module executing through `installWasmScalarCallable` to the expected integer Value

Four falsifiers run beside it, each failing for a stated reason rather than merely failing:

| Falsifier | Fails where |
| --- | --- |
| a vendored file changed without updating `.cargo-checksum.json` | this repository's validation, before any container starts |
| a `Cargo.lock` checksum that disagrees with the vendored package | real Cargo's source-replacement integrity check |
| the vendored package removed while the dependency stays declared | real Cargo: `failed to get tiny-math` / `--frozen was specified` |
| the image named by tag instead of digest | `normalizePinnedOciImage` |

The second one matters most for honesty: it is internally consistent, so this repository's own
validation passes it and only the compiler can catch it. The third is what makes "closed inputs" a
claim rather than a slogan — with a network or a warm host cache it would quietly succeed.

The vendored dependency is also read back *through execution*: the vendored crate carries a
constant that the compiled module's exported function returns, so a fixture whose vendored code
never reached the compiler would produce a valid module, export the right symbol, and still fail.

## Decision 5: `wasm-binary/v1` still means bytes

The proof executes its output through an explicit `wasm-callable-interface/v1`, exactly as ADR 0021
requires. Nothing here relabels Cargo output as `wasm-module/v1`, and the `wasm-scalar-call/v0`
no-import rule is load-bearing rather than incidental: it is why the vendored crate is `#![no_std]`,
and it means the execution half of the proof also demonstrates that the closed build produced a
module with no host imports.

## Consequence

The Cargo/rustc claims in ADRs 0018 and 0019 are no longer supported only by a fake runner. Their
"CI does not require Docker" and "does not claim GitHub Actions actually compiled the fixture"
statements describe the state at the time they were written; this ADR supersedes those two
statements specifically, and no other part of either decision.

Still not proven here, and still open: crates.io `.crate` archive import, git dependency vendoring,
alternate registries, WASM Component generation from Cargo output, and any ABI wider than
`wasm-scalar-call/v0`.
