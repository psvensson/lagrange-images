import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAGRANGE_CODE_V1,
  LAGRANGE_CODE_V2,
  NEUTRAL_EXPRESSION_V1,
  NEUTRAL_EXPRESSION_V2,
  WASM_BINARY_V1,
  WASM_MODULE_V2,
  bytesValue,
  createRuntime,
  defineClass,
  defineMethods,
  ensureClassFromDeclaration,
  installCallableInterfaceV2,
  installImageProjectionBinding,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkControlFlow,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installWasmBlockTree,
  installWasmScalarCallable,
  instanceVariableBindings,
  integerValue,
  lowerLagrangeCodeV1,
  lowerLagrangeCodeV2,
  normalizeTypeDeclarations,
  objectRef,
  objectResource,
  pinnedRef,
  textValue,
} from '../src/index.js';
import {compileWasmV1Module} from '../src/wasm/compiler-v1.js';
import {compileResumableWasmV2Module} from '../src/wasm/resumable-compiler-v2.js';
import {findSmalltalkBlockProtocol} from '../src/language/smalltalk-block-protocol.js';
import {assembleWasmV1FunctionArtifact} from '../src/wasm/tree-installer-v1.js';
import {readModuleDescriptor, soleModuleEntry} from '../src/wasm/module-contract.js';
import {
  I32,
  functionExport,
  functionType,
  section,
  u32,
  vector,
} from '../src/wasm/encoding.js';

