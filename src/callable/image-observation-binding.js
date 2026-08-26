import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {objectRef, textValue} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  normalizeObjectRef,
  resolveCallableInterface,
} from './binding-artifacts.js';
import {assertImages} from './interface-artifacts.js';
import {assertCallableInterfaceArguments} from './interface-v2-artifacts.js';
import {packCompositeValue} from './composite-codec.js';
import {resolveDeclaredType} from './type-grammar.js';

// ADR 0070. The authorized image-observation lane — the ONLY environment-facing observation
// seam. It is a substrate-side FILTERED, METADATA-ONLY invalidation feed:
//
//   observe(after-cursor: string) -> {events: list<obs-event>, cursor: string}
//   obs-event = record{object-id: string, kind: string, cursor: string}
//
// (The declared field is `object-id` because composite record field names are kebab-case; the
// contract's `objectId` is this field's semantic name — the changed object's identity.)
//
// The lane scans the image's private history internally and emits, for each `object.put`
// event the caller may `object/read`, ONLY identity + kind + an opaque cursor — never the
// record payload, never the raw global revision. State disclosure stays in one place: the
// environment rereads through the authorized readObject lane (ADR 0068). Non-object record
// kinds (shape/block/artifact/environment/root-set/created) are DROPPED from the v1 feed.
//
// The filter is fail-closed and adds no existence oracle: the per-event check-only `require`
// runs in a try/catch, an AuthorityError means "invisible — skip", and an unreadable object's
// changes are indistinguishable from no-change.
//
// THE CURSOR is the load-bearing security property (ADR 0070 side-channel decision). The raw
// history stream is one global per-image sequence, so handing the consumer a global revision
// would let it gap-analyze writes to objects it cannot see. The cursor is therefore an opaque,
// integrity-protected token that internally encodes the global high-water mark:
//
//   obs-cursor/v1:<base64url(AES-256-GCM IV + authTag + ciphertext(revision))>
//
// The consumer cannot parse a number out of it (it is encrypted, not merely base64'd), cannot
// compare two cursors (a fresh random IV per token makes identical revisions produce different
// tokens), and cannot forge one (the GCM tag is verified on every incoming after-cursor; tamper
// throws a TypeError rather than silently accepting). A VALID older cursor simply resumes from that
// earlier revision — an idempotent resume (re-emitted events are idempotent invalidations), not an
// error, so the cursor is rollback-safe. The default secret is generated per lane-install, so
// cursors are not forgeable by the consumer.
const IMAGE_OBSERVATION_BINDING_V1 = 'image-observation-binding/v1';
const EVENTS_FIELD = 'events';
const CURSOR_FIELD = 'cursor';
const OBJECT_ID_FIELD = 'object-id';
const KIND_FIELD = 'kind';
const EVENT_CURSOR_FIELD = 'cursor';
const OBJECT_PUT_KIND = 'object.put';

const OBSERVATION_CURSOR_V1 = 'obs-cursor/v1';
const LIVE_FOLLOW_CURSOR = '';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

// The cursor encrypts the revision with AES-256-GCM under a per-install key. A fresh random IV per
// token means two cursors for the SAME revision differ (non-comparable), and the GCM tag gives
// integrity (tamper fails decryption). The revision is therefore genuinely opaque to the consumer:
// it cannot be read out, two cursors cannot be gap-compared, and a forged one is rejected. This —
// not base64 (which is trivially decodable) — is what actually closes the gap-analysis channel.
function observationKey(secret) {
  return createHash('sha256').update(`${OBSERVATION_CURSOR_V1}:${secret}`, 'utf8').digest();
}

function encodeObservationCursor(secret, revision) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', observationKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(revision), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${OBSERVATION_CURSOR_V1}:${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

