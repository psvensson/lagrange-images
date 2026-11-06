# ADR 0097: Structured AST dialect lowering and Project-scoped namespace re-export

Status: implemented
Proven by: test/cuis-native-import.test.js, test/nested-namespaces.test.js, test/smalltalk-authorized-import.test.js

## Context

1. **Structured AST dialect lowering (`src/language/cuis-native-import.js`).** Under ADR 0085 and ADR 0093, the Cuis native-import adapter translates the legacy assignment arrow `_` to `:=` and lowers the closed three-entry `CUIS_DIALECT_IDIOMS` table (`String new`, `UnicodeString writeStream`, and `UnicodeString streamContents: [ ... ]`) when the receiver name is neither locally bound nor declared by the package. Previously, `adaptDialect` performed this lowering by scanning the flat token stream with manual prefix sets (`IDIOM_EXPRESSION_PREFIXES`), manual bracket-depth counting (`hasExactBlockArgument`), manual `|` bar disambiguation (`boundNames`), and right-to-left character-offset string splicing.
2. **Project-scoped shared-binding re-export (`src/language/smalltalk-globals.js`).** ADR 0061 establishes that nested namespaces are mappings onto flat, shared `GlobalBinding` records. When importing a Cuis package or sharing existing root globals into a Project's child namespace, callers needed an explicit owner operation to re-export existing `GlobalBinding` identities into a target namespace without minting duplicate `GlobalBinding` objects.

## Decision

1. **Structured AST dialect parsing and lowering (`parseSymmetricSmalltalkDialect` and `lowerCuisDialectAst`).**
   - `src/language/symmetric-smalltalk-parser.js` exports `parseSymmetricSmalltalkDialect(source)` (while `parseSymmetricSmalltalk(source)` continues to reject `legacyAssign` `_` outright for direct native source). `parseSymmetricSmalltalkDialect` accepts `legacyAssign` (`_`) only in grammatical assignment position (`identifier _ expression`) and produces the canonical `assign` AST node.
   - `src/language/cuis-native-import.js` parses each Cuis method body into a structured AST during the method-group admission phase, collects bound names directly from the AST (`parameters`, `sequence.temporaries`, `block.parameters`, and `assign.name`), lowers the closed three-entry `CUIS_DIALECT_IDIOMS` table directly on AST `send` nodes (`String new` -> `''`, `UnicodeString writeStream` -> `(WriteStream on: '')`, and `UnicodeString streamContents: [ ... ]` with an exact `block` argument -> `Text streamContents: [ ... ]`) when the receiver is an unbound, undeclared `{kind: 'name'}` node (never a `cascade` or chained send), and formats the lowered AST into canonical Symmetric Smalltalk block source.
   - No `String` or `UnicodeString` global is published, and every unsupported selector or bare reference (`String new: 16`, `String`, `UnicodeString readStream`, cascades, non-block `streamContents:` arguments) remains a compile-time unbound-name refusal.

2. **Shared-binding namespace re-export (`reexportGlobal` and `reexportGlobals`).**
   - `src/language/smalltalk-globals.js` owns and exports `reexportGlobal({images, imageId, name, fromNamespaceId, toNamespaceId, as})` and `reexportGlobals({images, imageId, names, fromNamespaceId, toNamespaceId})`.
   - `reexportGlobal` resolves the existing `GlobalBinding` ref in `fromNamespaceId` (failing with `SmalltalkGlobalConflictError` if absent or if `toNamespaceId` already maps the target name to a different `GlobalBinding` id) and maps the target name in `toNamespaceId` to the identical `GlobalBinding` ref without creating a second `GlobalBinding` object.
   - `importCuisNativePackage` accepts an optional `targetNamespaceId` and, after publishing imported class globals into the root namespace, re-exports the scoped package class bindings into `targetNamespaceId` via `reexportGlobals`.

## Consequences

- Cuis dialect lowering is structural over the parsed AST rather than character-offset splicing over raw source text, while preserving ADR 0093's closed three-entry idiom table and ADR 0094's partial-admission error contract.
- Imported Cuis packages and existing globals can be re-exported into Project-scoped child namespaces as true shared `GlobalBinding` references (ADR 0061), so a single `rebindGlobal` is observed across all namespaces sharing that binding.
