# ADR 0038: capability-aware Component host imports

Status: implemented — `wasm-component-binding/v2` declares which host interfaces an implementation may import, and every concrete host operation is authorized at use time.
Proven by: test/component-host-imports.test.js

## Problem

ADR 0037 decided that guest authority is the intersection of what an implementation declares
it may import and what the current execution is granted. It did not say when that intersection
is computed, and the obvious reading — build the import object from `declared ∩ granted` at
instantiation — is wrong twice over.

It is not implementable. The executor holds a check-only `require(demand)` and cannot enumerate
grants, by design. Worse, the concrete resource is not knowable in advance:

```wit
read-value: func(name: string) -> string
```

At instantiation you know the Component may use `read-value`. You do not know which `name` it
will ask for.

It is also unsound. `AuthorityService.require` walks the ancestor chain for revocation on every
call. Deciding authorization once at instantiation would turn a live, revocable capability into
a snapshot taken at activation start, so a context revoked mid-activation would keep working.

## Decision

### 1. Declaration decides what is wired; authority decides what succeeds

```text
declared imports   ->  which host interfaces are wired into the instance
current grants     ->  which concrete calls through them succeed
```

The effective ability is still `declared ∩ granted`, but the intersection happens **at each
host operation**, not by pre-filtering the import object.

### 2. Undeclared is a linking failure; ungranted is an authorization failure

These are different questions and must not collapse into one another.

```text
Component imports host-values, binding does not declare it
    -> unavailable, instantiation fails          UndeclaredHostImportError

Component imports host-values, binding declares it, runtime has no provider
    -> declared but unsatisfiable                HostImportUnavailableError

wired, caller lacks host-value/read "private-message"
    -> read-value("private-message") throws      AuthorityError

wired and granted
    -> succeeds
```

A WIT import is a static requirement of instantiation: a Component with an unsatisfied import
cannot be linked at all. That is a property of the durable program and its binding, decided
before any authority exists. Whether a wired call is permitted is a property of *this*
execution.

```text
undeclared != unauthorized
```

So a declared-but-ungranted interface is **present**. The guest instantiates, calls, and is
refused per operation. Making it absent instead would report a policy decision as a linking
error and would leak the caller's grants into the shape of the guest's world.

### 3. The durable binding declares interface names and nothing else

```json
{
  "abi": "wasm-component-binding/v2",
  "hostImports": ["lagrange:proof/host-values"]
}
```

No principal, no grants, no resources, no secrets, no service objects, no authority context.
Anything else would put authority into the durable graph, which ADR 0037 forbids outright.

Specifiers are the WIT import specifiers the Component actually declares, so
`declared ⊇ required` is a direct check rather than a mapping table.

`wasm-component-binding/v1` stays frozen. It has no declaration, therefore no wired host
surface, therefore it can never satisfy a Component that imports anything. Same version
discipline as `callable-interface/v2`.

### 4. The host import registry is runtime-local

The binding says which host interfaces a program was *designed* to use. The registry says which
implementation satisfies them *in this deployment*. Those are different questions, so the
registry is transient and never part of artifact identity.

### 5. A provider receives `require`, never authority

```js
readValue(name) {
  require({operation: 'host-value/read', resource: name});
  return valueStore.read(name);
}
```

The containment rule between `ActivationExecutor` and executors extends unchanged to host
implementations: no `AuthorityService`, no context, no principal, no grant, no enumeration.
`require` is handed in per execution rather than held by the registry, so an implementation
cannot outlive or cache the authority of the call that built it.

### 6. Each layer keeps one job

```text
jco adapter            Component execution mechanics; authority-agnostic
binding executor       durable declaration + execution policy
host import provider   maps a host operation to require(demand)
AuthorityService       authority
```

The jco runtime gained `requiredImports(component)` and an `imports` argument. It still knows
nothing about grants, principals or capability semantics — it reports a linking fact and
instantiates with whatever it is handed.

## Consequence

This is the first foreign execution that can do anything but compute. It arrives without
weakening any containment already established: authority is still absent from the durable
graph, still unreachable from an executor, still unenumerable, and still checked live rather
than snapshotted.

Revocation works through it for free, precisely because nothing was precomputed. A context
revoked between two host calls in the same activation stops the second one.

The cost is that a guest can discover which interfaces exist without being able to use them.
That is the correct trade: the alternative reveals the caller's grants through the shape of the
import object, which is a worse leak than knowing an interface's name.

## What is deferred

- authorized object projection, then WIT `resource` handles, in that order
- the foreign-runtime lane's host-call transport, whose semantics ADR 0037 decision 12 fixes
- WASI, which remains out unless deliberately declared and granted
- async foreign callbacks, still ordered after authority

## Guardrails

```text
declaration != authorization
undeclared != unauthorized
declared import -> wired, regardless of grants
authorization happens per concrete operation, at use time
no grant enumeration; no precomputed intersection
revocation stays live because nothing is snapshotted
durable binding carries interface names only
host import registry is runtime-local, never artifact identity
provider receives require, never authority
jco adapter stays authority-agnostic
wasm-component-binding/v1 frozen; declared imports are v2
```
