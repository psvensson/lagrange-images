import {referencesOfRecord} from './references.js';
import {canonicalizeValue, isObjectRef, isPinnedRef, isReference, objectRef, VALUE_KIND} from '../value/index.js';
import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {bytesToHex, utf8Encode} from '../support/portable-bytes.js';
import {TupleMap} from '../support/tuple-map.js';

// ADR 0074: durable graph roots <-> portable graph bundle + deterministic
// contentIdentity. EXPORT (first slice) + IMPORT (second slice).
//
// OWNERSHIP. This module is the single owner of portable graph bundle semantics
// (closure, bundle-local identity, external-ref rule, canonical form, content
// identity, bundle validation, the external-resolution contract, and bundle-local
// -> target-local identity translation). It CONSUMES `referencesOfRecord` — the
// single owner of which graph edges a durable record has — and never re-implements
// per-kind traversal. It reads records through `GraphImageService` and never
// duplicates graph storage semantics. The IMPORT direction publishes exclusively
// through `GraphImageService.createRecords` — the owner of record-model validation,
// relational validation, batch-local fresh-record visibility and the atomic
// N-records + N-history-events transaction; the importer never calls the backend,
// never appends history and never calls the per-kind single-record puts. Project
// release semantics, authority lanes, reconciliation/dedup, GC/retention,
// historical reads and deployment are all separate owners and out of scope here.
//
// BUNDLE-LOCAL IDENTITY. Source ObjectRefs are used internally ONLY for fetching
// and visited/dedup bookkeeping; they never become portable internal identity.
// Local ids (r0, r1, ...) are assigned by deterministic traversal: roots in
// canonical code-unit key order, outgoing edges in canonical semantic edge order
// (the order `referencesOfRecord` yields). Source objectIds never break traversal
// ties and never appear inside roots/records internal identity data. On import,
// bundle localIds likewise never become target identity: every target id is a
// freshly minted uuid, and the localId -> target-ref map is transient import state.
//
// PORTABILITY. This module imports no Node host API; it resolves the active crypto
// provider (SHA-256, uuid) and the portable-bytes owner, so it runs inside the
// portable runtime closure once a host provider is installed.

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

// contentIdentity: SHA-256 over the canonical bundle form, via the active crypto
// provider and portable-bytes. Source refs/provenance/frontiers/metadata are
// already excluded by the projection. The bundle does not contain its own
// contentIdentity, so the hash is well-founded. ONE owner: exporter and importer
// compute identity through this same function, so the two directions can never
// drift on what a bundle's hash means.
function contentIdentityForBundle(bundle, {crypto} = {}) {
  const activeCrypto = crypto ?? getDefaultCryptoProvider();
  return `sha256:${bytesToHex(activeCrypto.sha256(utf8Encode(canonicalJson(bundle))))}`;
}

class GraphBundleImportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GraphBundleImportError';
    Object.assign(this, details);
  }
}

function importFail(message, details) {
  throw new GraphBundleImportError(message, details);
}

// --- Bundle v1 validation: ONE owner of what a valid bundle is -------------------
// Used by the importer (pre-publication gate) and by the exporter (post-assembly
// self-check). Structural checks PLUS closure completeness: a bundle is a closed
// graph, not an arbitrary bag of records. Throws TypeError with a precise message;
// the importer converts these into GraphBundleImportError.

const LOCAL_ID_PATTERN = /^r\d+$/;
const EXTERNAL_KEY_PATTERN = /^e\d+$/;
// Source/runtime fields the exporter strips (ADR 0074 §4); they must never
// reappear at a portable record's top level.
const FORBIDDEN_RECORD_FIELDS = new Set(['id', 'imageId', '_version', 'updatedAt', 'metadata']);

function isPlainMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The canonical v1 key domain: exactly r0..r(N-1) (or e0..e(M-1)), contiguous and
// complete — no gaps, no aliases, no foreign keys.
function assertCanonicalKeyDomain(keys, pattern, prefix, label) {
  const indices = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || !pattern.test(key)) {
      throw new TypeError(`${label} key is not in the canonical ${prefix}<n> domain: ${JSON.stringify(key)}`);
    }
    indices.add(Number(key.slice(1)));
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (!indices.has(index)) {
      throw new TypeError(`${label} keys are not the contiguous canonical domain ${prefix}0..${prefix}${keys.length - 1}`);
    }
  }
}

