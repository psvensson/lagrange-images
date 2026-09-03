// The B1b acceptance assertions, parameterized ONLY by where module source comes from
// (bead lagrange-images-z42, slice B2).
//
// This file is the differential proof's whole point: BOTH the checkout loader and the
// artifact loader run THIS code, unchanged. The single parameter is `load(logicalPath)`,
// which returns a module namespace. If proving B2 ever required changing an assertion
// here, that would mean packaging had absorbed semantics — so the assertions are frozen
// and only the loader differs.
//
// The crypto provider is built HERE from node:crypto, the way a native host supplies its
// own provider. It is deliberately NOT Images' `node-crypto-provider.js`: that module is
// correctly absent from the portable artifact, and a consumer must be able to bring its
// own.

import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';

// A real host-supplied provider over the narrow synchronous contract.
function createHostCryptoProvider() {
  return {
    secureRandomBytes: (length) => new Uint8Array(randomBytes(length)),
    sha256: (bytes) => new Uint8Array(createHash('sha256').update(Buffer.from(bytes)).digest()),
    aes256gcmEncrypt: ({key, iv, plaintext}) => {
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      return {ciphertext: new Uint8Array(ciphertext), tag: new Uint8Array(cipher.getAuthTag())};
    },
    aes256gcmDecrypt: ({key, iv, ciphertext, tag}) => {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
      decipher.setAuthTag(Buffer.from(tag));
      return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
    },
    uuid: () => randomUUID(),
  };
}

// A deliberately broken provider: a CONSTANT sha256. Used only to prove the SHA
// assertions discriminate — with this installed, distinct types must collide.
function createConstantShaProvider(base) {
  return {...base, sha256: () => new Uint8Array(32)};
}

const OBS_TYPES = {
  'obs-result': {kind: 'record', fields: [
    {name: 'events', type: {kind: 'list', element: 'obs-event'}},
    {name: 'cursor', type: 'string'},
  ]},
  'obs-event': {kind: 'record', fields: [
    {name: 'object-id', type: 'string'}, {name: 'kind', type: 'string'}, {name: 'cursor', type: 'string'},
  ]},
};

