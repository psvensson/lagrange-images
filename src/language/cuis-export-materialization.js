import {SHAPE_INDEXED} from '../object/model.js';
import {objectRef} from '../value/index.js';
import {defineClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';

// Cuis semantic export — Stage 2 materialization (Bead lagrange-images-i3f; ADR 0072 §6 + ADR 0067).
//
// This module turns ONE canonical smalltalk/cuis-semantic-export-v1 manifest (produced by the
// OpenSmalltalk/Cuis toolchain provider, which owns ONLY the extraction seam) into ordinary Lagrange
// image objects through the SHIPPED authorized atomic creation batch (image-creation-batch-binding/v1,
// ADR 0067). No new lane, no new authority, no Cuis-specific privileged insertion path.
//
// REPRESENTATION MODEL (Peter-confirmed, narrowing the design): three language-owned representation
// Behavior classes — CuisExportPackage / CuisExportClass / CuisExportMethod — are the ADR 0067
// creation/schema boundary. An INSTANCE of CuisExportClass REPRESENTS a Cuis class; it is NOT the
// executable Lagrange Class for that Cuis class, and we never create one Behavior per exported Cuis
// class. These classes are behaviorally boring (no methods; defineClass installs empty method
// dictionaries). They live here, in the Cuis/Smalltalk compatibility personality — NOT in the generic
// image layer, which keeps knowing only Shape/Object/Value/ref/history.
//
// IDENTITY: the cuis-package/... / cuis-class/... / cuis-method/... strings are durable SEMANTIC
// identity carried as ordinary string DATA in slots. ObjectRefs are server-minted by the batch and are
// never derived from a semantic identity. Cuis-Base is never materialized as a package or class: a
// base superclass/target keeps the reserved cuis-class/Cuis-Base/<name> identity STRING in a slot and
// leaves the relationship edge EMPTY (we do not manufacture an ObjectRef for a base class).
//
// OWNERSHIP (docs/ownership.md): the image-creation-batch binding executor owns manifest->objects;
// this module is the Cuis-adapter's pure translator + the representation-class schema installer that
// feed that lane. The toolchain does not create image objects.

// The three representation Behavior class names (deliberately explicit, so nobody mistakes an instance
// for the Cuis entity it describes). defineClass gives each the deterministic id smalltalk/class/<name>.
const CUIS_EXPORT_PACKAGE_CLASS_NAME = 'CuisExportPackage';
const CUIS_EXPORT_CLASS_CLASS_NAME = 'CuisExportClass';
const CUIS_EXPORT_METHOD_CLASS_NAME = 'CuisExportMethod';

const CUIS_SEMANTIC_EXPORT_V1 = 'smalltalk/cuis-semantic-export-v1';
// The reserved package name for base-image classes. It is never materialized as a package object.
const CUIS_BASE_PACKAGE_NAME = 'Cuis-Base';
// The empty superclass identity for a class with no superclass (e.g. ProtoObject). ADR 0072 keeps this
// null; we store it as the empty string in the text slot (a text slot has no null distinct from '').
const CUIS_BASE_SUPERCLASS_NULL = '';

// The deterministic Shape ids for the three representation layouts. Shapes are immutable; these ids are
// stable so re-installation is ensure-exact-or-create (idempotent), not a fresh shape each run.
const CUIS_EXPORT_PACKAGE_SHAPE_ID = 'cuis-export/package-shape/v1';
const CUIS_EXPORT_CLASS_SHAPE_ID = 'cuis-export/class-shape/v1';
const CUIS_EXPORT_METHOD_SHAPE_ID = 'cuis-export/method-shape/v1';

// The member-record union type field names. RESERVED (consumed by the batch, never stored): `class`
// (the member's class id) and `name` (the batch-local local name). Every OTHER field maps to a slot or
// an indexed edge. Shared STRING slots are mapped by ALL THREE classes (so a member whose class does
// not use a given string simply leaves it as '' — and because every class maps it, the batch lane's
// fail-closed "unmapped field" check never rejects a string). The relationship/list fields are
// class-specific INDEXED list<string> fields, whose codec zero ([]) is the one the fail-closed check
// tolerates for a class that does not map them (the shipped presentations pattern).
//
// The ADR 0067 lane allows AT MOST ONE indexed field per class (image-creation-binding.js:98). So the
// ALWAYS-present relationship (the owning package, which is always materialized) is a SCALAR SLOT EDGE
// (edge:true on a slot, holding a local:<pkgIdentity> string resolved to the minted ObjectRef — the
// lane resolves slot-edge local: refs exactly like indexed ones, image-creation-batch-binding.js:342-388),
// and the OPTIONAL base/exported relationship (superclass / target class) is the single INDEXED edge
// (0 or 1 elements: empty for a base class, [local:<identity>] for an exported one). Every edge field
// is union-typed 'string' (a ref target can only arrive as text; the lane canonicalizes it host-side).
const MEMBER_UNION_FIELDS = Object.freeze([
  {name: 'class', type: 'string'},
  {name: 'name', type: 'string'},
  // Shared string slots (mapped by all three representation classes).
  {name: 'semanticidentity', type: 'string'},
  {name: 'entityname', type: 'string'},
  {name: 'superclassidentity', type: 'string'},
  {name: 'targetclassidentity', type: 'string'},
  {name: 'side', type: 'string'},
  {name: 'selector', type: 'string'},
  {name: 'source', type: 'string'},
  // The always-present owning-package relationship: a scalar slot edge (string holding local:<pkg>).
  {name: 'packageref', type: 'string'},
  // Class-specific indexed list<string> fields ([] for classes that do not map them).
  {name: 'requirements', type: {kind: 'list', element: 'string'}},
  {name: 'superclassref', type: {kind: 'list', element: 'string'}},
  {name: 'targetclassref', type: {kind: 'list', element: 'string'}},
]);

// The shared plain (non-edge) string-slot field mappings, identical for all three classes. Slot ids
// are stable. `packageref` is NOT shared: its `edge` flag differs per class (below), and the edge flag
// lives on the per-class mapping entry, never in the union type — so this per-class split is legal.
const SHARED_STRING_FIELDS = Object.freeze([
  {name: 'semanticidentity', slot: 'slot-semanticidentity'},
  {name: 'entityname', slot: 'slot-entityname'},
  {name: 'superclassidentity', slot: 'slot-superclassidentity'},
  {name: 'targetclassidentity', slot: 'slot-targetclassidentity'},
  {name: 'side', slot: 'slot-side'},
  {name: 'selector', slot: 'slot-selector'},
  {name: 'source', slot: 'slot-source'},
]);

// Per-class field maps for the ADR 0067 binding (AT MOST ONE indexed field per class).
// - Package: `packageref` is a NON-edge plain string slot (a Package has no owning package, so the slot
//   holds a harmless '' text Value — the edge:false branch never parses it as a ref). Its single
//   indexed field is `requirements` (a NON-edge list of cuis-package/<name> identity strings).
// - Class: `packageref` is a scalar slot EDGE (always the exported owning package, local: -> minted
//   ref) + single indexed edge `superclassref` (0 or 1: empty for a base superclass, [local:] for an
//   exported one).
// - Method: `packageref` is a scalar slot EDGE (always the exported owning package, local:) + single
//   indexed edge `targetclassref` (0 or 1: empty for a base target — e.g. ByteArray>>unzipped
//   targeting cuis-class/Cuis-Base/ByteArray — [local:] for an exported target).
// (Keys are the representation classes' deterministic object ids — the batch member `class` field and
// the binding fields map are both keyed by objectId, not the bare class name.)
const CUIS_EXPORT_FIELDS = Object.freeze({
  [representationClassObjectId(CUIS_EXPORT_PACKAGE_CLASS_NAME)]: Object.freeze([
    ...SHARED_STRING_FIELDS,
    {name: 'packageref', slot: 'slot-packageref'},
    {name: 'requirements', indexed: true},
  ]),
  [representationClassObjectId(CUIS_EXPORT_CLASS_CLASS_NAME)]: Object.freeze([
    ...SHARED_STRING_FIELDS,
    {name: 'packageref', slot: 'slot-packageref', edge: true},
    {name: 'superclassref', indexed: true, edge: true},
  ]),
  [representationClassObjectId(CUIS_EXPORT_METHOD_CLASS_NAME)]: Object.freeze([
    ...SHARED_STRING_FIELDS,
    {name: 'packageref', slot: 'slot-packageref', edge: true},
    {name: 'targetclassref', indexed: true, edge: true},
  ]),
});

// The Shape slot declarations shared by all three representation layouts. `slot-packageref` holds the
// owning-package ref Value for Class/Method; for Package it holds a harmless '' text Value (a Package
// has no owning package).
const SHARED_SHAPE_SLOTS = Object.freeze([
  {id: 'slot-semanticidentity', name: 'semanticIdentity'},
  {id: 'slot-entityname', name: 'entityName'},
  {id: 'slot-superclassidentity', name: 'superclassIdentity'},
  {id: 'slot-targetclassidentity', name: 'targetClassIdentity'},
  {id: 'slot-side', name: 'side'},
  {id: 'slot-selector', name: 'selector'},
  {id: 'slot-source', name: 'source'},
  {id: 'slot-packageref', name: 'packageRef'},
]);

// Install (ensure-exact-or-create) the three representation Behavior classes and their instance
// Shapes. This is a SEPARATE prerequisite schema step: the classes are infrastructure, installed once
// and idempotently (defineClass and ensureSmalltalkShape are both ensure-exact-or-create: an exact
// existing record is reused, a differing one is a conflict, an absent one is created); the
// all-or-none atomicity that matters is the manifest instance graph, not this schema. Returns the
// class refs + shape refs the caller needs to authorize object/create and to build the binding.
async function ensureCuisExportSchema({images, imageId} = {}) {
  // ensureSmalltalkShape is get-then-put with a layout-projection conflict check: re-running the
  // schema install (a retry after a lost acknowledgement, or a second materialization into a reused
  // image) reuses the existing Shapes instead of failing putShape's expectedVersion:0.
  const desired = (id) => ({id, slots: [...SHARED_SHAPE_SLOTS], indexed: SHAPE_INDEXED.VALUES});
  const packageShapeRef = await ensureSmalltalkShape(images, imageId, desired(CUIS_EXPORT_PACKAGE_SHAPE_ID));
  const classShapeRef = await ensureSmalltalkShape(images, imageId, desired(CUIS_EXPORT_CLASS_SHAPE_ID));
  const methodShapeRef = await ensureSmalltalkShape(images, imageId, desired(CUIS_EXPORT_METHOD_SHAPE_ID));
  const {classRef: packageClassRef} = await defineClass({
    images, imageId, name: CUIS_EXPORT_PACKAGE_CLASS_NAME, instanceShapeRef: packageShapeRef,
  });
  const {classRef: classClassRef} = await defineClass({
    images, imageId, name: CUIS_EXPORT_CLASS_CLASS_NAME, instanceShapeRef: classShapeRef,
  });
  const {classRef: methodClassRef} = await defineClass({
    images, imageId, name: CUIS_EXPORT_METHOD_CLASS_NAME, instanceShapeRef: methodShapeRef,
  });
  return Object.freeze({
    packageClassRef,
    classClassRef,
    methodClassRef,
    packageShape: {id: packageShapeRef.objectId},
    classShape: {id: classShapeRef.objectId},
    methodShape: {id: methodShapeRef.objectId},
  });
}

// --- the pure, deterministic translator ---------------------------------------------------------------

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError(`manifest must be a ${CUIS_SEMANTIC_EXPORT_V1} object`);
  }
  if (manifest.format !== CUIS_SEMANTIC_EXPORT_V1) {
    throw new TypeError(`manifest format must be ${CUIS_SEMANTIC_EXPORT_V1}, got ${manifest.format ?? 'missing'}`);
  }
  for (const key of ['packages', 'classes', 'methods']) {
    if (!Array.isArray(manifest[key])) {
      throw new TypeError(`manifest ${key} must be an array`);
    }
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function packageIdentity(packageName) {
  return `cuis-package/${packageName}`;
}

// The deterministic object id defineClass gives each representation Behavior class. The batch member's
// `class` field and the binding's fields map are both keyed by this objectId (not the bare class name).
function representationClassObjectId(className) {
  return `smalltalk/class/${className}`;
}

function isBaseClassIdentity(classIdentity) {
  return typeof classIdentity === 'string' && classIdentity.startsWith(`cuis-class/${CUIS_BASE_PACKAGE_NAME}/`);
}

// The set of class identities that THIS manifest materializes (i.e. exported, non-base classes). A
// superclass/target that is NOT in this set is a base/foreign class: keep its reserved identity string
// and leave the relationship edge empty (no recursive export, no manufactured base object).
function materializedClassIdentities(manifest) {
  const set = new Set();
  for (const cls of manifest.classes) {
    const identity = requiredText(cls.identity, 'class identity');
    if (!isBaseClassIdentity(identity)) set.add(identity);
  }
  return set;
}

// Translate one canonical manifest into the ADR 0067 member list. PURE and DETERMINISTIC: it consumes
// the manifest AS GIVEN (already canonical — the toolchain canonicalizes + sorts it) and emits members
// in a fixed order (packages, then classes, then methods), preserving the manifest's own order within
// each kind. It re-sorts nothing (a locale-dependent comparator would diverge from the byte-identical
// manifest guarantee). Local names are the FULL semantic identity strings (batch-local syntax; they
// never leak); method local names use the full target-class identity, never the manifest's simple
// className, so cross-package same-simple-name extension methods cannot collide.
//
// Returns {members, unionFields, fieldsByClass} — the member list to pack + the binding metadata the
// caller installs once. `members` is deeply frozen: the translator is a pure function and a later
// mutation must not leak between calls.
function manifestToBatchMembers(manifest) {
  assertManifest(manifest);
  const exportedClassIds = materializedClassIdentities(manifest);

  // A relationship edge: [local:<identity>] when the target is materialized in this batch, else [].
  // (We always use local: refs for intra-batch edges; the batch mints the durable ObjectRef.)
  const edgeTo = (identity, isMaterialized) => (isMaterialized ? [`local:${identity}`] : []);

  const members = [];

  // Packages. Cuis-Base is never materialized as a package.
  for (const pkg of manifest.packages) {
    const name = requiredText(pkg.name, 'package name');
    if (name === CUIS_BASE_PACKAGE_NAME) continue;
    if (!Array.isArray(pkg.requires)) throw new TypeError(`package ${name} requires must be an array`);
    members.push({
      class: representationClassObjectId(CUIS_EXPORT_PACKAGE_CLASS_NAME),
      name: packageIdentity(name),
      semanticidentity: packageIdentity(name),
      entityname: name,
      superclassidentity: CUIS_BASE_SUPERCLASS_NULL,
      targetclassidentity: '',
      side: '',
      selector: '',
      source: '',
      requirements: pkg.requires.map((r) => packageIdentity(requiredText(r, `package ${name} requirement`))),
      packageref: '',
      superclassref: [],
      targetclassref: [],
    });
  }

  // Classes (exported, non-base). The package relationship is a local ref to the exported package.
  for (const cls of manifest.classes) {
    const identity = requiredText(cls.identity, 'class identity');
    if (isBaseClassIdentity(identity)) continue;
    const packageName = requiredText(cls.package, `class ${identity} package`);
    const name = requiredText(cls.name, `class ${identity} name`);
    // superclass: null (ProtoObject) -> empty identity + empty edge; a base superclass -> reserved
    // identity string + empty edge; an exported superclass -> its identity + a local edge ref.
    const superclassIdentity = cls.superclass === null || cls.superclass === undefined
      ? CUIS_BASE_SUPERCLASS_NULL
      : requiredText(cls.superclass, `class ${identity} superclass`);
    const superclassIsExported = superclassIdentity !== CUIS_BASE_SUPERCLASS_NULL && exportedClassIds.has(superclassIdentity);
    members.push({
      class: representationClassObjectId(CUIS_EXPORT_CLASS_CLASS_NAME),
      name: identity,
      semanticidentity: identity,
      entityname: name,
      superclassidentity: superclassIdentity,
      targetclassidentity: '',
      side: '',
      selector: '',
      source: '',
      requirements: [],
      packageref: `local:${packageIdentity(packageName)}`,
      superclassref: edgeTo(superclassIdentity, superclassIsExported),
      targetclassref: [],
    });
  }

  // Methods. Owning package is always a local ref to the exported package. Target class: an exported
  // target -> local edge ref; a base target -> reserved identity string + empty edge (the
  // ByteArray>>unzipped case: owned by Compression, targeting cuis-class/Cuis-Base/ByteArray).
  for (const method of manifest.methods) {
    const identity = requiredText(method.identity, 'method identity');
    const packageName = requiredText(method.package, `method ${identity} package`);
    const targetClassIdentity = requiredText(method.class, `method ${identity} class`);
    const targetIsExported = exportedClassIds.has(targetClassIdentity);
    members.push({
      class: representationClassObjectId(CUIS_EXPORT_METHOD_CLASS_NAME),
      // Local name from the FULL target-class identity (not the manifest's simple className), so two
      // extension methods on same-named classes in different packages cannot collide.
      name: `cuis-method/${packageName}/${targetClassIdentity.slice('cuis-class/'.length)}/${requiredText(method.side, `method ${identity} side`)}/${requiredText(method.selector, `method ${identity} selector`)}`,
      semanticidentity: identity,
      entityname: '',
      superclassidentity: '',
      targetclassidentity: targetClassIdentity,
      side: requiredText(method.side, `method ${identity} side`),
      selector: requiredText(method.selector, `method ${identity} selector`),
      source: typeof method.source === 'string' ? method.source : '',
      requirements: [],
      packageref: `local:${packageIdentity(packageName)}`,
      superclassref: [],
      targetclassref: edgeTo(targetClassIdentity, targetIsExported),
    });
  }

  // Reject duplicate local names here too (the lane also checks, but a clear translator error beats a
  // lane error for a malformed manifest).
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.name)) {
      throw new TypeError(`duplicate local name derived from manifest: ${member.name}`);
    }
    seen.add(member.name);
  }

  return deepFreeze({
    members,
    unionFields: MEMBER_UNION_FIELDS,
    fieldsByClass: CUIS_EXPORT_FIELDS,
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export {
  CUIS_BASE_PACKAGE_NAME,
  CUIS_BASE_SUPERCLASS_NULL,
  CUIS_EXPORT_CLASS_CLASS_NAME,
  CUIS_EXPORT_CLASS_SHAPE_ID,
  CUIS_EXPORT_FIELDS,
  CUIS_EXPORT_METHOD_CLASS_NAME,
  CUIS_EXPORT_METHOD_SHAPE_ID,
  CUIS_EXPORT_PACKAGE_CLASS_NAME,
  CUIS_EXPORT_PACKAGE_SHAPE_ID,
  MEMBER_UNION_FIELDS,
  ensureCuisExportSchema,
  manifestToBatchMembers,
};