function buildWasmAddTenModuleBytes() {
  const types = vector([functionType([I32], [I32])]);
  const functions = vector([[...u32(0)]]);
  const exports = vector([functionExport('add_ten', 0)]);
  // local.get 0, i32.const 10, i32.add, end
  const body = [0x00, 0x20, 0x00, 0x41, 0x0a, 0x6a, 0x0b];
  const code = vector([[...u32(body.length), ...body]]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(3, functions),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

async function installV2Block(runtime, imageId, id, program, {lane = 'neutral', bindings = null} = {}) {
  const semantic = await runtime.images.putCodeArtifact(imageId, {
    id: `${id}:semantic`,
    languageId: 'neutral-test',
    representation: LAGRANGE_CODE_V2,
    content: textValue(JSON.stringify(program)),
  });
  const semanticRef = objectRef(imageId, semantic.id);
  const environment = bindings
    ? await runtime.images.putLexicalEnvironment(imageId, {
      id: `${id}:env`,
      bindings,
    })
    : null;
  const environmentRef = environment ? objectRef(imageId, environment.id) : null;

  if (lane === 'wasm') {
    const moduleArtifact = await runtime.compilation.compileArtifact(semanticRef, {
      id: `${id}:wasm:module`,
      targetRepresentation: WASM_MODULE_V2,
    });
    const {functionArtifact} = await assembleWasmV1FunctionArtifact({
      images: runtime.images,
      semanticRef,
      moduleRef: objectRef(imageId, moduleArtifact.id),
      functionId: `${id}:wasm:function`,
      entry: soleModuleEntry(readModuleDescriptor(moduleArtifact)),
    });
    const block = await runtime.images.putBlock(imageId, {
      id,
      code: objectRef(imageId, functionArtifact.id),
      environment: environmentRef,
    });
    return objectRef(imageId, block.id);
  }

  const code = await runtime.compilation.compileArtifact(semanticRef, {
    id: `${id}:code`,
    targetRepresentation: NEUTRAL_EXPRESSION_V2,
  });
  const block = await runtime.images.putBlock(imageId, {
    id,
    code: objectRef(imageId, code.id),
    environment: environmentRef,
  });
  return objectRef(imageId, block.id);
}

test('lagrange-code/v1 and neutral-expression/v1 stay frozen and reject op: apply', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());

  const applyProgram = {
    parameters: [{id: 'p0', name: 'callee'}],
    temporaries: [],
    captures: [],
    body: {
      op: 'apply',
      callee: {op: 'argument', index: 0},
      arguments: [{op: 'literal', value: integerValue(5)}],
    },
  };

  assert.throws(
    () => lowerLagrangeCodeV1(applyProgram),
    /unknown lagrange-code\/v1 expression op: apply/,
  );
  assert.throws(
    () => compileWasmV1Module(applyProgram),
    /WASM backend v1 does not support semantic op: apply/,
  );
  assert.throws(
    () => compileResumableWasmV2Module(applyProgram),
    /WASM resumable backend v2 does not support semantic op: apply/,
  );

  // Also check that neutral-expression/v1 rejects op: apply at execution time
  const image = await runtime.images.createImage({id: 'frozen-v1-img', name: 'frozen-v1'});
  const loweredV2 = lowerLagrangeCodeV2(applyProgram);
  const v1Code = await runtime.images.putCodeArtifact(image.id, {
    id: 'bad-v1-code',
    languageId: 'neutral-test',
    representation: NEUTRAL_EXPRESSION_V1,
    content: textValue(JSON.stringify(loweredV2)),
  });
  const v1Block = await runtime.images.putBlock(image.id, {
    id: 'bad-v1-block',
    code: objectRef(image.id, v1Code.id),
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef(image.id, v1Block.id),
    [objectRef(image.id, v1Block.id)],
  );
  await assert.rejects(
    runtime.executor.execute(activation),
    /unknown neutral-expression\/v1 expression op: apply/,
  );
});

test('lagrange-code/v2 executes tail and non-tail apply with identical left-to-right evaluation in neutral and WASM lanes', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  const image = await runtime.images.createImage({id: 'v2-apply-img', name: 'v2-apply'});

  for (const lane of ['neutral', 'wasm']) {
    const adderBlockRef = await installV2Block(runtime, image.id, `adder-${lane}`, {
      parameters: [
        {id: 'a', name: 'a'},
        {id: 'b', name: 'b'},
      ],
      temporaries: [],
      captures: [],
      body: {
        op: 'integer-add',
        left: {op: 'argument', index: 0},
        right: {op: 'argument', index: 1},
      },
    }, {lane});

    // Tail apply: apply(adder, [x, 10])
    const tailCallerRef = await installV2Block(runtime, image.id, `tail-caller-${lane}`, {
      parameters: [{id: 'x', name: 'x'}],
      temporaries: [],
      captures: [{id: 'cap:adder', mode: 'snapshot', name: 'adder'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'cap:adder'},
        arguments: [
          {op: 'argument', index: 0},
          {op: 'literal', value: integerValue(10)},
        ],
      },
    }, {
      lane,
      bindings: {'cap:adder': {name: 'adder', value: adderBlockRef}},
    });

    const tailAct = await runtime.invocations.invokeBlock(tailCallerRef, [integerValue(32)]);
    const tailRes = await runtime.executor.execute(tailAct);
    assert.deepEqual(tailRes, integerValue(42));

    // Non-tail (resumable) apply with mutable cell side-effects in callee and arguments:
    // t := 1;
    // r1 := apply((t := t + 10; adder), [(t := t + 100), t]);
    // r1 + apply(adder, [t, 1])
    // Trace:
    //   initial: t = 1
    //   callee eval: t becomes 11, returns adder
    //   arg0 eval: t becomes 111, returns 111
    //   arg1 eval: reads t = 111
    //   first apply: adder(111, 111) = 222
    //   second apply: adder(111, 1) = 112
    //   sum: 222 + 112 = 334
    const nonTailCallerRef = await installV2Block(runtime, image.id, `nontail-caller-${lane}`, {
      parameters: [],
      temporaries: [{id: 'temp:t', name: 't'}],
      captures: [{id: 'cap:adder', mode: 'snapshot', name: 'adder'}],
      body: {
        op: 'sequence',
        statements: [
          {op: 'binding-write', id: 'temp:t', value: {op: 'literal', value: integerValue(1)}},
          {
            op: 'integer-add',
            left: {
              op: 'apply',
              callee: {
                op: 'sequence',
                statements: [
                  {
                    op: 'binding-write',
                    id: 'temp:t',
                    value: {
                      op: 'integer-add',
                      left: {op: 'binding', id: 'temp:t'},
                      right: {op: 'literal', value: integerValue(10)},
                    },
                  },
                  {op: 'binding', id: 'cap:adder'},
                ],
              },
              arguments: [
                {
                  op: 'binding-write',
                  id: 'temp:t',
                  value: {
                    op: 'integer-add',
                    left: {op: 'binding', id: 'temp:t'},
                    right: {op: 'literal', value: integerValue(100)},
                  },
                },
                {op: 'binding', id: 'temp:t'},
              ],
            },
            right: {
              op: 'apply',
              callee: {op: 'binding', id: 'cap:adder'},
              arguments: [
                {op: 'binding', id: 'temp:t'},
                {op: 'literal', value: integerValue(1)},
              ],
            },
          },
        ],
      },
    }, {
      lane,
      bindings: {'cap:adder': {name: 'adder', value: adderBlockRef}},
    });

    const nonTailAct = await runtime.invocations.invokeBlock(nonTailCallerRef, []);
    const nonTailRes = await runtime.executor.execute(nonTailAct);
    assert.deepEqual(nonTailRes, integerValue(334));
  }
});

