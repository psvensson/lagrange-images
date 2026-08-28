import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUIS_BASE_PACKAGE_NAME,
  CUIS_BASE_SUPERCLASS_NULL,
  manifestToBatchMembers,
} from '../src/language/cuis-export-materialization.js';

// The member `class` field carries the representation Behavior class's deterministic object id
// (smalltalk/class/<name>), keyed to the binding's fields map — not the bare class name.
const CUIS_EXPORT_PACKAGE_CLASS_NAME = 'smalltalk/class/CuisExportPackage';
const CUIS_EXPORT_CLASS_CLASS_NAME = 'smalltalk/class/CuisExportClass';
const CUIS_EXPORT_METHOD_CLASS_NAME = 'smalltalk/class/CuisExportMethod';

// Stage 2 (Bead lagrange-images-i3f, ADR 0072 §6 + ADR 0067): the manifest->batch translator is a
// PURE, DETERMINISTIC function from one canonical smalltalk/cuis-semantic-export-v1 manifest to the
// ADR 0067 member list. These tests run WITHOUT a VM. They pin: semantic identity stays string data
// (never an ObjectRef); Cuis-Base is never materialized; base superclass/target refs stay reserved
// cuis-class/Cuis-Base/<name> strings with EMPTY relationship edges; extension methods keep the
// owning-package/target-class distinction; local names are batch-local syntax derived from the FULL
// semantic identity (never the manifest's simple className, which can collide across packages).

const MANIFEST = {
  format: 'smalltalk/cuis-semantic-export-v1',
  packages: [
    {name: 'Compression', requires: []},
    {name: 'FFI', requires: ['Alien-Core', 'WeakDictionaries']},
  ],
  classes: [
    {identity: 'cuis-class/Compression/Archive', package: 'Compression', name: 'Archive', superclassName: 'Object', superclass: 'cuis-class/Cuis-Base/Object'},
    {identity: 'cuis-class/Compression/ZipMember', package: 'Compression', name: 'ZipMember', superclassName: 'Archive', superclass: 'cuis-class/Compression/Archive'},
    {identity: 'cuis-class/Compression/ProtoThing', package: 'Compression', name: 'ProtoThing', superclassName: '', superclass: null},
  ],
  methods: [
    // A normal method on a Compression-defined class.
    {identity: 'cuis-method/Compression/Archive/instance/addBytes:as:', package: 'Compression', class: 'cuis-class/Compression/Archive', side: 'instance', selector: 'addBytes:as:', source: 'addBytes: b as: n\n\t^ self'},
    // An EXTENSION method owned by Compression but TARGETING the base class ByteArray.
    {identity: 'cuis-method/Compression/ByteArray/instance/unzipped', package: 'Compression', class: 'cuis-class/Cuis-Base/ByteArray', side: 'instance', selector: 'unzipped', source: 'unzipped\n\t^ (GZipReadStream on: self) upToEnd'},
    // A class-side method.
    {identity: 'cuis-method/Compression/Archive/class/on:', package: 'Compression', class: 'cuis-class/Compression/Archive', side: 'class', selector: 'on:', source: 'on: s\n\t^ self new'},
  ],
};

test('translator emits one member per package + class + method, in deterministic order (packages, then classes, then methods)', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  // 2 packages + 3 classes + 3 methods = 8 members.
  assert.equal(members.length, 8);
  const kinds = members.map((m) => m.class);
  // Packages first (both CuisExportPackage), then classes (CuisExportClass), then methods (CuisExportMethod).
  assert.deepEqual(kinds.slice(0, 2), [CUIS_EXPORT_PACKAGE_CLASS_NAME, CUIS_EXPORT_PACKAGE_CLASS_NAME]);
  assert.deepEqual(kinds.slice(2, 5), [CUIS_EXPORT_CLASS_CLASS_NAME, CUIS_EXPORT_CLASS_CLASS_NAME, CUIS_EXPORT_CLASS_CLASS_NAME]);
  assert.deepEqual(kinds.slice(5), [CUIS_EXPORT_METHOD_CLASS_NAME, CUIS_EXPORT_METHOD_CLASS_NAME, CUIS_EXPORT_METHOD_CLASS_NAME]);
});

