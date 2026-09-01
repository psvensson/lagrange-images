import {referencesOfRecord} from './references.js';
import {canonicalizeValue, isObjectRef, isPinnedRef, isReference, VALUE_KIND} from '../value/index.js';
import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {bytesToHex, utf8Encode} from '../support/portable-bytes.js';
import {TupleMap} from '../support/tuple-map.js';

// ADR 0074 first slice: durable graph roots -> portable graph bundle + deterministic
// contentIdentity. EXPORT ONLY.
//
// OWNERSHIP. This module is the single owner of portable graph bundle semantics
// (closure, bundle-local identity, external-ref rule, canonical form, content
// identity). It CONSUMES `referencesOfRecord` — the single owner of which graph
// edges a durable record has — and never re-implements per-kind traversal. It reads
// records through `GraphImageService` and never duplicates graph storage semantics.
// Project release semantics, import, an authorized export lane, GC/retention,
// historical reads and deployment are all separate owners and out of scope here.
//
// BUNDLE-LOCAL IDENTITY. Source ObjectRefs are used internally ONLY for fetching
// and visited/dedup bookkeeping; they never become portable internal identity.
// Local ids (r0, r1, ...) are assigned by deterministic traversal: roots in
// canonical code-unit key order, outgoing edges in canonical semantic edge order
// (the order `referencesOfRecord` yields). Source objectIds never break traversal
// ties and never appear inside roots/records internal identity data.
//
// PORTABILITY. This module imports no Node host API; it resolves the active crypto
// provider (SHA-256) and the portable-bytes owner, so it runs inside the portable
// runtime closure once a host provider is installed.

const GRAPH_BUNDLE_V1 = 'lagrange-graph-bundle/v1';

class GraphBundleExportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GraphBundleExportError';
    Object.assign(this, details);
  }
}

function fail(message, details) {
  throw new GraphBundleExportError(message, details);
}

function requiredRef(value, label) {
  const normalized = canonicalizeValue(value);
  if (!isObjectRef(normalized)) fail(`${label} must be an unpinned ObjectRef`);
  return normalized;
}

// A source ObjectRef is an internal/bookkeeping key only. Pinned refs are never
// internal closure targets (ADR 0074 §C: always external by construction).
//
// Bookkeeping keys are TUPLES, never joined strings: image ids, object ids and
// revision text are arbitrary strings, so any separator is ambiguous — ('ab','c')
// and ('a','bc') join to the same key, silently collapsing two distinct records to
// one localId (or two distinct external requirements to one externalKey) and
// corrupting aliasing/cycles. The repository's tuple-key owner (TupleMap) makes
// that mistake unavailable rather than discouraged.

// The default per-ref policy (ADR 0074 §C). `rootImageIds` is the set of Image ids
// the closure is allowed to internalize: by default exactly the Images named by the
// roots, so a cross-Image ObjectRef is external UNLESS the caller opts it in. The
// caller's `referencePolicy` may override either direction for an UNPINNED ref; a
// pinned ref is ALWAYS external and no policy may internalize it.
function defaultReferencePolicy({rootImageIds}) {
  return {
    // Return 'internal' to bundle the ref's target, 'external' to record it as an
    // unresolved requirement. Only ever called for unpinned refs.
    classify(ref) {
      return rootImageIds.has(ref.imageId) ? 'internal' : 'external';
    },
  };
}

// Canonical JSON: map keys in code-unit order, arrays in semantic order, values in
// their existing canonical form. This is the host-independent encoding the content
// identity is hashed from. No new binary codec — UTF-8 via portable-bytes, SHA-256
// via the crypto provider.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