test('installWasmBlockTree compiles and executes nested lagrange-code/v2 closures applied via apply', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  const image = await runtime.images.createImage({id: 'v2-tree-img', name: 'v2-tree'});

  // Outer block declares cell `acc := 5`, creates a nested closure that mutates `acc := acc + x`,
  // applies that closure twice via `apply`, and returns `acc`.
  const treeProgram = {
    parameters: [{id: 'root:step', name: 'step'}],
    temporaries: [
      {id: 'root:acc', name: 'acc'},
      {id: 'root:fn', name: 'fn'},
    ],
    captures: [],
    body: {
      op: 'sequence',
      statements: [
        {op: 'binding-write', id: 'root:acc', value: {op: 'literal', value: integerValue(5)}},
        {
          op: 'binding-write',
          id: 'root:fn',
          value: {
            op: 'block',
            blockId: 'bump',
            captures: [{id: 'root:acc', mode: 'cell', name: 'acc'}],
            program: {
              parameters: [{id: 'bump:delta', name: 'delta'}],
              temporaries: [],
              captures: [{id: 'root:acc', mode: 'cell', name: 'acc'}],
              body: {
                op: 'binding-write',
                id: 'root:acc',
                value: {
                  op: 'integer-add',
                  left: {op: 'binding', id: 'root:acc'},
                  right: {op: 'argument', index: 0},
                },
              },
            },
          },
        },
        {
          op: 'apply',
          callee: {op: 'binding', id: 'root:fn'},
          arguments: [{op: 'argument', index: 0}],
        },
        {
          op: 'apply',
          callee: {op: 'binding', id: 'root:fn'},
          arguments: [{op: 'argument', index: 0}],
        },
        {op: 'binding', id: 'root:acc'},
      ],
    },
  };

  const semantic = await runtime.images.putCodeArtifact(image.id, {
    id: 'v2-tree:semantic',
    languageId: 'neutral-test',
    representation: LAGRANGE_CODE_V2,
    content: textValue(JSON.stringify(treeProgram)),
  });
  const installed = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef(image.id, semantic.id),
    id: 'v2-tree:root',
  });

  const act = await runtime.invocations.invokeBlock(
    objectRef(image.id, installed.block.id),
    [integerValue(10)],
  );
  const result = await runtime.executor.execute(act);
  assert.deepEqual(result, integerValue(25));
});

