import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLABLE_INTERFACE_V1,
  CALLABLE_INTERFACE_V2,
  bytesValue,
  createRuntime,
  installCallableInterfaceV2,
  normalizeCallableInterfaceV2Descriptor,
  normalizeTypeDeclarations,
  objectRef,
  packCompositeValue,
  parseCallableInterfaceV2Artifact,
  textValue,
  typeFingerprint,
  unpackCompositeValue,
} from '../src/runtime.js';

const LIST_OF_STRING = {kind: 'list', element: 'string'};

const ITEM_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [
      {name: 'name', type: 'string'},
      {name: 'quantity', type: 's64'},
      {name: 'enabled', type: 'bool'},
    ],
  },
});

test('v2 rejects string type expressions in favour of structural constructors', () => {
  // The whole point of the structural grammar: no type-expression parser in the descriptor.
  assert.throws(() => normalizeCallableInterfaceV2Descriptor({
    abi: CALLABLE_INTERFACE_V2, function: 'f', types: {}, parameters: ['list<string>'], result: 'string',
  }), /string type expression .* must be structural/);

  // list<u8> stays a primitive atom, because canonical bytes already carries it.
  const descriptor = normalizeCallableInterfaceV2Descriptor({
    abi: CALLABLE_INTERFACE_V2, function: 'f', types: {}, parameters: ['list<u8>'], result: 'list<u8>',
  });
  assert.deepEqual([...descriptor.parameters], ['list<u8>']);
});

test('v2 type declarations must be acyclic and fully declared', () => {
  const build = (types, parameters = ['string']) => () => normalizeCallableInterfaceV2Descriptor({
    abi: CALLABLE_INTERFACE_V2, function: 'f', types, parameters, result: 'string',
  });

  assert.throws(build({
    node: {kind: 'record', fields: [{name: 'next', type: 'node'}]},
  }), /cyclic/);
  assert.throws(build({
    a: {kind: 'record', fields: [{name: 'b', type: 'b'}]},
    b: {kind: 'record', fields: [{name: 'a', type: 'a'}]},
  }), /cyclic/);
  assert.throws(build({}, ['missing']), /references undeclared type/);
  assert.throws(build({string: {kind: 'record', fields: [{name: 'x', type: 's32'}]}}), /shadows a primitive/);
  assert.throws(build({
    dup: {kind: 'record', fields: [{name: 'x', type: 's32'}, {name: 'x', type: 's32'}]},
  }), /duplicate field/);
});

test('the fingerprint depends on the type and nothing else', () => {
  // `types` is a set of declarations, so its key order must not matter.
  const forward = normalizeTypeDeclarations({
    a: {kind: 'record', fields: [{name: 'x', type: 's32'}]},
    b: {kind: 'record', fields: [{name: 'y', type: 'string'}]},
  });
  const reversed = normalizeTypeDeclarations({
    b: {kind: 'record', fields: [{name: 'y', type: 'string'}]},
    a: {kind: 'record', fields: [{name: 'x', type: 's32'}]},
  });
  assert.deepEqual(typeFingerprint('a', forward), typeFingerprint('a', reversed));

  // Record field order is part of the type's meaning and of the encoding layout.
  const ordered = normalizeTypeDeclarations({
    r: {kind: 'record', fields: [{name: 'x', type: 's32'}, {name: 'y', type: 'string'}]},
  });
  const swapped = normalizeTypeDeclarations({
    r: {kind: 'record', fields: [{name: 'y', type: 'string'}, {name: 'x', type: 's32'}]},
  });
  assert.notDeepEqual(typeFingerprint('r', ordered), typeFingerprint('r', swapped));

  // Only reachable declarations contribute, so an unrelated type cannot change it.
  const withExtra = normalizeTypeDeclarations({
    ...JSON.parse(JSON.stringify({a: forward.a})),
    unrelated: {kind: 'record', fields: [{name: 'z', type: 'bool'}]},
  });
  assert.deepEqual(typeFingerprint('a', forward), typeFingerprint('a', withExtra));

  assert.notDeepEqual(typeFingerprint(LIST_OF_STRING), typeFingerprint({kind: 'list', element: 's64'}));
});

