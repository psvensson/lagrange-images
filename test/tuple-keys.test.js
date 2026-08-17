import test from 'node:test';
import assert from 'node:assert/strict';
import {TupleMap, TupleSet} from '../src/support/tuple-map.js';
import {
  CodeCompilerRegistry,
  CompilationGroupCompilerRegistry,
  createAuthorityService,
  createCompilationGroup,
} from '../src/runtime.js';

const NUL = String.fromCharCode(0);
const compiler = Object.freeze({async compile() { return {}; }});

// Every collision below is built from the same shape: for any separator `s`, the parts `a + s + b`
// and `c` join to the same string as `a` and `b + s + c`. Joined keys made these pairs
// indistinguishable; tuple keys cannot.
test('TupleMap keeps colliding joined keys distinct', () => {
  const map = new TupleMap(2);
  map.set([`a${NUL}b`, 'c'], 'first');
  map.set(['a', `b${NUL}c`], 'second');
  assert.equal(map.size, 2);
  assert.equal(map.get([`a${NUL}b`, 'c']), 'first');
  assert.equal(map.get(['a', `b${NUL}c`]), 'second');
  assert.equal(map.get(['a', 'c']), undefined);
  assert.equal(map.has(['a', 'c']), false);
  assert.deepEqual([...map.keys()], [[`a${NUL}b`, 'c'], ['a', `b${NUL}c`]]);
  assert.deepEqual([...map.values()], ['first', 'second']);
});

test('TupleMap delete prunes emptied levels and keeps size honest', () => {
  const map = new TupleMap(3);
  map.set(['x', 'y', 'z'], 1);
  map.set(['x', 'y', 'w'], 2);
  assert.equal(map.delete(['x', 'y', 'z']), true);
  assert.equal(map.delete(['x', 'y', 'z']), false);
  assert.equal(map.size, 1);
  assert.equal(map.delete(['x', 'y', 'w']), true);
  assert.equal(map.size, 0);
  assert.deepEqual([...map.entries()], []);
  map.set(['x', 'y', 'z'], 3);
  assert.equal(map.get(['x', 'y', 'z']), 3);
  map.clear();
  assert.equal(map.size, 0);
});

test('TupleMap rejects keys of the wrong arity or type', () => {
  const map = new TupleMap(2);
  assert.throws(() => map.set(['only'], 1), /exactly 2 parts/);
  assert.throws(() => map.get(['a', 'b', 'c']), /exactly 2 parts/);
  assert.throws(() => map.set(['a', 7], 1), /must be strings/);
  assert.throws(() => new TupleMap(0), /positive integer/);
});

test('TupleSet keeps colliding joined keys distinct', () => {
  const set = new TupleSet(2, [[`a${NUL}b`, 'c']]);
  assert.equal(set.has([`a${NUL}b`, 'c']), true);
  assert.equal(set.has(['a', `b${NUL}c`]), false);
  set.add(['a', `b${NUL}c`]);
  assert.equal(set.size, 2);
  assert.deepEqual([...set], [[`a${NUL}b`, 'c'], ['a', `b${NUL}c`]]);
});

// The consequential one. A joined grant key made these two grants the same entry, so holding either
// satisfied a `require` for the other — a fail-open collision in the authority substrate.
test('an authority grant does not satisfy a demand for a colliding resource', () => {
  const authority = createAuthorityService();
  const context = authority.issue({
    principal: 'test',
    grants: [{operation: `object/read${NUL}x`, resource: 'y'}],
  });

  authority.require(context, {operation: `object/read${NUL}x`, resource: 'y'});
  assert.throws(
    () => authority.require(context, {operation: 'object/read', resource: `x${NUL}y`}),
    (error) => error.name === 'AuthorityError' && /not authorized/.test(error.message),
  );
});

test('attenuation cannot widen into a colliding grant', () => {
  const authority = createAuthorityService();
  const context = authority.issue({
    principal: 'test',
    grants: [{operation: `object/read${NUL}x`, resource: 'y'}],
  });

  assert.throws(
    () => authority.attenuate(context, {grants: [{operation: 'object/read', resource: `x${NUL}y`}]}),
    (error) => error.name === 'AuthorityError'
      && /attenuation may only narrow/.test(error.message)
      && error.operation === 'object/read'
      && error.resource === `x${NUL}y`,
  );

  // Narrowing to a grant actually held still works, and the error path above no longer
  // reconstructs operation and resource by splitting a joined key.
  const narrowed = authority.attenuate(context, {
    grants: [{operation: `object/read${NUL}x`, resource: 'y'}],
  });
  authority.require(narrowed, {operation: `object/read${NUL}x`, resource: 'y'});
});

test('compiler registries distinguish colliding representation pairs', () => {
  const registry = new CodeCompilerRegistry();
  registry.register(`a${NUL}b`, 'c', compiler);
  // Under a joined key this threw "compiler already registered".
  registry.register('a', `b${NUL}c`, compiler);
  assert.equal(registry.has('a', 'c'), false);
  assert.equal(registry.has(`a${NUL}b`, 'c'), true);
  assert.equal(registry.has('a', `b${NUL}c`), true);
  assert.deepEqual(registry.list(), [['a', `b${NUL}c`], [`a${NUL}b`, 'c']]);

  const groups = new CompilationGroupCompilerRegistry();
  groups.register(`p${NUL}q`, 'r', compiler);
  groups.register('p', `q${NUL}r`, compiler);
  assert.equal(groups.has('p', 'r'), false);
  assert.deepEqual(groups.list(), [['p', `q${NUL}r`], [`p${NUL}q`, 'r']]);
});

test('compilation group member deduplication distinguishes colliding refs', () => {
  const group = createCompilationGroup({
    policyId: 'test/policy',
    targetRepresentation: 'test/target',
    members: [
      {kind: 'ref', imageId: `a${NUL}b`, objectId: 'c'},
      {kind: 'ref', imageId: 'a', objectId: `b${NUL}c`},
    ],
  });
  assert.equal(group.members.length, 2);

  assert.throws(
    () => createCompilationGroup({
      policyId: 'test/policy',
      targetRepresentation: 'test/target',
      members: [
        {kind: 'ref', imageId: 'a', objectId: 'c'},
        {kind: 'ref', imageId: 'a', objectId: 'c'},
      ],
    }),
    /duplicate compilation group member/,
  );
});
