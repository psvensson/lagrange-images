import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

// The CI split is a naming convention, and a convention with no check is a convention that decays.
//
// `node-test` runs everything *except* names carrying the prefix, and `recovery-test` runs exactly
// those. So a new exhaustive sweep that forgets the prefix does not fail — it quietly joins the
// general gate and pushes it toward its ten-minute timeout, which is the failure this guards.
const PREFIX = 'exhaustive-recovery:';
const TEST_DIR = new URL('./', import.meta.url);

function testNames(source) {
  // Both spellings the suite uses: a plain string and a template literal.
  return [...source.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((match) => match[2]);
}

test('every exhaustive publication-recovery sweep carries the CI prefix', () => {
  const offenders = [];
  for (const file of readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js'))) {
    const source = readFileSync(new URL(file, TEST_DIR), 'utf8');
    for (const name of testNames(source)) {
      // The shape every sweep has: it enumerates writes and injects a failure at each one.
      const isSweep = /every write (publishing|installing)/.test(name);
      if (isSweep && !name.startsWith(PREFIX)) offenders.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    `these sweeps would run in the general gate instead of the recovery job:\n${offenders.join('\n')}`,
  );
});

test('the prefix is only used by tests the recovery job should run', () => {
  const prefixed = [];
  for (const file of readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js'))) {
    const source = readFileSync(new URL(file, TEST_DIR), 'utf8');
    for (const name of testNames(source)) {
      if (name.startsWith(PREFIX)) prefixed.push(name);
    }
  }
  // Cheap tests wearing the prefix would be excluded from the ordinary gate for no reason, which is
  // the opposite mistake and just as quiet.
  assert.ok(prefixed.length >= 6, `expected the known sweeps to be prefixed, saw ${prefixed.length}`);
  for (const name of prefixed) {
    assert.match(name, /every write (publishing|installing)/, `${name} is prefixed but is not a sweep`);
  }
});

test('the workflow runs the split scripts, and npm test still runs everything', () => {
  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(workflow, /npm run test:fast/, 'the general gate must run the fast script');
  assert.match(workflow, /npm run test:recovery/, 'the recovery job must run the recovery script');
  assert.ok(!/^\s+- run: npm test$/m.test(workflow), 'no job should run the whole suite');

  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  // A local `npm test` must still mean everything: the split is about CI budgets, not coverage.
  assert.equal(scripts.test, 'node --test');
  assert.match(scripts['test:fast'], new RegExp(`--test-skip-pattern=.${PREFIX}`));
  assert.match(scripts['test:recovery'], new RegExp(`--test-name-pattern=.${PREFIX}`));
});
