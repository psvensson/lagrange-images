# Runbook

AGENTS.md says what must stay true. This says how to run and debug the thing. If you are
a visiting agent, read the "Traps" section before you start; every entry in it cost
somebody real time.

## Running the suite

```sh
npm test                  # unit + in-process proofs, no external assets
npm run demo              # examples/graph-demo.js, also run by CI
npm run test:integration  # the real proofs; needs scripts/integration-setup.sh first
```

### `npm test` skipping is not the same as passing

`npm test` reports something like `# skipped 3`. Those skips are the tests that exercise a
real OpenSmalltalkVM and a real Lagrange backend — that is, the ones that prove the
foreign boundaries actually work. They skip silently when their environment is absent, so
a green `npm test` is **not** evidence that the foreign lanes are healthy.

| Gated test | Environment | Proves |
| --- | --- | --- |
| `test/opensmalltalk-cuis-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | live Cuis image through `ForeignRuntimeService` |
| `test/opensmalltalk-cuis-toolchain-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | Cuis toolchain build + mixed Lagrange-WASM program |
| `test/lagrange-backend-real.test.js` | `LAGRANGE_IMAGES_REAL_LAGRANGE=1` | schema and atomic transactions on real Lagrange |

If you changed anything under `src/foreign-runtime/`, `src/wasm/` or `src/backend/`, run
the matching real proof before claiming the change works.

### Setting up the integration assets

```sh
scripts/integration-setup.sh   # ~30 MB, digest-pinned, idempotent
npm run test:integration
```

`.integration/` is gitignored. The pins live in `scripts/integration-setup.sh`, which CI
calls too — change them in one place.

The Lagrange backend proof needs a checkout of `psvensson/lagrange` linked as
`node_modules/lagrange-server`; see the `lagrange-backend-integration` job in
`.github/workflows/test.yml`.

## Debugging a foreign runtime that produces no output

This is the single most expensive failure mode in this repository, so it gets its own
section.

**Symptom:** a foreign-runtime test times out. The VM process starts, stderr shows only
the harmless `pthread_setschedparam failed` warning, and stdout is completely empty — not
even the `BOOT` lines the bridge prints on its first statement.

**Cause:** Cuis compiles the whole `-s script.st` file as a *single* doIt. A syntax error
anywhere in the script means no statement runs at all, including the `BOOT` markers put
there to diagnose exactly this. An unhandled *runtime* error hangs the same way, because
`-vm-display-null` has nowhere to show the debugger. Both look identical to a wedged
process.

**Get the actual error.** Run a second script that compiles the first as *data* and traps
the failure:

```smalltalk
| out src |
out := StdIOWriteStream stdout.
src := (DirectoryEntry currentDirectory // 'bridge.st') fileContents.
[ Compiler new evaluate: src in: nil to: nil notifying: nil
    ifFail: [ out nextPutAll: 'COMPILE-FAILED'; newLine; flush. nil ] ]
  on: Error do: [ :e |
    out nextPutAll: e class name; nextPutAll: ' :: '; nextPutAll: e messageText; newLine; flush ].
Smalltalk quitPrimitive: 0.
```

`SyntaxErrorNotification` is an `Error` subclass, so `on: Error do:` catches it, and its
`messageText` is the whole source with the fault marked inline, e.g.
`a clashing Temporary Variable named: 'result' was found. ->result`.

**Bisect first when the script is large.** `head -N bridge.st` plus a trailing marker
statement narrows the fault to a line range in a few runs, which is usually faster than
reading the whole compiler message.

**Check selectors before relying on them.** A throwaway script beats a CI round trip:

```smalltalk
out nextPutAll: (String canUnderstand: #someSelector) printString; newLine; flush.
```

Note that `allSelectors` and `includesSubstring:` are not usable this way in the pinned
image; stick to `canUnderstand:`.

**Keep the doIt small.** Compile each operation as its own method via `compile:` rather
than growing one nested doIt. Method temporaries cannot clash with doIt temporaries, one
bad method cannot silence the rest, and the bridge can report which selectors failed to
compile instead of hanging.

### Cuis image constructs that do not behave

Verified against the pinned Cuis 7.9-8090 image. These fail silently or at runtime rather
than at compile time, so they are easy to ship broken:

| Avoid | Use instead |
| --- | --- |
| block temp shadowing an outer doIt temp | rename; it is a *syntax error* in Cuis |
| `String fromUtf8Bytes:` for non-Latin-1 | `UnicodeString fromUtf8Bytes:` — `String` truncates above code point 255 **silently** |
| `Float new: 8` + byte-wise `basicAt:` | `Float fromIEEE64Bit:` / `Float>>asIEEE64BitWord` |
| `Character>>numericValue` | `digitValue` (note `$a digitValue` is `-1`; uppercase hex first) |
| `String>>codePointAt:` | `(str at: i) codePoint` |
| `String new: 16` as an accumulator | `WriteStream on: (String new: 16)` |
| `Object>>isByteArray` | `isKindOf: ByteArray` |
| hand-rolled base64 | `String>>base64Decoded`, `ByteArray>>base64Encoded` |

## Traps

**Adding a module can break every test at import time.** `src/runtime.js` re-exports 13
modules with `export *`. If a new module exports a name another one already exports, the
whole package fails to import with `SyntaxError: ... contains conflicting star exports for
name 'X'`. The message names the symbol but neither file. Before adding a shared constant,
`grep -rn "MY_CONSTANT" src/` — and if the concept already exists, import it rather than
spelling it twice.

**A hanging test is usually a foreign process, not a deadlock in JavaScript.** Check for a
stray `squeak` process before assuming the runtime is at fault.

**Running the Cuis proofs dirties the working tree.** The VM writes a `UserChanges/`
directory beside its working directory and appends to the `.changes` file. Both are
gitignored; do not commit them.

**ADRs describe decisions, not necessarily reality.** Check the `Status:` line before
trusting an ADR as a description of the code — see AGENTS.md. An ADR may be `accepted`
long before anything implements it.
