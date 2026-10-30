# Runbook

AGENTS.md says what must stay true. This says how to run and debug the thing. If you are
a visiting agent, read the "Traps" section before you start; every entry in it cost
somebody real time.

## Consumer delivery and resource workflow

Start with one observable Images acceptance scenario. Name its owner, interaction owner,
dependency revision and completion proof in the Bead. Keep implementation, diagnostics,
consumer acceptance, upstream acceptance and release qualification separate.

Lagrange owns verification of Lagrange changes. For a dependency already verified at an exact
revision, retain the applicable upstream receipts and run the Images interaction proof. An
upstream defect needs its own owner, minimal public reproducer, source identities and handoff;
it does not silently turn a consumer task into an upstream repair campaign. Separately
authorized core work still follows the core repository's required workflow. Neither repository
may claim that old evidence proves a newly changed dependency.

Use this proof order:

1. A focused owner proof or counterfactual that can reject the hypothesis cheaply.
2. A bounded real public-operation diagnostic with a declared time, operation and output budget.
3. The complete unchanged consumer witness after the relevant cause has been addressed.
4. Every required job on the final PR head, followed by mergeability and final-diff review.

For M6.3, the completion witness remains the canonical shared-server Life fixture on its
candidate revision. A partial installation, row census, mock result or short profile does not
prove cross-runtime execution. Do not recreate its runtime setup in another diagnostic, lower
its replication targets or remove its assertions. The compiler cache's whole-image lookup is
a source-reachable cost hypothesis; measure its time alongside transaction work before changing
cache semantics. Do not multiply a small SQL workload's metadata counts by the whole graph and
present that estimate as a measurement.

Reuse proofs only when the existing proof owner establishes matching source/dependency inputs,
configuration, environment and scope. `scripts/ci-proof.mjs` owns native/recovery CI reuse;
real integration lanes still execute on the current head. An installed npm artifact and a
source checkout are different inputs. Pin the diagnosis candidate, then reconcile relevant
upstream changes once before final integration.

### Capacity before execution

Heavy work includes preflight: duplication analysis, large inventories, compilation and
dependency setup belong on an approved worker along with the tests. Before submission, verify
the actual workload is supported, toolchain and effective Node heap fit the reservation,
storage is sufficient, the machine lock/holder protocol is available, and idle/lease policies
will allow the declared run. A shared CI VM with an idle-stop policy is not automatically a
generic long-job worker. Do not disable another owner's lifecycle policy to make it one.

Cap the entire process tree, not merely Node test concurrency. Docker-created scopes must
share the cap too. Record observed CPU quota, memory limit and temperature admission; preserve
the existing thermal owner and its unavailable-sensor result on cloud hosts. Use one heavy
workload per machine under its shared lock. Parallelize independent work on separate approved
machines and overlap reviews or upstream CI while a consumer diagnostic runs.

Keep the interactive controller free of heavy work. On the reference Linux workstation, all
lightweight orchestration can share one transient user slice:

```sh
systemd-run --user --scope --slice=m63-orchestration.slice --quiet true
systemctl --user set-property --runtime m63-orchestration.slice CPUQuota=50% CPUWeight=10 IOWeight=10
systemd-run --user --scope --slice=m63-orchestration.slice --quiet node --version
```

Replace `node --version` with the lightweight orchestration command. This is a shared half-core
ceiling, not half the workstation, and it does not authorize heavy
local work. The slice is specific to these jobs; do not change limits or stop processes owned
by other work. On other hosts use their executor's equivalent observed limits.

### Run facts and retries

Record the immutable input identities, command, host, reservation, output location and
continuation owner before launch. Then distinguish prepared, admitted, running, terminal and
collected using actual request IDs, process identities and timestamps. A queued agent message
is not an active job. Verify the receiving executor started and identify who observes its result.
Report preflight as preflight rather than saying its tests are running.

A diagnostic receipt is evidence, not a second task graph; Beads retains task state and
dependencies. Partial, timed-out and infrastructure-interrupted runs stay explicitly below
consumer acceptance. Preserve original logs and source/copy hashes before a retry. Correct the
identified cause first, keep resource changes within the authorized reservation, and reuse
successful setup instead of starting it again. Do not repeat an unchanged long run or expand
acceptance deadlines to conceal non-completion.

### Bounded M6 diagnostic

`scripts/m6-profile.mjs` observes the canonical shared-server fixture from an explicit Images
checkout. It does not contain another Life installer or server setup. Its default is a plan:

