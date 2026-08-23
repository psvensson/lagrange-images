import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function text(path) {
  return readFile(join(ROOT, path), 'utf8');
}

function tableRows(section) {
  return section
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

test('repository pins Beads and preserves project-owned agent instructions', async () => {
  const pkg = JSON.parse(await text('package.json'));
  assert.equal(pkg.devDependencies['@beads/bd'], '1.2.2');
  assert.match(pkg.scripts['beads:init'], /^bd init /);
  assert.match(pkg.scripts['beads:init'], /--skip-agents/);
  assert.equal(pkg.scripts['beads:prime'], 'bd prime');
  assert.equal(pkg.scripts['beads:ready'], 'bd ready --json');

  const agents = await text('AGENTS.md');
  assert.match(agents, /docs\/domain-agent-rules\.md/);
  assert.match(agents, /Every subsystem or major responsibility has exactly one architectural owner/);
  assert.match(agents, /Every interaction between subsystems also has exactly one architectural owner/);
  assert.match(agents, /The arrow has one owner/);
  assert.match(agents, /bd remember/);
  assert.match(agents, /Falsification/);

  const domain = await text('docs/domain-agent-rules.md');
  assert.match(domain, /Keep this repository small and semantic\./);
  assert.match(domain, /shape != behavior/);
  assert.match(domain, /Authority is execution context, never program data/);
  assert.match(domain, /ADR status is a claim, and it is checked/);
});

test('single-owner registry covers major subsystems and interactions without ambiguous owners', async () => {
  const ownership = await text('docs/ownership.md');
  const subsystems = ownership.split('## Subsystem owners')[1]?.split('## Interaction owners')[0];
  const interactions = ownership.split('## Interaction owners')[1]?.split('## Ownership change protocol')[0];
  assert.ok(subsystems, 'missing subsystem ownership table');
  assert.ok(interactions, 'missing interaction ownership table');

  const subsystemRows = tableRows(subsystems);
  const interactionRows = tableRows(interactions);
  assert.ok(subsystemRows.length >= 15, `expected mature subsystem map, got ${subsystemRows.length}`);
  assert.ok(interactionRows.length >= 12, `expected mature interaction map, got ${interactionRows.length}`);

  for (const [responsibility, owner] of subsystemRows) {
    assert.ok(responsibility, 'subsystem responsibility must be named');
    assert.ok(owner, `${responsibility}: owner must be named`);
    assert.doesNotMatch(owner, /\b(shared|co-owned|both sides|multiple owners)\b/i, `${responsibility}: ambiguous owner`);
  }

  for (const [interaction, owner] of interactionRows) {
    assert.ok(interaction, 'interaction must be named');
    assert.ok(owner, `${interaction}: interaction owner must be named`);
    assert.doesNotMatch(owner, /\b(shared|co-owned|both sides|multiple owners)\b/i, `${interaction}: ambiguous interaction owner`);
  }

  assert.match(ownership, /Lagrange Object Environment -> Lagrange Images/);
  assert.match(ownership, /`ImageClientAdapter` in `lagrange-object-environment`/);
});

test('provider-independent governance ADR is indexed and points at this proof', async () => {
  const index = await text('docs/decisions/README.md');
  const adr = await text('docs/decisions/0059-provider-independent-agent-governance.md');
  assert.match(index, /0059 — provider-independent agent governance/);
  assert.match(adr, /^Status: implemented/m);
  assert.match(adr, /^Proven by: test\/agent-governance\.test\.js$/m);
});
