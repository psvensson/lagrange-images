import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDefaultCodeExecutorRegistry} from '../src/execution/executor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECISIONS = join(ROOT, 'docs', 'decisions');
const STATUS_TOKENS = ['proposed', 'accepted', 'implemented', 'superseded'];

async function adrFiles() {
  const entries = await readdir(DECISIONS);
  return entries.filter((name) => /^\d{4}-.+\.md$/.test(name)).sort();
}

// An ADR that overstates its status turns a missing feature into a false belief for the
// next agent to read it, which is more expensive than no documentation at all.
test('every ADR declares a status from the fixed vocabulary', async () => {
  const files = await adrFiles();
  assert.ok(files.length > 0, 'expected ADRs in docs/decisions');

  for (const file of files) {
    const lines = (await readFile(join(DECISIONS, file), 'utf8')).split('\n');
    const status = lines[2];
    assert.ok(
      status?.startsWith('Status: '),
      `${file}: line 3 must be a "Status: ..." line, got ${JSON.stringify(status)}`,
    );
    const token = status.slice('Status: '.length).split(/[\s.—]/)[0];
    assert.ok(
      STATUS_TOKENS.includes(token),
      `${file}: status must start with one of ${STATUS_TOKENS.join(', ')}, got ${JSON.stringify(token)}`,
    );
    if (token === 'superseded') {
      assert.match(status, /superseded by \d{4}/, `${file}: superseded status must name the replacing ADR`);
    }
  }
});

test('an ADR claiming to be implemented cites tests that exist', async () => {
  const files = await adrFiles();
  for (const file of files) {
    const content = await readFile(join(DECISIONS, file), 'utf8');
    const lines = content.split('\n');
    if (!lines[2].startsWith('Status: implemented')) {
      assert.ok(
        !lines[3]?.startsWith('Proven by:'),
        `${file}: only an implemented ADR may claim "Proven by:"`,
      );
      continue;
    }
    const provenBy = lines[3];
    assert.ok(
      provenBy?.startsWith('Proven by: '),
      `${file}: an implemented ADR must follow its status with a "Proven by:" line`,
    );
    const paths = provenBy.slice('Proven by: '.length).split(',').map((entry) => entry.trim());
    assert.ok(paths.length > 0, `${file}: "Proven by:" must list at least one test`);
    for (const path of paths) {
      assert.ok(
        existsSync(join(ROOT, path)),
        `${file}: cites ${path}, which does not exist`,
      );
    }
  }
});

// docs/seams.md exists so agents stop guessing installer and executor names. It is only
// worth having if it cannot silently fall behind the registry it describes.
test('docs/seams.md lists exactly the executable representations the registry serves', async () => {
  const seams = await readFile(join(ROOT, 'docs', 'seams.md'), 'utf8');
  const section = seams.split('## Executable representations')[1]?.split('\n## ')[0];
  assert.ok(section, 'docs/seams.md must have an "## Executable representations" section');
  const documented = new Set(
    [...section.matchAll(/^\| `([^`]+)` \|/gm)].map(([, representation]) => representation),
  );

  const registry = createDefaultCodeExecutorRegistry({
    foreignRuntimeDefinitions: {start() {}},
    foreignRuntimes: {call() {}},
    foreignRuntimeDefinitionBindings: {resolve() {}},
  });
  const registered = new Set(registry.executors.keys());
  assert.ok(registered.size > 0, 'expected the default registry to register representations');

  for (const representation of registered) {
    assert.ok(
      documented.has(representation),
      `docs/seams.md does not document executable representation ${representation}`,
    );
  }
  for (const representation of documented) {
    if (!registered.has(representation)) {
      assert.fail(`docs/seams.md documents ${representation} as executable, but nothing registers it`);
    }
  }
});
