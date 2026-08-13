# Agent notes

Keep this repository small and semantic.

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
shape     != behavior
reference != authority
identity  != revision
durable representation != execution representation
```

- Object slots contain only tagged Values; do not reintroduce arbitrary nested JSON state.
- Graph edges are refs in slots, shape or behavior. Metadata must not hide refs.
- Keep `(imageId, objectId)` as stable identity independent of backend row/version/location.
- Use `pinned-ref` when a historical state is meant.
- Shape records are immutable; structural change gets a new shape identity.
- Preserve stable slot IDs across renames when semantics are continuous.
- Do not add `classId`, `source` or another language-specific shortcut to generic objects.
- A ref grants no access rights. Capability/authorization state stays separate.

## Architecture

```text
tools -> languages/runtime -> image graph -> backend -> Lagrange
```

Do not reverse the dependency direction. Projects, source, notes and work items should tend toward objects in the image model; files/Git are interoperability views. Distributed execution is later runtime policy, not an excuse to make every object send an RPC.

## Documentation

When a design is exploratory, say so. Keep current, next and possible-later distinct. Avoid describing planned capabilities as implemented.
