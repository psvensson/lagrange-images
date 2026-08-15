# 0032 — Atomic backend transactions for state and history

## Status

Accepted.

## Context

Image mutations materialize current state and append a history event. The original backend boundary exposed `put` and `append` independently, so a failure between them could leave state without history or history without the corresponding state.

A static operation batch is insufficient because history events include the version assigned by the state write. Precomputing that version outside the commit would weaken optimistic concurrency.

## Decision

Every backend implements:

```js
backend.transaction(async (transaction) => {
  const stored = await transaction.put(
    collection,
    key,
    value,
    {expectedVersion},
  );
  await transaction.append(stream, eventFor(stored));
  return stored;
});
```

The transaction-scoped object exposes only the existing data primitives:

```text
get / put / scan / append / readStream
```

All callback operations commit together or none commit. Reads through the transaction observe its staged writes. A failed optimistic version check aborts earlier operations in the same transaction. The scoped object is valid only until the callback settles.

Image creation, shape/object/artifact/environment/Block writes and root changes use this path for their state-plus-history pair. Snapshots currently perform one state write and therefore do not require a transaction merely for uniformity.

The mock backend implements the same observable contract using isolated draft maps and one write gate shared by direct writes and transactions. This proves API semantics and rollback, not process-crash durability.

A parameterized backend conformance suite verifies ordinary versioned operations, atomic commit, callback-failure rollback and conflict rollback. The mock runs it now; a Lagrange adapter must run the same suite before being accepted.

## Consequences

- A successful image mutation cannot expose current state without its corresponding history event.
- History can safely include the actual stored record version.
- The Lagrange adapter has a precise transaction requirement without importing Lagrange internals.
- Toolchain multi-output persistence is unchanged; it remains a separate contract if a real toolchain requires whole-result transactional installation.
- Restart, crash and multi-node durability still require a real Lagrange backend proof.
