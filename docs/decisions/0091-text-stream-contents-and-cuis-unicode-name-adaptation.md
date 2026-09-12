# ADR 0091: Text stream contents and narrow Cuis Unicode name adaptation

Status: implemented — native `Text class>>streamContents:` composes WriteStream, including the later execution-earned Character `nextPut:` and buffer `reset` protocol; the adapter normalizes only the exact foreign receiver locator.
Proven by: test/smalltalk-write-stream.test.js, test/smalltalk-write-stream-reset.test.js, test/smalltalk-write-stream-reset-recovery.test.js, test/cuis-native-import.test.js, test/cuis-yaxo-native-import-real.test.js

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

4. **Later identity, stream, and Character protocol remains pressure-driven.**

   The upstream block contains `nextPut:` and `isSeparator`, but at this decision's exact revision
   real causal execution first sent the then-absent identity-inequality selector `~~`. A test-only
   bridge let this slice prove its empty-result observation while recording that independent child;
   it was not product protocol. The later ADR 0048 reconciliation removes that bridge, installs
   product `Object>>~~` at the equality owner, and moves unchanged execution to `isSeparator`.
   ADR 0090's narrow Character-protocol amendment then installs the exact pinned `isSeparator`,
   after which unchanged execution genuinely reaches `WriteStream>>nextPut:`.

5. **Character element writes share the existing WriteStream state and codec owner.**

   The pinned Cuis 7.9-8090 receiver is `Utf8EncodedWriteStream`. Its `nextPut:` accepts a
   Character or byte; for a Character it sends `codePoint`, delegates to `nextPutCodePoint:`,
   remembers the last element, and—with no explicit return—answers the stream. Live execution
   confirms the stream answer, UnicodeString results for ASCII, U+03BB and U+1F600, ordered
   consecutive writes, exact interleaving with `nextPutAll:`, and equivalence to a one-character
   String chunk at the observed result boundary.

   Native `WriteStream>>nextPut:` appends a tagged Character entry to the same private ordered
   accumulation used by `nextPutAll:` and answers `self`. The private tag preserves the element vs
   chunk distinction without a second channel. The Character is not passed to `nextPutAll:` and no
   second accumulator exists. `contents` stays the sole result constructor: it distinguishes the
   tagged element from Text chunks, sends ordinary `Character>>codePoint`, and
   gives that scalar to a private captured codec Block installed by the existing Text/ByteArray
   codec owner. That codec routes through the same portable `utf8Encode` operation as
   `Text>>utf8Bytes`; neither WriteStream nor Character duplicates UTF-8 arithmetic. No
   `Character>>utf8Bytes`, `Character>>asString`, generic Value kind, mutable String, importer
   execution rule, or compiler primitive is introduced.

6. **Reset reuses the existing stream and its single accumulation owner.**

   The complete M4 public parsing path reaches `XMLTokenizer>>nextName`, whose first send is
   `nameBuffer reset` (p6u). The pinned xxm.9 oracle already establishes that the Unicode stream
   returns itself and answers empty Unicode contents after reset. Native `WriteStream>>reset`
   clears its private `written` accumulation and returns `self`; backing and stream identity stay
   intact. Subsequent writes form a new prefix, so a shorter Unicode write cannot expose a stale
   suffix. There is no new Shape, cursor, primitive, host mutation or Text conversion policy.
   Arbitrary positioning and reading a WriteStream remain outside the executed protocol.

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
- **Delegate `nextPut:` to `nextPutAll:`.** A Character is an element, not a chunk, and does not
  answer `utf8Bytes`; the real Unicode executions kill that shape.
- **Teach Character a conversion selector for one stream consumer.** Character already owns the
  scalar through `codePoint`; byte encoding stays private at the established Text/ByteArray codec
  owner until another public consumer proves broader Character conversion protocol.
- **Encode the scalar independently inside WriteStream.** This would create a second UTF-8 owner.
  The private scalar codec instead reuses the same portable encoder as Text.
- **Treat ADR 0085's `UnicodeString writeStream` idiom as a general mapping.** It was deliberately
  a closed construction claim and established no class-side convenience protocol.

## Completion and causal review

The pinned Cuis oracle executes empty, ASCII, BMP and supplementary writes, ignored block answer,
multiple ordered writes, empty-write equality/identity, yielded-stream protocol, corresponding
`writeStream ... contents`, and Error propagation. Direct provider-free native execution proves
empty/multiple/Unicode results, one block evaluation, ignored answer, Text result identity, and
unmodified error propagation.

The dependency on the existing stream owner is executable rather than documentary: an isolated
test replaces `WriteStream>>contents` with an Integer answer and proves `Text streamContents:`
returns that exact answer. This would stay Text under a second accumulator. Exact adapter tests keep
unrelated selectors, arguments, chains, cascades, local/declared receivers, strings and comments
unadapted; a combined arrow/three-idiom method reconciles to the exact canonical native source and
executes, proving one drift-free replacement plan and no macro expansion. Direct native source
still refuses the Cuis-only `UnicodeString` name.

The exact real OpenSmalltalk/Cuis lane imports the full unchanged M4 causal scope with no alias. In
a Cuis-free native runtime, unchanged `XMLTokenizer>>nextWhitespace` now writes both ASCII space and
non-ASCII NBSP Characters through the product selector, returns their exact native Text, and stops
at a following non-separator. There is no test-local WriteStream method. Removing the selector,
aliasing it to `nextPutAll:`, returning the element, bypassing `codePoint`, separating accumulation,
or specializing ASCII makes complementary proofs red. The same unbridged causal run advances to
the independently recorded `lagrange-images-xxm.15` `next` RED. Exact-head CI and final revision
evidence live on each owning Bead/PR.
