import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConditionRuntime,
  LAGRANGE_CODE_V0,
  LAGRANGE_CODE_V2,
  NEUTRAL_EXPRESSION_V0,
  WASM_FUNCTION_V2,
  WASM_MODULE_V2,
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V2,
  WASM_VALUE_HANDLE_ABI_V1,
  WasmModuleBudgetExceededError,
  analyzeClosureEscape,
  analyzeLivePlanVariables,
  captureActivationStackReport,
  compileResumableWasmModule,
  compileResumableWasmV2Module,
  compileSymmetricSmalltalkBlock,
  compileWasmV1ModuleEntries,
  createCompilationGroup,
  createRuntime,
  describeWasmFunctionV2,
  describeWasmModuleV2Result,
  installSmalltalkKernel,
  installWasmBlockTree,
  integerValue,
  objectRef,
  optimizeNonEscapingClosures,
  partitionCompilationGroupByBudget,
  readModuleDescriptor,
  textValue,
} from '../src/runtime.js';

test('live-Value-handle liveness analysis eliminates dead handles at WASM suspension points', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  await runtime.images.createImage({id: 'live-handles-img'});

  // Program has 3 parameters (effect, liveArg, deadArg), 2 snapshot captures (liveCap, deadCap),
  // and 1 cell temporary. Before suspending on `effect value`, it computes a dead arithmetic
  // expression using deadArg + deadCap, and a live arithmetic expression using liveArg + liveCap.
  // After resumption, only the live pre-suspension sum and the effect return value are used.
  const program = {
    parameters: [
      {id: 'p:effect', name: 'effect'},
      {id: 'p:liveArg', name: 'liveArg'},
      {id: 'p:deadArg', name: 'deadArg'},
    ],
    temporaries: [{id: 't:scratch', name: 'scratch'}],
    captures: [
      {id: 'c:liveCap', mode: 'snapshot', name: 'liveCap'},
      {id: 'c:deadCap', mode: 'snapshot', name: 'deadCap'},
    ],
    body: {
      op: 'sequence',
      statements: [
        {
          op: 'binding-write',
          id: 't:scratch',
          value: {
            op: 'integer-add',
            left: {op: 'argument', index: 2},
            right: {op: 'binding', id: 'c:deadCap'},
          },
        },
        {
          op: 'integer-add',
          left: {
            op: 'integer-add',
            left: {op: 'argument', index: 1},
            right: {op: 'binding', id: 'c:liveCap'},
          },
          right: {
            op: 'send',
            languageId: 'symmetric-smalltalk',
            message: textValue('value'),
            receiver: {op: 'argument', index: 0},
            arguments: [],
          },
        },
      ],
    },
  };

  const unoptimized = compileResumableWasmV2Module(program, {optimizeLiveHandles: false});
  const optimized = compileResumableWasmV2Module(program, {optimizeLiveHandles: true});

  assert.equal(optimized.liveHandleOptimization.enabled, true);
  assert.ok(
    optimized.effectSites[0].savedCount < unoptimized.effectSites[0].savedCount,
    `expected optimized savedCount (${optimized.effectSites[0].savedCount}) < unoptimized (${unoptimized.effectSites[0].savedCount})`,
  );
  // Only the pre-computed left operand of the outer integer-add needs to survive across the send!
  assert.equal(optimized.effectSites[0].savedCount, 1);
  assert.ok(optimized.liveHandleOptimization.eliminatedHandleCount >= 5);
  assert.equal(optimized.continuations[0].parameters, 2); // 1 saved handle + 1 resumed result handle

  // Verify v0 resumable compiler also eliminates dead handles by default
  const v0Program = {
    version: 0,
    parameters: [
      {id: 'p:effect', name: 'effect'},
      {id: 'p:live', name: 'live'},
      {id: 'p:dead', name: 'dead'},
    ],
    captures: [{id: 'c:unused', name: 'unused'}],
    body: {
      op: 'integer-add',
      left: {
        op: 'send',
        languageId: 'symmetric-smalltalk',
        message: textValue('value'),
        receiver: {op: 'argument', index: 0},
        arguments: [],
      },
      right: {op: 'argument', index: 1},
    },
  };
  const v0Unopt = compileResumableWasmModule(v0Program, {optimizeLiveHandles: false});
  const v0Opt = compileResumableWasmModule(v0Program, {optimizeLiveHandles: true});
  assert.equal(v0Opt.effectSites[0].savedCount, 1); // only $argument:1 is live after the send
  assert.ok(v0Opt.effectSites[0].savedCount < v0Unopt.effectSites[0].savedCount);

  // Execute the optimized v2 module end-to-end and inspect stack report during suspension
  const conditionRuntime = new ConditionRuntime();
  const effectCode = await runtime.images.putCodeArtifact('live-handles-img', {
    id: 'effect-code',
    representation: NEUTRAL_EXPRESSION_V0,
    content: textValue(JSON.stringify({
      parameters: 0,
      body: {op: 'literal', value: integerValue(100)},
    })),
  });
  const effectBlock = await runtime.images.putBlock('live-handles-img', {
    id: 'effect-block',
    code: objectRef('live-handles-img', effectCode.id),
  });

  const semantic = await runtime.images.putCodeArtifact('live-handles-img', {
    id: 'live-prog:semantic',
    languageId: 'symmetric-smalltalk',
    representation: LAGRANGE_CODE_V2,
    content: textValue(JSON.stringify(program)),
  });
  const env = await runtime.images.putLexicalEnvironment('live-handles-img', {
    id: 'live-prog:env',
    bindings: {
      'c:liveCap': {name: 'liveCap', value: integerValue(20)},
      'c:deadCap': {name: 'deadCap', value: integerValue(999)},
    },
  });
  const installed = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('live-handles-img', semantic.id),
    id: 'live-prog:block',
    environment: objectRef('live-handles-img', env.id),
  });

  const act = await runtime.invocations.invokeBlock(
    objectRef('live-handles-img', installed.block.id),
    [objectRef('live-handles-img', effectBlock.id), integerValue(5), integerValue(888)],
  );
  const result = await runtime.executor.execute(act, {conditionRuntime});
  // liveArg (5) + liveCap (20) + effect (100) = 125
  assert.deepEqual(result, integerValue(125));
  const stackReport = captureActivationStackReport(conditionRuntime);
  assert.equal(stackReport.wasmResumptions.length, 2); // suspend + resume
  assert.equal(stackReport.wasmResumptions[0].suspension.savedHandleCount, 1);
});

