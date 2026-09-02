import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNodeCryptoProvider} from '../src/support/node-crypto-provider.js';
import {createNodeSourceReader} from '../src/portable-artifact/node-source-reader.js';
import {
  PORTABLE_RUNTIME_ARTIFACT_ENTRY,
  PORTABLE_RUNTIME_ARTIFACT_FORMAT,
  assertPortableRuntimeArtifactV1,
  buildPortableRuntimeArtifact,
  canonicalPortableRuntimeArtifactJson,
  portableRuntimeArtifactIdentity,
  portableRuntimeArtifactMaterial,
} from '../src/portable-artifact/portable-runtime-artifact.js';

// lagrange-images-portable-runtime/v1 artifact proofs (bead lagrange-images-z42, B2).
//
// PACKAGING ONLY. Runtime behaviour is proven by the differential acceptance in
// `portable-runtime-artifact-acceptance.test.js`; nothing here asserts runtime semantics.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PRODUCER = join(REPO, 'scripts', 'build-portable-runtime-artifact.mjs');
const CRYPTO = createNodeCryptoProvider();

function buildFromRepo(options = {}) {
  return buildPortableRuntimeArtifact({readSource: createNodeSourceReader(REPO), ...options});
}

function mapReader(artifact, mutate) {
  const map = new Map(artifact.modules.map(({path, source}) => [path, source]));
  mutate(map);
  return (path) => map.get(path);
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lagrange-artifact-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('FORMAT: v1 is entry + canonical module list, and the entry is the REAL portable root', () => {
  const artifact = buildFromRepo();
  assert.equal(artifact.format, PORTABLE_RUNTIME_ARTIFACT_FORMAT);
  assert.equal(artifact.format, 'lagrange-images-portable-runtime/v1');
  assert.equal(artifact.entry, PORTABLE_RUNTIME_ARTIFACT_ENTRY);
  assert.equal(artifact.entry, 'src/portable-runtime.js');
  assert.ok(artifact.modules.some(({path}) => path === artifact.entry), 'entry is present in modules');
  assert.ok(artifact.modules.length > 30, `closure is non-trivial (${artifact.modules.length} modules)`);

  const entryModule = artifact.modules.find(({path}) => path === artifact.entry);
  assert.equal(entryModule.source, createNodeSourceReader(REPO)(PORTABLE_RUNTIME_ARTIFACT_ENTRY),
    'entry source is the exact repo source, byte for byte');
  // Relative specifiers preserved exactly: no rewriting, bundling, minification or transpilation.
  assert.match(entryModule.source, /from '\.\/support\/default-crypto\.js'/);
  assert.match(entryModule.source, /from '\.\/backend\/create-backend\.js'/);
});

test('FORMAT: every module is an ESM source preserved verbatim from the tree', () => {
  const artifact = buildFromRepo();
  const read = createNodeSourceReader(REPO);
  for (const {path, source} of artifact.modules) {
    assert.equal(source, read(path), `${path} must be byte-identical to the repo source`);
  }
});

test('FORMAT: paths are repo-relative POSIX logical paths, canonically ordered, unique', () => {
  const {modules} = buildFromRepo();
  const paths = modules.map(({path}) => path);
  assert.deepEqual(paths, [...paths].sort(), 'modules are in canonical logical-path order');
  assert.equal(new Set(paths).size, paths.length, 'no duplicate module paths');
  for (const path of paths) {
    assert.ok(path.startsWith('src/'), `${path} is under the artifact source root`);
    assert.ok(!path.startsWith('/'), `${path} is not absolute`);
    assert.ok(!path.includes('\\'), `${path} is POSIX`);
    assert.ok(!path.split('/').includes('..'), `${path} has no .. segment`);
  }
  const serialized = canonicalPortableRuntimeArtifactJson(buildFromRepo());
  assert.ok(!serialized.includes(REPO), 'the absolute checkout path never appears in the artifact');
  assert.ok(!serialized.includes(tmpdir()), 'no temp directory appears in the artifact');
});

test('DETERMINISM: repeated builds are byte-identical', () => {
  assert.equal(
    canonicalPortableRuntimeArtifactJson(buildFromRepo()),
    canonicalPortableRuntimeArtifactJson(buildFromRepo()),
  );
  assert.equal(
    portableRuntimeArtifactIdentity(buildFromRepo(), {crypto: CRYPTO}),
    portableRuntimeArtifactIdentity(buildFromRepo(), {crypto: CRYPTO}),
  );
});

test('DETERMINISM: a different absolute checkout path produces byte-identical output', () => {
  const fromRepo = canonicalPortableRuntimeArtifactJson(buildFromRepo());
  const fromCopy = withTempDir((dir) => {
    cpSync(join(REPO, 'src'), join(dir, 'src'), {recursive: true});
    return canonicalPortableRuntimeArtifactJson(
      buildPortableRuntimeArtifact({readSource: createNodeSourceReader(dir)}),
    );
  });
  assert.equal(fromCopy, fromRepo, 'checkout absolute path must not affect artifact bytes');
});

test('DETERMINISM: no mtime or filesystem metadata can enter the artifact', () => {
  // Same content, deliberately different mtimes: the artifact must not notice.
  const fromRepo = canonicalPortableRuntimeArtifactJson(buildFromRepo());
  const fromTouched = withTempDir((dir) => {
    cpSync(join(REPO, 'src'), join(dir, 'src'), {recursive: true});
    const future = new Date(Date.now() + 86_400_000);
    const touchAll = (current) => {
      for (const item of readdirSync(current, {withFileTypes: true})) {
        const full = join(current, item.name);
        if (item.isDirectory()) touchAll(full);
        else utimesSync(full, future, future);
      }
    };
    touchAll(join(dir, 'src'));
    return canonicalPortableRuntimeArtifactJson(
      buildPortableRuntimeArtifact({readSource: createNodeSourceReader(dir)}),
    );
  });
  assert.equal(fromTouched, fromRepo, 'mtimes must not affect artifact bytes');
});

test('DETERMINISM: filesystem/enumeration order cannot affect the artifact', () => {
  const reference = buildFromRepo();
  const referenceBytes = canonicalPortableRuntimeArtifactJson(reference);
  const entries = reference.modules.map(({path, source}) => [path, source]);
  for (const order of [[...entries].reverse(), [...entries].sort(() => 0.5 - Math.random())]) {
    const shuffled = new Map(order);
    assert.equal(
      canonicalPortableRuntimeArtifactJson(buildPortableRuntimeArtifact({readSource: (p) => shuffled.get(p)})),
      referenceBytes,
    );
  }
  // FALSIFIER: an order-dependent generator must be rejected -- this keeps the
  // determinism proof non-vacuous.
  assert.throws(
    () => assertPortableRuntimeArtifactV1({...reference, modules: [...reference.modules].reverse()}),
    /canonical logical-path order/,
  );
});

test('PRODUCER: the generation entrypoint emits deterministic canonical bytes', () => {
  // The CLI is the producer boundary a consumer actually uses; exercise it, do not
  // merely assume it works.
  const first = execFileSync(process.execPath, [PRODUCER], {cwd: REPO, maxBuffer: 64 * 1024 * 1024});
  const second = execFileSync(process.execPath, [PRODUCER], {cwd: '/', maxBuffer: 64 * 1024 * 1024});
  assert.ok(first.equals(second), 'producer output must not depend on the working directory');
  assert.equal(first.toString('utf8'), canonicalPortableRuntimeArtifactJson(buildFromRepo()),
    'producer output must equal the library producer, byte for byte');

  const identity = execFileSync(process.execPath, [PRODUCER, '--identity'], {cwd: REPO}).toString().trim();
  assert.equal(identity, portableRuntimeArtifactIdentity(buildFromRepo(), {crypto: CRYPTO}));
  assert.match(identity, /^sha256:[0-9a-f]{64}$/);
});

test('IDENTITY: content identity is over canonical material; a source revision is NOT in it', () => {
  const plain = buildFromRepo();
  const withProvenance = buildFromRepo({provenance: {sourceRevision: 'deadbeef'.repeat(5)}});
  const other = buildFromRepo({provenance: {sourceRevision: 'cafe'.repeat(10)}});

  assert.equal(withProvenance.provenance.sourceRevision, 'deadbeef'.repeat(5), 'provenance is recorded');
  assert.deepEqual(
    Object.keys(portableRuntimeArtifactMaterial(withProvenance)).sort(),
    ['entry', 'format', 'modules'],
    'canonical material carries only format/entry/modules',
  );
  const identity = portableRuntimeArtifactIdentity(plain, {crypto: CRYPTO});
  assert.equal(portableRuntimeArtifactIdentity(withProvenance, {crypto: CRYPTO}), identity);
  assert.equal(portableRuntimeArtifactIdentity(other, {crypto: CRYPTO}), identity);
  assert.match(identity, /^sha256:[0-9a-f]{64}$/);
  // No git SHA may reach the canonical material.
  assert.ok(!canonicalPortableRuntimeArtifactJson(withProvenance).includes('deadbeef'));
});

test('CLOSURE: the artifact contains every static relative dependency exactly once, and no node:*', () => {
  const artifact = buildFromRepo();
  const paths = new Set(artifact.modules.map(({path}) => path));
  for (const {path, source} of artifact.modules) {
    for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(!specifier.startsWith('node:'), `${path} must not statically import ${specifier}`);
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'),
        `${path} must not statically import bare specifier ${specifier}`);
    }
  }
  assert.ok(paths.has('src/support/default-crypto.js'), 'the crypto owner is shipped');
  assert.ok(paths.has('src/support/crypto-provider.js'), 'the provider validator is shipped');
  assert.ok(!paths.has('src/support/node-crypto-provider.js'), 'the NODE provider is NOT shipped');
  assert.ok(!paths.has('src/runtime.js'), 'the Node composition root is NOT shipped');
});

