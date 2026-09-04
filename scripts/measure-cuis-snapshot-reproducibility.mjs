// Repeatable measurement for ADR 0083 (bead lagrange-images-kd1): are the OpenSmalltalk/Cuis
// toolchain's derived snapshot bytes reproducible from closed inputs?
//
// Builds the SAME closed input graph (pinned base image/changes/sources + JSON.pck.st) N times
// through the real provider via `runtime.toolchains.run`, each build in an independently created
// workspace root, separated in time, then sha256s and byte-compares every derived output and
// classifies each difference region. It changes nothing in the repository and enables nothing.
//
//   source scripts/integration-env.sh
//   node scripts/measure-cuis-snapshot-reproducibility.mjs            # 3 builds, 15s apart
//   KD1_RUNS=2 KD1_SEMANTIC_EXPORT=1 node scripts/measure-cuis-snapshot-reproducibility.mjs
//   setarch "$(uname -m)" -R node scripts/measure-cuis-snapshot-reproducibility.mjs   # no ASLR
//
// Env: KD1_RUNS (default 3), KD1_GAP_MS (default 15000), KD1_SEMANTIC_EXPORT=1 (also compare the
// ADR 0072 export), KD1_REPORT (JSON report path, default ./cuis-snapshot-reproducibility.json).
// Derived outputs of every run are kept under a temp directory named on stdout for inspection.
import {readFile, mkdtemp, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  CUIS_BUILD_CONTRACT_V0, CUIS_BUILD_V1, CUIS_CHANGES_V1, CUIS_IMAGE_V1, CUIS_PACKAGE_V1, CUIS_SOURCES_V1,
  OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, bytesValue, createOpenSmalltalkCuisToolchainProvider, createRuntime, objectRef, textValue,
} from '../src/runtime.js';

const VM_IDENTITY = 'opensmalltalk-vm/202606270913/squeak.cog.spur_linux64x64/sha256:dff5dd4217820e971828e9459f235d0ab3a07aa02aea9004d0e4318391eb09ba';
const env = process.env;
const N = Number(env.KD1_RUNS ?? 3);
const GAP_MS = Number(env.KD1_GAP_MS ?? 5000);
const semanticExport = env.KD1_SEMANTIC_EXPORT === '1';
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function buildOnce(label) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `kd1-${label}-`));
  const provider = createOpenSmalltalkCuisToolchainProvider({vmPath: env.LAGRANGE_OPENSMALLTALK_VM_PATH, vmIdentity: VM_IDENTITY, timeoutMs: 120_000, workspaceRoot});
  const runtime = await createRuntime({backend: {mode: 'mock'}, toolchainProviders: [[OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, provider]]});
  await runtime.images.createImage({id: 'b'});
  const put = (id, representation, content, extra = {}) => runtime.images.putCodeArtifact('b', {id, languageId: 'smalltalk', representation, content, ...extra});
  try {
    const img = await put('base-image', CUIS_IMAGE_V1, bytesValue(await readFile(env.LAGRANGE_CUIS_IMAGE_PATH)), {logicalPath: 'Cuis7.9-8090.image'});
    const chg = await put('base-changes', CUIS_CHANGES_V1, bytesValue(await readFile(env.LAGRANGE_CUIS_CHANGES_PATH)), {logicalPath: 'Cuis7.9-8090.changes'});
    const src = await put('base-sources', CUIS_SOURCES_V1, bytesValue(await readFile(env.LAGRANGE_CUIS_SOURCES_PATH)), {logicalPath: 'Cuis7.8.sources'});
    const pkg = await put('json', CUIS_PACKAGE_V1, textValue(await readFile(env.LAGRANGE_CUIS_JSON_PACKAGE_PATH, 'utf8')), {logicalPath: 'JSON.pck.st'});
    const build = await put('build', CUIS_BUILD_V1, textValue(CUIS_BUILD_CONTRACT_V0), {dependencies: [
      {role: 'base-image', artifact: objectRef('b', img.id)}, {role: 'base-changes', artifact: objectRef('b', chg.id)},
      {role: 'base-sources', artifact: objectRef('b', src.id)}, {role: 'package', artifact: objectRef('b', pkg.id)},
    ]});
    const t0 = Date.now();
    const result = await runtime.toolchains.run({
      providerId: OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, imageId: 'b', roots: [objectRef('b', build.id)],
      target: {representation: CUIS_IMAGE_V1, fileName: 'LagrangeDerived.image'}, options: semanticExport ? {semanticExport: true} : {},
      outputIds: {image: 'out-image', changes: 'out-changes', ...(semanticExport ? {'semantic-export': 'out-export'} : {})},
    });
    const outputs = {};
    for (const o of result.outputs) {
      const rec = await runtime.images.getCodeArtifact('b', {image: 'out-image', changes: 'out-changes', 'semantic-export': 'out-export'}[o.name]);
      outputs[o.name] = rec.content.kind === 'bytes' ? Buffer.from(rec.content.base64, 'base64') : Buffer.from(rec.content.value, 'utf8');
    }
    return {label, workspaceRoot, ms: Date.now() - t0, outputs};
  } finally {
    await runtime.close();
  }
}