// Strict generic walk over portable material. Every local-ref/external-ref token
// is validated and handed to `visit`; a raw durable ObjectRef/pinned-ref Value
// (kind 'ref'/'pinned-ref') is a source-identity smuggling attempt and rejected.
// No record-kind switch — one structural transform.
function forEachPortableToken(value, visit, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => forEachPortableToken(entry, visit, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    if (value.kind === 'local-ref') {
      const keys = Object.keys(value);
      if (keys.length !== 2 || typeof value.localId !== 'string' || !LOCAL_ID_PATTERN.test(value.localId)) {
        throw new TypeError(`malformed local-ref token at ${path}`);
      }
      visit(value);
      return;
    }
    if (value.kind === 'external-ref') {
      const keys = Object.keys(value);
      if (keys.length !== 2 || typeof value.externalKey !== 'string' || !EXTERNAL_KEY_PATTERN.test(value.externalKey)) {
        throw new TypeError(`malformed external-ref token at ${path}`);
      }
      visit(value);
      return;
    }
    if (value.kind === VALUE_KIND.REF || value.kind === VALUE_KIND.PINNED_REF) {
      throw new TypeError(`raw source ${value.kind} smuggled into portable material at ${path}`);
    }
    for (const key of Object.keys(value)) forEachPortableToken(value[key], visit, `${path}.${key}`);
  }
}

// Validate the ENTIRE bundle: exact format, plain maps, canonical key domains,
// root/local-ref/external-ref referential integrity, descriptor shapes, no
// smuggled source refs, no source/runtime fields, and closure completeness (every
// record reachable from a root; every external descriptor actually referenced).
function assertGraphBundleV1(bundle) {
  if (!isPlainMap(bundle)) throw new TypeError('graph bundle must be a plain object');
  if (bundle.format !== GRAPH_BUNDLE_V1) {
    throw new TypeError(`unsupported graph bundle format: ${JSON.stringify(bundle.format)}`);
  }
  const {roots, records, externals} = bundle;
  if (!isPlainMap(roots)) throw new TypeError('graph bundle roots must be a plain map');
  if (!isPlainMap(records)) throw new TypeError('graph bundle records must be a plain map');
  if (!isPlainMap(externals)) throw new TypeError('graph bundle externals must be a plain map');
  const rootKeys = Object.keys(roots);
  if (rootKeys.length === 0) throw new TypeError('graph bundle must name at least one root');

  assertCanonicalKeyDomain(Object.keys(records), LOCAL_ID_PATTERN, 'r', 'records');
  assertCanonicalKeyDomain(Object.keys(externals), EXTERNAL_KEY_PATTERN, 'e', 'externals');

  for (const rootKey of rootKeys) {
    const localId = roots[rootKey];
    if (typeof localId !== 'string' || !Object.hasOwn(records, localId)) {
      throw new TypeError(`root ${JSON.stringify(rootKey)} names an unknown localId: ${JSON.stringify(localId)}`);
    }
  }

  for (const [externalKey, descriptor] of Object.entries(externals)) {
    if (!isPlainMap(descriptor)) throw new TypeError(`external descriptor ${externalKey} must be a plain object`);
    const keys = Object.keys(descriptor).sort();
    if (descriptor.pinned === true) {
      if (keys.join(',') !== 'imageId,objectId,pinned,revision'
        || typeof descriptor.imageId !== 'string' || typeof descriptor.objectId !== 'string'
        || typeof descriptor.revision !== 'string') {
        throw new TypeError(`pinned external descriptor ${externalKey} must be exactly {pinned:true, imageId, objectId, revision}`);
      }
    } else if (descriptor.pinned === false) {
      if (keys.join(',') !== 'imageId,objectId,pinned'
        || typeof descriptor.imageId !== 'string' || typeof descriptor.objectId !== 'string') {
        throw new TypeError(`unpinned external descriptor ${externalKey} must be exactly {pinned:false, imageId, objectId} (no revision)`);
      }
    } else {
      throw new TypeError(`external descriptor ${externalKey} must declare pinned: true|false`);
    }
  }

  for (const [localId, record] of Object.entries(records)) {
    if (!isPlainMap(record)) throw new TypeError(`record ${localId} must be a plain object`);
    if (typeof record.kind !== 'string' || record.kind.length === 0) {
      throw new TypeError(`record ${localId} must declare a non-empty kind`);
    }
    for (const field of Object.keys(record)) {
      if (FORBIDDEN_RECORD_FIELDS.has(field)) {
        throw new TypeError(`record ${localId} carries forbidden source/runtime field: ${field}`);
      }
    }
    // Referential integrity + no smuggled source refs, generically over tokens.
    forEachPortableToken(record, (token) => {
      if (token.kind === 'local-ref' && !Object.hasOwn(records, token.localId)) {
        throw new TypeError(`record ${localId} references unknown localId: ${token.localId}`);
      }
      if (token.kind === 'external-ref' && !Object.hasOwn(externals, token.externalKey)) {
        throw new TypeError(`record ${localId} references unknown externalKey: ${token.externalKey}`);
      }
    }, localId);
  }

  // Closure completeness: walk portable tokens from the root localIds. Every
  // records entry must be reachable and every external descriptor used, so hidden
  // extra material cannot hitchhike through import inside one "graph bundle".
  const reachable = new Set();
  const usedExternals = new Set();
  const queue = rootKeys.map((rootKey) => roots[rootKey]);
  while (queue.length > 0) {
    const localId = queue.shift();
    if (reachable.has(localId)) continue;
    reachable.add(localId);
    forEachPortableToken(records[localId], (token) => {
      if (token.kind === 'local-ref') queue.push(token.localId);
      else usedExternals.add(token.externalKey);
    }, localId);
  }
  for (const localId of Object.keys(records)) {
    if (!reachable.has(localId)) throw new TypeError(`unreachable record in bundle closure: ${localId}`);
  }
  for (const externalKey of Object.keys(externals)) {
    if (!usedExternals.has(externalKey)) throw new TypeError(`unused external descriptor in bundle: ${externalKey}`);
  }
  return bundle;
}