test('interface-composite/v0 round-trips every type in the v2 subset', () => {
  const roundTrip = (value, type, types = {}) => unpackCompositeValue(
    packCompositeValue(value, type, types), type, types,
  );

  assert.deepEqual(roundTrip([], LIST_OF_STRING), []);
  assert.deepEqual(roundTrip([''], LIST_OF_STRING), ['']);
  assert.deepEqual(roundTrip(['a', '', 'hällo 世界 \u{1f600}'], LIST_OF_STRING),
    ['a', '', 'hällo 世界 \u{1f600}']);
  // Content that looks like the Cuis line protocol must be inert inside an envelope.
  assert.deepEqual(roundTrip(['d:x', 'e:%20', 'OK\tERR', 'a\nb'], LIST_OF_STRING),
    ['d:x', 'e:%20', 'OK\tERR', 'a\nb']);

  const long = Array.from({length: 2000}, (_, i) => `item ${i}`);
  assert.deepEqual(roundTrip(long, LIST_OF_STRING), long);

  // Nested lists work through the same machinery, with no extra grammar.
  const nested = {kind: 'list', element: LIST_OF_STRING};
  assert.deepEqual(roundTrip([[], ['a'], ['b', 'c']], nested), [[], ['a'], ['b', 'c']]);

  const record = {name: 'Peter', quantity: 3n, enabled: true};
  assert.deepEqual(roundTrip(record, 'item', ITEM_TYPES), record);

  const listOfItem = {kind: 'list', element: 'item'};
  assert.deepEqual(
    roundTrip([record, {name: '', quantity: -1n, enabled: false}], listOfItem, ITEM_TYPES),
    [record, {name: '', quantity: -1n, enabled: false}],
  );
});

test('an envelope cannot be decoded against a different type', () => {
  const packed = packCompositeValue(['a', 'b'], LIST_OF_STRING);
  assert.throws(() => unpackCompositeValue(packed, {kind: 'list', element: 's64'}),
    /encoded against a different interface type/);
  assert.throws(() => unpackCompositeValue(packed, 'item', ITEM_TYPES),
    /encoded against a different interface type/);

  // Same structure, different declared field order: still a different type.
  const swapped = normalizeTypeDeclarations({
    item: {
      kind: 'record',
      fields: [
        {name: 'quantity', type: 's64'},
        {name: 'name', type: 'string'},
        {name: 'enabled', type: 'bool'},
      ],
    },
  });
  const asItem = packCompositeValue({name: 'x', quantity: 1n, enabled: true}, 'item', ITEM_TYPES);
  assert.throws(() => unpackCompositeValue(asItem, 'item', swapped),
    /encoded against a different interface type/);
});

test('the codec refuses refs, malformed envelopes and out-of-range values', () => {
  // A ref inside an envelope would be a graph edge the flat walker cannot see.
  assert.throws(() => packCompositeValue([objectRef('demo', 'thing')], LIST_OF_STRING),
    /must be ref-free|must be a string/);

  assert.throws(() => unpackCompositeValue(bytesValue(new Uint8Array([1, 2, 3])), LIST_OF_STRING),
    /envelope is too short/);
  assert.throws(() => unpackCompositeValue(bytesValue(new Uint8Array(40)), LIST_OF_STRING),
    /not an interface-composite\/v0 envelope/);
  assert.throws(() => unpackCompositeValue(textValue('nope'), LIST_OF_STRING),
    /must be a bytes Value/);

  const packed = packCompositeValue(['a'], LIST_OF_STRING);
  const withTrailing = bytesValue(new Uint8Array([
    ...Buffer.from(packed.base64, 'base64'), 0,
  ]));
  assert.throws(() => unpackCompositeValue(withTrailing, LIST_OF_STRING), /trailing bytes/);

  assert.throws(() => packCompositeValue([2n ** 40n], {kind: 'list', element: 's32'}),
    /outside s32 range/);
  assert.throws(() => packCompositeValue({name: 'x', quantity: 1n}, 'item', ITEM_TYPES),
    /missing field enabled/);
  assert.throws(() => packCompositeValue({name: 'x', quantity: 1n, enabled: true, extra: 1}, 'item', ITEM_TYPES),
    /fields not in the type/);
});

test('v1 and v2 are separate durable representations and v1 stays closed', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'demo'});
    const artifact = await installCallableInterfaceV2({
      images: runtime.images,
      imageId: 'demo',
      interfaceId: 'normalize-all-interface',
      functionName: 'normalize-all',
      parameters: [LIST_OF_STRING],
      result: LIST_OF_STRING,
    });
    assert.equal(artifact.representation, CALLABLE_INTERFACE_V2);
    assert.notEqual(CALLABLE_INTERFACE_V2, CALLABLE_INTERFACE_V1);

    const descriptor = parseCallableInterfaceV2Artifact(artifact);
    assert.deepEqual(Object.keys(descriptor).sort(), ['abi', 'function', 'parameters', 'result', 'types']);
    assert.deepEqual(descriptor.result, LIST_OF_STRING);

    // A v2 interface still declares no dependencies, exactly as v1.
    assert.deepEqual(artifact.dependencies, []);

    // A v2 descriptor must not parse as v1, and vice versa.
    const asV1 = await runtime.images.putCodeArtifact('demo', {
      id: 'mislabelled', representation: CALLABLE_INTERFACE_V1, content: artifact.content,
    });
    assert.throws(() => parseCallableInterfaceV2Artifact(asV1), /must be callable-interface\/v2/);
  } finally {
    await runtime.close();
  }
});
