import {VALUE_KIND} from './kinds.js';

// ADR 0052 decision 5b: the runtime owns a reserved REF namespace.
//
// Object ids are otherwise arbitrary non-empty text, and every record kind shares one per-image
// collection keyed by that id, so nothing else distinguishes a transient closure instance from a
// durable record. This module is that distinction, and it is deliberately generic runtime
// infrastructure rather than anything Symmetric Smalltalk owns: a language-specific carve-out in the
// object store would be the layering mistake ADR 0044 decision 9 avoids elsewhere.
//
// The prefix is chosen to be decidable without any I/O — that is the whole point, since a per-
// resolution existence check would put durable reads back into the path this exists to keep free.
const TRANSIENT_ID_PREFIX = '~runtime/transient/';

function transientObjectId(suffix) {
  if (typeof suffix !== 'string' || suffix.length === 0) {
    throw new TypeError('transient object id suffix must be non-empty text');
  }
  return `${TRANSIENT_ID_PREFIX}${suffix}`;
}

function isTransientObjectId(objectId) {
  return typeof objectId === 'string' && objectId.startsWith(TRANSIENT_ID_PREFIX);
}

// Both REF and PINNED_REF, because a pinned handle to a transient instance would persist exactly the
// same dangling identity.
function isTransientRef(value) {
  return Boolean(value)
    && typeof value === 'object'
    && (value.kind === VALUE_KIND.REF || value.kind === VALUE_KIND.PINNED_REF)
    && isTransientObjectId(value.objectId);
}

// A structural walk rather than a per-record-kind field list. Record kinds differ in where they
// carry refs — slots, indexed parts, bindings, code, environment, dependencies, metadata — and an
// enumeration would silently miss whichever field a future kind adds, which is precisely the
// "write path nobody thought of" this guard exists to catch.
function findTransientRefs(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const entry of value) findTransientRefs(entry, found);
    return found;
  }
  if (isTransientRef(value)) {
    found.push(value);
    return found;
  }
  for (const entry of Object.values(value)) findTransientRefs(entry, found);
  return found;
}

export {
  TRANSIENT_ID_PREFIX,
  findTransientRefs,
  isTransientObjectId,
  isTransientRef,
  transientObjectId,
};