test('apply directly invokes WASM scalar callables and image projection bindings while refusing direct loop primitives', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  const image = await runtime.images.createImage({id: 'v2-callable-img', name: 'v2-callable'});

  await installSmalltalkKernel({images: runtime.images, imageId: image.id});
  await installSmalltalkControlFlow({images: runtime.images, compilation: runtime.compilation, imageId: image.id});
  await installSmalltalkBlockProtocol({images: runtime.images, compilation: runtime.compilation, imageId: image.id});

  const wasmBinary = await runtime.images.putCodeArtifact(image.id, {
    id: 'wasm-add-ten-binary',
    representation: WASM_BINARY_V1,
    content: bytesValue(buildWasmAddTenModuleBytes()),
  });
  const wasmCallable = await installWasmScalarCallable({
    images: runtime.images,
    imageId: image.id,
    wasm: objectRef(image.id, wasmBinary.id),
    exportName: 'add_ten',
    parameters: ['i32'],
    result: 'i32',
  });
  const wasmCallableRef = objectRef(image.id, wasmCallable.block.id);

  // Also install an image projection binding and apply it directly via `apply`
  const counterShape = await runtime.images.putShape(image.id, {
    id: 'shape:counter',
    slots: [{id: 'slot:count', name: 'count'}],
  });
  const counterObj = await runtime.images.putObject(image.id, {
    id: 'obj:counter-1',
    shape: objectRef(image.id, counterShape.id),
    slots: {'slot:count': integerValue(32)},
  });
  const projIface = await installCallableInterfaceV2({
    images: runtime.images,
    imageId: image.id,
    packageName: 'lagrange:test',
    interfaceName: 'counter-proj',
    functionName: 'project-counter',
    parameters: ['string'],
    result: 'counter-view',
    types: normalizeTypeDeclarations({
      'counter-view': {
        kind: 'record',
        fields: [{name: 'count', type: 's64'}],
      },
    }),
  });
  const counterProjection = await installImageProjectionBinding({
    images: runtime.images,
    imageId: image.id,
    callableInterface: objectRef(image.id, projIface.id),
    shape: objectRef(image.id, counterShape.id),
    fields: [{name: 'count', slot: 'slot:count'}],
  });
  const projectionBlockRef = objectRef(image.id, counterProjection.block.id);

  for (const lane of ['neutral', 'wasm']) {
    const wasmCallerRef = await installV2Block(runtime, image.id, `apply-wasm-callable-${lane}`, {
      parameters: [{id: 'x', name: 'x'}],
      temporaries: [],
      captures: [{id: 'cap:callee', mode: 'snapshot', name: 'callee'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'cap:callee'},
        arguments: [{op: 'argument', index: 0}],
      },
    }, {
      lane,
      bindings: {'cap:callee': {name: 'callee', value: wasmCallableRef}},
    });

    const act = await runtime.invocations.invokeBlock(wasmCallerRef, [integerValue(32)]);
    assert.deepEqual(await runtime.executor.execute(act), integerValue(42));

    const projectionCallerRef = await installV2Block(runtime, image.id, `apply-projection-${lane}`, {
      parameters: [{id: 'target', name: 'target'}],
      temporaries: [],
      captures: [{id: 'cap:proj', mode: 'snapshot', name: 'proj'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'cap:proj'},
        arguments: [{op: 'argument', index: 0}],
      },
    }, {
      lane,
      bindings: {'cap:proj': {name: 'proj', value: projectionBlockRef}},
    });
    const auth = runtime.authority.issue({
      principal: 'test:v2-apply',
      grants: [{
        operation: 'object/read',
        resource: objectResource(image.id, counterObj.id),
      }],
    });
    const projAct = await runtime.invocations.invokeBlock(
      projectionCallerRef,
      [textValue(counterObj.id)],
    );
    const projected = await runtime.executor.execute(projAct, {authority: auth});
    assert.equal(projected.kind, 'bytes');

    // Direct apply of a loop primitive must still be refused by assertLoopBlock because receiver is null
    const loopProtocol = await findSmalltalkBlockProtocol({images: runtime.images, imageId: image.id});
    const loopCallerRef = await installV2Block(runtime, image.id, `apply-loop-prim-${lane}`, {
      parameters: [{id: 'body', name: 'body'}],
      temporaries: [],
      captures: [{id: 'cap:loop', mode: 'snapshot', name: 'loop'}],
      body: {
        op: 'apply',
        callee: {op: 'binding', id: 'cap:loop'},
        arguments: [{op: 'argument', index: 0}],
      },
    }, {
      lane,
      bindings: {'cap:loop': {name: 'loop', value: loopProtocol.whileTrue}},
    });
    const loopAct = await runtime.invocations.invokeBlock(loopCallerRef, [wasmCallerRef]);
    await assert.rejects(
      runtime.executor.execute(loopAct),
      (err) => err.name === 'SmalltalkPrimitiveReceiverError'
        && /block-while-true primitive cannot act on no condition; a loop primitive is reachable only by dispatching whileTrue: or whileFalse:/.test(err.message),
    );
  }
});

