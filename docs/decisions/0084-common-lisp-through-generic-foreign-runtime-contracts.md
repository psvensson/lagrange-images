# ADR 0084: Common Lisp integrates through the generic foreign-runtime contracts — the language-neutrality falsifier

Status: implemented
Proven by: test/common-lisp-sbcl-provider.test.js, test/common-lisp-sbcl-real.test.js, test/opensmalltalk-cuis-provider.test.js

## Question

The platform claims to be language-neutral (docs/language-platform.md §1), but its deepest
personality is Smalltalk and its only external-compiler path is Rust/WASM. Bead
`lagrange-images-9p4` asked the hard question with a runtime that differs in image model, runtime
assumptions, loading behavior and callable representation from everything already integrated:

> Can a substantially different language/runtime integrate through the existing Images contracts
> without adding language-specific authority to generic layers?

Success was defined as: Common Lisp represented as an ordinary language/runtime through existing
generic contracts; no generic owner gaining an `if (common-lisp)` branch; any genuinely missing
abstraction identified at its correct owner — not "SBCL runs hello world".

## What the spike found

1. **The generic foreign-runtime contracts were sufficient, unchanged.** A Common Lisp source is an
   ordinary code artifact (`common-lisp/source-v1`, text, `logicalPath` `*.lisp`). The runtime
   definition is an ordinary code artifact (`common-lisp/sbcl-runtime-definition-v1`) whose
   `source` dependencies are resolved by the generic `ForeignRuntimeDefinitionService`, and whose
   representation is bound to a provider id (`common-lisp/sbcl`) by the generic definition-binding
   registry. The lifecycle is `ForeignRuntimeService`. The callable is the existing
   `foreign-runtime-callable-interface/v1` (`foreign-runtime-value-call/v0`) with its one
   `runtime-definition` dependency, executed by the generic callable executor through the generic
   definition instance cache. Project membership, capture, bundle, managed install and fresh-runtime
   execution are the existing owners over an ordinary Block. Not one generic module changed to
   admit Lisp, and a structural test keeps it so: no generic owner may mention Lisp or SBCL, and the
   entire Lisp-specific surface is exactly one provider module.

2. **One missing generic owner was found and repaired first.** The stdio line framing
   (`READY`/`CALL`/`OK`/`ERR`/`QUIT`/`BYE`), the canonical Value transport (`i:`/`b:`/`f:`/`e:`/`d:`),
   the per-handle call queue and the session helpers lived inside the OpenSmalltalk/Cuis provider.
   A second, unrelated runtime needed exactly the same protocol — the point at which a
   provider-private protocol is really a shared owner. It is now `src/foreign-runtime/stdio-value-
   bridge.js`; the Cuis provider delegates to it with unchanged behavior and exported bindings, and
   the bridge does not know which runtimes exist.

3. **What stays language-specific, in one module** (`src/foreign-runtime/common-lisp-sbcl-provider.js`):
   the definition contract (`{contract: 'common-lisp-runtime-definition/v0', exports: [{service,
   operation, function, arity}]}`), materializing sources into a transient workspace, generating the
   guest bridge, and how SBCL is started (`--noinform --non-interactive --no-userinit --no-sysinit
   --disable-debugger --load`). The exports table **is** the allowlist: the guest dispatches a
   `CALL` only to a declared `(service, operation)` by resolving the named symbol at call time
   (`FIND-SYMBOL` in the named package after the sources are loaded) and applying it with exactly
   `arity` arguments. There is no reader evaluation of caller text, no ambient symbol lookup, no
   host callback, no Lisp heap identity in any Value; an undeclared operation, a wrong arity, an
   unsupported Value kind or an undefined function is an `ERR` code, never a crash, and a Lisp
   condition surfaces as `CommonLispCallError` carrying the condition text.

## Decision

- Common Lisp is an ordinary foreign runtime of this platform under the existing contracts; the
  neutrality claim holds for this first slice and is enforced structurally.
- The stdio value-call bridge is a generic owner, shared by every line-protocol provider.
- The spike's transport subset is integers (including bignums), booleans and text; float64 and
  bytes are refused by the guest with `unsupported-value` until a consumer needs them (they are
  already defined on the host side of the bridge).

## Consequences

- `npm run test:common-lisp` runs the real proof (`LAGRANGE_SBCL_INTEGRATION=1`); CI installs the
  distribution's SBCL in a dedicated lane. The identity recorded is `sbcl/<version>` as the binary
  reports it — a version pin, not a digest pin, which is honest for a distribution package and is
  the first thing to tighten if a provenance argument ever rests on it.
- The remaining roadmap items for a Lisp personality (reader/macroexpansion representation,
  dynamic bindings, multiple values, conditions/restarts, CLOS, ASDF/packages, FFI, debugger) are
  language-personality work above this boundary and are deliberately not started here.

## Not in scope

A Common Lisp image-native personality; ASDF or Quicklisp; FFI; a debugger; the condition system
or CLOS across the bridge; float64/bytes transport on the guest side; digest-pinned SBCL.