test('non-escaping closure analysis and inlining eliminate closure materialization and host apply round-trips', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  await runtime.images.createImage({id: 'closure-opt-img'});

  // Program with:
  // 1. A local block binding `bump` that mutates cell `acc` and is applied twice via `apply`
  // 2. An immediate inline block application `apply([ :v | v + 1 ], [acc])`
  const programWithNonEscapingBlocks = {
    parameters: [{id: 'root:step', name: 'step'}],
    temporaries: [
      {id: 'root:acc', name: 'acc'},
      {id: 'root:bump', name: 'bump'},
    ],
    captures: [],
    body: {
      op: 'sequence',
      statements: [
        {op: 'binding-write', id: 'root:acc', value: {op: 'literal', value: integerValue(10)}},
        {
          op: 'binding-write',
          id: 'root:bump',
          value: {
            op: 'block',
            blockId: 'bump-block',
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
          callee: {op: 'binding', id: 'root:bump'},
          arguments: [{op: 'argument', index: 0}],
        },
        {
          op: 'apply',
          callee: {op: 'binding', id: 'root:bump'},
          arguments: [{op: 'argument', index: 0}],
        },
        {
          op: 'apply',
          callee: {
            op: 'block',
            blockId: 'inc-block',
            captures: [],
            program: {
              parameters: [{id: 'inc:x', name: 'x'}],
              temporaries: [],
              captures: [],
              body: {
                op: 'integer-add',
                left: {op: 'argument', index: 0},
                right: {op: 'literal', value: integerValue(1)},
              },
            },
          },
          arguments: [{op: 'binding', id: 'root:acc'}],
        },
      ],
    },
  };

  const escapeReport = analyzeClosureEscape(programWithNonEscapingBlocks);
  assert.deepEqual(escapeReport.nonEscapingBlockIds, ['bump-block', 'inc-block']);
  assert.deepEqual(escapeReport.escapingBlockIds, []);

  const semantic = await runtime.images.putCodeArtifact('closure-opt-img', {
    id: 'closure-opt:semantic',
    languageId: 'symmetric-smalltalk',
    representation: LAGRANGE_CODE_V2,
    content: textValue(JSON.stringify(programWithNonEscapingBlocks)),
  });

  // Falsification baseline: without optimizeClosures, 3 nodes are installed and resumable ABI v2 is required
  const unoptimizedInstall = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('closure-opt-img', semantic.id),
    id: 'closure-unopt:root',
    optimizeClosures: false,
  });
  assert.equal(unoptimizedInstall.nodes.length, 3);
  assert.equal(readModuleDescriptor(unoptimizedInstall.moduleArtifact).abi, WASM_RESUMABLE_VALUE_HANDLE_ABI_V2);
  assert.equal(readModuleDescriptor(unoptimizedInstall.moduleArtifact).closureSites.length, 2);

  // With optimizeClosures: true, both non-escaping closures are inlined; 0 closureSites, 0 sendSites,
  // and the module compiles to the simple non-resumable ABI (lagrange-value-handle/v1)!
  const optimizedInstall = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('closure-opt-img', semantic.id),
    id: 'closure-opt:root',
    optimizeClosures: true,
  });
  assert.equal(optimizedInstall.nodes.length, 1);
  assert.deepEqual(optimizedInstall.closureOptimization.inlinedBlockIds, ['bump-block', 'inc-block']);
  assert.equal(optimizedInstall.closureOptimization.eliminatedClosureSites, 2);
  assert.equal(optimizedInstall.closureOptimization.eliminatedApplySites, 3);

  const optDescriptor = readModuleDescriptor(optimizedInstall.moduleArtifact);
  assert.equal(optDescriptor.abi, WASM_VALUE_HANDLE_ABI_V1);
  assert.equal(optDescriptor.closureSites.length, 0);
  assert.equal(optDescriptor.sendSites.length, 0);
  assert.equal(optDescriptor.effectSites.length, 0);

  const actUnopt = await runtime.invocations.invokeBlock(
    objectRef('closure-opt-img', unoptimizedInstall.block.id),
    [integerValue(7)],
  );
  const actOpt = await runtime.invocations.invokeBlock(
    objectRef('closure-opt-img', optimizedInstall.block.id),
    [integerValue(7)],
  );
  // 10 + 7 + 7 + 1 = 25
  assert.deepEqual(await runtime.executor.execute(actUnopt), integerValue(25));
  assert.deepEqual(await runtime.executor.execute(actOpt), integerValue(25));
});

