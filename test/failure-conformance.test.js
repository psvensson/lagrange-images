import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V0,
  NEUTRAL_EXPRESSION_V0,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  compileWasmFunctionArtifact,
  createAuthorityService,
  createRuntime,
  installCallableInterfaceV2,
  installImageMutationBinding,
  installImageProjectionBinding,
  integerValue,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  objectVersionToken,
  packCompositeValue,
  textValue,
} from '../src/runtime.js';

// Failure conformance, as distinct from success conformance.
//
//   success conformance   lane A value   == lane B value
//   failure conformance   lane A failure == lane B failure, for the same semantic reason
//
// Every differential suite in this repo compared values; none compared which error an equivalent
// invalid program or operation produces. That gap let the WASM lane report an ABI-internal
// "invalid handle" where the neutral lane reported "activation has no receiver" — both threw, so
// nothing caught it.
//
// The assertions below deliberately do NOT demand identical strings, and introduce no new error
// taxonomy. Each case names one regex expressing the shared semantic reason and requires both
// implementations to match it, which permits lane-specific prefixes while rejecting a lane that
// fails for a different reason.

async function installSemanticV0(runtime, id, program) {
  return await runtime.images.putCodeArtifact('demo', {
    id: `${id}:semantic`,
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify(program)),
  });
}

async function neutralBlock(runtime, semantic, id) {
  const code = await runtime.compilation.compileArtifact(
    objectRef('demo', semantic.id),
    {id: `${id}:neutral-code`, targetRepresentation: NEUTRAL_EXPRESSION_V0},
  );
  const block = await runtime.images.putBlock('demo', {id: `${id}:neutral`, code: objectRef('demo', code.id)});
  return objectRef('demo', block.id);
}

async function wasmBlock(runtime, semantic, id) {
  const {functionArtifact} = await compileWasmFunctionArtifact({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('demo', semantic.id),
    moduleId: `${id}:module`,
    functionId: `${id}:function`,
  });
  const block = await runtime.images.putBlock('demo', {
    id: `${id}:wasm`,
    code: objectRef('demo', functionArtifact.id),
  });
  return objectRef('demo', block.id);
}

async function failureOf(runtime, blockRef, args) {
  const activation = await runtime.invocations.invokeBlock(blockRef, args);
  try {
    const value = await runtime.executor.execute(activation);
    return {failed: false, detail: `completed with ${JSON.stringify(value)}`};
  } catch (error) {
    return {failed: true, name: error.name, message: error.message};
  }
}

// Runs one invalid v0 program through both execution lanes and requires the same semantic reason.
async function bothLanesFail(runtime, id, program, args, reason) {
  const semantic = await installSemanticV0(runtime, id, program);
  const outcomes = {
    neutral: await failureOf(runtime, await neutralBlock(runtime, semantic, id), args),
    wasm: await failureOf(runtime, await wasmBlock(runtime, semantic, id), args),
  };
  for (const [lane, outcome] of Object.entries(outcomes)) {
    assert.ok(outcome.failed, `${id}: the ${lane} lane did not fail — it ${outcome.detail}`);
    assert.match(
      outcome.message,
      reason,
      `${id}: the ${lane} lane failed for a different reason: ${outcome.name}: ${outcome.message}`,
    );
  }
  return outcomes;
}

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'demo'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

test('an activation given the wrong argument count fails alike in both execution lanes', async () => {
  await withRuntime(async (runtime) => {
    await bothLanesFail(
      runtime,
      'arity',
      {parameters: [{id: 'p0', name: 'x'}], captures: [], body: {op: 'argument', index: 0}},
      [],
      /expected 1 arguments, received 0/,
    );
  });
});

// The case that motivated this sweep. The WASM lane reported "WASM result handle is invalid: 0",
// which is a statement about the handle ABI rather than about the program: reading a receiver the
// activation does not have.
test('reading an absent receiver fails alike in both execution lanes', async () => {
  await withRuntime(async (runtime) => {
    await bothLanesFail(
      runtime,
      'receiver',
      {parameters: [], captures: [], body: {op: 'receiver'}},
      [],
      /activation has no receiver/,
    );
  });
});

test('integer-add on a non-integer fails alike in both execution lanes', async () => {
  await withRuntime(async (runtime) => {
    await bothLanesFail(
      runtime,
      'add-type',
      {
        parameters: [{id: 'p0', name: 'x'}],
        captures: [],
        body: {op: 'integer-add', left: {op: 'argument', index: 0}, right: {op: 'argument', index: 0}},
      },
      [textValue('nope')],
      /integer[-_]add operands must be integer Values/,
    );
  });
});

