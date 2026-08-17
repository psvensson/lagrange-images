# ADR 0002: language-neutral graph representation

Status: accepted — the bootstrap substrate.

## Context

The first scaffold stored arbitrary JSON slots plus `classId` and `source`. That proved persistence and history, but would leak Smalltalk assumptions into storage and leave cycles, exact values, Lisp support and distribution ambiguous.

## Decision

Object slots contain only tagged Values:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

Integers use canonical decimal strings. Float64 uses exact hexadecimal bit payloads. Bytes use canonical base64 in the portable form. Arbitrary nested JSON is not object state.

An ordinary ref is `(imageId, objectId)` and means stable evolving identity. A pinned ref adds an opaque revision/frontier for history and debugging. References contain no capabilities or credentials.

Shapes are immutable durable substrate records in the same identity namespace as objects. Shape slots have stable IDs plus display names. Structural change creates a new shape identity; stable slot IDs may survive renames.

A generic object has stable identity, a required shape ref, an optional behavior ref, `slot-id -> Value` state, and non-semantic metadata. Shape describes physical state; behavior is interpreted only by a language/runtime personality. Generic object records do not contain `classId` or `source`.

Metadata may not contain object refs. Graph relationships must remain explicit so reachability cannot be hidden.

The durable representation does not dictate runtime layout. Compilers may unbox, tag, intern or otherwise specialize values and objects while preserving image semantics.

## Consequences

This gives Smalltalk, Lisp and future personalities a shared substrate without forcing them to share language semantics. Cycles and graph traversal become explicit, numeric persistence is exact, slot identity can survive refactoring, and Lagrange can normalize/index records without changing their meaning.

The cost is intentional explicitness: language personalities must map convenient literals and collections onto the substrate, and shape migration becomes real work rather than host-object serialization.

## Deferred

- immutable structural tuple/record Values, if profiling justifies them
- code artifacts, blocks and lexical environments
- capability-handle format
- Lagrange revision-frontier encoding
- optimized runtime tagging/handle schemes
