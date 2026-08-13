# ADR 0004: invocation and message dispatch

Status: accepted for the bootstrap execution substrate.

## Decision

Invocation and message dispatch are transient runtime protocols, not durable image record kinds.

A direct Block call takes an unpinned Block ref plus tagged argument Values. The runtime validates the Block, its CodeArtifact and optional LexicalEnvironment, then produces an immutable `activation-request`. Preparing that request does not execute code or append image history.

A message send is:

```text
languageId
receiver   : Value
message    : Value
arguments  : Value[]
```

`message` is deliberately a Value rather than a selector string. A Smalltalk personality may use text or a Symbol-like object; another language may use a different representation. The receiver is also a Value so a personality can define semantics for immediate values as well as object refs.

`DispatchRegistry` maps a language personality ID to a dispatcher implementing `resolveMessage(request, context)`. The dispatcher owns language lookup semantics only. It returns exactly one unpinned Block ref; it does not execute the Block. The resolved Block then follows the same activation path as a direct call.

An activation request contains the Block, CodeArtifact and optional environment refs, receiver or null, canonical argument Values, and optional dispatch provenance (`languageId` plus message Value).

The dispatch language and the CodeArtifact language are intentionally distinct. A language dispatcher may resolve to code represented as another language or neutral IR later.

Object refs still carry identity only. This contract adds no capabilities, credentials or remote-send authority.

## Consequences

Direct calls, Smalltalk-like sends and future personalities converge on one execution handoff without putting selector lookup or calling conventions into the durable graph model. Dispatchers can inspect image state through the supplied image service while remaining outside persistence semantics.

## Deferred

- execution of activation requests
- parameter and calling conventions
- Smalltalk method/selector lookup
- Lisp function-binding lookup
- durable activation/debug records
- return values and exception/condition propagation
- capability contexts and authorization
- local versus remote execution policy