test('packages carry semantic identity + name + requirements (requirement identity strings), never an ObjectRef', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  const compression = members.find((m) => m.class === CUIS_EXPORT_PACKAGE_CLASS_NAME && m.entityname === 'Compression');
  assert.equal(compression.semanticidentity, 'cuis-package/Compression');
  assert.equal(compression.name, 'cuis-package/Compression', 'local name == full semantic identity');
  assert.deepEqual(compression.requirements, [], 'Compression has no requirements');
  const ffi = members.find((m) => m.class === CUIS_EXPORT_PACKAGE_CLASS_NAME && m.entityname === 'FFI');
  assert.deepEqual(ffi.requirements, ['cuis-package/Alien-Core', 'cuis-package/WeakDictionaries'], 'FFI requires as identity strings');
  // No requirement is ever a local: ref or an ObjectRef — requirements stay identity strings in v1.
  for (const pkg of members.filter((m) => m.class === CUIS_EXPORT_PACKAGE_CLASS_NAME)) {
    for (const req of pkg.requirements) {
      assert.ok(req.startsWith('cuis-package/'), `requirement is a semantic identity string: ${req}`);
      assert.ok(!req.startsWith('local:'), 'requirement is never a local ref');
    }
  }
});

test('Cuis-Base is never materialized as a package or a class', () => {
  const {members} = manifestToBatchMembers({
    ...MANIFEST,
    classes: [...MANIFEST.classes, {identity: 'cuis-class/Cuis-Base/Object', package: 'Cuis-Base', name: 'Object', superclassName: '', superclass: null}],
  });
  assert.ok(!members.some((m) => m.class === CUIS_EXPORT_PACKAGE_CLASS_NAME && m.entityname === CUIS_BASE_PACKAGE_NAME), 'no Cuis-Base package');
  assert.ok(!members.some((m) => m.class === CUIS_EXPORT_CLASS_CLASS_NAME && m.semanticidentity.startsWith('cuis-class/Cuis-Base/')), 'no Cuis-Base class materialized');
});

test('exported-to-exported superclass uses a local: edge ref; the ref points at the superclass member', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  const zipMember = members.find((m) => m.class === CUIS_EXPORT_CLASS_CLASS_NAME && m.entityname === 'ZipMember');
  assert.equal(zipMember.superclassidentity, 'cuis-class/Compression/Archive');
  assert.deepEqual(zipMember.superclassref, ['local:cuis-class/Compression/Archive'], 'superclass is a local ref to the exported Archive');
  // The local ref target must exist as a member local name.
  const localNames = new Set(members.map((m) => m.name));
  assert.ok(localNames.has('cuis-class/Compression/Archive'), 'the superclass local name resolves to a member');
});

test('a base (Cuis-Base) superclass keeps the reserved identity string and an EMPTY superclass edge', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  const archive = members.find((m) => m.class === CUIS_EXPORT_CLASS_CLASS_NAME && m.entityname === 'Archive');
  assert.equal(archive.superclassidentity, 'cuis-class/Cuis-Base/Object', 'base superclass stays the reserved identity string');
  assert.deepEqual(archive.superclassref, [], 'no manufactured ObjectRef for a base superclass');
});

test('ProtoObject (no superclass) keeps an empty superclass identity and empty edge', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  const proto = members.find((m) => m.class === CUIS_EXPORT_CLASS_CLASS_NAME && m.entityname === 'ProtoThing');
  assert.equal(proto.superclassidentity, CUIS_BASE_SUPERCLASS_NULL, 'ProtoObject superclass identity is empty (null)');
  assert.deepEqual(proto.superclassref, [], 'ProtoObject has no superclass ref');
});