test('SINGLE OWNER: exactly one module defines the artifact format and the portable closure', () => {
  // This failure mode actually happened: a second artifact implementation appeared under a
  // different directory, giving the shipping closure and the structural proof independent
  // definitions. The property protected here is "exactly one owner", not a folder name.
  const sourceFiles = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.js')) sourceFiles.push(full);
    }
  };
  walk(join(REPO, 'src'));

  const declaresFormat = sourceFiles.filter((file) =>
    readFileSync(file, 'utf8').includes("'lagrange-images-portable-runtime/v1'"));
  assert.deepEqual(
    declaresFormat.map((file) => file.replace(`${REPO}/`, '')),
    ['src/portable-artifact/portable-runtime-artifact.js'],
    'exactly one module may declare the artifact format',
  );

  const declaresClosure = sourceFiles.filter((file) =>
    /function collectStaticModuleClosure|function walkPortableClosure/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(
    declaresClosure.map((file) => file.replace(`${REPO}/`, '')),
    ['src/portable-artifact/module-closure.js'],
    'exactly one module may define the portable static closure',
  );

  // Both consumers of the closure must reach that one definition.
  assert.match(
    readFileSync(join(REPO, 'src/portable-artifact/portable-runtime-artifact.js'), 'utf8'),
    /from '\.\/module-closure\.js'/,
    'the artifact producer consumes the one closure owner',
  );
  assert.match(
    readFileSync(join(REPO, 'test/portable-runtime.test.js'), 'utf8'),
    /from '\.\.\/src\/portable-artifact\/module-closure\.js'/,
    'the structural portability proof consumes the SAME closure owner',
  );
});