// Canonical localId order: r0, r1, ... by numeric index (the key domain is already
// validated contiguous by assertGraphBundleV1).
function orderedLocalIds(bundle) {
  return Object.keys(bundle.records).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
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

  // Post-assembly self-check through the SAME validation owner the importer gates
  // on. A correct exporter never trips it; if a future exporter change emits an
  // invalid bundle, it fails here at the source rather than at a distant import.
  assertGraphBundleV1(bundle);

  return {bundle, contentIdentity: contentIdentityForBundle(bundle, {crypto})};
}

// --- IMPORT: portable graph bundle -> fresh target-Image graph (ADR 0074 §H) -----
//
// The ownership chain: this module owns bundle validation, the external-resolution
// contract, bundle-local -> target-local identity translation and portable ref
// rewriting. `GraphImageService.createRecords` owns record-model validation,
// relational validation, batch-local fresh-record visibility and the atomic
// N-records + N-history-events transaction. The importer NEVER calls the backend,
// appends history, reproduces per-kind validation, or sequences the single-record
// puts. Its ONLY durable effect is one createRecords call.

// Generic recursive portable rewrite: local-ref -> freshly minted target ref,
// external-ref -> the explicitly bound target ref. Everything else is structurally
// preserved. This transform does not know that Block has code, Object has shape,
// etc. — createRecords owns those schemas and relationships.
function rewritePortableValue(value, targetRefs, resolvedBindings) {
  if (Array.isArray(value)) return value.map((entry) => rewritePortableValue(entry, targetRefs, resolvedBindings));
  if (value && typeof value === 'object') {
    if (value.kind === 'local-ref') return targetRefs[value.localId];
    if (value.kind === 'external-ref') return resolvedBindings[value.externalKey];
    const out = {};
    for (const key of Object.keys(value)) out[key] = rewritePortableValue(value[key], targetRefs, resolvedBindings);
    return out;
  }
  return value ?? null;
}

// Freeze the fresh preparation result recursively. The plan contains only arrays,
// plain records and canonical Values constructed by this owner; it never freezes
// caller-owned bundle or binding objects.
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

