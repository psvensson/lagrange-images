# ADR 0061: Nested namespace semantics

Status: implemented
Proven by: test/nested-namespaces.test.js, test/global-names.test.js

## Problem

ADR 0057 shipped exactly one root namespace: a single durable object
(`smalltalk-global-namespace/v1`) whose indexed part is a flat, sorted map from a non-empty Text
name to a GlobalBinding. That was the right first step — it separated name, binding identity and
current value, and it made "an unknown global is a compile-time failure" true. What it cannot
express is any *organization* of names:

```text
today (ADR 0057, flat)                     the pressure this ADR answers
──────────────────────────────────────     ──────────────────────────────────────────
one root namespace object                  a Project wants its own names without squatting
Array  ->  binding/Array                   the kernel's Array, or colliding with another
Point  ->  binding/Point                   Project's Point
MyPoint -> binding/MyPoint                 two teams both want to call a class `Point`
```

The roadmap asks for two things at once (§1 "nested namespace semantics", §8 "nested/related
Project and namespace conventions"), and they are the same question: **how do names nest, and what
does a Project have to do with it?**

The constraints ADR 0057 already fixed are the hard part, and they narrow this design sharply:

- **globals resolve at compile time, never at runtime** — a compiled read holds the GlobalBinding,
  so namespace structure can never be a runtime lookup chain.
- **binding identity is what the artifact carries** — nesting must not fork or rename a binding;
  two namespaces that name the same thing name the *same* binding.
- **rename/remove are identity-scoped management operations** — nesting adds a dimension (which
  namespace) without changing that rule.
- **the compiler learns the namespace protocol, never a class name or a deterministic id** — nesting
  is a change to what the protocol can resolve, not a new fact baked into generated code.

ADR 0057 named the escape hatch explicitly ("a later project or nested namespace is another mapping
onto the same bindings"). This ADR takes it.

## Decision

### 1. A namespace is a mapping onto shared bindings; nesting is lexical visibility, not containment

A namespace stays what ADR 0057 made it: an object whose indexed part maps names to GlobalBinding
refs. **Nesting does not put bindings inside namespaces.** Bindings remain flat, durable, peer
objects with stable identities; a nested namespace is a *second mapping* that can name some of the
same bindings under its own names, plus bindings the root does not name.

```text
root namespace                 Project namespace "Game"            the bindings (flat, shared)
───────────────                ──────────────────────────          ─────────────────────────
Array   -> b/Array             Array   -> b/Array   (re-export)    b/Array      -> Array class
Dictionary -> b/Dictionary     Board   -> b/Game.Board             b/Dictionary -> Dictionary
(no Point)                     Point   -> b/Game.Point             b/Game.Board -> Board class
                                                                b/Game.Point -> Game's Point
                                                                b/Physics.Point -> Physics' Point
```

`Game.Point` and `Physics.Point` are two bindings because they are two classes. `Game` re-exporting
`Array` names the *same* `b/Array` binding the root names — one binding, reachable two ways. This is
the whole reason ADR 0057 kept name, identity and value apart, and it is what makes nesting cheap:
**a namespace edge is a name→binding pair, nothing more.**

### 2. A namespace has an optional parent; lookup walks outward, and inner shadows outer

A namespace object may carry a parent edge to another namespace. Compile-time resolution of an
unqualified name starts at the *current* namespace and walks parent links outward to the root:

```text
resolve(name, fromNamespace):
    for ns in fromNamespace, then ns.parent, ... up to the root:
        if ns maps name -> binding: return binding
    fail: unbound name            (still a compile-time error — decision 4)
```

- **Inner shadows outer.** A name defined in a nearer namespace wins. A Project can define its own
  `Point` and its code sees that `Point`, while the root's `Array` is still visible through the
  parent chain. Shadowing is a *compile-time* choice of which binding a spelling resolves to; it
  changes nothing about the bindings themselves.
- **The walk is acyclic and finite.** A parent edge that would close a cycle is refused at write
  time by the management seam, exactly as ADR 0057 refuses a corrupt mapping. A corrupted cycle is a
  dangling-edge class of error, not a silent loop.
- **The root is the parentless namespace.** ADR 0057's `smalltalk-global-namespace/v1` is the root:
  it has no parent, and every chain terminates there. Nothing about its existing entries changes.

This is deliberately *not* a path-qualified naming scheme. There is no `Game::Point` source syntax
in this ADR (decision 7). Nesting answers "which bindings are visible from here", which is the
question a compiler actually asks.

### 3. Where code compiles *in* a namespace, not where a name has a path

A compilation happens **in the context of a namespace**, the same way ADR 0044 made a send happen in
a dispatch image: it is context, not a field baked into the artifact. The compiler is handed the
namespace to resolve against (transient, per-compilation, exactly as `globalDeclarations` is read
per compilation today); it walks that namespace's chain; the artifact that results carries binding
ids and no namespace path, unchanged from ADR 0057.

This is the decision that keeps the runtime at zero cost and the artifact portable:

- a compiled global read is still one ordinary `value` send to the captured binding — nesting adds
  no runtime indirection, because the chain was already walked at compile time;
- the artifact carries `$global:<bindingId>` captures exactly as before, so a Block compiled in a
  Project namespace installs and runs in any image where those binding identities exist;
- re-resolution by spelling never happens at install or run time (ADR 0057 guardrail unchanged).

What a "current namespace" is for the standalone-Block seam (`installSymmetricSmalltalkBlock`) is
decided per call site by the caller — defaulting to the root, which reproduces today's behavior for
every existing caller.

### 4. Unknown stays unknown; an empty chain is a compile-time failure

Resolution that reaches the root without finding the name fails at compile time, precisely as ADR
0057 decision 4 fixed. Nesting changes *how far* the search reaches, not *what failure means*. A
name visible only in a sibling Project's namespace is **not** visible — namespaces share bindings
only through a common ancestor, never sideways. There is no implicit cross-Project visibility.

### 5. Projects relate to namespaces as organization, not as storage and not as authority

ADR 0058 decided Project is an image-level semantic model over ordinary objects/refs, not a storage
primitive, and that authority does not follow Project structure. Nesting is consistent with both:

- **A Project may designate a namespace** as the one its code compiles in. That is an ordinary
  object edge from a Project object to a namespace object — organization, exactly as §8's Project
  edges are organization. This ADR does not create the Project object; it says what a Project *has*
  when §8 lands, namely a namespace, and what that namespace already is here.
- **Namespace nesting is independent of Project nesting.** A Project's namespace has a parent chain;
  a Project's own §8 relationships (containment, dependency) are a separate graph. A child Project
  is *conventionally* given a namespace whose parent is the parent Project's namespace — that is how
  "a child Project sees its parent's names" is expressed — but the convention is a management
  choice, not a structural rule, and it confers no authority (ADR 0058 decision 6, unchanged).
- **No new storage kind.** A nested namespace is the same namespace object ADR 0057 already stores,
  with a parent edge; bindings are the same GlobalBinding objects. Nothing in this ADR requires a
  backend change. (Implementation note: because ADR 0002 makes a Shape immutable and a structural
  change a new shape identity, the parent edge lives on a **v2 namespace Shape**
  (`smalltalk/global-namespace-shape/v2`) rather than mutating v1. Pre-0061 v1 records dual-read and
  migrate to v2 on their first mapping rewrite — v1 is never mutated.)

### 6. Management operations gain a namespace dimension, keep their identity-scoped rules

`publishGlobal`, `rebindGlobal`, `renameGlobal`, `removeGlobal` and `resolveGlobal` operate on *a
namespace*, so each names the namespace it acts on (the root is simply the default, preserving every
existing call). Their ADR 0057 guarantees are untouched:

- publication is exact-or-create and idempotent within one namespace;
- rename/remove are still identity-scoped (they require the expected binding id), so a retry never
  acts on an ABA replacement — now within the named namespace;
- rebinding a binding is namespace-independent: the binding is one object, so `rebindGlobal` on it
  is visible through every namespace that names it. That is the *point* of shared bindings, and it
  is why ADR 0057 forbade a `value:` setter — rebind stays a trusted-seam operation, not something a
  reader can do.
- a name published only in a child namespace does not appear in the parent; the parent chain is
  read for lookup, never written by a child operation.

Creating a namespace, setting its parent, and designating a Project's namespace are new
trusted-management-seam operations, not Smalltalk protocol — same status as `writeMapping` today.

### 7. Deferred, deliberately

- **path-qualified source syntax** (`Game::Point`, `Physics.Point`) — nesting answers visibility;
  an explicit qualification syntax is a separate, additive language decision. Nothing here needs it,
  and choosing it now would couple this ADR to surface syntax.
- **private/hidden names** (a name visible in a namespace but blocked from children) — the parent
  chain grants visibility; selective hiding is a further rule this ADR does not need.
- **`Smalltalk at:put:`-style runtime publication** — still deferred from ADR 0057, unchanged.
- **global assignment** — still deferred from ADR 0057, unchanged, and still bound to the
  already-resolved binding identity if ever admitted.
- **making any namespace a Smalltalk-visible Dictionary** and a reflective protocol over nesting —
  deferred from ADR 0057, unchanged.
- **the Project object and §8 semantics** — branch/frontier/diff/merge are their own ADRs; this ADR
  only fixes what a Project's *names* mean.

## Consequences

- Namespaces nest by **parent-linked visibility** over **flat, shared bindings** — the one move ADR
  0057 reserved for this purpose, taken without touching binding identity, compile-time resolution,
  or the artifact format.
- Two Projects can each have a `Point`; they are two bindings, and neither sees the other's unless
  a common ancestor names it. The kernel's names stay at the root and stay visible everywhere
  through the chain.
- Runtime cost is still one `value` send; the chain is walked at compile time. `lagrange-code`
  gains no op.
- The root namespace and every existing caller behave exactly as before (a namespace with no parent
  and the default namespace), so this is purely additive over ADR 0057.
- The implementation task that follows adds: the parent edge on the namespace object, the
  chain-walking resolver, per-call current-namespace plumbing in the compiler entry points
  (defaulting to root), cycle refusal in the management seam, and the create/set-parent/designate
  operations — each with proof that ADR 0057's guardrails still hold.

## Guardrails

```text
nesting is visibility, never containment: a binding is not *in* a namespace; a namespace *names* a
    binding. Two namespaces naming one binding name one object
the parent chain is walked at COMPILE time; a compiled read is still one `value` send, and the
    artifact still carries binding ids and no namespace path. Never resolve a name at runtime
inner shadows outer, and the walk is acyclic and terminates at the root — a parent edge that closes
    a cycle is refused at write time, and a corrupted cycle is a dangling-edge error, never a loop
an unknown name after the root is a compile-time failure; namespaces never see sideways into a
    sibling, only upward through a common ancestor
rebinding is namespace-independent and stays a trusted-seam operation — every namespace that names a
    binding sees the rebind, and no reader can rebind
a Project designates a namespace; the namespace's parent chain is not the Project's §8 relationship
    graph, and neither confers authority (ADR 0058 decision 6 unchanged)
no path-qualified source syntax, no private names, no runtime publication, no global assignment in
    this ADR — nesting is visibility and nothing more
the compiler still learns the namespace protocol, never a class name, never a deterministic class
    id, and now never a namespace path either
```
