# ADR 0091: Text stream contents and narrow Cuis Unicode name adaptation

Status: accepted

## Problem

After ADR 0090 made Character literals native, the ADR 0085 M4 causal scope reached unchanged
YAXO `XMLTokenizer>>nextWhitespace`. Native name resolution refused the distinct class-side
expression `UnicodeString streamContents: [...]`. ADR 0085's earlier `UnicodeString writeStream`
adaptation did not establish this operation's block evaluation, result, or error semantics, and a
general `UnicodeString -> Text` alias would falsely claim a second native text class and arbitrary
protocol compatibility.

The pinned Cuis 7.9-8090 oracle and source establish the exact boundary:

```smalltalk
streamContents: blockWithArg
    | stream |
    stream := Utf8EncodedWriteStream on: (ByteArray new: 100).
    blockWithArg value: stream.
    ^stream contents
```

- `UnicodeString class>>streamContents:` is implemented on `UnicodeString class` itself;
- it creates a `Utf8EncodedWriteStream` over a `ByteArray`, evaluates the supplied block once,
  ignores the block's answer, and answers `stream contents`;
- empty, ASCII, U+03BB and supplementary U+1F600 writes answer `UnicodeString`; multiple writes
  preserve order;
- no write and an empty write are equal but non-identical empty results;
- the yielded stream understands `nextPut:`, `nextPutAll:` and `contents`, and has the same class as
  `UnicodeString writeStream`;
- the corresponding `writeStream ... contents` operation answers an equal result of the same
  class; and
- a signalled `Error` escapes with the same class and message.

The forcing method observes only the yielded stream's `nextPut:`, the returned text through
`isEmpty`, and a non-empty result passed to `handleWhitespace:`. It does not inspect the concrete
stream or text class.

## Decision

1. **Generic `streamContents:` execution is native Text/WriteStream protocol.**

   Native `Text class>>streamContents:` creates the existing native `WriteStream` on an empty Text,
   evaluates the producer Block once, discards its answer, and answers `WriteStream>>contents`.
   The existing stream owner remains the only accumulator and text reconstruction owner. The Text
   method captures that installed class directly because standard-image composition creates the
   class before publishing its global; this is explicit dependency injection, not another stream
   path.

   Direct Symmetric Smalltalk source can call `Text streamContents:` with no Cuis export, adapter,
   toolchain, or runtime present. `Text>>isEmpty` is added at the existing Text protocol owner as
   the exact observation the forcing caller makes, implemented by ordinary equality with empty
   Text rather than a new text-size primitive.

2. **The native result is canonical Text, not a simulated UnicodeString.**

   This image deliberately has one textual Value representation. On the forcing path it preserves
   the measured text content, Unicode scalars, write order, block sequencing, and error propagation.
   It does not preserve Cuis's concrete `UnicodeString` identity. In particular, empty Text Values
   compare identical under native Value identity where the two upstream allocated empty results do
   not; the caller observes emptiness, not allocation identity. This decision introduces no
   `UnicodeString` Class/global, second text representation, mutable String, or generic Value kind.

3. **The Cuis adapter translates only the exact foreign semantic locator.**

   The closed token idiom table recognizes an unbound, undeclared global receiver in the complete
   expression `UnicodeString streamContents: [literalBlock]` and replaces only receiver plus
   selector with `Text streamContents:`. The block and all execution semantics remain untouched.
   A locally bound or manifest-declared `UnicodeString`, another receiver/selector/argument shape,
   a longer message chain, a cascade, string data, and comment text remain unadapted.

   This replacement joins legacy assignment, `String new`, and `UnicodeString writeStream` in the
   one immutable replacement plan collected against the original token stream and applied once
   right-to-left. There is no macro expansion and no second rewrite pass.

4. **Later stream and Character protocol remains pressure-driven.**

   The upstream block contains `nextPut:`, but the real causal execution asks the current
   Character whether it `isSeparator` before that send is reached. Neither selector is added by
   this decision merely because it appears in source. The repaired vertical must classify its next
   actual refusal and schedule that as a separate M4 child.

## Alternatives rejected

- **Publish `UnicodeString -> Text`.** This would make every unrelated UnicodeString expression
  appear supported and collapse a Cuis class identity into a native Value class without evidence.
- **Macro-expand the whole operation in the adapter.** That would give the translation boundary
  ownership of Block evaluation, stream lifecycle, return sequencing, and exception propagation.
- **Build text directly in `Text class>>streamContents:`.** This creates a second accumulator and
  duplicates the UTF-8 reconstruction already owned by `WriteStream>>contents`.
- **Return the producer Block's answer.** The pinned oracle proves that answer is ignored.
- **Implement only ASCII concatenation.** The oracle's BMP and supplementary writes disprove that
  domain.
- **Treat ADR 0085's `UnicodeString writeStream` idiom as a general mapping.** It was deliberately
  a closed construction claim and established no class-side convenience protocol.

## Completion and causal review

Implementation status requires direct provider-free Text execution, a causal dependency on
`WriteStream>>contents`, exact adapter negative/offset tests, unchanged pinned
`XMLTokenizer>>nextWhitespace` execution with Cuis absent, the next genuine M4 RED recorded as a
child, and exact-head CI plus adversarial breaks. This section will record those results before the
status advances to implemented.
