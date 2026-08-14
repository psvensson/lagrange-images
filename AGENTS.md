# Agent notes

Keep this repository small and semantic.

## Repository workflow

Use one repository path for every change:

```text
main -> agent/<task> -> pull request -> GitHub Actions -> squash merge -> main
```

- Never make feature changes directly on `main`.
- Start each task from current `main` on a fresh `agent/<task>` branch.
- Keep one semantic task per branch and pull request.
- Read this file and the relevant design documents before editing.
- Connected agents use GitHub `create_file` and `update_file` for ordinary text changes on the feature branch.
- GitHub Actions on the exact branch/PR head is the merge authority. Local checks are supplementary.
- Before merge, compare the branch with `main`, verify the PR is mergeable, and verify the current head has a successful `test` workflow.
- Squash-merge using the expected PR head SHA so `main` receives one semantic commit.
- After merge, read back the important changed files from `main`.
- If the normal connector write cannot perform a required change, report the blocker instead of silently changing remote-write mechanisms.

`.github/workflows/test.yml` is the canonical repository validation path.

## Code

- JavaScript ES modules only; no TypeScript/build step without a concrete need.
- Prefer Node core modules before dependencies.
- Keep image semantics language-neutral.
- Keep language personalities independent of Lagrange storage details.
- Never import `lagrange-server/src/...`; use the public package only.
- A mock behavior is not a production guarantee. Mark weaker semantics in docs/tests.
- Add a test before broadening the backend contract.

## Graph representation

Protect these invariants:

```text
shape != behavior
reference != authority
identity != revision
durable representation != execution representation
semantic code != executable artifact
WASM handle != image identity
```

- Object slots contain only tagged Values; do not reintroduce arbitrary nested JSON state.
- Graph edges are refs in slots, shape or behavior. Metadata must not hide refs.
- Keep `(imageId, objectId)` as stable identity independent of backend row/version/location.
- Use `pinned-ref` when a historical state is meant.
- Shape records are immutable; structural change gets a new shape identity.
- Preserve stable slot IDs across renames when semantics are continuous.
- Do not add `classId`, `source` or another language-specific shortcut to generic objects.
- A ref grants no access rights. Capability/authorization state stays separate.

## Code derivation

- Preserve language source -> syntax -> `lagrange-code/v0` semantic code -> derived execution artifacts.
- Executable artifacts are rebuildable state, never the sole surviving meaning of a program.
- Add lowering backends through `CodeCompilerRegistry`; do not teach language compilers about executor internals.
- WASM belongs in `wasm-module/v1` / `wasm-function/v1` CodeArtifacts, not in Block/image identity fields.
- Keep `lagrange-value-handle/v0` handles invocation-local. Never persist them, use them as object IDs, or treat them as capabilities.
- The generic WASM ABI must preserve canonical Value semantics; optimized/unboxed ABIs need explicit new contracts rather than silently narrowing Values.
- Graph refs may cross the WASM boundary through receiver/argument/capture handles. Do not hide ref literals inside artifact metadata.
- Unsupported WASM semantic operations must fail explicitly; do not silently fall back to another executor when WASM was requested.
- Keep interpreter/WASM differential tests for every semantic operation added to the WASM backend.

## Symmetric Smalltalk seed

- Keep parser/compiler/dispatch semantics in the language personality; do not teach the image backend what a selector, class or method is.
- Compile ordinary source sends through the shared language-tagged send path. Do not add compiler-only primitive semantics just to make examples easier.
- The current behavior-object selector-slot lookup is a bootstrap convention, not the final Class/Metaclass model.
- Nested Blocks use automatic lexical capture analysis; captured state is identified by stable binding ID rather than source name.
- `self` crossing a Block boundary is a lexical capture, not the Block object used as the `value*` message receiver.

## Architecture

```text
tools -> languages/runtime -> image graph -> backend -> Lagrange
```

Do not reverse the dependency direction. Projects, source, notes and work items should tend toward objects in the image model; files/Git are interoperability views. Distributed execution is later runtime policy, not an excuse to make every object send an RPC.

## Documentation

When a design is exploratory, say so. Keep current, next and possible-later distinct. Avoid describing planned capabilities as implemented.
