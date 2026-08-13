# Agent notes

Keep this repository small and semantic.

## Code

- JavaScript ES modules only; no TypeScript and no build step unless there is a concrete need.
- Prefer Node core modules before dependencies.
- Keep `ImageService` language-neutral.
- Keep language personalities independent of Lagrange storage details.
- Never import `lagrange-server/src/...`; use the public package only.
- A mock behavior is not a production guarantee. Mark weaker mock semantics in docs/tests.
- Add a test before broadening the backend contract.

## Architecture

The dependency direction is:

```text
tools -> languages/runtime -> image model -> backend -> Lagrange
```

Do not reverse it.

Projects, source, notes and work items should tend toward objects in the image model. Files/Git are interoperability views, not assumptions baked into the runtime.

Distributed execution is a later optimization/semantic layer. Do not turn every object send into an RPC abstraction.

## Documentation

When a design is still exploratory, say so. Keep "current", "next" and "possible later" distinct. Avoid describing planned capabilities as implemented.