```sh
node scripts/m6-profile.mjs \
  --images-root /worker/images-candidate \
  --fixture /worker/images-candidate/fixtures/real-lagrange-m6-shared-server-process.js \
  --fixture-sha256 REVIEWED_FIXTURE_SHA256 \
  --data-dir /worker/fresh-life-data \
  --output-dir /worker/fresh-profile-evidence \
  --worker OBSERVED_WORKER_HOSTNAME \
  --controller-boot-id BOOT_ID_CAPTURED_ON_CONTROLLER \
  --thermal-owner /worker/lagrange/scripts/checks/wait-for-thermal-headroom.js \
  --max-ms 180000 --max-operations 40 --max-log-bytes 16777216
```

Review the plan and retain the executor's full source archive, dependency and environment
identities. The runner's selected file hashes do not replace that provenance. Add `--execute`
only inside the existing worker executor, with its machine lock and live ancestor holder
(`project: lagrange-images`), observed cgroup v2 caps of at most two CPUs and 12 GiB, and a lease
long enough to collect the evidence. The worker boot identity must differ from the controller's.
Output and data paths must be fresh. Execution refuses missing caps, a missing lock, a mismatched
fixture hash or a thermal refusal; it records unavailable cloud thermal telemetry as unavailable.
The external executor remains responsible for placement, Docker containment and lease cleanup.

The preload observes Images calls in the fixture's main thread. Metrics count logical backend
calls and returned scan rows; transaction spans measure time before, within and after the callback.
Inclusive compiler, image and backend timings overlap. They are not physical SQL counts or
independent costs to add together, and a scan's returned rows do not establish how many records
the database examined. Scoped transaction objects retain their original identity.

The runner writes `plan.json`, `started.json`, bounded `canonical.log`, `observation.json` and
`terminal.json` when their phases are reached. An operation limit requests a stop after an outer
backend operation completes so the original fixture can run its cleanup. Wall, log, thermal and
cancellation stops terminate and reap the owned child process group within finite grace periods.
A failed cleanup remains a failure. A normal diagnostic completion exits zero; a partial or
failed diagnostic exits nonzero. Every result retains `diagnosticOnly: true` and `acceptance:
false`, even when the original fixture finishes. Complete consumer acceptance still requires its
ordinary unchanged witness and exact-head CI.

## Running the suite

```sh
npm test                  # unit + in-process proofs, no external assets — still means everything
npm run test:fast         # the same, minus the exhaustive recovery sweeps (what CI's node-test runs)
npm run test:recovery     # only those sweeps (what CI's recovery-test runs)
npm run demo              # examples/graph-demo.js, also run by CI
npm run test:integration  # the real proofs; needs scripts/integration-setup.sh first
npm run test:cargo-oci    # the real Cargo/rustc OCI proof; needs scripts/cargo-oci-setup.sh first
```

### Heavy checks run on workers