test('VALIDATOR: rejects a wrong or missing format', () => {
  const artifact = buildFromRepo();
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, format: 'lagrange-images-portable-runtime/v2'}),
    /artifact format must be/);
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, format: undefined}), /artifact format must be/);
  assert.throws(() => assertPortableRuntimeArtifactV1(null), /artifact must be an object/);
  assert.throws(() => assertPortableRuntimeArtifactV1([]), /artifact must be an object/);
});

test('VALIDATOR: rejects a missing entry, or an entry absent from modules', () => {
  const artifact = buildFromRepo();
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, entry: undefined}),
    /entry is not a canonical logical path/);
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, entry: 'src/not-shipped.js'}),
    /entry is not present in artifact modules/);
});

test('VALIDATOR: rejects duplicate, non-canonical, absolute and escaping module paths', () => {
  const artifact = buildFromRepo();
  const [first] = artifact.modules;
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, modules: [first, ...artifact.modules]}),
    /canonical logical-path order|duplicate artifact module path/);
  for (const badPath of ['/etc/passwd', '../outside.js', 'src/../../escape.js', 'src\\win.js', 'C:/x.js', 'other/x.js']) {
    assert.throws(() => assertPortableRuntimeArtifactV1({
      ...artifact, modules: [{path: badPath, source: ''}, ...artifact.modules],
    }), /canonical logical path|canonical logical-path order/, `must reject ${badPath}`);
  }
});