async function exportGraphBundle({images, roots, referencePolicy, crypto} = {}) {
  if (!images || typeof images.getRecord !== 'function') fail('images must be a GraphImageService');
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) fail('roots must be a map of root key -> ObjectRef');
  const rootEntries = Object.entries(roots);
  if (rootEntries.length === 0) fail('roots must name at least one root');

  // Roots processed in canonical code-unit key order. Source refs validated and
  // used ONLY for fetching/dedup — never as portable identity.
  const sortedRoots = rootEntries
    .map(([key, ref]) => [key, requiredRef(ref, `root ${JSON.stringify(key)}`)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const policy = referencePolicy ?? defaultReferencePolicy({
    rootImageIds: new Set(sortedRoots.map(([, ref]) => ref.imageId)),
  });
  if (typeof policy.classify !== 'function') fail('referencePolicy must supply classify(ref)');

  const sourceToLocal = new TupleMap(2);        // [imageId, objectId] -> localId (visited/dedup only)
  const unpinnedExternalToKey = new TupleMap(2); // [imageId, objectId] -> externalKey (dedup only)
  const pinnedExternalToKey = new TupleMap(3);   // [imageId, objectId, revision] -> externalKey (dedup only)
  const records = {};                  // localId -> canonical portable record
  const externals = {};                // externalKey -> external descriptor
  const rootLocalIds = {};             // rootKey -> localId
  let nextLocal = 0;
  let nextExternal = 0;
  const queue = [];                    // BFS frontier of {localId, ref}

  // Classify one enumerated ref and return its portable edge token.
  function edgeToken(ref, ownerLocalId) {
    if (isPinnedRef(ref)) {
      // Pinned historical ref: ALWAYS external by construction; no policy may
      // internalize it. The exact pin is the external requirement. The dedup key is
      // the exact 3-tuple — the revision is a distinct part, so two pins whose
      // concatenations would collide stay distinct.
      const identity = [ref.imageId, ref.objectId, ref.revision];
      let externalKey = pinnedExternalToKey.get(identity);
      if (externalKey === undefined) {
        externalKey = `e${nextExternal}`;
        nextExternal += 1;
        pinnedExternalToKey.set(identity, externalKey);
        externals[externalKey] = {
          pinned: true,
          imageId: ref.imageId,
          objectId: ref.objectId,
          revision: ref.revision,
        };
      }
      return {kind: 'external-ref', externalKey};
    }
    // Unpinned ref: the caller policy decides internal vs external.
    const decision = policy.classify(ref);
    if (decision === 'internal') {
      // Look up (assigning if first encounter) the local id. The BFS drives the
      // ASSIGNMENT ORDER via referencesOfRecord; this only resolves the id.
      return {kind: 'local-ref', localId: assignLocalId(ref)};
    }
    if (decision === 'external') {
      const identity = [ref.imageId, ref.objectId];
      let externalKey = unpinnedExternalToKey.get(identity);
      if (externalKey === undefined) {
        externalKey = `e${nextExternal}`;
        nextExternal += 1;
        unpinnedExternalToKey.set(identity, externalKey);
        externals[externalKey] = {
          pinned: false,
          imageId: ref.imageId,
          objectId: ref.objectId,
        };
      }
      return {kind: 'external-ref', externalKey};
    }
    fail(`referencePolicy.classify must return 'internal' or 'external', got ${JSON.stringify(decision)}`, {ownerLocalId});
    return undefined; // unreachable
  }

  // Generic recursive projection: strip source/runtime provenance and rewrite
  // every ref Value through edgeToken. Non-ref Values are reused in their canonical
  // form. No record-kind serializer registry; one structural transform for every
  // kind. `enqueue` is called (in first-encounter order) for every INTERNAL ref so
  // the BFS discovers targets; the traversal ORDER is then driven by the edge owner
  // (see the BFS loop below), not by this projection's key order.
  function projectValue(value, ctx) {
    if (isReference(value)) {
      ctx.rewritten += 1;
      return edgeToken(value, ctx.ownerLocalId);
    }
    if (Array.isArray(value)) return value.map((entry) => projectValue(entry, ctx));
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = projectValue(value[key], ctx);
      return out;
    }
    return value ?? null;
  }

  // The semantic record fields minus source/runtime provenance (ADR 0074 §4):
  // id, imageId, _version, updatedAt, metadata are stripped. `kind` is preserved.
  // The projection only REWRITES refs and counts them; local-id ASSIGNMENT order is
  // driven separately by the BFS through referencesOfRecord (the edge owner).
  function projectRecord(record, ownerLocalId) {
    const ctx = {ownerLocalId, rewritten: 0};
    const out = {kind: record.kind};
    for (const field of Object.keys(record).sort()) {
      if (field === 'kind') continue;
      if (field === 'id' || field === 'imageId' || field === '_version'
        || field === 'updatedAt' || field === 'metadata') continue;
      out[field] = projectValue(record[field], ctx);
    }
    return {projected: out, rewritten: ctx.rewritten};
  }

  // Assign (or reuse) the local id for an unpinned internal ref, in the order the
  // caller (the BFS, driven by referencesOfRecord) presents it.
  function assignLocalId(ref) {
    const identity = [ref.imageId, ref.objectId];
    let localId = sourceToLocal.get(identity);
    if (localId === undefined) {
      localId = `r${nextLocal}`;
      nextLocal += 1;
      sourceToLocal.set(identity, localId);
    }
    return localId;
  }

  // Seed the BFS with the roots (canonical key order).
  for (const [rootKey, ref] of sortedRoots) {
    const localId = assignLocalId(ref);
    rootLocalIds[rootKey] = localId;
    queue.push({localId, ref});
  }

  // Breadth-first closure. Each record is projected exactly once (first encounter);
  // a shared target reuses its already-assigned localId; a cycle resolves to an
  // already-assigned localId, so traversal terminates.
  const projected = new Set(); // localId already projected
  while (queue.length > 0) {
    const {localId, ref} = queue.shift();
    if (projected.has(localId)) continue; // already projected (shared/cyclic)
    // Read through the graph owner. A genuinely missing required internal record is
    // an explicit export failure, never a silent omission.
    // eslint-disable-next-line no-await-in-loop
    const record = await images.getRecord(ref.imageId, ref.objectId);
    if (!record) {
      fail(`graph bundle export failed: required internal record is missing: ${ref.imageId}/${ref.objectId}`, {localId});
    }
    // TRAVERSAL ORDER IS OWNED BY THE EDGE OWNER. Discover this record's outgoing
    // edges in referencesOfRecord order and assign/enqueue internal targets in THAT
    // order — never in the projection's key order and never sorted by source ref.
    const ownedRefs = referencesOfRecord(record);
    const internalInEdgeOrder = [];
    for (const edgeRef of ownedRefs) {
      if (isPinnedRef(edgeRef)) continue; // pinned refs are external; not traversed
      if (policy.classify(edgeRef) === 'internal') {
        const targetLocalId = assignLocalId(edgeRef);
        internalInEdgeOrder.push({localId: targetLocalId, ref: edgeRef});
      }
    }
    // Executable guard: the projection must rewrite exactly the refs the edge owner
    // enumerates. A mismatch means the projection and the edge owner disagree — a
    // bug to repair in the responsible owner, not to paper over here.
    const result = projectRecord(record, localId);
    if (ownedRefs.length !== result.rewritten) {
      fail(
        `reference enumeration/projection mismatch for ${record.kind}: referencesOfRecord reports ${ownedRefs.length} refs but the projection rewrote ${result.rewritten}`,
        {localId, kind: record.kind},
      );
    }
    records[localId] = result.projected;
    projected.add(localId);
    // Enqueue internal targets in edge-owner order for breadth-first discovery.
    for (const target of internalInEdgeOrder) queue.push(target);
  }

  const bundle = {
    format: GRAPH_BUNDLE_V1,
    roots: rootLocalIds,
    records,
    externals,
  };

  // contentIdentity: SHA-256 over the canonical bundle form, via the active crypto
  // provider and portable-bytes. Source refs/provenance/frontiers/metadata are
  // already excluded by the projection. The bundle does not contain its own
  // contentIdentity, so the hash is well-founded.
  const activeCrypto = crypto ?? getDefaultCryptoProvider();
  const contentIdentity = `sha256:${bytesToHex(activeCrypto.sha256(utf8Encode(canonicalJson(bundle))))}`;

  return {bundle, contentIdentity};
}

export {
  GRAPH_BUNDLE_V1,
  GraphBundleExportError,
  defaultReferencePolicy,
  exportGraphBundle,
};