// Prepare the complete target-side graph without publishing it (ADR 0076
// Decision 4). This is the sole owner of bundle validation, content-identity
// verification, external resolution, target-id minting and portable ref
// rewriting for BOTH standalone and managed installation. The returned record
// inputs may be appended to another owner-created batch, but never reinterpreted,
// filtered, reordered or rewritten.
async function prepareGraphBundleImport({images, targetImageId, bundle, externalBindings = {}, expectedContentIdentity, crypto} = {}) {
  if (!images || typeof images.getRecord !== 'function') importFail('images must be a GraphImageService');
  if (typeof targetImageId !== 'string' || targetImageId.length === 0) importFail('targetImageId must be non-empty text');

  // (2) Validate the ENTIRE bundle — structure AND closure completeness — BEFORE
  // any durable effect. Malformed input is never silently normalized.
  try {
    assertGraphBundleV1(bundle);
  } catch (error) {
    importFail(`invalid graph bundle: ${error.message}`, {cause: error});
  }

  // (4) Verify content identity BEFORE any identity minting or publication. This
  // is the seam a Project installation later uses: the release says identity X,
  // the supplied bundle is verified to BE X before it is materialized. A mismatch
  // means ZERO createRecords calls and ZERO durable state/history.
  const actualContentIdentity = contentIdentityForBundle(bundle, {crypto});
  if (expectedContentIdentity !== undefined && expectedContentIdentity !== actualContentIdentity) {
    importFail(`graph bundle content identity mismatch: expected ${expectedContentIdentity}, actual ${actualContentIdentity}`);
  }

  // (5) External resolution. A source external descriptor is a REQUIREMENT; the
  // binding says which target-environment reference satisfies it. Source
  // descriptors are NEVER automatically reinterpreted as target refs. Exactly one
  // binding per external, no unknown/extra keys; pinnedness must match. No
  // authority is inferred from a binding, and a bound ref is not followed.
  const externalKeys = Object.keys(bundle.externals);
  const bindingKeys = Object.keys(externalBindings ?? {});
  for (const externalKey of externalKeys) {
    if (!Object.hasOwn(externalBindings, externalKey)) {
      importFail(`missing external binding for ${externalKey}`, {descriptor: bundle.externals[externalKey]});
    }
  }
  for (const bindingKey of bindingKeys) {
    if (!Object.hasOwn(bundle.externals, bindingKey)) {
      importFail(`unknown external binding key: ${JSON.stringify(bindingKey)}`);
    }
  }
  const resolvedBindings = {};
  for (const externalKey of externalKeys) {
    const descriptor = bundle.externals[externalKey];
    const binding = canonicalizeValue(externalBindings[externalKey]);
    if (descriptor.pinned) {
      // A pinned external is a historical requirement; the exact provided
      // PinnedRef is preserved faithfully. Historical readability/retention is a
      // separate owner — getRecord must NOT be used to pretend the pinned
      // revision is verified.
      if (!isPinnedRef(binding)) {
        importFail(`pinned external ${externalKey} must bind to a PinnedRef`);
      }
    } else {
      if (!isObjectRef(binding)) {
        importFail(`unpinned external ${externalKey} must bind to an unpinned ObjectRef`);
      }
      // The bound target must actually exist BEFORE any creation.
      let target;
      try {
        // eslint-disable-next-line no-await-in-loop
        target = await images.getRecord(binding.imageId, binding.objectId);
      } catch (error) {
        importFail(`external binding ${externalKey} target cannot be read: ${binding.imageId}/${binding.objectId}`, {cause: error});
      }
      if (!target) {
        importFail(`external binding ${externalKey} target does not exist: ${binding.imageId}/${binding.objectId}`);
      }
    }
    resolvedBindings[externalKey] = binding;
  }

  // (6) Mint ALL target identities FIRST, in canonical localId order. Cycles and
  // shared refs require every fresh target identity to exist conceptually before
  // any portable record is rewritten. Target ids are freshly minted uuids from the
  // active crypto provider — NEVER derived from localId, source ObjectId,
  // contentIdentity or root key. The map is transient import state only.
  const activeCrypto = crypto ?? getDefaultCryptoProvider();
  const localIds = orderedLocalIds(bundle);
  const targetRefs = {};
  for (const localId of localIds) {
    targetRefs[localId] = objectRef(targetImageId, activeCrypto.uuid());
  }

  // (7) Rewrite every record generically, in canonical localId order. One
  // structural transform for every kind; {kind, ...portableFields} becomes
  // {kind, id: freshId, ...rewrittenFields} — the createRecords input shape.
  const recordInputs = localIds.map((localId) => {
    const {kind, ...portableFields} = bundle.records[localId];
    return {
      kind,
      id: targetRefs[localId].objectId,
      ...rewritePortableValue(portableFields, targetRefs, resolvedBindings),
    };
  });

  // Expose only semantic roots. The complete localId -> target ref table is
  // transient implementation state and is not persisted or returned.
  const roots = {};
  for (const [rootKey, localId] of Object.entries(bundle.roots)) {
    roots[rootKey] = targetRefs[localId];
  }

  return deepFreeze({roots, recordInputs, contentIdentity: actualContentIdentity});
}

async function importGraphBundle({images, targetImageId, bundle, externalBindings = {}, expectedContentIdentity, crypto} = {}) {
  if (!images || typeof images.createRecords !== 'function') importFail('images must be a GraphImageService');

  const plan = await prepareGraphBundleImport({
    images,
    targetImageId,
    bundle,
    externalBindings,
    expectedContentIdentity,
    crypto,
  });

  // (8) Publish ONCE. If createRecords refuses (wrong-kind relationship,
  // collision, malformed reconstructed record, backend failure), its proven
  // all-or-none atomicity is the whole failure story — the importer performs no
  // prior put, no cleanup transaction, no rollback and no selective id
  // regeneration inside a partly-rewritten graph.
  try {
    await images.createRecords(targetImageId, plan.recordInputs);
  } catch (error) {
    importFail(`graph bundle import publication failed: ${error.message}`, {cause: error});
  }

  return {roots: plan.roots, contentIdentity: plan.contentIdentity};
}

export {
  GRAPH_BUNDLE_V1,
  GraphBundleExportError,
  GraphBundleImportError,
  assertGraphBundleV1,
  contentIdentityForBundle,
  defaultReferencePolicy,
  exportGraphBundle,
  importGraphBundle,
  prepareGraphBundleImport,
};