test('the ByteArray>>unzipped extension-method case: owning package local-ref, target stays cuis-class/Cuis-Base/ByteArray with an EMPTY target edge', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  const unzipped = members.find((m) => m.class === CUIS_EXPORT_METHOD_CLASS_NAME && m.selector === 'unzipped');
  assert.equal(unzipped.semanticidentity, 'cuis-method/Compression/ByteArray/instance/unzipped');
  assert.equal(unzipped.packageref, 'local:cuis-package/Compression', 'owning package is a scalar slot-edge local ref to the materialized Compression package');
  assert.equal(unzipped.targetclassidentity, 'cuis-class/Cuis-Base/ByteArray', 'target stays the reserved base identity — no manufactured Compression ByteArray');
  assert.deepEqual(unzipped.targetclassref, [], 'no manufactured ObjectRef for a base target class');
  assert.equal(unzipped.side, 'instance');
  assert.equal(unzipped.source, 'unzipped\n\t^ (GZipReadStream on: self) upToEnd', 'source survives byte-for-byte');
});

test('a method on an exported class gets a local: target-class edge; class side is preserved', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  const on = members.find((m) => m.class === CUIS_EXPORT_METHOD_CLASS_NAME && m.selector === 'on:');
  assert.equal(on.side, 'class');
  assert.deepEqual(on.targetclassref, ['local:cuis-class/Compression/Archive'], 'method on an exported class refs the materialized class');
  assert.equal(on.targetclassidentity, 'cuis-class/Compression/Archive');
});

test('method local names use the FULL target-class identity, never the simple class name (avoids cross-package collisions)', () => {
  // Two packages define classes with the SAME simple name; a third package extends both. The local
  // names must not collide even though the manifest method identity uses the simple className.
  const collision = {
    format: 'smalltalk/cuis-semantic-export-v1',
    packages: [{name: 'A', requires: []}, {name: 'B', requires: []}, {name: 'Ext', requires: []}],
    classes: [
      {identity: 'cuis-class/A/Foo', package: 'A', name: 'Foo', superclassName: '', superclass: null},
      {identity: 'cuis-class/B/Foo', package: 'B', name: 'Foo', superclassName: '', superclass: null},
    ],
    methods: [
      {identity: 'cuis-method/Ext/Foo/instance/bar', package: 'Ext', class: 'cuis-class/A/Foo', side: 'instance', selector: 'bar', source: 'bar ^ 1'},
      {identity: 'cuis-method/Ext/Foo/instance/bar', package: 'Ext', class: 'cuis-class/B/Foo', side: 'instance', selector: 'bar', source: 'bar ^ 2'},
    ],
  };
  const {members} = manifestToBatchMembers(collision);
  const localNames = members.map((m) => m.name);
  assert.equal(new Set(localNames).size, localNames.length, 'no duplicate local names across colliding simple class names');
  const bars = members.filter((m) => m.class === CUIS_EXPORT_METHOD_CLASS_NAME && m.selector === 'bar');
  assert.equal(bars.length, 2);
  assert.notEqual(bars[0].name, bars[1].name, 'the two Ext>>Foo>>bar methods have distinct local names');
});

test('translator is pure and deterministic: byte-identical manifests yield identical member lists', () => {
  const a = manifestToBatchMembers(MANIFEST);
  const b = manifestToBatchMembers(MANIFEST);
  assert.deepEqual(a, b, 'same input -> identical member list');
  // Deep-frozen output: mutating the result must not affect a subsequent call's output.
  assert.throws(() => { a.members[0].entityname = 'MUTATED'; }, TypeError, 'members are frozen');
  const c = manifestToBatchMembers(MANIFEST);
  assert.equal(c.members[0].entityname, 'Compression', 'prior mutation did not leak');
});

test('malformed manifest is rejected before any batch (missing format / wrong shape)', () => {
  assert.throws(() => manifestToBatchMembers(null), /cuis-semantic-export-v1|format/);
  assert.throws(() => manifestToBatchMembers({format: 'wrong', packages: [], classes: [], methods: []}), /format/);
  assert.throws(() => manifestToBatchMembers({format: 'smalltalk/cuis-semantic-export-v1', packages: 'nope', classes: [], methods: []}), /packages/);
});

test('a class member carries the package relationship as a local ref to its exported package', () => {
  const {members} = manifestToBatchMembers(MANIFEST);
  const archive = members.find((m) => m.class === CUIS_EXPORT_CLASS_CLASS_NAME && m.entityname === 'Archive');
  assert.equal(archive.packageref, 'local:cuis-package/Compression', 'class -> owning package is a scalar slot-edge local ref');
});