test('VALIDATOR: rejects a non-string module source and a malformed module entry', () => {
  const artifact = buildFromRepo();
  const rest = artifact.modules.slice(1);
  assert.throws(() => assertPortableRuntimeArtifactV1({
    ...artifact, modules: [{path: artifact.modules[0].path, source: 42}, ...rest],
  }), /module source must be a string/);
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, modules: [null, ...rest]}),
    /every artifact module must be an object/);
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, modules: []}),
    /modules must be a non-empty array/);
});

test('FALSIFIER: deleting one required module makes validation red', () => {
  const artifact = buildFromRepo();
  const victim = 'src/support/default-crypto.js';
  assert.ok(artifact.modules.some(({path}) => path === victim));
  assert.throws(
    () => assertPortableRuntimeArtifactV1({
      ...artifact, modules: artifact.modules.filter(({path}) => path !== victim),
    }),
    /closure reaches a module the artifact does not contain|unresolved/,
    'a missing closure member must be rejected by Images, not discovered by a consumer loader',
  );
});

test('FALSIFIER: altering one import target makes closure validation red', () => {
  const artifact = buildFromRepo();
  const readSource = mapReader(artifact, (map) => {
    map.set(PORTABLE_RUNTIME_ARTIFACT_ENTRY, map.get(PORTABLE_RUNTIME_ARTIFACT_ENTRY)
      .replace("'./support/default-crypto.js'", "'./support/does-not-exist.js'"));
  });
  assert.throws(() => buildPortableRuntimeArtifact({readSource}), /unresolved/);
});

test('FALSIFIER: injecting node:crypto makes the portable closure red', () => {
  const artifact = buildFromRepo();
  const readSource = mapReader(artifact, (map) => {
    map.set(PORTABLE_RUNTIME_ARTIFACT_ENTRY,
      `import {randomUUID} from 'node:crypto';\n${map.get(PORTABLE_RUNTIME_ARTIFACT_ENTRY)}`);
  });
  assert.throws(() => buildPortableRuntimeArtifact({readSource}), /node-builtin/);
});

test('FALSIFIER: an unexpected bare static import makes the closure red', () => {
  const artifact = buildFromRepo();
  const readSource = mapReader(artifact, (map) => {
    map.set(PORTABLE_RUNTIME_ARTIFACT_ENTRY,
      `import lodash from 'lodash';\n${map.get(PORTABLE_RUNTIME_ARTIFACT_ENTRY)}`);
  });
  assert.throws(() => buildPortableRuntimeArtifact({readSource}), /bare/);
});

test('FALSIFIER: a dependency escaping the artifact source root makes the closure red', () => {
  // Rejected AS an escape, not incidentally caught by some other rule.
  const artifact = buildFromRepo();
  const readSource = mapReader(artifact, (map) => {
    map.set(PORTABLE_RUNTIME_ARTIFACT_ENTRY,
      `import '../scripts/integration-env.sh';\n${map.get(PORTABLE_RUNTIME_ARTIFACT_ENTRY)}`);
  });
  assert.throws(() => buildPortableRuntimeArtifact({readSource}), /escape/);
});

test('VALIDATOR: rejects an artifact carrying modules outside its declared closure', () => {
  const artifact = buildFromRepo();
  const padded = {
    ...artifact,
    modules: [...artifact.modules, {path: 'src/zzz-not-in-closure.js', source: 'export const x = 1;\n'}]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
  assert.throws(() => assertPortableRuntimeArtifactV1(padded), /outside the declared closure/);
});

test('PROVENANCE: a non-object provenance is rejected', () => {
  const artifact = buildFromRepo();
  assert.throws(() => assertPortableRuntimeArtifactV1({...artifact, provenance: 'abc123'}),
    /provenance, when present, must be an object/);
});
