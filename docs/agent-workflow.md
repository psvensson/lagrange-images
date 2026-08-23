# Provider-independent agent workflow

The repository must remain understandable and resumable when the next agent uses a different model/provider and has none of the previous conversation context.

`AGENTS.md` is the operational bootloader. `docs/domain-agent-rules.md` contains the accumulated Images-specific implementation rules. Beads carries the active work/dependency graph and short durable discoveries. Tests, current docs and ADRs carry project truth.

## Task lifecycle

```text
reconnaissance
    -> plan
    -> falsify assumptions
    -> implement one semantic slice
    -> verify
    -> reconcile discoveries
    -> hand off / close
```

### 1. Reconnaissance

Before proposing a design:

- claim/read the relevant Bead
- inspect current HEAD and any active PR
- read `AGENTS.md`, `docs/domain-agent-rules.md`, `docs/ownership.md`, `docs/seams.md` and relevant current docs/ADRs
- locate the current implementation and its proof tests
- search Beads/ADRs/tests for prior discoveries or rejected approaches
- identify subsystem owners and every interaction owner crossed by the change

Do not infer current behavior from roadmap prose or an old conversation.

### 2. Plan

A nontrivial Bead should record or link:

- problem and desired observable outcome
- current behavior/evidence
- affected subsystem owner(s)
- interaction owner(s)
- invariants/ADRs that constrain the change
- smallest implementation slices
- alternatives already checked
- falsification plan
- exact completion proof

If the design creates shared semantic ownership, the plan is not ready.

### 3. Falsify

Try to disprove the design before relying on it. Useful techniques include:

- construct the collision/concurrency/failure case the design claims to handle
- temporarily remove/revert the proposed guard and prove the intended negative test goes red
- compare neutral and WASM lanes on both success and semantic failure
- exercise restart/recovery when durability is part of the claim
- use a real foreign/runtime/backend integration when a mock cannot establish the promised semantics

A passing happy-path example is not enough evidence for a boundary or invariant.

### 4. Implement

Implement one semantic slice at a time. Keep the current task narrow.

When adjacent work is discovered:

```text
current bead
    |
    `-- discovered-from --> new bead
```

Only absorb it when it actually blocks completion of the current task.

### 5. Verify

Verification follows the affected owners/boundaries, not convenience.

At minimum:

- targeted tests for the claim
- appropriate ordinary suite
- any required recovery proof
- real Lagrange backend integration for backend/public-storage claims
- real OpenSmalltalk/Cuis integration for the relevant foreign-runtime/toolchain claims
- exact PR-head required GitHub checks
- final diff review against plan, ownership and invariants

### 6. Reconcile

Implementation often teaches something the plan did not know. Before closing:

- update the Bead with actual outcome/evidence
- `bd remember` non-obvious hazards, measurements and rejected assumptions
- include a `revisit when` condition for attractive rejected approaches
- create `discovered-from` Beads for deferred work
- update current architecture/seam/ownership docs if reality changed
- add/supersede an ADR for durable architectural decisions
- upgrade an ADR to `implemented` only when named proof tests exist

No important discovery should exist only in chat or a PR review thread.

### 7. Handoff

A provider/session handoff is successful when a new agent can continue from repository state alone.

Before stopping:

- leave HEAD coherent
- leave the active Bead claimed/statused accurately
- record what remains and what currently blocks it
- record exact tests/CI already run
- sync Beads with `bd dolt push` when its remote is available

The next agent should need no narrative reconstruction from the previous provider.

## Memory placement

Use the smallest durable place that matches the knowledge:

| Knowledge | Durable home |
| --- | --- |
| active task, blocker, dependency | Beads issue/dependency graph |
| concise hazard/discovery/measurement/rejected assumption | `bd remember` |
| observable semantic behavior | executable tests + current docs |
| architectural decision and rationale | ADR |
| current subsystem/boundary authority | `docs/ownership.md` |
| exact representation/installer/executor name | `docs/seams.md` |
| low-level implementation guardrail | `docs/domain-agent-rules.md` |
| strategic possible work | roadmap |

Do not create parallel memory or task systems.

## Ping-pong prevention

Before reviving a previously rejected approach, identify the earlier rejection and state which premise changed. If no premise changed, do not spend implementation effort rediscovering the same failure.

If new evidence contradicts a settled decision, record the contradiction and revisit the decision explicitly. Do not silently flip the implementation back and forth between two locally attractive states.
