# ADR 0086: Native method revisions advance the existing MethodDictionary binding

Status: implemented
Proven by: test/smalltalk-method-reconciliation.test.js, test/smalltalk-builder-recovery.test.js, test/cuis-native-import.test.js, test/opensmalltalk-cuis-semantic-export-real.test.js

## Context

ADR 0044 deliberately made `defineMethods()` add-only. Its original immutable method identities
were derived from native Class/Metaclass plus selector, so writing different semantic/code/Block
material at the same ids could only conflict or overwrite history. ADR 0049 retained that rule and
deferred replacement until native method identity was versioned.

ADR 0085 M2 then proved this path:

```text
real Cuis method source
    -> canonical semantic export
    -> translation-only Cuis adapter
    -> native semantic compiler
    -> immutable semantic/code/Block material
    -> native MethodDictionary
```

Exact replay converged, but changing only a method body reached the intentional
`SmalltalkMethodRedefinitionError`. That RED located the gap at the native class-builder and
method-dictionary owner. It did not justify importer source comparison, a Project import token, or
a second history authority.

## Decision

### 1. Keep logical position separate from immutable revision identity

The logical method position remains:

```text
native Class or Metaclass identity + selector
```

The MethodDictionary binding at that position says which immutable Block is current.

The first definition retains the existing class-plus-selector Block/artifact identity. A changed
definition receives an immutable revision identity beneath that position. The class builder derives
the revision identity from its existing normalized semantic input:

- compiled native `lagrange-code` program content and representation;
- execution lane;
- normalized capture ids, names and Values.

The material is canonical-JSON encoded directly with base64url. It is not a source-text identity and
not a truncated/probabilistic digest. Equal native semantic inputs therefore select the same
create-once records; different inputs cannot alias through a hash collision.

Semantic CodeArtifacts, derived executable artifacts, lexical environments, nested Blocks and the
method Block remain immutable. Revision B never mutates A in place.

### 2. Add an explicit native reconciliation operation; keep definition add-only

`defineMethods()` retains its define-once contract and rejects different semantics already bound to
a selector.

`reconcileMethods()` is the explicit class-builder operation for desired current native method
semantics:

| Existing selector state | Result |
| --- | --- |
| absent | install the first immutable definition and bind it |
| exactly the requested native semantic identity | return success without a write |
| different | publish the requested immutable revision, then conditionally advance the binding |

`reconcileMethodsFromSource()` performs the existing class-scoped compilation and delegates this
decision to `reconcileMethods()`. It adds no identity or history policy.

### 3. One MethodDictionary CAS is the publication point

For A -> B the order is:

```text
persist immutable B semantic/executable material
    -> put the existing MethodDictionary with expectedVersion = version read for A
    -> B becomes current
```

The Behavior, Class, Project and unrelated selector bindings do not move. The old immutable A
material remains addressable, while ordinary image history records the MethodDictionary versions
that made A and B current.

If publication is interrupted before the CAS, A remains current and retry reuses any already-created
B material. If acknowledgement is lost after the CAS, retry observes B and is write-free.
Unreferenced immutable material from a losing contender is an accepted create-before-publication
property; this decision adds no rollback subsystem.

### 4. The class builder interprets a lost backend CAS

The backend remains authoritative for conditional persistence. On `VersionConflictError`, the
class builder rereads the Behavior's authoritative current MethodDictionary once:

- every requested selector resolves to the requested native semantic identity -> adopt the winner;
- a selector resolves differently -> `SmalltalkMethodRedefinitionError`;
- a requested selector is absent -> the existing Smalltalk method-dictionary conflict.

There is no unconditional overwrite and no internal retry loop. The backend error and its cause do
not cross the native Smalltalk boundary. A fresh explicit caller operation may later reconcile from
the newly observed state; the stale operation itself never overwrites its winner.

### 5. The Cuis importer remains translation-only

`importCuisNativePackage()` routes its translated current method inputs through
`reconcileMethodsFromSource()`. It stores no previous source, compares no source strings, chooses no
revision id, and owns no current-method or concurrency decision. Canonical Cuis method identity
continues to locate package/class/side/selector input; native Class/Metaclass plus selector remains
the executable logical position.

Project membership, Project `versionToken`, releases and managed installation are organization and
distribution concerns. None serializes native method evolution.

## Consequences

- `A import -> A replay -> B change -> B replay` advances exactly one authoritative
  MethodDictionary version for each new current definition and none for exact replay.
- Class identity, selector identity, Shapes and unrelated bindings remain stable.
- Immutable method revisions make the semantic and derived-code transition inspectable without a
  generic reconciliation framework.
- Revision ids can be long because they encode semantic identity injectively. A future compact
  identity scheme would need a collision-free durable identity contract, not a silent digest swap.
- This does not add Shape migration, compatibility-library breadth, Project-wide generations,
  generic graph merge, or changed class-layout reconciliation.

## Relationship to earlier ADRs

- **ADR 0044** remains authoritative for native class/method construction; only its deferred method
  evolution now has an explicit operation. `defineMethods()` remains add-only.
- **ADR 0049** remains authoritative for MethodDictionary representation and CAS publication. This
  ADR supplies the versioned immutable method identity it deferred.
- **ADR 0085** remains authoritative for progressive native import. This proof sits between M2 and
  M3 and deliberately adds no Cuis compatibility surface.