Prefer [the lab](#running-the-suite-on-the-lab) for a full-suite receipt; it runs nothing on this
machine. `.github/workflows/test.yml` is the merge authority, and targeted tests plus the relevant
real lane plus exact-head CI are sufficient merge evidence. `node --test` defaults to
`availableParallelism() - 1` workers, which on a 20-core workstation starts nineteen CPU-bound
files at once. `nice` and `--test-concurrency=1` are insufficient substitutes for a process-tree
CPU quota, temperature admission and a shared machine lock. Use the worker workflow above.

**`test/cuis-native-import.test.js` is CI-only on a thermally constrained host.** It performs 26
standard-image installs; three controlled local attempts on the reference workstation reached
76/76/81 °C, above its 80 °C package `high`. Use small targeted cases on an approved worker and
let CI's `node-test` lane run the complete file.

This is a HOST policy, not a property of the test. The file carries no skip, its semantics are
unchanged, and **product code and test semantics are never altered to accommodate workstation
thermals**. If the inability to run it locally becomes a real developer-productivity problem, that
is its own test-performance investigation — never a side change inside a compatibility PR.

### Running the suite on the lab

The Lagrange repository keeps a home-lab inventory of Linux machines reachable over SSH
(`~/.config/lagrange/lab/inventory.json`, managed by that repository's `node scripts/lab.js`; see
its `docs/development/home-lab.md`). `scripts/lab-suite.mjs` runs this repository's two CI lanes
across those machines and prints one verdict, so a full-suite receipt costs the workstation nothing:

```sh
npm run test:lab                                   # both lanes, every reachable worker
node scripts/lab-suite.mjs --lanes fast            # the ordinary lane only
node scripts/lab-suite.mjs test/a.test.js test/b.test.js   # targeted files
node scripts/lab-suite.mjs --nodes tv-dator        # one worker
node scripts/lab-suite.mjs --dry-run               # the plan, nothing shipped
```

It ships the working tree as it is (HEAD plus uncommitted and untracked-but-not-ignored files,
snapshotted through a temporary index, never the real one), so a branch can be tested before it is
committed. Each worker gets one SSH session: the snapshot as a `git archive` tar into its own checkout
under a `flock`, `npm ci --ignore-scripts` only when the lockfile changed, and then test files one at
a time on request (`scripts/lab-suite-worker.mjs`), each as its own `node --test` process with exactly
CI's lane flag. The controller keeps one queue of all files, longest first by recorded duration
(`~/.cache/lagrange-images/lab-timings.json`), and tops each worker up as its files finish, so a
worker that runs slower than expected simply takes fewer files. The first wave spreads the longest
files one per machine, fastest single core first (the Lagrange probe's CPU sample); each worker's
throughput speed is learned from its own runs (`~/.cache/lagrange-images/lab-speeds.json`) and used to
predict finish times. Slots default to about a third of a worker's logical cores: a test file is two
processes plus V8's compiler and GC threads, and a 12-core worker ran the whole ordinary lane in the
same time at 4 slots as at 11 while its longest file ran 25% faster. The run ends with the same
`# fail` and `EXIT=` lines a local run prints, each worker's predicted and actual finish, and a JSON
receipt under `~/.cache/lagrange-images/lab-receipts/` naming the exact tree it tested and every
file's measured time.

Workers are the inventory's Linux nodes with the `runner` role that answer SSH at the start of the
run. The controller's own machine is never used (a node whose probed boot id equals the
controller's is the same box under another name). Settings that belong to this repository live in
`~/.config/lagrange-images/lab.json`, never in the Lagrange inventory:

```json
{"defaultDir": "~/lab/lagrange-images",
 "nodes": {"adam-laptop": {"dir": "/mnt/old/lab/lagrange-images"}, "some-node": {"slots": 2, "exclude": false}}}
```

A checkout directory must end in `/lagrange-images`, and the script cleans it only when it is empty
or carries the script's owner marker, so a wrong path cannot wipe someone's directory.

Reading the counts: the ordinary lane's totals equal a single-machine run of the same tree (verified
1780/1737/43 skipped on one worker and on four). The recovery lane gets only the files that name a
sweep, so its `tests` is the sweep count plus one entry per such file with no matching test; the
line prints `sweeps` separately. CI's recovery total is larger only because node reports every other
file as one empty entry.

The lab is **evidence for iteration, not merge authority**: exact-head CI remains the gate. It does
not run the real OpenSmalltalk/Cuis, Cargo/OCI, SBCL or Lagrange lanes (their tests skip there
exactly as in the ordinary CI lanes). Measured on five workers (Sept 24 2026): both lanes in about
90 s wall, against about 5 minutes per lane on the hosted runners. The floor is the longest single
files: the Character recovery sweep and the M5 witness take 67 s and 49 s on a quiet worker and
roughly 90 s and 80 s on a loaded one.

### CI splits the suite; `npm test` does not

CI runs `test:fast` and `test:recovery` as two required jobs, because the exhaustive
publication-recovery sweeps grow with every new protocol and were pushing the general gate toward
its ten-minute timeout. The split is about budgets, not coverage: **nothing is sampled**, every
sweep still visits every write in both lanes under pre-commit and commit-then-lost-ack failure, and
a local `npm test` still runs the lot.

New commits cancel obsolete runs of the same PR; only its latest head should consume CI workers.

The two native jobs can reuse a previously successful CI proof when their declared inputs and
runner environment are identical. `scripts/ci-proof.mjs` owns this decision. It hashes every
tracked source, ordinary/recovery test, helper, dependency lock, script, workflow and unknown file,
plus the actual Node version, platform, architecture, runner image and relevant environment.
It excludes documentation and the explicit real-integration test modules: documentation assertions
belong in `steering-docs.test.js` or `agent-governance.test.js`, and those modules, the split guard,
and native-environment loading of the real-test files are checked on the current head when reusing.
Real integration jobs always execute their complete existing commands. Any new document-dependent
proof must join the current-head documentation checks; test files must not communicate through
undeclared mutable cross-file fixtures.

Reuse requires a receipt published after lane success by the PR that produced the merged base.
That PR's tested tree must equal the base tree, its exact-head `test` workflow must have all six
required jobs green, and the receipt must match the lane, inputs, runner and producer identity.
Missing, expired, malformed or mismatched evidence runs the full lane. A proof-policy or workflow
change therefore cold-runs both suites. The job summary records the reused run explicitly; all six
required checks still report on the current head. Local results cannot stand in for these CI
receipts. This is conservative reuse of the two native test groups, not an assumption that modules
using the broad runtime/standard-image composition are independent.

The ordinary job has a finite 30-minute budget. The M4 ASCII-conversion head exhausted the former
20-minute limit after 1,501 passing tests while still advancing through existing super-send proofs
(Actions run 34698454936). Native standard-image additions increase the work in many fixtures.
This budget change removes no assertions or files and leaves the separate recovery and real
integration lanes intact. A semantic failure still fails the job; an execution stall still times out.

The recovery job also has a finite 30-minute budget. The M4 digit-conversion head exceeded its
former 20-minute limit with 162 passing entries and no assertion failures (Actions run
34705349160, job 103584297247). The job annotation explicitly reports the execution-time limit.
Every publication write, both interruption modes and both execution lanes remain covered; the
required command and all other job budgets are unchanged by this later adjustment.

A new sweep must carry the `exhaustive-recovery:` prefix in its test name, or it silently rejoins
the general gate. `test/ci-split.test.js` enforces that in both directions — an unprefixed sweep
fails it, and so does a cheap test wearing the prefix.

Write a new sweep against `test/support/recovery-harness.js`: `faultingImages()` is the shared
write-fault wrapper, and `forkableRuntime(prepare)` builds the sweep's base image once and hands
each iteration a runtime over a `MockBackend.fork()` copy, so the fixed setup cost is paid once
per lane instead of once per write × 2 failure modes. The fork copies versions and streams too, so
optimistic concurrency behaves identically on either side. Coverage rules are unchanged — every
write, both failure modes, nothing sampled; only the installs under test repeat per iteration.

The ordinary lane has the same mechanism in `test/support/standard-image-fixture.js`:
`withStandardImage({lane, imageId}, body)` installs the standard image once per (lane, imageId) per
test process and runs `body` over a fresh `MockBackend.fork()` runtime. A file with many tests pays
one install per lane instead of one per test, and every test still starts from exactly the state a
fresh install produces, with nothing shared between tests — which is what distinguishes it from
`sharedFixture`, whose tests share one live image and must therefore be add-only. Use it for tests
that exercise the installed image; tests of installation itself (the preflight, write-free replay
and interrupted installs) keep a real install. Measured on the reference workstation at one worker
(Sept 23 2026): one standard-image install cost roughly 13-14 s per lane, and
`test/cuis-native-import.test.js` alone made 32 of them (527 s for the file).

The same prepared-backend helper reduces repeated setup in `test/super-send.test.js`: that module
builds its standard image once per lane, then runs every behavioral case in a fresh runtime over
an isolated fork. Its isolation proof rejects shared graph writes and runtime services. This is
mock fixture setup reuse, with module teardown closing the templates; it makes no durable restart
claim and skips no test. The measured trigger was M4 run 34735443456 exhausting the ordinary
30-minute job budget after 1,541 passing entries while the super-send module repeatedly installed
the same standard image. CI test selection and time budgets remain unchanged.

### `npm test` skipping is not the same as passing

`npm test` reports a handful of skips. Those skips are the tests that exercise a real
OpenSmalltalkVM, a real Lagrange backend and a real Cargo/rustc container — that is, the ones that
prove the foreign boundaries actually work. They skip silently when their environment is absent, so
a green `npm test` is **not** evidence that the foreign lanes are healthy.

| Gated test | Environment | CI lane | Proves |
| --- | --- | --- | --- |
| `test/opensmalltalk-cuis-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | live Cuis image through `ForeignRuntimeService` |
| `test/opensmalltalk-cuis-toolchain-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | Cuis toolchain build + mixed Lagrange-WASM program |
| `test/opensmalltalk-cuis-multipackage-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | the six-package upstream cluster with its real `!requires:` DAG |
| `test/opensmalltalk-cuis-semantic-export-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | deterministic `smalltalk/cuis-semantic-export-v1`/`v2` and the M1/M2 two-runtime native import |
| `test/cuis-export-materialize-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | canonical export materialized into ordinary objects |
| `test/cuis-json-native-import-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | the M3 forcing harness: `Json render:` natively with Cuis gone |
| `test/cuis-yaxo-native-import-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | the M4 acceptance: a native YAXO application graph, durable and restartable |
| `test/cuis-life-project-release-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | M5.1: the Life package closure captured as a managed, replay-safe Project release from the real toolchain |
| `test/two-lane-callable-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | one callable interface satisfied by a real Rust Component and a live Cuis image |
| `test/mixed-language-project-real.test.js` | `LAGRANGE_OPENSMALLTALK_INTEGRATION=1` | opensmalltalk-cuis-integration | one durable Project spanning native Smalltalk, a live Cuis VM and a real Rust Component, captured/installed/recovered |
| `test/lagrange-backend-real.test.js` | `LAGRANGE_IMAGES_REAL_LAGRANGE=1` | lagrange-backend-integration | schema and atomic transactions on real Lagrange |
| `test/cargo-rustc-oci-real.test.js` | `LAGRANGE_CARGO_OCI_INTEGRATION=1` | cargo-rustc-oci-integration | real Cargo/rustc in a digest-pinned image, closed inputs, executable output |
| `test/common-lisp-sbcl-real.test.js` | `LAGRANGE_SBCL_INTEGRATION=1` | common-lisp-integration | real SBCL through the unchanged generic foreign-runtime contracts (ADR 0084) |

Every file in this table is listed in `package.json`'s `test:integration` command or named directly
by its workflow job, and `scripts/ci-proof.mjs` carries the same list as `REAL_TEST_FILES`;
`test/ci-proof.test.js` checks that each entry has an always-running real lane. A new env-gated
file that is not added to both is a proof that never runs: the M5.1 Life release test sat outside
the integration file list from PR #295 until this table was completed, and its only trace in a
merge run was a skip in the ordinary lane.

If you changed anything under `src/foreign-runtime/`, `src/wasm/`, `src/toolchain/` or
`src/backend/`, run the matching real proof before claiming the change works.

### Setting up the integration assets

```sh
scripts/integration-setup.sh   # ~30 MB, digest-pinned, idempotent
npm run test:integration
```

`.integration/` is gitignored. The pins live in `scripts/integration-setup.sh`, which CI
calls too — change them in one place.

Downloads retry transient failures including HTTP 429, which the host does return when these
assets are fetched repeatedly, and land through a temporary file renamed only on success. A
failed transfer therefore leaves nothing behind for the next run to mistake for a cached asset.
If a download fails persistently, curl's own message is the diagnostic.

The Lagrange backend proof needs a checkout of `psvensson/lagrange` linked as
`node_modules/lagrange-server`; see the `lagrange-backend-integration` job in
`.github/workflows/test.yml`.

### Setting up the Cargo/rustc toolchain image

```sh
scripts/cargo-oci-setup.sh   # ~330 MB, digest-pinned, idempotent; needs Docker or Podman
npm run test:cargo-oci
```

The pin lives in `scripts/cargo-oci-setup.sh`, which CI calls too. `scripts/cargo-oci-env.sh`
reads back the reference that script actually pulled rather than repeating it, so the proof cannot
run against a digest nobody fetched. Set `LAGRANGE_OCI_CLI=podman` to use Podman.

The image is amd64-only (see ADR 0077 for why it is that image). On an arm64 workstation the
proof needs an emulation-capable engine; otherwise read the `cargo-rustc-oci-integration` CI lane
instead of running it locally.

Builds themselves are fast — a few hundred milliseconds each once the image is local — so a
failure that takes minutes is a pull or a container-start problem, not the compiler.

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

**A toolchain image's own `ENTRYPOINT` is not yours.** `buildOciRunArgs` always passes the program
as an explicit `--entrypoint` (ADR 0077). Without it, an image that declares an entrypoint runs
*that* with `cargo build ...` as its arguments, and the build fails in whatever way that program
happens to fail — usually nothing that mentions Cargo. If a real OCI build produces a baffling
error, check the argv before the compiler.

**Running the Cuis proofs dirties the working tree.** The VM writes a `UserChanges/`
directory beside its working directory and appends to the `.changes` file. Both are
gitignored; do not commit them.

**ADRs describe decisions, not necessarily reality.** Check the `Status:` line before
trusting an ADR as a description of the code — see AGENTS.md. An ADR may be `accepted`
long before anything implements it.
