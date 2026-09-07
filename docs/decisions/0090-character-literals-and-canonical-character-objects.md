# ADR 0090: Character literals and canonical Character objects

Status: implemented — direct Symmetric Smalltalk `$x` syntax lowers through an image-local Character interner, and native Text indexing produces the same canonical Character object.
Proven by: test/symmetric-smalltalk-character.test.js, test/cuis-yaxo-native-import-real.test.js

## Problem

The ADR 0085 M4 vertical reached the unchanged pinned YAXO method
`XMLTokenizer>>nextEntity` and the native tokenizer refused its comparison operand `$<`. This was
not evidence for an importer rewrite. `$<` is ordinary Smalltalk literal syntax, so the initial
owner was the Symmetric Smalltalk language personality unless the real dialect proved otherwise.

Representation could not be inferred from the glyph. A Character might have been observationally
equivalent to one-code-point Text, to an Integer code point, or to a distinct language object. More
importantly, the literal had to agree with the value supplied by the normal indexed/stream path the
real tokenizer compares against. A parser-only repair could compile and still choose the wrong
YAXO branch.

The pinned Cuis 7.9-8090 oracle established:

- `$<` is a `Character`, unequal to both the String `'<'` and Integer `60`;
- `'<' at: 1`, `'<' readStream next`, and the actual `XMLTokenizer>>peek` path all answer a
  Character equal and identical to `$<`;
- direct `$λ` and `$😀` agree identically with their corresponding UnicodeString stream results,
  so ASCII punctuation is not the semantic domain;
- `$` consumes exactly one following Unicode code point, without required whitespace or a
  JavaScript-style escape grammar, including whitespace and punctuation; at physical source end it
  consumes Cuis's U+001A scanner end marker; strings and comments keep dollars as data/comment text.

The oracle therefore disproved both convenient immediate-Value shortcuts. Character is genuinely
distinct at the forcing boundary.

## Decision

1. **Character literal syntax is native language syntax.**

   The tokenizer emits a distinct `character` token for `$` plus one Unicode scalar, the parser
   preserves an explicit `character` syntax node, and the semantic compiler lowers that node. The
   Cuis import adapter has no Character-literal recognition or rewrite. Consequently direct source
   such as `[ ^ $< ]` compiles with no Cuis provider, export or adapter present.

   The lexical rule is the measured Smalltalk rule, not a new escape language. A lone surrogate is
   refused because it is not a Unicode scalar. Physical end of source denotes U+001A, matching the
   pinned scanner rather than inventing an unterminated-literal rule.

2. **A native Character is a canonical image-local Smalltalk object, not Text, Integer, or a new
   generic Value kind.**

   The Symmetric Smalltalk personality owns a `Character` Class and a one-slot Character Shape. The
   slot stores the Unicode scalar as an existing Integer Value. Object identity is the injective,
   deterministic `smalltalk/character/<lowercase hexadecimal scalar>` within the image. Interning
   the same scalar therefore answers the same ObjectRef, making ordinary object identity and the
   existing default equality protocol implement the measured equality/identity semantics.

   This is language-specific object personality, composed from the existing graph/object and Value
   owners. `VALUE_KIND` and `lagrange-code` remain unchanged. The Character class is not published
   as a global merely because the representation exists; the forcing source names no such global.

3. **Literal and indexed production share one interner.**

   The compiler lowers a literal to an ordinary send of `value:` to its reserved `$character`
   intrinsic with the scalar as an Integer literal. Installation binds that intrinsic to the
   image-local `character-intern` primitive Block; the semantic artifact contains no image ref.

   Native `Text>>at:` delegates Unicode-scalar indexing to `text-at-character`, which in turn calls
   the same interner. Indexing is one-based and counts Unicode scalar values, so a supplementary
   character occupies one Smalltalk element rather than two UTF-16 code units. A lone surrogate is
   refused rather than becoming an invalid Character. No second identity or equality rule exists.

4. **The protocol is limited to the measured forcing semantic.**

   This decision adds canonical identity and Text indexed production. It does not add
   `codePoint`, classification predicates, case conversion, digit tables, normalization, printing,
   a ReadStream class, or escape parsing. Those are separate pressures if reached. In particular,
   the newly exposed YAXO refusal after this repair remains outside this ADR.

5. **The real consumer must choose the branch.**

   The integration proof imports unchanged pinned `XMLTokenizer>>nextEntity`, removes Cuis and its
   toolchain, and executes that inherited method on a native probe whose `peek` obtains the compared
   value through ordinary `Text>>at:`. The real `$<` comparison answers visibly different results
   for markup and non-markup inputs. This jointly falsifies parse-only lowering, Text/Integer
   representation shortcuts, an ASCII-specialized literal, and a stream-side-only patch.

## Alternatives rejected

- **Rewrite `$<` in `cuis-native-import.js`.** Direct native source remains red and ordinary
  Smalltalk syntax acquires the wrong owner.
- **Lower every Character to one-code-point Text.** The pinned language says `$< = '<'` is false.
- **Lower every Character to its Integer code point.** The pinned language says `$< = 60` is false.
- **Add a generic Character Value kind or a Character operation to `lagrange-code`.** Ordinary
  Smalltalk objects plus an image-local interner already express the required semantics; widening
  shared substrate would make a language-specific distinction universal.
- **Hard-code ASCII punctuation.** The same scanner and stream identity contract covers direct BMP
  and supplementary Unicode Characters.
- **Patch only stream/index production.** Direct `[ ^ $< ]` would remain a syntax refusal.
- **Publish a `Character` global with guessed class protocol.** The forcing source requires literal
  semantics, not global lookup or a broader base library.

## Causal review

The following deliberate breaks were applied, run, and reverted. Runtime representation breaks
used a minimal native image and the same executed Smalltalk `=` comparison between the literal and
`Text>>at:` used by the full proof; this kept the local run thermally bounded without replacing the
load-bearing pinned-YAXO proof on the final code.

| deliberate break | observed result |
| --- | --- |
| remove the native `$` tokenizer branch (the importer-only and stream-side-patch shapes) | direct `[ ^ $< ]` parsing returned to `unexpected character "$"` |
| lower every Character literal to one-character Text | executed `$< = ('<' at: 1)` answered false |
| lower every Character literal to its Integer code point | the same executed comparison answered false |
| keep the wrong Integer lowering while running only the parser proof | explicit Character syntax stayed green, proving syntax alone cannot validate representation |
| hard-code the tokenizer's Character value to `<` | the oracle-backed supplementary `$😀` case failed, leaving the trailing surrogate visible |
| add a Character-token branch to `cuis-native-import.js` | the structural owner proof failed immediately |

The final unchanged-YAXO proof composes the same two owners and observes both branches, so the Text
and Integer breaks would choose its non-markup result for `<node` rather than merely changing a host
representation.

## Resulting boundary

The Symmetric Smalltalk tokenizer/parser/compiler owns literal syntax and lowering. The Character
personality owns canonical runtime identity and delegates its records to existing image-object
owners. Text indexing is the ordinary native producer and delegates to that same Character owner.
The Cuis adapter and canonical export remain unchanged with respect to Character syntax.

After the repair, the exact M4 causal prefix imports through `XMLTokenizer>>nextEntity`. Its next
method, unchanged `XMLTokenizer>>nextWhitespace`, is refused earlier than Character classification:
ordinary name resolution reaches the distinct, unmeasured `UnicodeString streamContents:` idiom.
That pressure is recorded as child bead `lagrange-images-xxm.11` and is not repaired here.
