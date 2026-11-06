# 0095. Indexed-aware object projection and polyglot method bridges

Status: implemented
Proven by: test/image-projection.test.js, test/versioned-projection.test.js, test/polyglot-method-bridge.test.js

## Context

1. ADR 0047 introduced ordered `indexed` Value storage on image objects, ADR 0064 added `indexed: true` `list<T>` field mappings to `image-creation-binding/v1`, and ADR 0065 added `indexed: true` `list<T>` rewrites to `image-mutation-binding/v1`. However, `image-projection-binding/v1` (ADR 0039) and `image-versioned-projection-binding/v1` still rejected any `indexed: true` mapping and threw `image-projection-binding/v1 cannot project indexed object` on any object carrying an indexed part. As a result, a WASM Component or foreign runtime could create and mutate an indexed object through typed composite records, but could not project that same object back across the callable boundary.
2. Non-`lagrange-code` Block executors (`wasm-component-binding/v1`/`v2`, `foreign-runtime-binding/v1`, `wasm-callable-interface/v1`, and the image bindings) enforce `assertBlockApplicationReceiver` (ADR 0046) so that placing a callable Block directly into a `MethodDictionary` slot cannot silently discard `self`. Attaching a polyglot callable Block as an ordinary method on a native Smalltalk class therefore required callers to hand-author boilerplate `lagrange-code/v0` wrapper programs.

## Decision

1. **Indexed-aware projection in `image-projection-binding/v1` and `image-versioned-projection-binding/v1`:**
   - A projection binding's `fields` array may contain at most one entry with `{name, indexed: true}` (mutually exclusive with `slot`), matching the syntax of ADR 0064 and ADR 0065.
   - The corresponding field in the declared result record must have type `{kind: 'list', element: <leaf scalar>}` where `<leaf scalar>` is a canonical leaf type (`bool`, `s32`, `s64`, `f32`, `f64`, `string`, excluding `list<u8>`).
   - Every element in `object.indexed` is checked before conversion: if any element is a reference (`ref` or `pinned-ref`), projection fails closed (`indexed element <index> holds a reference; image-projection-binding/v1 never follows refs`), preserving ADR 0039's no-traversal authority rule.
   - Named-slot-only projections (with no `indexed: true` field) continue to refuse objects that carry an `indexed` part so a partial projection never looks like a complete object, and a projection that declares `indexed: true` refuses a non-indexed object.
2. **Polyglot method bridge helpers in `src/language/smalltalk-class-builder.js`:**
   - `polyglotMethodBridgeDescriptor({selector, callableBlockRef, passSelf = false})` synthesizes a deterministic `lagrange-code/v2` method descriptor that captures `callableBlockRef` and invokes it directly via `{op: 'apply', callee, arguments}` (ADR 0098) with the method arguments (and `self` prepended when `passSelf: true`), avoiding any `value` / `value:` message-dispatch round-trip.
   - `definePolyglotMethodBridge({images, compilation, imageId, classRef, selector, callableBlockRef, passSelf = false, lane = 'neutral'})` installs the bridge method through `defineMethods` so it participates in standard deterministic method identity, recovery convergence, and both `'neutral'` and `'wasm'` execution lanes while preserving `assertBlockApplicationReceiver` and ADR 0050 frame isolation.

## Rejected alternatives

- **Relaxing `assertBlockApplicationReceiver` on Component or foreign-runtime Block executors:** rejected because a raw callable Block placed in a `MethodDictionary` slot would either silently discard `self` or confuse receiver and first argument.
- **Allowing `edge: true` reference traversal in `image-projection-binding/v1`:** rejected because `object/read` authorizes only the projected object itself, never the targets of its outgoing references.
