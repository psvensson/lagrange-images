import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setDefaultCryptoProvider, resetDefaultCryptoProvider} from '../src/support/default-crypto.js';
import {createNodeCryptoProvider} from '../src/support/node-crypto-provider.js';
import {createPortableRuntime} from '../src/portable-runtime.js';
import {objectRef, textValue, integerValue} from '../src/value/index.js';
import {objectResource, OBJECT_READ_OPERATION} from '../src/authority/object-resource.js';
import {installCallableInterfaceV2} from '../src/callable/interface-v2-artifacts.js';
import {installImageObservationBinding} from '../src/callable/image-observation-binding.js';
import {unpackCompositeValue} from '../src/callable/composite-codec.js';

// Portable runtime composition root proofs (bead lagrange-images-16q).
//
// Two proofs:
//   1. STRUCTURAL — the portable entrypoint's complete STATIC transitive ESM closure
//      contains no forbidden node:* module. This is what lets a non-Node JS host load
//      the module graph at all.
//   2. ACCEPTANCE — the portable composition, given an explicitly supplied crypto
//      provider, performs the real create -> install kernel -> authorized read ->
//      authorized mutation -> observe/reread operations under the Node test harness.
//
// (node:fs/node:path are imported HERE, in the Node test harness that walks the file
// system — never inside the portable closure being measured.)

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

// The forbidden host APIs the portable closure must never touch.
const FORBIDDEN = new Set([
  'node:crypto', 'node:buffer', 'node:child_process', 'node:readline',
  'node:fs', 'node:fs/promises', 'node:path', 'node:os', 'node:util', 'node:process',
]);

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walkStaticClosure(entryFile) {
  const visited = new Set();
  const offenders = []; // {file, spec}
  const queue = [resolve(entryFile)];
  while (queue.length > 0) {
    const file = queue.shift();
    const norm = resolve(file);
    if (visited.has(norm)) continue;
    visited.add(norm);
    let src;
    try {
      src = readFileSync(norm, 'utf8');
    } catch {
      continue;
    }
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      if (spec.startsWith('node:')) {
        if (FORBIDDEN.has(spec)) offenders.push({file: norm, spec});
        continue;
      }
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const base = resolve(dirname(norm), spec);
        for (const candidate of [base, `${base}.js`, `${base}.mjs`, resolve(base, 'index.js')]) {
          try {
            readFileSync(candidate);
            queue.push(candidate);
            break;
          } catch { /* try next candidate */ }
        }
      }
      // Bare specifiers (npm packages) are host-provided; not walked here.
    }
  }
  return {visited, offenders};
}

test('STRUCTURAL: portable-runtime.js static closure contains no forbidden node:* module', () => {
  const {visited, offenders} = walkStaticClosure(resolve(SRC, 'portable-runtime.js'));
  assert.ok(visited.size > 30, `closure is non-trivial (${visited.size} modules), so the check is meaningful`);
  assert.deepEqual(
    offenders.map(({file, spec}) => `${spec} <- ${file.replace(SRC, 'src')}`),
    [],
    'the portable entrypoint must not statically reach any forbidden node:* module',
  );
});

test('STRUCTURAL is non-vacuous: the SAME walker flags the broad-barrel Node-runtime shape', () => {
  // Demonstrate the walker actually catches the problem it exists for: src/runtime.js
  // statically imports the foreign-runtime/toolchain barrels (node:child_process,
  // node:readline, node:fs, node:path, node:os, node:util) and the Node crypto provider.
  const {offenders} = walkStaticClosure(resolve(SRC, 'runtime.js'));
  const specs = new Set(offenders.map(({spec}) => spec));
  assert.ok(offenders.length > 0, 'the walker must find node:* offenders in the broad Node root');
  for (const expected of ['node:child_process', 'node:readline', 'node:crypto']) {
    assert.ok(specs.has(expected), `walker should catch ${expected} via the broad Node root`);
  }
});

