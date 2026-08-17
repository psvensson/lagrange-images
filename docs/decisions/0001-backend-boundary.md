# 0001: Keep Lagrange behind an image backend boundary

Status: accepted — bootstrap.

## Context

The image/language work needs to start before its durable Lagrange integration is settled. Lagrange itself already has an embeddable public package surface, but its public API is much broader and lower-level than the storage contract this project wants to depend on.

Importing Lagrange internals would make quick progress today and create a permanent coupling problem tomorrow.

## Decision

Image semantics depend on a narrow backend contract owned by this repository.

The default backend selector runs in `auto` mode:

1. try to import `lagrange-server`
2. use a compatible Lagrange backend factory when available
3. otherwise run the in-memory mock and expose the fallback reason

Explicit `lagrange` mode never silently falls back.

## Consequences

Good:

- image and language work can proceed now
- tests are fast and deterministic
- no Lagrange daemon lifecycle leaks into the image model
- the durable schema can evolve independently
- missing public Lagrange seams stay visible

Costs:

- the mock cannot prove durability or transaction semantics
- the current backend contract may be replaced after real schema work
- there is temporary adapter machinery that may become simpler later

## Guardrail

No imports from `lagrange-server/src/...`.