test('apply inside a Smalltalk method does not lend self/definingBehavior to an external Block, while lexical closures still restore their own creation frame', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  const image = await runtime.images.createImage({id: 'v2-frame-img', name: 'v2-frame'});

  await installSmalltalkKernel({images: runtime.images, imageId: image.id});
  await installSmalltalkControlFlow({images: runtime.images, compilation: runtime.compilation, imageId: image.id});
  await installSmalltalkBlockProtocol({images: runtime.images, compilation: runtime.compilation, imageId: image.id});
  await installSmalltalkAllocationProtocol({images: runtime.images, compilation: runtime.compilation, imageId: image.id});
  const ivarProtocol = await installSmalltalkInstanceVariableProtocol({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: image.id,
  });

  const declared = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId: image.id,
    name: 'Vault',
    instanceVariables: ['secret'],
  });
  const vaultSlots = await instanceVariableBindings({
    images: runtime.images,
    imageId: image.id,
    classRef: declared.classRef,
  });
  const secretSlotId = vaultSlots.secret;

  // An external Block that takes `(target, slotId)` and tries to read `slotId` on `target`
  // by sending `value:value:` to `instance-slot-read` — must fail with `SmalltalkSlotFrameMissingError`
  // even when invoked via `apply` from inside a Smalltalk method on `target`, because `apply` does
  // not lend the method's `activeFrame` to the external Block!
  const snoopingBlockRef = await installV2Block(runtime, image.id, 'snooping-block', {
    parameters: [
      {id: 'target', name: 'target'},
      {id: 'slotId', name: 'slotId'},
    ],
    temporaries: [],
    captures: [{id: 'cap:readSlot', mode: 'snapshot', name: 'readSlot'}],
    body: {
      op: 'send',
      languageId: 'symmetric-smalltalk',
      receiver: {op: 'binding', id: 'cap:readSlot'},
      message: textValue('value:value:'),
      arguments: [
        {op: 'argument', index: 0},
        {op: 'argument', index: 1},
      ],
    },
  }, {
    lane: 'neutral',
    bindings: {'cap:readSlot': {name: 'readSlot', value: ivarProtocol.readPrimitive}},
  });

  for (const lane of ['neutral', 'wasm']) {
    const classDecl = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: image.id,
      name: `Vault_${lane}`,
      instanceVariables: ['secret'],
    });
    const classRef = classDecl.classRef;
    const laneSlots = await instanceVariableBindings({
      images: runtime.images,
      imageId: image.id,
      classRef,
    });
    const slotId = laneSlots.secret;

    await defineMethods({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: image.id,
      classRef,
      lane,
      methods: [
        // 1. Method that applies an external Block passed as argument with `(self, slotId)` —
        //    must NOT lend its Smalltalk frame to the external Block!
        {
          selector: 'runExternal:',
          program: {
            parameters: [{id: 'p0', name: 'aBlock'}],
            temporaries: [],
            captures: [],
            body: {
              op: 'apply',
              callee: {op: 'argument', index: 0},
              arguments: [
                {op: 'receiver'},
                {op: 'literal', value: textValue(slotId)},
              ],
            },
          },
        },
        // 2. Method that creates a lexical closure and applies it via `apply` — the closure
        //    restores its own creation frame from the arena so its `instance-slot-write` /
        //    `instance-slot-read` sends succeed!
        {
          selector: 'writeAndReadViaAppliedClosure:',
          captures: [
            {id: 'cap:writeSlot', name: 'writeSlot', value: ivarProtocol.writePrimitive},
            {id: 'cap:readSlot', name: 'readSlot', value: ivarProtocol.readPrimitive},
          ],
          program: {
            parameters: [{id: 'p0', name: 'newValue'}],
            temporaries: [{id: 'temp:closure', name: 'closure'}],
            captures: [
              {id: 'cap:writeSlot', mode: 'snapshot', name: 'writeSlot'},
              {id: 'cap:readSlot', mode: 'snapshot', name: 'readSlot'},
            ],
            body: {
              op: 'sequence',
              statements: [
                {
                  op: 'binding-write',
                  id: 'temp:closure',
                  value: {
                    op: 'block',
                    blockId: 'inner-closure',
                    captures: [
                      {id: 'cap:self', mode: 'snapshot', name: 'self', value: {op: 'receiver'}},
                      {id: 'cap:writeSlot', mode: 'snapshot', name: 'writeSlot', value: {op: 'binding', id: 'cap:writeSlot'}},
                      {id: 'cap:readSlot', mode: 'snapshot', name: 'readSlot', value: {op: 'binding', id: 'cap:readSlot'}},
                    ],
                    program: {
                      parameters: [{id: 'c0', name: 'val'}],
                      temporaries: [],
                      captures: [
                        {id: 'cap:self', mode: 'snapshot', name: 'self'},
                        {id: 'cap:writeSlot', mode: 'snapshot', name: 'writeSlot'},
                        {id: 'cap:readSlot', mode: 'snapshot', name: 'readSlot'},
                      ],
                      body: {
                        op: 'sequence',
                        statements: [
                          {
                            op: 'send',
                            languageId: 'symmetric-smalltalk',
                            receiver: {op: 'binding', id: 'cap:writeSlot'},
                            message: textValue('value:value:value:'),
                            arguments: [
                              {op: 'binding', id: 'cap:self'},
                              {op: 'literal', value: textValue(slotId)},
                              {op: 'argument', index: 0},
                            ],
                          },
                          {
                            op: 'send',
                            languageId: 'symmetric-smalltalk',
                            receiver: {op: 'binding', id: 'cap:readSlot'},
                            message: textValue('value:value:'),
                            arguments: [
                              {op: 'binding', id: 'cap:self'},
                              {op: 'literal', value: textValue(slotId)},
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
                {
                  op: 'apply',
                  callee: {op: 'binding', id: 'temp:closure'},
                  arguments: [{op: 'argument', index: 0}],
                },
              ],
            },
          },
        },
      ],
    });

    const newAct = await runtime.invocations.sendMessage({
      languageId: 'symmetric-smalltalk',
      receiver: classRef,
      message: textValue('new'),
      arguments: [],
    });
    const instanceRef = await runtime.executor.execute(newAct);

    // External Block applied inside `runExternal:` has no frame and cannot read `self`'s slot
    const externalAct = await runtime.invocations.sendMessage({
      languageId: 'symmetric-smalltalk',
      receiver: instanceRef,
      message: textValue('runExternal:'),
      arguments: [snoopingBlockRef],
    });
    await assert.rejects(
      runtime.executor.execute(externalAct),
      (err) => err.name === 'SmalltalkSlotFrameMissingError',
    );

    // Lexical closure created in `writeAndReadViaAppliedClosure:` and invoked via `apply`
    // restores its creation frame and writes + reads the instance slot
    const closureAct = await runtime.invocations.sendMessage({
      languageId: 'symmetric-smalltalk',
      receiver: instanceRef,
      message: textValue('writeAndReadViaAppliedClosure:'),
      arguments: [integerValue(77)],
    });
    const result = await runtime.executor.execute(closureAct);
    assert.deepEqual(result, integerValue(77));
  }
});

test('apply failure conformance matches between neutral-expression/v2 and WASM lanes for non-Block callees', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  const image = await runtime.images.createImage({id: 'v2-fail-img', name: 'v2-fail'});

  const shape = await runtime.images.putShape(image.id, {id: 'plain-shape', slots: []});
  const plainObj = await runtime.images.putObject(image.id, {
    id: 'plain-obj',
    shape: objectRef(image.id, shape.id),
    slots: {},
  });

  const applyArgProgram = {
    parameters: [{id: 'callee', name: 'callee'}],
    temporaries: [],
    captures: [],
    body: {
      op: 'apply',
      callee: {op: 'argument', index: 0},
      arguments: [],
    },
  };

  const neutralCaller = await installV2Block(runtime, image.id, 'fail-neutral', applyArgProgram, {lane: 'neutral'});
  const wasmCaller = await installV2Block(runtime, image.id, 'fail-wasm', applyArgProgram, {lane: 'wasm'});

  const badCallees = [
    integerValue(42),
    pinnedRef(image.id, 'some-block', 1),
    objectRef(image.id, plainObj.id),
  ];

  for (const badCallee of badCallees) {
    const neutralAct = await runtime.invocations.invokeBlock(neutralCaller, [badCallee]);
    const wasmAct = await runtime.invocations.invokeBlock(wasmCaller, [badCallee]);

    let neutralErr = null;
    let wasmErr = null;
    try {
      await runtime.executor.execute(neutralAct);
    } catch (err) {
      neutralErr = err;
    }
    try {
      await runtime.executor.execute(wasmAct);
    } catch (err) {
      wasmErr = err;
    }

    assert.ok(neutralErr instanceof TypeError, `expected neutral lane TypeError for ${JSON.stringify(badCallee)}`);
    assert.ok(wasmErr instanceof TypeError, `expected WASM lane TypeError for ${JSON.stringify(badCallee)}`);
    assert.equal(neutralErr.message, wasmErr.message);
  }
});
