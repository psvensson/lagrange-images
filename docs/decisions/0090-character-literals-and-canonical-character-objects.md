# ADR 0090: Character literals and canonical Character objects

Status: implemented — direct Symmetric Smalltalk `$x` syntax lowers through an image-local Character interner, native Text indexing and scalar enumeration produce the same canonical Character objects, and the Character personality exposes its scalar plus the first pinned classification protocol.
Proven by: test/symmetric-smalltalk-character.test.js, test/smalltalk-text-enumeration.test.js, test/smalltalk-character-ascii.test.js, test/smalltalk-character-constructor.test.js, test/cuis-yaxo-native-import-real.test.js

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

Later, unchanged `XMLTokenizer>>nextWhitespace` supplied the next independent Character pressure.
Pinned Cuis source defines `Character>>isSeparator` as membership of `self codePoint` in exactly
seven scalars: U+0020, U+0009, U+000A, U+000D, U+000C, U+00A0 and U+200B. The live oracle confirmed
all seven and rejected U+0000, U+000B, U+001B, `A`, U+0085, U+2002, U+200C and U+1F600. This is an
exact dialect semantic, not Unicode White_Space or a control-character range. Cuis's use of
`Array>>statePointsTo:` is its implementation mechanism, not evidence that native Array membership
belongs in the forcing contract.

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
   as a global merely because the representation exists. The original literal pressure named no
   such global; standard-image composition later publishes the installed class when the actual M4
   initializer names `Character` (qpr), through the existing namespace owner.

3. **Literal, indexed and enumerated production share one interner.**

   The compiler lowers a literal to an ordinary send of `value:` to its reserved `$character`
   intrinsic with the scalar as an Integer literal. Installation binds that intrinsic to the
   image-local `character-intern` primitive Block; the semantic artifact contains no image ref.

   Native `Text>>at:` delegates Unicode-scalar indexing to `text-at-character`, which in turn calls
   the same interner. Indexing is one-based and counts Unicode scalar values, so a supplementary
   character occupies one Smalltalk element rather than two UTF-16 code units. A lone surrogate is
   refused rather than becoming an invalid Character. No second identity or equality rule exists.

   The actual M4 initializer later forced `Text>>do:` (bead dph). Its scalar count comes from
   `text-size`, a pure language-local primitive reusing the exact `textCodePoints` interpretation
   of `text-at-character`, exposed through ordinary `Text>>size`. Enumeration is ordinary native
   source over `size`/`at:` and the existing Integer/Block loop: one canonical Character per scalar
   in order, callback answers ignored, receiver returned, empty text makes no callback, and callback
   failures propagate. Neither UTF-16 units nor UTF-8 bytes determine the element count. The generic
   executor gains no iterator and the codec gains no second scalar interpretation.

4. **Character exposes only the measured ordinary protocol.**

   The full M4 initializer later forces `asciiValue` (cmy) on its delimiter Characters. Pinned Cuis
   answers the scalar for ASCII 0–127 and canonical nil otherwise. Native ordinary source composes
   `codePoint`, Integer comparison and Boolean branches; it adds no scalar representation, primitive
   or unforced `isAscii` surface. The unrestricted `codePoint` alias fails the non-ASCII proof.

   The full M4 initializer forces public `Character class>>codePoint:` (0q8). Its ordinary class
   method captures the existing Character interner Block. Repeated construction, literal production
   and Text indexing therefore share exactly one ObjectRef per image/scalar. The existing interner
   continues to validate the Unicode scalar domain; public construction introduces no new allocation
   or recovery authority.

   `Character>>codePoint` is an ordinary instance-variable method that answers the scalar already
   stored in the canonical Character Shape. It adds no state, host lookup or primitive.

   `Character>>isSeparator` is ordinary Character-owned Smalltalk source. It sends `codePoint` and
   composes existing Integer equality and lazy Boolean `or:` to implement exactly the seven pinned
   values above. It does not add `Array>>statePointsTo:`, a generic membership protocol, a host
   Unicode classifier, a second Character table or a classification primitive. Removing/breaking
   `codePoint` therefore breaks classification too: there is one scalar owner.

   No wider classification framework is claimed. Case conversion, digit tables, normalization,
   printing, conversion protocol, a ReadStream class and escape parsing remain separate pressures.

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
- **Mirror Cuis's `Array>>statePointsTo:` implementation.** The forcing claim is Character
  classification. Adding generic collection membership for one indirect consumer would transfer
  ownership based on source shape rather than observable semantics.
- **Delegate to host Unicode whitespace.** It includes values the pinned language rejects (notably
  U+000B and U+0085) and obscures the seven-value Character contract behind another classifier.

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
| make `codePoint` answer `65` while leaving `isSeparator` unchanged | U+0020 classification answered false, proving classification consumes the ordinary accessor |
| admit U+000B as a tempting control-range approximation | the oracle-backed vertical-tab negative answered true |
| remove NBSP and U+200B as an ASCII-only approximation | the U+00A0 positive answered false before execution could hide the omission |

The unchanged pinned `XMLTokenizer>>nextWhitespace` proof reads its receiver through native
`Text>>at:`, verifies the product `Character>>isSeparator` binding survives import, and observes
both an accumulated-space callback and the non-separator branch. A separately unbridged execution
of the same method reaches `WriteStream>>nextPut:` next; that selector is recorded as M4 child
`lagrange-images-xxm.14` and is not implemented by this decision.

The final unchanged-YAXO proof composes the same two owners and observes both branches, so the Text
and Integer breaks would choose its non-markup result for `<node` rather than merely changing a host
representation.

## Resulting boundary

The Symmetric Smalltalk tokenizer/parser/compiler owns literal syntax and lowering. The Character
personality owns canonical runtime identity and delegates its records to existing image-object
owners. It also owns the ordinary `codePoint` accessor over its existing slot and the exact pinned
seven-value `isSeparator` classification. Text indexing and scalar enumeration are ordinary native producers and
delegate to that same Character owner. The Cuis adapter and canonical export remain unchanged with
respect to Character syntax and protocol.

The original literal repair exposed the distinct `UnicodeString streamContents:` pressure, followed
by ordinary `Object>>~~`; those decisions remain owned by ADR 0091 and ADR 0048. Once those landed,
unchanged `XMLTokenizer>>nextWhitespace` reached this narrowly added Character classification. The
next failure observed after it remains a separate M4 child rather than broadening this decision.