function assert(condition, message) {
  if (!condition) throw new Error(`ACCEPTANCE FAILED: ${message}`);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// base64url helpers for the AES-tag falsifier (harness-side; the cursor format is the
// binding's, and we only tamper with bytes we were handed).
function base64urlDecode(text) {
  return new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}
function base64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Run the whole B1b acceptance against ONE loader. Returns a result record; the
// differential proof asserts two loaders produce deeply equal records.
async function runPortableAcceptance(load) {
  const results = {};

  // --- public seam, through the artifact/checkout ENTRY module only ----------------
  const portable = await load('src/portable-runtime.js');
  results.hasCreatePortableRuntime = typeof portable.createPortableRuntime === 'function';
  results.hasSetDefaultCryptoProvider = typeof portable.setDefaultCryptoProvider === 'function';
  results.hasCreateRuntimeCore = typeof portable.createRuntimeCore === 'function';
  results.hasCreatePortableCodeExecutorRegistry =
    typeof portable.createPortableCodeExecutorRegistry === 'function';
  results.hasAuthorizedReadProjectDescriptor =
    typeof portable.authorizedReadProjectDescriptor === 'function';
  results.hasCreateProject = typeof portable.createProject === 'function';
  results.hasAddProjectMember = typeof portable.addProjectMember === 'function';
  results.hasProjectObjectId = typeof portable.projectObjectId === 'function';
  assert(results.hasCreatePortableRuntime, 'entry must expose createPortableRuntime');
  assert(results.hasSetDefaultCryptoProvider, 'entry must expose setDefaultCryptoProvider');
  assert(results.hasAuthorizedReadProjectDescriptor,
    'entry must expose the authorized Project descriptor read seam');
  assert(results.hasCreateProject && results.hasAddProjectMember && results.hasProjectObjectId,
    'entry must expose the bounded Project acceptance/control-plane setup helpers');

  // (1) no provider installed yet -> the existing explicit refusal.
  let refusal = null;
  try {
    await portable.createPortableRuntime({backend: {mode: 'mock'}});
  } catch (error) {
    refusal = error.message;
  }
  assert(refusal !== null, 'composing with no provider must refuse');
  assert(/no crypto provider installed/.test(refusal), `unexpected refusal: ${refusal}`);
  results.refusesWithoutProvider = true;

  // (4) malformed providers still fail through Images' existing validator, reached
  // ONLY through the entry export -- no second crypto API, no support/* path.
  const validatorErrors = [];
  for (const bad of [{}, null, {sha256: () => {}}]) {
    try {
      portable.setDefaultCryptoProvider(bad);
      validatorErrors.push(null);
    } catch (error) {
      validatorErrors.push(error.message);
    }
  }
  assert(validatorErrors.every((message) => typeof message === 'string'),
    'every malformed provider must be rejected');
  assert(validatorErrors.some((message) => /must supply|must be an object/.test(message)),
    `validator messages unexpected: ${JSON.stringify(validatorErrors)}`);
  results.malformedProviderRejected = true;

  // (2)(3) install a valid host provider through the entry export, then compose.
  const provider = createHostCryptoProvider();
  portable.setDefaultCryptoProvider(provider);
  const runtime = await portable.createPortableRuntime({backend: {mode: 'mock'}});
  results.composed = Boolean(runtime && runtime.images && runtime.authority && runtime.executor);
  assert(results.composed, 'createPortableRuntime must compose after install');

  try {
    const {authority, images, invocations, executor} = runtime;
    const {objectRef, textValue} = await load('src/value/index.js');
    const {objectResource, OBJECT_READ_OPERATION} = await load('src/authority/object-resource.js');
    const {installCallableInterfaceV2} = await load('src/callable/interface-v2-artifacts.js');
    const {installImageObservationBinding} = await load('src/callable/image-observation-binding.js');
    const {unpackCompositeValue} = await load('src/callable/composite-codec.js');
    const {typeFingerprint} = await load('src/callable/type-grammar.js');

    // --- SHA -> real typeFingerprint ----------------------------------------------
    // Independently discriminating: two DISTINCT type schemas must produce DIFFERENT
    // 32-byte fingerprints. A constant/fake sha256 collapses them (proven below).
    const fingerprintA = typeFingerprint('obs-result', OBS_TYPES);
    const fingerprintB = typeFingerprint('obs-event', OBS_TYPES);
    assert(fingerprintA.length === 32, 'typeFingerprint must be 32 bytes');
    assert(bytesToHex(fingerprintA) !== bytesToHex(fingerprintB),
      'distinct types must have distinct fingerprints (real SHA)');
    results.typeFingerprintDiscriminates = true;
    results.typeFingerprintBytes = fingerprintA.length;

    // --- UUID path ------------------------------------------------------------------
    const uuids = new Set([provider.uuid(), provider.uuid(), provider.uuid()]);
    assert(uuids.size === 3, 'uuid() must not repeat');
    assert([...uuids].every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)),
      'uuid() must be RFC 4122 v4');
    results.uuidPath = true;

    // --- native secure randomness ---------------------------------------------------
    const randomA = provider.secureRandomBytes(32);
    const randomB = provider.secureRandomBytes(32);
    assert(randomA.length === 32 && randomB.length === 32, 'secureRandomBytes length');
    assert(bytesToHex(randomA) !== bytesToHex(randomB), 'secureRandomBytes must not repeat');
    results.secureRandomness = true;

    // --- the real image lane: create -> read -> mutate -> observe --------------------
    await images.createImage({id: 'demo'});
    const shape = await images.putShape('demo', {id: 'shape', slots: [{id: 'slot-name', name: 'name'}]});
    await images.putObject('demo', {
      id: 'a', shape: objectRef('demo', shape.id), slots: {'slot-name': textValue('a-v0')},
    });
    const context = authority.issue({principal: 'alice', grants: [
      {operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'a')},
    ]});
    results.authorizedRead = (await images.getObject('demo', 'a')).slots['slot-name'].value;

    const before = await images.getObject('demo', 'a');
    await images.putObject('demo', {
      id: 'a', shape: objectRef('demo', shape.id), slots: {'slot-name': textValue('a-v1')},
    }, {expectedVersion: before._version});
    results.authorizedMutation = (await images.getObject('demo', 'a')).slots['slot-name'].value;

    const callableInterface = await installCallableInterfaceV2({
      images, imageId: 'demo', interfaceId: 'observe',
      functionName: 'observe', parameters: ['string'], result: 'obs-result', types: OBS_TYPES,
    });
    await installImageObservationBinding({
      images, callableInterface: objectRef('demo', callableInterface.id),
      bindingId: 'observation', blockId: 'observation-block',
    });
    const observe = async (afterCursor) => {
      const activation = await invocations.invokeBlock(
        objectRef('demo', 'observation-block'), [textValue(afterCursor)]);
      const packed = await executor.execute(activation, {authority: context});
      return unpackCompositeValue(packed, 'obs-result', OBS_TYPES);
    };

    // --- cursor mint / resume --------------------------------------------------------
    const start = await observe('');
    assert(typeof start.cursor === 'string' && start.cursor.startsWith('obs-cursor/v1:'),
      'cursor must be an obs-cursor/v1 token');
    assert(Number.isNaN(Number(start.cursor)), 'cursor must be opaque, not a bare revision');
    await images.putObject('demo', {
      id: 'a', shape: objectRef('demo', shape.id), slots: {'slot-name': textValue('a-v2')},
    }, {expectedVersion: (await images.getObject('demo', 'a'))._version});
    const feed = await observe(start.cursor);
    assert(feed.events.length === 1, `resume must see exactly the one mutation, saw ${feed.events.length}`);
    assert(feed.events[0]['object-id'] === 'a', 'event must name the mutated object');
    results.cursorMintResume = feed.events.length;
    results.rereadAfterObserve = (await images.getObject('demo', 'a')).slots['slot-name'].value;

    // --- AES-tag falsifier ------------------------------------------------------------
    // Flip one byte of the GCM tag (payload bytes 12..28) and require the integrity
    // check to reject. If AES-GCM authentication were not real, this would be accepted.
    const payload = base64urlDecode(start.cursor.slice('obs-cursor/v1:'.length));
    const tampered = Uint8Array.from(payload);
    tampered[12] ^= 0x01;
    const tamperedCursor = `obs-cursor/v1:${base64urlEncode(tampered)}`;
    let tamperRejected = null;
    try {
      await observe(tamperedCursor);
    } catch (error) {
      tamperRejected = error.message;
    }
    assert(tamperRejected !== null, 'a tampered GCM tag must be rejected');
    results.aesTagFalsifier = true;

    // --- SHA falsifier ----------------------------------------------------------------
    // Prove the fingerprint assertion above actually discriminates: with a CONSTANT
    // sha256, the two distinct types collapse to the same fingerprint.
    portable.setDefaultCryptoProvider(createConstantShaProvider(provider));
    const collidedA = typeFingerprint('obs-result', OBS_TYPES);
    const collidedB = typeFingerprint('obs-event', OBS_TYPES);
    assert(bytesToHex(collidedA) === bytesToHex(collidedB),
      'the SHA falsifier must collapse distinct fingerprints (otherwise the SHA check is vacuous)');
    results.shaFalsifierDiscriminates = true;
    portable.setDefaultCryptoProvider(provider);
  } finally {
    await runtime.close();
  }

  return results;
}

export {runPortableAcceptance, createHostCryptoProvider};
