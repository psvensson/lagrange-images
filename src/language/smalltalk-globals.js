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
const NAMESPACE_SHAPE_ID = 'smalltalk/global-namespace-shape/v1';
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

  const namespaceShape = await ensureShape(images, imageId, {
    id: NAMESPACE_SHAPE_ID,
    slots: [],
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
      slots: {},
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

// Absent stays distinct from corrupt, as with every other discoverable protocol here: an image
// without a namespace simply has no globals, while a damaged one is an explicit failure.
async function findSmalltalkGlobalNamespace({images, imageId} = {}) {
  requiredText(imageId, 'namespace image id');
  const record = await images.getObject(imageId, NAMESPACE_OBJECT_ID);
  if (!record) return null;
  if (record.metadata?.protocol !== SMALLTALK_GLOBAL_NAMESPACE_V1) {
    throw new SmalltalkNamespaceError(imageId, `object does not declare ${SMALLTALK_GLOBAL_NAMESPACE_V1}`);
  }
  if (!isLocalRef(record.shape, imageId, NAMESPACE_SHAPE_ID)) {
    throw new SmalltalkNamespaceError(imageId, `object does not have shape ${NAMESPACE_SHAPE_ID}`);
  }
  const entries = decodePairs(imageId, record.indexed);
  for (const [name, binding] of entries) {
    await assertIsBinding({images, imageId, name, binding});
  }
  return Object.freeze({protocol: SMALLTALK_GLOBAL_NAMESPACE_V1, record, entries});
}

async function requireNamespace({images, imageId}) {
  const namespace = await findSmalltalkGlobalNamespace({images, imageId});
  if (!namespace) throw new TypeError(`image ${imageId} has no global namespace; install it first`);
  return namespace;
}

async function writeMapping({images, imageId, namespace, entries}) {
  await images.putObject(imageId, {
    id: NAMESPACE_OBJECT_ID,
    shape: namespace.record.shape,
    behavior: namespace.record.behavior,
    slots: {},
    indexed: encodePairs(entries),
    metadata: namespace.record.metadata,
  }, {expectedVersion: namespace.record._version});
}

// The trusted management seam. None of this is Smalltalk protocol.
//
// `publish` is retry-safe in the way an installer needs: a binding that already exists keeps the
// value it has. Re-running an installer must not undo a legitimate rebind — the current value has
// its own lifecycle now, and only `rebind` is allowed to change it.
async function publishGlobal({images, imageId, name, bindingId, value}) {
  requiredText(name, 'global name');
  requiredText(bindingId, 'global binding id');
  const namespace = await requireNamespace({images, imageId});

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
    await assertIsBinding({images, imageId, name, binding: objectRef(imageId, bindingId)});
  }

  const mapped = namespace.entries.get(name);
  if (mapped) {
    if (mapped.objectId === bindingId) return objectRef(imageId, bindingId);
    throw new SmalltalkGlobalConflictError(name, `is already bound to ${mapped.objectId}, not ${bindingId}`);
  }
  const entries = new Map(namespace.entries);
  entries.set(name, objectRef(imageId, bindingId));
  await writeMapping({images, imageId, namespace, entries});
  return objectRef(imageId, bindingId);
}

async function resolveGlobal({images, imageId, name}) {
  const namespace = await findSmalltalkGlobalNamespace({images, imageId});
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

// The same binding under a new name: identity survives, so compiled code is unaffected.
async function renameGlobal({images, imageId, from, to}) {
  requiredText(from, 'global name');
  requiredText(to, 'global name');
  const namespace = await requireNamespace({images, imageId});
  const binding = namespace.entries.get(from);
  if (!binding) {
    // Retry after a lost acknowledgement: the rename already landed.
    const already = namespace.entries.get(to);
    if (already) return already;
    throw new SmalltalkGlobalConflictError(from, 'is not published');
  }
  const target = namespace.entries.get(to);
  if (target && target.objectId !== binding.objectId) {
    throw new SmalltalkGlobalConflictError(to, `is already bound to ${target.objectId}`);
  }
  const entries = new Map(namespace.entries);
  entries.delete(from);
  entries.set(to, binding);
  await writeMapping({images, imageId, namespace, entries});
  return binding;
}

// Withdraws a *name*. The binding object stays, so code already holding it keeps working — removing
// a name is not removing an identity someone already has (ADR 0057 decision 6).
async function removeGlobal({images, imageId, name}) {
  requiredText(name, 'global name');
  const namespace = await requireNamespace({images, imageId});
  if (!namespace.entries.has(name)) return false;
  const entries = new Map(namespace.entries);
  entries.delete(name);
  await writeMapping({images, imageId, namespace, entries});
  return true;
}

// Name -> binding id, for the compiler. Transient: it is read per compilation and never stored.
async function globalDeclarations({images, imageId}) {
  const namespace = await findSmalltalkGlobalNamespace({images, imageId});
  if (!namespace) return {};
  return Object.fromEntries([...namespace.entries].map(([name, binding]) => [name, binding.objectId]));
}

export {
  GLOBAL_BINDING_CLASS_ID,
  GLOBAL_BINDING_SHAPE_ID,
  GLOBAL_BINDING_VALUE_SLOT,
  NAMESPACE_OBJECT_ID,
  NAMESPACE_SHAPE_ID,
  SMALLTALK_GLOBAL_NAMESPACE_V1,
  SmalltalkGlobalConflictError,
  SmalltalkNamespaceError,
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
};