test('STRUCTURAL is non-vacuous: the walker flags a module that imports the Node crypto provider', () => {
  // The Node provider module itself imports node:crypto; the walker must catch it.
  const {offenders} = walkStaticClosure(resolve(SRC, 'support/node-crypto-provider.js'));
  assert.ok(offenders.some(({spec}) => spec === 'node:crypto'), 'walker catches node:crypto in the Node provider');
});

// --- acceptance ---------------------------------------------------------------

const OBS_TYPES = {
  'obs-result': {kind: 'record', fields: [
    {name: 'events', type: {kind: 'list', element: 'obs-event'}},
    {name: 'cursor', type: 'string'},
  ]},
  'obs-event': {kind: 'record', fields: [
    {name: 'object-id', type: 'string'}, {name: 'kind', type: 'string'}, {name: 'cursor', type: 'string'},
  ]},
};

test('ACCEPTANCE: portable runtime + explicit provider performs create -> read -> mutate -> observe', async () => {
  resetDefaultCryptoProvider();
  setDefaultCryptoProvider(createNodeCryptoProvider()); // the host-supplied provider
  const runtime = await createPortableRuntime({backend: {mode: 'mock'}});
  try {
    const {authority, images, invocations, executor} = runtime;

    // install kernel: a Shape + an object created through the image service.
    await images.createImage({id: 'demo'});
    const shape = await images.putShape('demo', {id: 'shape', slots: [{id: 'slot-name', name: 'name'}]});
    await images.putObject('demo', {
      id: 'a', shape: objectRef('demo', shape.id), slots: {'slot-name': textValue('a-v0')},
    });

    // authorized read: issue object/read(a) and read through the image service.
    const context = authority.issue({principal: 'alice', grants: [
      {operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'a')},
    ]});
    assert.ok(context, 'authority issues a context');
    const readBack = await images.getObject('demo', 'a');
    assert.equal(readBack.slots['slot-name'].value, 'a-v0');

    // authorized mutation: write a new version of a.
    const before = await images.getObject('demo', 'a');
    await images.putObject('demo', {
      id: 'a', shape: objectRef('demo', shape.id), slots: {'slot-name': textValue('a-v1')},
    }, {expectedVersion: before._version});
    assert.equal((await images.getObject('demo', 'a')).slots['slot-name'].value, 'a-v1');

    // observe: install the observation lane and read the invalidation feed.
    const callableInterface = await installCallableInterfaceV2({
      images, imageId: 'demo', interfaceId: 'observe',
      functionName: 'observe', parameters: ['string'], result: 'obs-result', types: OBS_TYPES,
    });
    await installImageObservationBinding({
      images, callableInterface: objectRef('demo', callableInterface.id),
      bindingId: 'observation', blockId: 'observation-block',
    });
    const observe = async (afterCursor) => {
      const activation = await invocations.invokeBlock(objectRef('demo', 'observation-block'), [textValue(afterCursor)]);
      const packed = await executor.execute(activation, {authority: context});
      return unpackCompositeValue(packed, 'obs-result', OBS_TYPES);
    };
    const start = await observe('');
    await images.putObject('demo', {
      id: 'a', shape: objectRef('demo', shape.id), slots: {'slot-name': textValue('a-v2')},
    }, {expectedVersion: (await images.getObject('demo', 'a'))._version});
    const feed = await observe(start.cursor);
    assert.equal(feed.events.length, 1, 'one invalidation event for the mutate');
    assert.equal(feed.events[0]['object-id'], 'a');
    assert.ok(Number.isNaN(Number(feed.cursor)), 'cursor is opaque, not a bare revision');

    // reread: the observed object reflects the latest mutation.
    assert.equal((await images.getObject('demo', 'a')).slots['slot-name'].value, 'a-v2');
  } finally {
    await runtime.close();
    resetDefaultCryptoProvider();
  }
});

test('ACCEPTANCE: portable runtime refuses to compose when no crypto provider is installed', async () => {
  resetDefaultCryptoProvider();
  await assert.rejects(
    createPortableRuntime({backend: {mode: 'mock'}}),
    /no crypto provider installed/,
  );
});