test('intra-module direct WASM calls execute sibling entries in one shared module without host effects', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  await runtime.images.createImage({id: 'direct-call-img'});

  // Entry 0 (caller) calls Entry 1 (helper) twice in non-tail position:
  //   helper(x) + helper(x + 10)
  // Entry 1 (helper) computes:
  //   a + a
  const callerProgram = {
    parameters: [{id: 'caller:x', name: 'x'}],
    temporaries: [],
    captures: [{id: 'cap:helper', mode: 'snapshot', name: 'helper'}],
    body: {
      op: 'integer-add',
      left: {
        op: 'apply',
        callee: {op: 'binding', id: 'cap:helper'},
        arguments: [{op: 'argument', index: 0}],
      },
      right: {
        op: 'apply',
        callee: {op: 'binding', id: 'cap:helper'},
        arguments: [
          {
            op: 'integer-add',
            left: {op: 'argument', index: 0},
            right: {op: 'literal', value: integerValue(10)},
          },
        ],
      },
    },
  };

  const helperProgram = {
    parameters: [{id: 'helper:a', name: 'a'}],
    temporaries: [],
    captures: [],
    body: {
      op: 'integer-add',
      left: {op: 'argument', index: 0},
      right: {op: 'argument', index: 0},
    },
  };

  // Falsification: without intraModuleCallTargets, non-tail apply in v1 compiler throws WasmV1TailEffectRestrictionError
  assert.throws(
    () => compileWasmV1ModuleEntries([
      {entry: 'run_0', memberIndex: 0, program: callerProgram, allowApply: true},
      {entry: 'run_1', memberIndex: 1, program: helperProgram, allowApply: true},
    ]),
    /supports callable applications only in tail position/,
  );

  // With intraModuleCallTargets mapping 'cap:helper' -> 'run_1', v1 compiler emits direct WASM `call` instructions!
  const compiled = compileWasmV1ModuleEntries(
    [
      {entry: 'run_0', memberIndex: 0, program: callerProgram, allowApply: true},
      {entry: 'run_1', memberIndex: 1, program: helperProgram, allowApply: true},
    ],
    {
      intraModuleCallTargets: {
        'cap:helper': {targetEntry: 'run_1'},
      },
    },
  );
  assert.equal(compiled.sendSites.length, 0);
  assert.equal(compiled.closureSites.length, 0);
  assert.equal(compiled.intraModuleDirectCalls.length, 2);
  assert.deepEqual(compiled.intraModuleDirectCalls[0], {
    callerEntry: 'run_0',
    targetEntry: 'run_1',
    targetMemberIndex: 1,
    arity: 1,
  });

  // Also prove installWasmBlockTree with {intraModuleDirectCalls: true} on a nested block tree
  const treeWithDirectSiblingCalls = {
    parameters: [{id: 'root:x', name: 'x'}],
    temporaries: [],
    captures: [],
    body: {
      op: 'integer-add',
      left: {
        op: 'apply',
        callee: {
          op: 'block',
          blockId: 'double-first',
          captures: [],
          program: helperProgram,
        },
        arguments: [{op: 'argument', index: 0}],
      },
      right: {
        op: 'apply',
        callee: {
          op: 'block',
          blockId: 'double-second',
          captures: [],
          program: helperProgram,
        },
        arguments: [
          {
            op: 'integer-add',
            left: {op: 'argument', index: 0},
            right: {op: 'literal', value: integerValue(10)},
          },
        ],
      },
    },
  };

  const treeSemantic = await runtime.images.putCodeArtifact('direct-call-img', {
    id: 'direct-tree:semantic',
    languageId: 'symmetric-smalltalk',
    representation: LAGRANGE_CODE_V2,
    content: textValue(JSON.stringify(treeWithDirectSiblingCalls)),
  });

  const installedDirectTree = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('direct-call-img', treeSemantic.id),
    id: 'direct-tree:root',
    intraModuleDirectCalls: true,
  });

  const directModuleDesc = readModuleDescriptor(installedDirectTree.moduleArtifact);
  assert.equal(directModuleDesc.abi, WASM_VALUE_HANDLE_ABI_V1);
  assert.equal(directModuleDesc.functions.length, 3); // run_0, run_1, run_2 in shared module
  assert.equal(directModuleDesc.sendSites.length, 0);
  assert.equal(directModuleDesc.closureSites.length, 0);
  assert.equal(installedDirectTree.moduleArtifact.metadata.intraModuleDirectCalls.length, 2);

  const act = await runtime.invocations.invokeBlock(
    objectRef('direct-call-img', installedDirectTree.block.id),
    [integerValue(6)],
  );
  // double(6) + double(6 + 10) = 12 + 32 = 44
  assert.deepEqual(await runtime.executor.execute(act), integerValue(44));
});

