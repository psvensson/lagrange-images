import {canonicalRecordJson} from '../graph/ensure-records.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {VALUE_KIND, isObjectRef, objectRef, textValue} from '../value/index.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {ensureNamedClass} from './smalltalk-class-builder.js';
import {KERNEL_CLASSES, ensureObject, ensureShape, findSmalltalkKernel, isLocalRef} from './smalltalk-kernel.js';

// ADR 0057: the durable namespace, and the first-class bindings it maps to.
//
// Three things are kept apart throughout, and most of this module exists to keep them apart:
//
//   name              a Text key in the mapping below
//   binding identity  a GlobalBinding object, stable across rename and rebinding
//   current value     what that binding holds right now
//
// The binding deliberately does not carry its own name — that is what lets renaming preserve
// identity — and it answers `value` and nothing else. A compiled method necessarily holds the
// binding ref in order to *read* the global, so an ordinary setter would make every reader a
// writer: reference is not authority (ADR 0057 decision 2). Rebinding happens through the trusted
// operations here.
const SMALLTALK_GLOBAL_NAMESPACE_V1 = 'smalltalk-global-namespace/v1';
const NAMESPACE_OBJECT_ID = 'smalltalk-global-namespace/v1';
// ADR 0002: Shapes are immutable, and a structural change creates a new shape identity. ADR 0061
// adds the parent slot, so the namespace Shape is v2 — never a mutation of v1. v1 is kept as a
// constant so a namespace record written before 0061 still validates (dual-read) and is migrated
// to v2 the first time its mapping is rewritten.
const NAMESPACE_SHAPE_ID_V1 = 'smalltalk/global-namespace-shape/v1';
const NAMESPACE_SHAPE_ID = 'smalltalk/global-namespace-shape/v2';
const NAMESPACE_PARENT_SLOT = 'namespace-parent';
const GLOBAL_BINDING_SHAPE_ID = 'smalltalk/global-binding-shape/v1';
const GLOBAL_BINDING_VALUE_SLOT = 'global-binding-value';
const GLOBAL_BINDING_CLASS_ID = 'smalltalk/class/GlobalBinding';

// Core installers choose stable, readable ids. The *generic* service never derives one — see
// `publish`, which requires the caller to supply it.
const globalBindingId = (name) => `smalltalk/global-binding/${name}`;

class SmalltalkNamespaceError extends TypeError {
  constructor(imageId, detail) {
    super(`Symmetric Smalltalk global namespace in ${imageId} is corrupt: ${detail}`);
    this.name = 'SmalltalkNamespaceError';
    this.imageId = imageId;
  }
}