// An empty after-cursor means "start from the current end" (live-follow, no backlog replay)
// and is the only unauthenticated cursor form. Anything else must be a well-formed token that
// DECRYPTS under this lane's key — tamper is a TypeError (GCM auth failure), never a silent accept.
function decodeObservationCursor(secret, cursor) {
  if (cursor === LIVE_FOLLOW_CURSOR) return null;
  if (typeof cursor !== 'string' || !cursor.startsWith(`${OBSERVATION_CURSOR_V1}:`)) {
    throw new TypeError('observation cursor is not an obs-cursor/v1 token');
  }
  let payload;
  try {
    payload = Buffer.from(cursor.slice(OBSERVATION_CURSOR_V1.length + 1), 'base64url');
  } catch (error) {
    throw new TypeError('malformed observation cursor', {cause: error});
  }
  // 12-byte IV + 16-byte GCM tag + at least 1 byte of ciphertext.
  if (payload.length < 12 + 16 + 1) throw new TypeError('malformed observation cursor');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  let revisionText;
  try {
    const decipher = createDecipheriv('aes-256-gcm', observationKey(secret), iv);
    decipher.setAuthTag(tag);
    revisionText = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new TypeError('observation cursor failed its integrity check', {cause: error});
  }
  if (!/^(0|[1-9]\d*)$/.test(revisionText)) throw new TypeError('observation cursor revision is malformed');
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision)) throw new TypeError('observation cursor revision is not a safe integer');
  return revision;
}

// One internal scan of the private stream, returning both its events and its global end. The
// backend owns `revision` (the service must not synthesize one — a missing field is not 0), so
// the end is derived strictly from what the scan returned.
async function scanHistory(images, imageId, afterRevision) {
  const events = await images.history(imageId, {afterRevision});
  const end = events.reduce((maximum, event) => Math.max(maximum, event.revision), afterRevision);
  return {events, end};
}

function parseImageObservationBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact'
    || artifact.representation !== IMAGE_OBSERVATION_BINDING_V1) {
    throw new TypeError(`artifact must be ${IMAGE_OBSERVATION_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') {
    throw new TypeError('observation binding content must be a text Value');
  }
  assertBindingDependencies(artifact, [CALLABLE_INTERFACE_DEPENDENCY_ROLE], IMAGE_OBSERVATION_BINDING_V1);
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('observation binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${IMAGE_OBSERVATION_BINDING_V1} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== IMAGE_OBSERVATION_BINDING_V1) {
    throw new TypeError(`unsupported observation binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({});
}

// observe(after-cursor: string) -> record { events: list<obs-event>, cursor: string }
// where obs-event is a declared record {object-id: string, kind: string, cursor: string}.
function assertObservationInterface(descriptor) {
  const {parameters, result, types = {}} = descriptor;
  if (parameters.length !== 1 || parameters[0] !== 'string') {
    throw new TypeError(
      `${IMAGE_OBSERVATION_BINDING_V1} requires exactly one string parameter naming the after-cursor`,
    );
  }
  const outer = typeof result === 'string' ? resolveDeclaredType(result, types) : null;
  if (!outer || outer.kind !== 'record') {
    throw new TypeError(`${IMAGE_OBSERVATION_BINDING_V1} result must be a declared record type`);
  }
  const names = outer.fields.map(({name}) => name);
  if (names.length !== 2 || names[0] !== EVENTS_FIELD || names[1] !== CURSOR_FIELD) {
    throw new TypeError(
      `${IMAGE_OBSERVATION_BINDING_V1} result must declare exactly ${EVENTS_FIELD} then ${CURSOR_FIELD}`,
    );
  }
  const [eventsField, cursorField] = outer.fields;
  if (cursorField.type !== 'string') {
    throw new TypeError(`${IMAGE_OBSERVATION_BINDING_V1} ${CURSOR_FIELD} must be string; a cursor is opaque text`);
  }
  const eventsType = typeof eventsField.type === 'string' ? resolveDeclaredType(eventsField.type, types) : eventsField.type;
  if (!eventsType || eventsType.kind !== 'list') {
    throw new TypeError(`${IMAGE_OBSERVATION_BINDING_V1} ${EVENTS_FIELD} must be a list of obs-event records`);
  }
  const eventType = typeof eventsType.element === 'string' ? resolveDeclaredType(eventsType.element, types) : eventsType.element;
  if (!eventType || eventType.kind !== 'record') {
    throw new TypeError(`${IMAGE_OBSERVATION_BINDING_V1} ${EVENTS_FIELD} elements must be a declared record type`);
  }
  const eventNames = eventType.fields.map(({name}) => name);
  if (eventNames.length !== 3
    || eventNames[0] !== OBJECT_ID_FIELD || eventNames[1] !== KIND_FIELD || eventNames[2] !== EVENT_CURSOR_FIELD
    || eventType.fields.some(({type}) => type !== 'string')) {
    throw new TypeError(
      `${IMAGE_OBSERVATION_BINDING_V1} obs-event must declare exactly string ${OBJECT_ID_FIELD}, ${KIND_FIELD}, ${EVENT_CURSOR_FIELD}`,
    );
  }
  return {outer, eventType};
}

async function installImageObservationBinding({
  images,
  callableInterface,
  imageId = null,
  bindingId = randomUUID(),
  blockId = randomUUID(),
  bindingMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const interfaceRef = normalizeObjectRef(callableInterface, 'observation binding interface');
  const interfaceArtifact = await imageService.getCodeArtifact(interfaceRef.imageId, interfaceRef.objectId);
  if (!interfaceArtifact) {
    throw new TypeError(`callable interface not found: ${interfaceRef.imageId}/${interfaceRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;

  const {descriptor} = await resolveCallableInterface(
    imageService,
    {dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}]},
    IMAGE_OBSERVATION_BINDING_V1,
  );
  assertObservationInterface(descriptor);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_OBSERVATION_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_OBSERVATION_BINDING_V1,
    })),
    dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}],
    metadata: bindingMetadata,
  });
  const block = await imageService.putBlock(targetImageId, {
    id: blockId,
    code: objectRef(targetImageId, bindingArtifact.id),
    environment: null,
    metadata: blockMetadata,
  });
  return Object.freeze({bindingArtifact, block, interfaceRef});
}

function createImageObservationBindingV1Executor({cursorSecret = randomUUID()} = {}) {
  if (typeof cursorSecret !== 'string' || cursorSecret.length === 0) {
    throw new TypeError('cursorSecret must be a non-empty string');
  }
  return Object.freeze({
    async execute({activation, code}, {images, require}) {
      if (!code || code.representation !== IMAGE_OBSERVATION_BINDING_V1) {
        throw new TypeError(`observation executor requires ${IMAGE_OBSERVATION_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, IMAGE_OBSERVATION_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${IMAGE_OBSERVATION_BINDING_V1} does not accept a lexical environment`);
      }
      parseImageObservationBindingArtifact(code);
      const {descriptor} = await resolveCallableInterface(images, code, IMAGE_OBSERVATION_BINDING_V1);
      assertObservationInterface(descriptor);

      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const afterCursor = args[0].value;
      if (typeof afterCursor !== 'string') throw new TypeError('observe after-cursor must be a string');
      // The image comes from the binding, never the caller.
      const imageId = code.imageId;

      // Decode/verify BEFORE any scan. A tampered cursor fails here, so it can never be used
      // as an oracle against the stream. A valid older cursor is simply a smaller number —
      // an idempotent resume, not an error.
      const decoded = decodeObservationCursor(cursorSecret, afterCursor);
      // Exactly one internal scan of the private stream. Live-follow (empty after-cursor)
      // starts at the end of THIS scan — the current end by definition — so the same scan
      // both establishes the high-water mark and supplies the events after a resume cursor.
      // No second read means no TOCTOU between "where is the end" and "what happened since".
      const {events, end: highWater} = decoded === null
        ? await scanHistory(images, imageId, 0)
        : await scanHistory(images, imageId, decoded);
      const candidates = decoded === null ? [] : events;

      const visible = [];
      for (const event of candidates) {
        // v1 emits object invalidations only; every non-object record kind is dropped from
        // the feed until its own read grant exists (ADR 0070 per-kind mapping).
        if (event.type !== OBJECT_PUT_KIND) continue;
        try {
          require({operation: OBJECT_READ_OPERATION, resource: objectResource(imageId, event.objectId)});
        } catch (error) {
          // Fail-closed: denied means invisible, and an absent authority context fails the
          // same way — an unreadable object's changes are indistinguishable from no-change.
          // Anything that is not an authority denial is operational and must surface.
          if (error?.name !== 'AuthorityError') throw error;
          continue;
        }
        visible.push({
          [OBJECT_ID_FIELD]: event.objectId,
          [KIND_FIELD]: event.type,
          [EVENT_CURSOR_FIELD]: encodeObservationCursor(cursorSecret, event.revision),
        });
      }

      return packCompositeValue(
        {
          [EVENTS_FIELD]: visible,
          [CURSOR_FIELD]: encodeObservationCursor(cursorSecret, highWater),
        },
        descriptor.result,
        descriptor.types ?? {},
        `${descriptor.function} result`,
      );
    },
  });
}

export {
  IMAGE_OBSERVATION_BINDING_V1,
  OBSERVATION_CURSOR_V1,
  assertObservationInterface,
  createImageObservationBindingV1Executor,
  installImageObservationBinding,
  parseImageObservationBindingArtifact,
};
