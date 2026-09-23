# ADR 0093: Native Smalltalk protocol tiers and their growth rules

Status: accepted — decision-only; names the tiers the standard image already has, fixes the rule each may grow by, and moves the personality's full owner contracts out of the ownership registry; no runtime behavior changes

## Context

The Symmetric Smalltalk personality is the largest owner in the repository and the one every
imported application grows: `src/language/` is 59 files and roughly 38% of the source, the
standard image is a 45-step fixed install sequence, there are 22 kernel primitives, and the M3 to
M5 forcing applications added owners whose registry rows describe them as "the measured surface"
the imported code reached (Point, Array2D, Interval, TextModel), plus a four-entry Cuis
correspondence table. Each addition was justified by a consumer and proven at its owner; that
discipline is not in question.

What is missing is the *shape* of the growth. The personality has three kinds of protocol with
three different rules for when a line may be added, and those rules live scattered across
`docs/domain-agent-rules.md`, `docs/seams.md`, ownership-row prose and ADR consequences. Two
effects follow:

- a visiting agent under application pressure cannot tell, from one place, whether the right
  repair is a primitive, a library method or an adapter entry, and the wrong choice hides a gap
  (a primitive per collection) or invents compatibility (a name-keyed correspondence);
- the ownership registry, whose job is a one-paragraph-per-owner map, carried four rows of 2,700
  to 10,400 characters for the personality's owners, so the map was the hardest place to read the
  map.

## Decision

### 1. Three tiers, each with one growth rule

| Tier | What it is | Grows only when |
| --- | --- | --- |
| **1. Kernel primitives** | the `smalltalk-kernel-primitive/v1` operations pinned by `SMALLTALK_PRIMITIVE_NAMES`: identity, allocation, slot and indexed access, Integer arithmetic and ordering, hashing and equality, interning, Character scalars, control transfer, super sends | the semantic is host-sensitive and cannot be written as ordinary Smalltalk over existing primitives, AND a real consumer reaches it. A primitive lands with the sorted name guard, a publication-recovery sweep and both-lane conformance, and never encodes a Cuis class or selector policy. |
| **2. Native library** | ordinary classes and methods written in Smalltalk over tier 1 and published through the ordinary namespace: Association, OrderedCollection, Dictionary protocol, Set, the streams, Character classification, Interval, Point, Array2D, TextModel | a real consumer NAMED the class or selector, with exactly the protocol that consumer exercised. When the consumer is imported Cuis code the semantics are anchored to a recorded real-Cuis oracle, never to Squeak/Pharo recollection. Library composes library (`collect:` over `do:`); a collection-shaped primitive, and a class that exists to be a foreign-dialect alias, are both refused. |
| **3. Cuis correspondence and translation** | the import adapter's closed identity -> native-class table and its token-level idiom plan | a frozen real-Cuis measurement exists for the exact POSITION (superclass or instance-side method target) or the exact idiom. Entries are keyed by complete semantic identity, never by name, each names the milestone or Bead that forced it, and none is added or removed for convenience. |

The tiers are a reading of what exists, not a reorganization: nothing moves between files, and
every existing installer, primitive and adapter entry already sits in exactly one tier.

### 2. "Measured surface" means tier 2 with a named consumer

A class that reaches the image through a tier 3 correspondence is a tier 2 class. The
correspondence says only which native class a Cuis identity denotes; the native class owns its
protocol and grows by tier 2's rule. "Measured surface" in a registry row therefore means: exactly
the protocol a pinned consumer exercised exists today, and each later addition names its consumer.
It does not license adding the rest of Cuis's protocol for that class.

### 3. The registry names owners; `docs/native-smalltalk.md` holds their contracts

`docs/ownership.md` keeps one paragraph per owner: the concern, the locus, the load-bearing rule
and the proof. The full contracts of the personality's four large owners — the class builder and
personality, the authorized browsing seam, the authorized replacement seam and the Cuis
native-import adapter — move verbatim to `docs/native-smalltalk.md`, which also carries the tier
table. Moving is not editing: the sentences are the same sentences, and the tests that pin them are
unchanged. The registry row is authoritative for WHO owns a concern; the contract page is
authoritative for WHAT that owner promises. `docs/domain-agent-rules.md` stays as it is.

### 4. Classification comes before repair

Under application pressure the first question is which tier the missing semantic belongs to, and
the answer decides the owner and the proof before any code is written: tier 1 needs the primitive
guard and a sweep, tier 2 needs the consumer's exact protocol and an oracle, tier 3 needs a frozen
measurement for a position or an idiom. A repair that cannot say its tier is not ready.

## Consequences

- The M3 to M5 rules already in force (`docs/native-import.md`, the roadmap's "add only from real
  imported pressure" items) gain one vocabulary; no existing rule is weakened or widened.
- The four registry rows shrink from 2,700 to 10,400 characters to one paragraph each; the
  contract page is 27 KB and grows only when a contract changes.
- ADR 0085's guardrails (`importer != second class/object/compiler owner`) are restated as tier 3's
  rule; nothing about the adapter's authority changes.

## Rejected

- **A fourth tier for "compatibility classes".** A class that exists to look like a Cuis class
  rather than to serve a consumer is exactly what tier 2 refuses; naming a tier for it would
  license it.
- **Moving the contracts into module header comments.** They would leave the documentation the
  tests and agents read, and the registry would still have to summarize them.
- **Reorganizing `src/language/` by tier.** The tiers are semantic, the files are owners; a file
  move would change every `Proven by:` and seam reference for no semantic gain.

## Revisit when

- A second imported language (ADR 0084's parked Common Lisp work) needs the same three questions;
  then the tiers become language-neutral vocabulary and this ADR is superseded by one that says so.
- A tier 2 class needs protocol no consumer named (a platform-level library decision); then tier
  2's rule gets an explicit exception with its own ADR rather than a quiet one.