test('compilation-group budget splitting partitions large logical groups into bounded WASM module shards', async (t) => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  t.after(async () => await runtime.close());
  await runtime.images.createImage({id: 'budget-split-img'});
  await installSmalltalkKernel({images: runtime.images, imageId: 'budget-split-img'});

  // Nested Smalltalk Block tree with 4 levels (4 group members: root + 3 nested blocks)
  const {semanticProgram} = compileSymmetricSmalltalkBlock(
    '[ :a | [ :b | [ :c | [ :d | a ] ] ] ]',
  );
  const semantic = await runtime.images.putCodeArtifact('budget-split-img', {
    id: 'deep-tree:semantic',
    languageId: 'symmetric-smalltalk',
    representation: LAGRANGE_CODE_V0,
    content: textValue(JSON.stringify(semanticProgram)),
  });

  // Split by maxMembersPerModule = 2 -> 4 members partitioned into 2 physical wasm-module/v2 shards
  const splitInstalled = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('budget-split-img', semantic.id),
    id: 'deep-tree:split',
    moduleBudget: {maxMembersPerModule: 2},
  });

  assert.equal(splitInstalled.nodes.length, 4);
  assert.equal(splitInstalled.moduleArtifacts.length, 2);
  assert.equal(splitInstalled.budgetSplit.shardCount, 2);
  assert.equal(splitInstalled.budgetSplit.maxMembersPerModule, 2);
  for (const shard of splitInstalled.budgetSplit.shards) {
    assert.ok(shard.memberIndices.length <= 2);
  }

  // Verify distinct module artifacts and cross-shard closure execution
  assert.notEqual(splitInstalled.moduleArtifacts[0].id, splitInstalled.moduleArtifacts[1].id);
  for (const mod of splitInstalled.moduleArtifacts) {
    assert.equal(mod.representation, WASM_MODULE_V2);
    assert.equal(readModuleDescriptor(mod).functions.length, 2);
  }

  const invokeValue = async (blockRef, arg) => {
    const activation = await runtime.invocations.sendMessage({
      languageId: 'symmetric-smalltalk',
      receiver: blockRef,
      message: textValue('value:'),
      arguments: [arg],
    });
    return await runtime.executor.execute(activation);
  };

  const rootAct = await runtime.invocations.invokeBlock(
    objectRef('budget-split-img', splitInstalled.block.id),
    [integerValue(10)],
  );
  const c1 = await runtime.executor.execute(rootAct);
  const c2 = await invokeValue(c1, integerValue(20));
  const c3 = await invokeValue(c2, integerValue(30));
  const finalVal = await invokeValue(c3, integerValue(40));
  assert.deepEqual(finalVal, integerValue(10));

  // Also test byte-budget splitting and strictSingleMemberBudget refusal
  const singleMemberBytes = splitInstalled.budgetSplit.shards[0].byteLength;
  const byteSplitInstalled = await installWasmBlockTree({
    images: runtime.images,
    compilation: runtime.compilation,
    semanticRef: objectRef('budget-split-img', semantic.id),
    id: 'deep-tree:byte-split',
    moduleBudget: {maxByteBudget: singleMemberBytes},
  });
  assert.ok(byteSplitInstalled.budgetSplit.shardCount >= 2);
  for (const shard of byteSplitInstalled.budgetSplit.shards) {
    assert.ok(shard.byteLength <= singleMemberBytes);
  }

  await assert.rejects(
    installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('budget-split-img', semantic.id),
      id: 'deep-tree:impossible-budget',
      moduleBudget: {maxByteBudget: 8, strictSingleMemberBudget: true},
    }),
    (err) => err instanceof WasmModuleBudgetExceededError && err.name === 'WasmModuleBudgetExceededError',
  );
});
