# Value, reference and object model

The shared substrate is deliberately smaller than any language object model.

## Invariants

```text
shape     != behavior
reference != authority
identity  != revision
durable representation != execution representation
```

## Values

Object slots contain tagged Values only:

```text
boolean | integer | float64 | text | bytes | ref | pinned-ref
```

Portable encodings are explicit and lossless: integers use decimal strings, float64 stores the exact 64-bit hexadecimal payload, and bytes use canonical base64. There is no generic nested JSON collection Value.

Languages decide how their semantics map onto these forms. The substrate therefore has no special `nil`, Array, dictionary, cons, class or closure value.

## References

An ordinary reference is stable identity:

```js
{kind: 'ref', imageId: 'playground', objectId: 'counter'}
```

A historical reference adds an opaque revision:

```js
{kind: 'pinned-ref', imageId: 'playground', objectId: 'counter', revision: 'snapshot:one'}
```

Neither form grants authority. Authorization is resolved separately from identity.

## Shapes

Shapes are immutable substrate records sharing the object identity namespace:

```js
{
  kind: 'shape',
  id: 'counter-shape-v1',
  imageId: 'playground',
  slots: [{id: 'slot-value', name: 'value'}]
}
```

Slot IDs are stable; names are source/display labels. A rename can therefore keep `slot-postal` while changing `postalCode` to `postcode`. Structural changes create new shape identities.

Shapes are a bootstrap record kind rather than self-shaped objects so the substrate does not require an infinite meta-shape regress.

## Objects

```js
{
  kind: 'object',
  id: 'counter',
  imageId: 'playground',
  shape: {kind: 'ref', imageId: 'playground', objectId: 'counter-shape-v1'},
  behavior: {kind: 'ref', imageId: 'smalltalk-core', objectId: 'Counter'},
  slots: {'slot-value': {kind: 'integer', value: '0'}},
  metadata: {}
}
```

`shape` describes durable physical state. `behavior` is an optional, uninterpreted language/runtime hook. Smalltalk may map it to Class/Behavior; another language can give it different meaning.

Every declared shape slot must be present and undeclared slots are rejected. Generic objects do not contain `classId` or `source` shortcuts.

## Graph edges

Metadata is annotation only and may not contain refs. Semantic relationships belong in slots, shape or behavior so graph traversal cannot miss them.

`referencesOfRecord()` walks those explicit edges. This is the seed for reachability, export, dependency analysis and later garbage-collection rules.

Cycles are natural because refs name identities rather than embedding records. Slot refs are not required to resolve synchronously, which permits cyclic bootstrap graphs.

## Runtime optimization

The portable graph format does not dictate execution layout. A compiler/runtime may use tagged words, compact handles, unboxed WASM values or eliminated non-escaping closures while preserving the same image semantics.