function classify(a, b) {
  if (a.length !== b.length) return {equal: false, lengthDelta: b.length - a.length, firstDiff: firstDiff(a, b)};
  const regions = [];
  let i = 0;
  while (i < a.length) {
    if (a[i] !== b[i]) {
      const start = i;
      while (i < a.length && a[i] !== b[i]) i += 1;
      regions.push({offset: start, length: i - start, a: a.subarray(start, Math.min(i, start + 24)).toString('hex'), b: b.subarray(start, Math.min(i, start + 24)).toString('hex')});
      if (regions.length > 200) break;
    } else i += 1;
  }
  return {equal: regions.length === 0, regions};
}
function firstDiff(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i; return n; }

const runs = [];
for (let i = 0; i < N; i += 1) {
  if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS));
  runs.push(await buildOnce(`run${i + 1}`));
  const r = runs[runs.length - 1];
  console.log(`${r.label}: ${r.ms}ms workspace=${r.workspaceRoot} ` + Object.entries(r.outputs).map(([k, v]) => `${k}=${v.length}B sha256:${sha(v).slice(0, 16)}`).join(' '));
}
const report = {runs: runs.map((r) => ({label: r.label, ms: r.ms, outputs: Object.fromEntries(Object.entries(r.outputs).map(([k, v]) => [k, {bytes: v.length, sha256: sha(v)}]))})), comparisons: []};
for (let i = 1; i < runs.length; i += 1) {
  for (const name of Object.keys(runs[0].outputs)) {
    const c = classify(runs[0].outputs[name], runs[i].outputs[name]);
    report.comparisons.push({pair: `run1 vs run${i + 1}`, output: name, ...c});
    console.log(`run1 vs run${i + 1} ${name}: ${c.equal ? 'IDENTICAL' : `DIFFERENT ${c.lengthDelta !== undefined ? `lengthDelta=${c.lengthDelta} firstDiff@${c.firstDiff}` : `${c.regions.length} regions`}`}`);
    if (!c.equal && c.regions) for (const r of c.regions.slice(0, 12)) console.log(`   @${r.offset} len=${r.length} a=${r.a} b=${r.b}`);
  }
}
const out = process.env.KD1_REPORT ?? 'cuis-snapshot-reproducibility.json';
await writeFile(out, JSON.stringify(report, null, 2));
if (runs.length) { const d = await mkdtemp(join(tmpdir(), 'kd1-keep-')); for (const r of runs) for (const [k, v] of Object.entries(r.outputs)) await writeFile(join(d, `${r.label}.${k}`), v); console.log('outputs kept in', d); }