test('a non-boolean condition fails alike in both execution lanes', async () => {
  await withRuntime(async (runtime) => {
    await bothLanesFail(
      runtime,
      'condition',
      {
        parameters: [{id: 'p0', name: 'x'}],
        captures: [],
        body: {
          op: 'if',
          condition: {op: 'argument', index: 0},
          then: {op: 'literal', value: integerValue(1)},
          else: {op: 'literal', value: integerValue(2)},
        },
      },
      [integerValue(5)],
      /condition must be a boolean Value/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The image callable lanes. Both consume callable-interface/v2 and both sit behind the same
// authority substrate, so an equivalent invalid call must fail for the same reason through either.

const ITEM_TYPES = normalizeTypeDeclarations({
  item: {
    kind: 'record',
    fields: [{name: 'name', type: 'string'}, {name: 'quantity', type: 's64'}],
  },
});
const FIELDS = [{name: 'name', slot: 'slot-name'}, {name: 'quantity', slot: 'slot-quantity'}];

async function seedImageLanes() {
  const authority = createAuthorityService();
  const runtime = await createRuntime({backend: {mode: 'mock'}, authority});
  await runtime.images.createImage({id: 'demo'});
  const shape = await runtime.images.putShape('demo', {
    id: 'item-shape',
    slots: [{id: 'slot-name', name: 'name'}, {id: 'slot-quantity', name: 'quantity'}],
  });
  await runtime.images.putObject('demo', {
    id: 'thing',
    shape: objectRef('demo', shape.id),
    slots: {'slot-name': textValue('a'), 'slot-quantity': integerValue(1)},
  });

  const readInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'read-item', functionName: 'read-item',
    parameters: ['string'], result: 'item', types: ITEM_TYPES,
  });
  const writeInterface = await installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'write-item', functionName: 'write-item',
    parameters: ['string', 'string', 'item'], result: 'string', types: ITEM_TYPES,
  });
  await installImageProjectionBinding({
    images: runtime.images, callableInterface: objectRef('demo', readInterface.id),
    fields: FIELDS, bindingId: 'projection', blockId: 'projection-block',
  });
  await installImageMutationBinding({
    images: runtime.images, callableInterface: objectRef('demo', writeInterface.id),
    fields: FIELDS, bindingId: 'mutation', blockId: 'mutation-block',
  });

  const item = packCompositeValue({name: 'a', quantity: 1n}, 'item', ITEM_TYPES);
  const lanes = {
    projection: {
      block: 'projection-block',
      grant: {operation: OBJECT_READ_OPERATION, resource: objectResource('demo', 'thing')},
      argumentsFor: (objectId) => [textValue(objectId)],
    },
    mutation: {
      block: 'mutation-block',
      grant: {operation: OBJECT_WRITE_OPERATION, resource: objectResource('demo', 'thing')},
      argumentsFor: (objectId, version = 1) => [
        textValue(objectId), textValue(objectVersionToken('demo', objectId, version)), item,
      ],
    },
  };

  const attempt = async (lane, args, context) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', lanes[lane].block), args);
    try {
      const value = await runtime.executor.execute(
        activation,
        context === undefined ? {} : {authority: context},
      );
      return {failed: false, detail: `completed with ${JSON.stringify(value)}`};
    } catch (error) {
      return {failed: true, name: error.name, message: error.message};
    }
  };

  return {runtime, authority, lanes, attempt};
}

// Runs one invalid call through both image lanes and requires the same semantic reason.
async function bothImageLanesFail({authority, lanes, attempt}, label, build, reason) {
  for (const lane of Object.keys(lanes)) {
    const outcome = await attempt(lane, ...build(lane, lanes[lane], authority));
    assert.ok(outcome.failed, `${label}: the ${lane} lane did not fail — it ${outcome.detail}`);
    assert.match(
      outcome.message,
      reason,
      `${label}: the ${lane} lane failed for a different reason: ${outcome.name}: ${outcome.message}`,
    );
  }
}

test('the image lanes reject a wrong argument count for the same reason', async () => {
  const seeded = await seedImageLanes();
  try {
    await bothImageLanesFail(seeded, 'arity', (lane, config, authority) => [
      [], authority.issue({principal: 'alice', grants: [config.grant]}),
    ], /expected \d+ arguments, got 0/);
  } finally {
    await seeded.runtime.close();
  }
});

test('the image lanes reject a wrong argument type for the same reason', async () => {
  const seeded = await seedImageLanes();
  try {
    await bothImageLanesFail(seeded, 'argument type', (lane, config, authority) => [
      config.argumentsFor('thing').map((value, index) => (index === 0 ? integerValue(7) : value)),
      authority.issue({principal: 'alice', grants: [config.grant]}),
    ], /argument 0 must be a text Value for string/);
  } finally {
    await seeded.runtime.close();
  }
});

// Authority denial has two distinct shapes, and both must be uniform across lanes: no context at
// all fails closed, and a context without the grant is refused by the algebra.
test('the image lanes fail closed without an authority context for the same reason', async () => {
  const seeded = await seedImageLanes();
  try {
    await bothImageLanesFail(seeded, 'absent authority', (lane, config) => [
      config.argumentsFor('thing'), undefined,
    ], /no authority context was supplied/);
  } finally {
    await seeded.runtime.close();
  }
});

test('the image lanes refuse an ungranted operation for the same reason', async () => {
  const seeded = await seedImageLanes();
  try {
    await bothImageLanesFail(seeded, 'ungranted', (lane, config, authority) => [
      config.argumentsFor('thing'), authority.issue({principal: 'alice', grants: []}),
    ], /^not authorized: object\/(read|write) on /);
  } finally {
    await seeded.runtime.close();
  }
});

// The lanes take different parameters, so "equivalent operation" has to be constructed with care:
// the mutation lane validates its version token before touching the object, and an ill-formed token
// is a different operation rather than a different answer to the same one.
test('the image lanes report a missing object for the same reason', async () => {
  const seeded = await seedImageLanes();
  try {
    await bothImageLanesFail(seeded, 'missing object', (lane, config, authority) => [
      config.argumentsFor('missing'),
      authority.issue({
        principal: 'alice',
        grants: [{...config.grant, resource: objectResource('demo', 'missing')}],
      }),
    ], /object not found: demo\/missing/);
  } finally {
    await seeded.runtime.close();
  }
});
