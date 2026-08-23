# Agent instructions

Keep this repository small and semantic. This repository is designed to survive model, provider and session changes: agents are transient execution machinery; durable project truth lives in current code/tests, current documentation, ADRs and Beads.

The previous detailed `AGENTS.md` has been preserved byte-for-byte as [docs/domain-agent-rules.md](docs/domain-agent-rules.md). **Those rules remain mandatory.** This file adds the provider-independent workflow and ownership discipline; it does not supersede the domain rules.

## Read this first

At the start of every task:

1. Read this file.
2. Read [docs/domain-agent-rules.md](docs/domain-agent-rules.md).
3. Run `npm install` if dependencies are not present.
4. If Beads is not initialized, run `npm run beads:init`.
5. Run `npm run beads:prime` and `npm run beads:ready`.
6. Read `docs/runbook.md`, `docs/seams.md`, `docs/ownership.md`, relevant current architecture docs, relevant ADRs/tests and the Bead for the task.
7. Inspect current HEAD, PR and CI state before trusting an older plan.
8. Reconcile the written plan against the code that actually exists before editing.

Do not ask the human to repeat information that is recoverable from repository state.

## Source-of-truth order

When sources disagree, prefer them in this order:

1. executable behavior and tests on current HEAD
2. current architecture, seam and ownership documentation
3. accepted/implemented ADRs, interpreted together with later ADRs
4. the current Bead and its evidence/comments
5. roadmap/backlog material
6. conversation/session memory

A plan, PR description or chat statement is never evidence that something is implemented.

## Beads is the work graph and operational memory

This project uses `bd` (Beads) for task tracking, dependencies and short durable project memory.

- Run `bd prime` for current workflow guidance.
- Use `bd ready --json`, `bd show <id> --json`, `bd update <id> --claim --json` and `bd close <id> --reason "..." --json`.
- Create discovered work as a new Bead and link it with `discovered-from` rather than silently expanding the current task.
- Use `bd remember "..."` for concise discoveries, hazards, measurements and rejected assumptions future agents should find.
- A rejected/tempting approach should record **why** it was rejected and **revisit when** the premise would have changed enough to reconsider it.
- Use Beads dependencies for blockers/ordering instead of prose-only dependency lists.
- Do not create `MEMORY.md` or another parallel memory system.
- Do not use Markdown TODO/checklists as the authoritative task tracker. Roadmaps are strategic documents, not issue queues.
- At the end of a session, sync Beads with `bd dolt push` when the configured remote is available.

If a discovery changes an architectural invariant, public contract or behavior, `bd remember` is not sufficient by itself: promote the result into tests and the appropriate current doc/ADR during reconciliation.

Use the repository-pinned Beads CLI (`npx bd ...` or npm scripts), not an assumed global version.

## Single-owner principle

**Every subsystem or major responsibility has exactly one architectural owner. Every interaction between subsystems also has exactly one architectural owner.**

An owner is a module, service, adapter, registry, repository/layer or other single code locus — not necessarily a human. Ownership means that locus is authoritative for the concern's invariants, state transitions/public contract and primary proof tests.

Rules:

- `shared ownership`, `both sides own it`, duplicated policy and mutually authoritative implementations are invalid designs.
- Other components may request, observe, cache or adapt an owner's state, but they must not independently decide the same semantic rule.
- A subsystem owner may delegate pure helpers; it may not split semantic authority.
- A cross-subsystem interaction owner owns the protocol/translation, sequencing, error mapping, cancellation/retry/idempotency policy where relevant, and integration proof for that boundary.
- The interaction owner is distinct from merely naming the two endpoint owners. **The arrow has one owner.**
- Before adding a new major subsystem or interaction, add/update exactly one entry in `docs/ownership.md`.
- If ownership is ambiguous, stop implementation and resolve ownership first. Ambiguity is an architecture bug.
- If a feature seems to require two components to make the same decision, redesign the boundary rather than synchronize competing owners.

Every nontrivial Bead/plan must name the affected subsystem owner(s) and, for every crossed boundary, the interaction owner from `docs/ownership.md`.

## Planning and falsification gate

Do not implement a nontrivial change until the current Bead contains or links enough evidence to answer:

- **Problem** — what observable problem exists?
- **Current behavior** — what code/tests/docs establish it?
- **Owner** — which subsystem owner is authoritative?
- **Interaction owner** — which boundary owner applies, or `none`?
- **Relevant invariants/ADRs** — what must remain true?
- **Plan** — smallest semantic slices in dependency order.
- **Falsification** — what result would show the plan/assumption is wrong?
- **Alternatives checked** — especially prior rejected or tempting approaches.
- **Completion proof** — exact targeted tests, integration proofs and CI gates needed.

For architectural work, prefer a falsifiable proof over an assertion. If changing a guard/filter is supposed to protect one case, temporarily removing/reverting it should make the specific proof go red when practical.

## Implementation discipline

- One semantic task per branch/PR.
- Implement the smallest planned slice; do not absorb adjacent discoveries unless they block the task.
- Record adjacent work in Beads with `discovered-from`.
- Add or strengthen the proof before broadening a contract.
- Do not create a second implementation path to avoid an awkward existing seam; either use the owner or explicitly change ownership first.
- Read the resulting diff after every high-risk structural edit. The guard-dense installer warning in the domain rules remains in force.

## Verification gate

Before calling a task complete:

1. run the targeted proof(s)
2. run the ordinary suite appropriate to the touched subsystem
3. run every required real integration lane for the touched boundary
4. verify the PR is mergeable
5. verify **all required checks on the exact PR head** are green
6. inspect the final diff against the plan, invariants and ownership map

For this repository, a generic green `npm test` is not sufficient where the real Lagrange or OpenSmalltalk/Cuis lanes are relevant. `.github/workflows/test.yml` is the merge authority.

## Reconciliation and handoff gate

Before ending a session or closing a Bead:

- reconcile implementation against the original plan
- update current docs/ADRs when the resulting truth changed
- update `docs/ownership.md` if an owner/boundary changed
- record non-obvious discoveries/rejected paths in Beads
- link deferred work with `discovered-from`/dependencies
- record the exact proof/CI evidence
- leave HEAD coherent and the Bead state sufficient for another provider/model to continue without chat history

Do not leave essential reasoning, discovered hazards or an unfinished plan only in conversation history.

## Domain-specific rules

Everything in [docs/domain-agent-rules.md](docs/domain-agent-rules.md) remains mandatory, including repository workflow, backend transaction rules, graph/Value invariants, artifact/toolchain contracts, WASM and foreign-runtime rules, Symmetric Smalltalk semantics, authority rules, recovery proofs and ADR status discipline.
