# ADR 0059: provider-independent agent governance and single ownership

Status: implemented — repository work state is provider-independent, Beads-backed and ownership-gated
Proven by: test/agent-governance.test.js

## Problem

Lagrange Images is large enough that an agent cannot safely reconstruct its architecture from code snippets or one conversation. Work may also move between LLM providers as cost and availability change. Conversation memory is therefore not an acceptable project memory layer.

The repository already accumulated unusually detailed implementation guardrails in `AGENTS.md` and decision history in ADRs, but active tasks/discoveries lacked one durable provider-independent work graph. A second failure mode is architectural diffusion: a subsystem boundary becomes unclear and two sides independently implement policy, retry, validation or state transitions.

## Decision

### 1. Repository state, not agent memory, is authoritative

Agents are transient. Current code/tests, current docs, ADRs, Beads and exact-head CI are durable project state. Every handoff must be recoverable from those sources without the previous conversation.

### 2. Beads owns the operational work graph and short durable memory

The repository pins `@beads/bd` and initializes Beads with `--skip-agents` so the tool cannot replace project-owned agent instructions.

Beads owns:

- active work and status
- blockers/dependency ordering
- `discovered-from` relationships
- concise durable discoveries/hazards/measurements/rejected assumptions via `bd remember`

It does not replace executable tests, current docs or ADRs. Architectural discoveries must be promoted into those stronger forms when they change project truth.

No parallel `MEMORY.md` or Markdown TODO issue system is introduced.

### 3. The existing detailed agent rules are preserved

The pre-existing `AGENTS.md` is retained byte-for-byte as `docs/domain-agent-rules.md`. The new root `AGENTS.md` is a provider-independent bootloader and explicitly makes the domain rules mandatory.

This keeps hard-won Images-specific invariants while making the start/handoff protocol small enough for every provider to follow.

### 4. Every major subsystem has one owner

A single architectural locus is authoritative for each major responsibility's semantics, state transitions/public contract and primary proof surface.

`shared ownership`, duplicated policy and mutually authoritative implementations are invalid designs.

### 5. Every interaction also has one owner

Naming the two endpoint subsystem owners is not enough. Every cross-subsystem interaction has one interaction owner responsible for its protocol/translation, sequencing, error mapping, lifecycle and retry/cancellation/idempotency policy where relevant, plus its integration proof.

In short:

```text
subsystem A owner
       |
       v
interaction owner
       |
       v
subsystem B owner
```

The arrow has one owner.

`docs/ownership.md` is the current authoritative map. New major subsystems/boundaries name an owner there before implementation.

### 6. Nontrivial work is planning- and falsification-gated

Before implementation, a Bead must identify current evidence, affected owners/interactions, constraints, semantic slices, alternatives, falsification and completion proofs.

Verification is matched to the claim: mock tests cannot establish real backend durability, and a neutral-lane proof cannot establish WASM conformance. Exact PR-head required GitHub checks remain merge authority.

### 7. Every task ends with reconciliation

Before handoff/closure, agents reconcile the implementation with the plan, record new knowledge, update current docs/ownership/ADRs as needed, create deferred Beads and record exact proof evidence.

A non-obvious discovery may not exist only in conversation history.

## Consequences

Changing model/provider becomes an execution choice rather than a project-memory migration.

Tempting but rejected approaches become discoverable rather than repeatedly rediscovered. `revisit when` conditions keep negative knowledge from becoming permanent dogma when its premises later change.

Ownership disputes surface during planning rather than after duplicated policy has landed.

The discipline costs some up-front bookkeeping, but Beads is deliberately used instead of inventing a custom task database and the existing ADR/test conventions remain unchanged.