class SmalltalkGlobalConflictError extends TypeError {
  constructor(name, detail) {
    super(`global ${name} ${detail}`);
    this.name = 'SmalltalkGlobalConflictError';
    this.globalName = name;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// The mapping is an indexed part rather than named Shape slots. A Shape's identity is its layout, so
// slots would turn every publication, rename and removal into a structural migration of the
// namespace object; an indexed part lets the mapping mutate while the Shape stays fixed.
//
// Canonical order — sorted by name — so two images that published the same globals in different
// orders hold the same record, and so a rewrite is a diff rather than a reshuffle.
function encodePairs(entries) {
  const indexed = [];
  for (const [name, binding] of [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    indexed.push(textValue(name), binding);
  }
  return indexed;
}

function decodePairs(imageId, indexed) {
  if (!Array.isArray(indexed)) throw new SmalltalkNamespaceError(imageId, 'the mapping is not an indexed part');
  if (indexed.length % 2 !== 0) {
    throw new SmalltalkNamespaceError(imageId, `the mapping has an odd number of entries (${indexed.length})`);
  }
  const entries = new Map();
  let previousName = null;
  for (let index = 0; index < indexed.length; index += 2) {
    const name = indexed[index];
    const binding = indexed[index + 1];
    if (name?.kind !== VALUE_KIND.TEXT || name.value.length === 0) {
      throw new SmalltalkNamespaceError(imageId, `entry ${index / 2} has a non-Text name`);
    }
    if (!isLocalRef(binding, imageId)) {
      throw new SmalltalkNamespaceError(imageId, `entry ${name.value} must map to an unpinned local ref`);
    }
    if (entries.has(name.value)) throw new SmalltalkNamespaceError(imageId, `duplicate name ${name.value}`);
    // The representation is *promised* canonical, so an out-of-order mapping is corrupt rather than
    // something to quietly normalise on the next write. Accepting it would mean two images holding
    // the same globals could hold different records, which is the property canonical order exists
    // to rule out.
    if (previousName !== null && previousName >= name.value) {
      throw new SmalltalkNamespaceError(imageId, `entries are not in canonical order: ${previousName} before ${name.value}`);
    }
    previousName = name.value;
    entries.set(name.value, binding);
  }
  return entries;
}

async function assertIsBinding({images, imageId, name, binding}) {
  const record = await images.getObject(binding.imageId, binding.objectId);
  if (!record) throw new SmalltalkNamespaceError(imageId, `${name} maps to a missing object`);
  if (!isLocalRef(record.shape, imageId, GLOBAL_BINDING_SHAPE_ID)) {
    throw new SmalltalkNamespaceError(imageId, `${name} maps to an object that is not a GlobalBinding`);
  }
  if (!isLocalRef(record.behavior, imageId, GLOBAL_BINDING_CLASS_ID)) {
    throw new SmalltalkNamespaceError(imageId, `${name} maps to an object whose behavior is not GlobalBinding`);
  }
  return record;
}

// Installs the binding class, its read protocol, and an empty namespace. Needs only the kernel and
// the instance-variable protocol — deliberately not `Association`, allocation or equality, so a
// binding can exist before the classes it will name.
async function installSmalltalkGlobalNamespace({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  const bindingShape = await ensureShape(images, imageId, {
    id: GLOBAL_BINDING_SHAPE_ID,
    slots: [{id: GLOBAL_BINDING_VALUE_SLOT, name: 'value'}],
  });
  const {classRef} = await ensureNamedClass({
    images, imageId, name: 'GlobalBinding', instanceShapeRef: objectRef(imageId, bindingShape.id),
  });
  // `value` and nothing else. There is no `value:`, by decision: see the header.
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef, methods: [{selector: 'value', source: '[ value ]'}],
  });

  // ADR 0061: one slot, the optional parent edge. This is the v2 Shape — v1 had no slots. The slot
  // is always present in a v2 namespace object — `putObject` enforces exact slot-set match — so
  // "no parent" is a nil Value here, never an omitted slot. The root is the parentless namespace.
  const namespaceShape = await ensureShape(images, imageId, {
    id: NAMESPACE_SHAPE_ID,
    slots: [{id: NAMESPACE_PARENT_SLOT, name: 'parent'}],
    indexed: SHAPE_INDEXED.VALUES,
  });
  // Created empty, but *not* ensured against an empty mapping: the mapping has its own lifecycle
  // once anything is published, exactly as a binding's value does. Ensuring exactness here would
  // make re-running the installer conflict with every global published since — the same mistake as
  // resetting a rebound value on republication.
  const existingNamespace = await images.getObject(imageId, NAMESPACE_OBJECT_ID);
  if (!existingNamespace) {
    await images.putObject(imageId, {
      id: NAMESPACE_OBJECT_ID,
      shape: objectRef(imageId, namespaceShape.id),
      behavior: null,
      slots: {[NAMESPACE_PARENT_SLOT]: kernel.nil},
      indexed: [],
      metadata: {protocol: SMALLTALK_GLOBAL_NAMESPACE_V1},
    }, {expectedVersion: 0});
  } else {
    // Present already: it must still be a real namespace, so a squatter is refused rather than
    // adopted.
    await findSmalltalkGlobalNamespace({images, imageId});
  }

  // The kernel classes are published here because they already exist and this installer is the
  // first thing that can name anything. Everything else is published deliberately by whoever
  // installs it — publication is an operation, never a side effect of creating a class.
  for (const {name} of KERNEL_CLASSES) {
    await publishGlobal({
      images, imageId, name, bindingId: globalBindingId(name),
      value: objectRef(imageId, `smalltalk/class/${name}`),
    });
  }

  return Object.freeze({
    protocol: SMALLTALK_GLOBAL_NAMESPACE_V1,
    ref: objectRef(imageId, NAMESPACE_OBJECT_ID),
    bindingClass: classRef,
  });
}

// An explicit publication step for classes a protocol installer created. Deliberately a separate
// call rather than something `ensureNamedClass` does: a class may exist and remain unnameable, which
// is what keeps a future private or project namespace possible (ADR 0057 decision 1).
async function publishSmalltalkClassGlobals({images, imageId, names} = {}) {
  requiredText(imageId, 'image id');
  if (!Array.isArray(names) || names.length === 0) throw new TypeError('names must be a non-empty array');
  const published = {};
  for (const name of names) {
    const classId = `smalltalk/class/${name}`;
    if (!await images.getObject(imageId, classId)) {
      throw new TypeError(`image ${imageId} has no class ${name} to publish`);
    }
    published[name] = await publishGlobal({
      images, imageId, name, bindingId: globalBindingId(name), value: objectRef(imageId, classId),
    });
  }
  return Object.freeze(published);
}

// ADR 0061: the parent edge. A namespace object stores it in the `namespace-parent` slot: the
// kernel nil for the root, a ref to another namespace otherwise. Reading it is tolerant of the
// pre-0061 root, which was written with `slots: {}` before the Shape grew the slot — absence reads
// as no parent, and the first rewrite carries the slot forward. `nilRef` is the kernel nil, the
// only value besides a namespace ref the slot may hold.
function namespaceParentRef(imageId, record, nilRef) {
  const parent = record.slots?.[NAMESPACE_PARENT_SLOT];
  if (parent === undefined || parent === null) return null;
  if (!isLocalRef(parent, imageId)) {
    throw new SmalltalkNamespaceError(imageId, `the parent slot holds a non-local value, not a namespace ref or nil`);
  }
  // The kernel nil means "no parent"; any other local ref names the parent namespace.
  if (nilRef && parent.objectId === nilRef.objectId) return null;
  return parent;
}

// Generalized finder (ADR 0061). `findSmalltalkGlobalNamespace` is the root special case; this one
// reads any namespace by id. Absent stays distinct from corrupt, as with every other discoverable
// protocol here: an image without the object simply has no such namespace, while a damaged one is
// an explicit failure.
async function findNamespace({images, imageId, namespaceId = NAMESPACE_OBJECT_ID} = {}) {
  requiredText(imageId, 'namespace image id');
  requiredText(namespaceId, 'namespace id');
  const record = await images.getObject(imageId, namespaceId);
  if (!record) return null;
  if (record.metadata?.protocol !== SMALLTALK_GLOBAL_NAMESPACE_V1) {
    throw new SmalltalkNamespaceError(imageId, `${namespaceId} does not declare ${SMALLTALK_GLOBAL_NAMESPACE_V1}`);
  }
  // Dual-read: a namespace written before ADR 0061 has the v1 (slotless) Shape; a nested one or a
  // migrated root has v2. Both are namespaces; only v2 can carry a parent edge.
  const isNamespaceShape = isLocalRef(record.shape, imageId, NAMESPACE_SHAPE_ID)
    || isLocalRef(record.shape, imageId, NAMESPACE_SHAPE_ID_V1);
  if (!isNamespaceShape) {
    throw new SmalltalkNamespaceError(imageId, `${namespaceId} does not have a namespace Shape`);
  }
  const entries = decodePairs(imageId, record.indexed);
  for (const [name, binding] of entries) {
    await assertIsBinding({images, imageId, name, binding});
  }
  // The kernel nil is the only non-namespace value the parent slot may hold; look it up to read the
  // edge. An image with a namespace always has a kernel (the installer needs one), so this is safe.
  const kernel = await findSmalltalkKernel({images, imageId});
  return Object.freeze({
    protocol: SMALLTALK_GLOBAL_NAMESPACE_V1,
    record,
    entries,
    parent: namespaceParentRef(imageId, record, kernel?.nil ?? null),
  });
}

// Absent stays distinct from corrupt, as with every other discoverable protocol here: an image
// without a namespace simply has no globals, while a damaged one is an explicit failure.
async function findSmalltalkGlobalNamespace({images, imageId} = {}) {
  return await findNamespace({images, imageId, namespaceId: NAMESPACE_OBJECT_ID});
}

async function requireNamespace({images, imageId, namespaceId = NAMESPACE_OBJECT_ID}) {
  const namespace = await findNamespace({images, imageId, namespaceId});
  if (!namespace) {
    throw new TypeError(`image ${imageId} has no global namespace ${namespaceId}; install it first`);
  }
  return namespace;
}

async function writeMapping({images, imageId, namespace, entries}) {
  // Writes this namespace's own id and preserves its slots — critically the parent edge. Writing
  // `slots: {}` would erase the parent on every publish/rename/remove in a nested namespace. A
  // record still on the v1 (slotless) Shape is MIGRATED to v2 here: it gains the parent slot (nil,
  // since a v1 record is the root and the root is parentless) and the v2 Shape ref, so ADR 0002's
  // immutability is honored — v1 is never mutated, the object just moves to the new Shape.
  const kernel = await findSmalltalkKernel({images, imageId});
  const onV1 = isLocalRef(namespace.record.shape, imageId, NAMESPACE_SHAPE_ID_V1);
  const slots = onV1
    ? {[NAMESPACE_PARENT_SLOT]: kernel.nil}
    : (namespace.record.slots && Object.hasOwn(namespace.record.slots, NAMESPACE_PARENT_SLOT)
      ? namespace.record.slots
      : {[NAMESPACE_PARENT_SLOT]: kernel.nil});
  await images.putObject(imageId, {
    id: namespace.record.id,
    shape: onV1 ? objectRef(imageId, NAMESPACE_SHAPE_ID) : namespace.record.shape,
    behavior: namespace.record.behavior,
    slots,
    indexed: encodePairs(entries),
    metadata: namespace.record.metadata,
  }, {expectedVersion: namespace.record._version});
}

// The trusted management seam. None of this is Smalltalk protocol.
//
// `publish` is retry-safe in the way an installer needs: a binding that already exists keeps the
// value it has. Re-running an installer must not undo a legitimate rebind — the current value has
// its own lifecycle now, and only `rebind` is allowed to change it.
async function publishGlobal({images, imageId, name, bindingId, value, namespaceId = NAMESPACE_OBJECT_ID}) {
  requiredText(name, 'global name');
  requiredText(bindingId, 'global binding id');
  const namespace = await requireNamespace({images, imageId, namespaceId});

  // Preflight, before anything is created. Checking the mapping only after minting the candidate
  // would leave an orphan GlobalBinding behind on every rejected publication.
  const mapped = namespace.entries.get(name);
  if (mapped) {
    if (mapped.objectId !== bindingId) {
      throw new SmalltalkGlobalConflictError(name, `is already bound to ${mapped.objectId}, not ${bindingId}`);
    }
    await assertIsBinding({images, imageId, name, binding: mapped});
    return objectRef(imageId, bindingId);
  }

  const existingBinding = await images.getObject(imageId, bindingId);
  if (!existingBinding) {
    await images.putObject(imageId, {
      id: bindingId,
      shape: objectRef(imageId, GLOBAL_BINDING_SHAPE_ID),
      behavior: objectRef(imageId, GLOBAL_BINDING_CLASS_ID),
      slots: {[GLOBAL_BINDING_VALUE_SLOT]: value},
      metadata: {},
    }, {expectedVersion: 0});
  } else {
    // Already there — keep the value it has. Re-running an installer must not undo a rebind.
    await assertIsBinding({images, imageId, name, binding: objectRef(imageId, bindingId)});
  }

  const entries = new Map(namespace.entries);
  entries.set(name, objectRef(imageId, bindingId));
  await writeMapping({images, imageId, namespace, entries});
  return objectRef(imageId, bindingId);
}

async function resolveGlobal({images, imageId, name, namespaceId = NAMESPACE_OBJECT_ID}) {
  const namespace = await findNamespace({images, imageId, namespaceId});
  return namespace?.entries.get(name) ?? null;
}

// Changes the value on a stable identity. Already-compiled code observes it because it holds the
// binding, not the value.
async function rebindGlobal({images, imageId, bindingId, value}) {
  requiredText(bindingId, 'global binding id');
  const record = await images.getObject(imageId, bindingId);
  if (!record) throw new TypeError(`no global binding ${imageId}/${bindingId}`);
  await assertIsBinding({images, imageId, name: bindingId, binding: objectRef(imageId, bindingId)});
  const current = record.slots?.[GLOBAL_BINDING_VALUE_SLOT];
  if (canonicalRecordJson(current) === canonicalRecordJson(value)) return objectRef(imageId, bindingId);
  await images.putObject(imageId, {
    id: bindingId,
    shape: record.shape,
    behavior: record.behavior,
    slots: {[GLOBAL_BINDING_VALUE_SLOT]: value},
    metadata: record.metadata,
  }, {expectedVersion: record._version});
  return objectRef(imageId, bindingId);
}

// The same binding under a new name: identity survives, so compiled code is unaffected. The caller
// must name the identity it believes it is moving. That makes retry convergence part of the one API
// contract rather than an optional stronger mode: after a lost acknowledgement, the retry succeeds
// only when that same identity is already at the destination.
async function renameGlobal({images, imageId, from, to, bindingId, namespaceId = NAMESPACE_OBJECT_ID}) {
  requiredText(from, 'global name');
  requiredText(to, 'global name');
  requiredText(bindingId, 'global binding id');
  const namespace = await requireNamespace({images, imageId, namespaceId});
  const binding = namespace.entries.get(from);
  const target = namespace.entries.get(to);

  if (!binding) {
    if (target && target.objectId === bindingId) return target;
    if (target) {
      throw new SmalltalkGlobalConflictError(to, `is bound to ${target.objectId}, not ${bindingId}`);
    }
    throw new SmalltalkGlobalConflictError(from, 'is not published');
  }
  if (binding.objectId !== bindingId) {
    throw new SmalltalkGlobalConflictError(from, `is bound to ${binding.objectId}, not ${bindingId}`);
  }
  if (target && target.objectId !== bindingId) {
    throw new SmalltalkGlobalConflictError(to, `is already bound to ${target.objectId}`);
  }
  // The desired mapping already exists to the expected binding: an ensure-style no-op.
  if (target && from === to) return binding;
  const entries = new Map(namespace.entries);
  entries.delete(from);
  entries.set(to, binding);
  await writeMapping({images, imageId, namespace, entries});
  return binding;
}

// Withdraws a *name*, but only for the identity the caller names. The binding object stays, so code
// already holding it keeps working. Identity is required for the same ABA reason as rename: if a
// removal commits, its acknowledgement is lost, and another actor republishes the same spelling to a
// different binding, the original retry must conflict rather than delete the new binding.
async function removeGlobal({images, imageId, name, bindingId, namespaceId = NAMESPACE_OBJECT_ID}) {
  requiredText(name, 'global name');
  requiredText(bindingId, 'global binding id');
  const namespace = await requireNamespace({images, imageId, namespaceId});
  const mapped = namespace.entries.get(name);
  if (!mapped) return false;
  if (mapped.objectId !== bindingId) {
    throw new SmalltalkGlobalConflictError(name, `is bound to ${mapped.objectId}, not ${bindingId}`);
  }
  const entries = new Map(namespace.entries);
  entries.delete(name);
  await writeMapping({images, imageId, namespace, entries});
  return true;
}

// ADR 0061: create a nested namespace. Same Shape and protocol as the root, at a caller-chosen id,
// with a parent edge (defaulting to the root). Exact-or-create: re-creating the same namespace with
// the same parent is a no-op; a conflict on id or parent is loud. The parent must exist and be a
// namespace. A fresh node cannot already be on a cycle, so the only self-cycle to refuse is
// parent === self.
async function createNamespace({images, imageId, namespaceId, parent = NAMESPACE_OBJECT_ID}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'namespace id');
  requiredText(parent, 'parent namespace id');
  if (namespaceId === parent) {
    throw new SmalltalkNamespaceError(imageId, `a namespace cannot be its own parent: ${namespaceId}`);
  }
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const existing = await images.getObject(imageId, namespaceId);
  if (existing) {
    // Converge on a retry: it must be the same namespace with the same parent.
    const found = await findNamespace({images, imageId, namespaceId});
    const foundParent = found.parent?.objectId ?? null;
    if (foundParent !== parent) {
      throw new SmalltalkGlobalConflictError(
        namespaceId,
        `already exists with parent ${foundParent ?? 'none'}, not ${parent}`,
      );
    }
    return objectRef(imageId, namespaceId);
  }
  // The parent must be a real namespace; this also validates the root exists for a default parent.
  await requireNamespace({images, imageId, namespaceId: parent});
  await images.putObject(imageId, {
    id: namespaceId,
    shape: objectRef(imageId, NAMESPACE_SHAPE_ID),
    behavior: null,
    slots: {[NAMESPACE_PARENT_SLOT]: objectRef(imageId, parent)},
    indexed: [],
    metadata: {protocol: SMALLTALK_GLOBAL_NAMESPACE_V1},
  }, {expectedVersion: 0});
  return objectRef(imageId, namespaceId);
}

// ADR 0061: (re)set a namespace's parent. Refuses to close a cycle: walking the proposed parent's
// chain to the root must not pass through this namespace. Identity-scoped by CAS on the record
// version, like the mapping writes.
async function setNamespaceParent({images, imageId, namespaceId, parent}) {
  requiredText(imageId, 'image id');
  requiredText(namespaceId, 'namespace id');
  requiredText(parent, 'parent namespace id');
  if (namespaceId === parent) {
    throw new SmalltalkNamespaceError(imageId, `a namespace cannot be its own parent: ${namespaceId}`);
  }
  const namespace = await requireNamespace({images, imageId, namespaceId});
  // The proposed parent must be a namespace, and reaching the root from it must not pass through
  // this namespace — that is the cycle.
  const visited = new Set();
  let cursor = parent;
  for (;;) {
    if (cursor === namespaceId) {
      throw new SmalltalkNamespaceError(
        imageId,
        `setting the parent of ${namespaceId} to ${parent} would close a cycle`,
      );
    }
    if (visited.has(cursor)) {
      throw new SmalltalkNamespaceError(imageId, `the proposed parent chain already has a cycle at ${cursor}`);
    }
    visited.add(cursor);
    const ancestor = await findNamespace({images, imageId, namespaceId: cursor});
    if (!ancestor) throw new SmalltalkNamespaceError(imageId, `the proposed parent ${cursor} is not a namespace`);
    if (!ancestor.parent) break;
    cursor = ancestor.parent.objectId;
  }
  // Gaining or changing a parent edge requires the v2 Shape (v1 has no parent slot): migrate a v1
  // record as part of the same write, honoring ADR 0002 immutability.
  const onV1 = isLocalRef(namespace.record.shape, imageId, NAMESPACE_SHAPE_ID_V1);
  const slots = {
    ...(onV1 ? {} : (namespace.record.slots ?? {})),
    [NAMESPACE_PARENT_SLOT]: objectRef(imageId, parent),
  };
  await images.putObject(imageId, {
    id: namespace.record.id,
    shape: onV1 ? objectRef(imageId, NAMESPACE_SHAPE_ID) : namespace.record.shape,
    behavior: namespace.record.behavior,
    slots,
    indexed: namespace.record.indexed,
    metadata: namespace.record.metadata,
  }, {expectedVersion: namespace.record._version});
  return objectRef(imageId, namespaceId);
}

// Name -> binding id, for the compiler. Transient: it is read per compilation and never stored.
//
// ADR 0061: resolution walks the parent chain from `namespaceId` outward to the root, and a nearer
// namespace's name shadows a farther one's (inner-wins). The walk is the compile-time lookup the
// ADR describes; the artifact the compiler produces still carries only binding ids, never a path.
// The chain is acyclic by construction (the management seam refuses a cycle-closing parent), but
// the walk defends itself anyway: a corrupted cycle is a namespace error, never a silent loop.
async function globalDeclarations({images, imageId, namespaceId = NAMESPACE_OBJECT_ID}) {
  const merged = new Map();
  const visited = new Set();
  let currentId = namespaceId;
  // Walk outward, recording which names are already claimed by a nearer namespace. First writer
  // wins, so a child name is never overwritten by its parent's.
  for (;;) {
    if (visited.has(currentId)) {
      throw new SmalltalkNamespaceError(imageId, `the namespace parent chain has a cycle at ${currentId}`);
    }
    visited.add(currentId);
    const namespace = await findNamespace({images, imageId, namespaceId: currentId});
    if (!namespace) {
      // A missing namespace is only legal as the caller's own starting point being absent — an
      // image with no globals at all. A parent that points nowhere is a dangling edge = corrupt.
      if (currentId === namespaceId && currentId === NAMESPACE_OBJECT_ID) return {};
      throw new SmalltalkNamespaceError(imageId, `the namespace ${currentId} named in a parent chain does not exist`);
    }
    for (const [name, binding] of namespace.entries) {
      if (!merged.has(name)) merged.set(name, binding.objectId);
    }
    if (!namespace.parent) return Object.fromEntries(merged);
    currentId = namespace.parent.objectId;
  }
}

export {
  GLOBAL_BINDING_CLASS_ID,
  GLOBAL_BINDING_SHAPE_ID,
  GLOBAL_BINDING_VALUE_SLOT,
  NAMESPACE_OBJECT_ID,
  NAMESPACE_PARENT_SLOT,
  NAMESPACE_SHAPE_ID,
  NAMESPACE_SHAPE_ID_V1,
  SMALLTALK_GLOBAL_NAMESPACE_V1,
  SmalltalkGlobalConflictError,
  SmalltalkNamespaceError,
  createNamespace,
  findNamespace,
  findSmalltalkGlobalNamespace,
  globalBindingId,
  globalDeclarations,
  installSmalltalkGlobalNamespace,
  publishGlobal,
  publishSmalltalkClassGlobals,
  rebindGlobal,
  removeGlobal,
  renameGlobal,
  resolveGlobal,
  setNamespaceParent,
};