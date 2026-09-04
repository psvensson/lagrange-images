// wasm-function/v2 (ADR 0082, bead lagrange-images-o8a): a function artifact owns ONLY its entry
// selection and closure-prototype binding, as identity-bearing canonical content, and reaches its
// module through exactly one role:module dependency. ABI, arity, captures and cellBindings are the
// module's function-table entry — never duplicated on the function. wasm-function/v1 is frozen.
import test from 'node:test';
import assert from 'node:assert/strict';
import './ensure-node-crypto.test-helper.js';
import {
  LAGRANGE_CODE_V0,
  WASM_FUNCTION_V1,
  WASM_FUNCTION_V2,
  WASM_MODULE_V2,
  WASM_VALUE_HANDLE_ABI_V0,
  assembleWasmFunctionArtifact,
  compileWasmFunctionArtifact,
  createRuntime,
  describeWasmFunctionV2,
  encodeFunctionSelectionContent,
  integerValue,
  moduleFunctionOf,
  objectRef,
  readFunctionSelection,
  readModuleDescriptor,
  resolveFunctionContract,
  textValue,
} from '../src/runtime.js';
import {exportGraphBundle} from '../src/graph/bundle.js';

const IMG = 'demo';
async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: IMG});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}
const ADD_ONE = {
  parameters: [{id: 'arg:0:value', name: 'value'}], captures: [],
  body: {op: 'integer-add', left: {op: 'argument', index: 0}, right: {op: 'literal', value: integerValue(1)}},
};
async function run(runtime, blockRef, args = []) {
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(blockRef, args));
}
async function compiled(runtime, id = 'f') {
  await runtime.images.putCodeArtifact(IMG, {id: `${id}:src`, representation: LAGRANGE_CODE_V0, content: textValue(JSON.stringify(ADD_ONE))});
  return await compileWasmFunctionArtifact({images: runtime.images, compilation: runtime.compilation, semanticRef: objectRef(IMG, `${id}:src`), moduleId: `${id}:module`, functionId: `${id}:function`});
}
const identityOf = (runtime, id) => exportGraphBundle({images: runtime.images, roots: {root: objectRef(IMG, id)}}).then((b) => b.contentIdentity);

test('a compiled function is wasm-function/v2: canonical selection content, one module dependency, no module mirror anywhere', async () => {
  await withRuntime(async (runtime) => {
    const {functionArtifact, moduleArtifact} = await compiled(runtime);
    assert.equal(functionArtifact.representation, WASM_FUNCTION_V2);
    assert.equal(functionArtifact.content.kind, 'text');
    const selection = JSON.parse(functionArtifact.content.value);
    assert.deepEqual(Object.keys(selection).sort(), ['closurePrototypes', 'entry']);
    assert.equal(selection.entry, 'run');
    assert.equal(encodeFunctionSelectionContent(selection), functionArtifact.content.value, 'content is canonical');
    assert.deepEqual(functionArtifact.dependencies, [{role: 'module', artifact: objectRef(IMG, moduleArtifact.id)}]);
    assert.deepEqual(functionArtifact.metadata, {});
    for (const mirror of ['abi', 'parameters', 'captures', 'cellBindings']) {
      assert.ok(!functionArtifact.content.value.includes(`"${mirror}"`), `${mirror} is the module's, not the function's`);
    }
    // The executable facts come from the module through the accessor.
    const fn = resolveFunctionContract(functionArtifact, readModuleDescriptor(moduleArtifact));
    assert.equal(fn.abi, WASM_VALUE_HANDLE_ABI_V0);
    assert.equal(fn.descriptor.parameters, 1);
    assert.equal(fn.entry, 'run');
    // No compiler or assembler produces v1 any more.
    assert.equal(runtime.codeExecutors.has(WASM_FUNCTION_V2), true);
    assert.equal(runtime.codeExecutors.has(WASM_FUNCTION_V1), true, 'the frozen version stays executable');
    const block = await runtime.images.putBlock(IMG, {id: 'b', code: objectRef(IMG, functionArtifact.id), environment: null});
    assert.deepEqual(await run(runtime, objectRef(IMG, block.id), [integerValue(41)]), integerValue(42));
  });
});

test('identity: entry selection over an identical module changes function identity; provenance does not; two entries of one module are distinct', async () => {
  await withRuntime(async (runtime) => {
    // A two-entry module: compile a nested group via the tree installer is heavier than needed;
    // build a v2 module by hand from a compiled one with a second (aliased) function entry.
    const {moduleArtifact} = await compiled(runtime, 'base');
    const contract = JSON.parse(moduleArtifact.content.value);
    const twoEntries = {...contract, functions: [contract.functions[0], {...contract.functions[0], entry: 'run_alias', memberIndex: 1}]};
    const {encodeModuleContractContent} = await import('../src/wasm/module-contract.js');
    await runtime.images.putCodeArtifact(IMG, {id: 'two', representation: WASM_MODULE_V2, content: textValue(encodeModuleContractContent(twoEntries)), dependencies: moduleArtifact.dependencies});
    const mk = async (id, entry, metadata = {}) => {
      const input = describeWasmFunctionV2({functionId: id, languageId: null, semanticRef: objectRef(IMG, 'base:src'), moduleRef: objectRef(IMG, 'two'), entry});
      await runtime.images.putCodeArtifact(IMG, {...input, metadata});
      return await identityOf(runtime, id);
    };
    const a = await mk('fa', 'run');
    assert.equal(await mk('fb', 'run'), a, 'same module + same entry => same identity');
    assert.notEqual(await mk('fc', 'run_alias'), a, 'same module + different entry => different identity');
    assert.equal(await mk('fd', 'run', {note: 'provenance only'}), a, 'provenance-only difference => unchanged identity');
  });
});

test('the frozen v1 function still executes in-image, and its mirrors are cross-checked against the module exactly as before', async () => {
  await withRuntime(async (runtime) => {
    const {moduleArtifact} = await compiled(runtime, 'old');
    const descriptor = readModuleDescriptor(moduleArtifact);
    const entry = moduleFunctionOf(descriptor, {entry: 'run'});
    const v1 = await runtime.images.putCodeArtifact(IMG, {
      id: 'fn-v1', representation: WASM_FUNCTION_V1, content: objectRef(IMG, moduleArtifact.id),
      derivedFrom: [objectRef(IMG, 'old:src'), objectRef(IMG, moduleArtifact.id)],
      metadata: {abi: descriptor.abi, entry: 'run', parameters: entry.parameters, captures: entry.captures, closurePrototypes: []},
    });
    assert.equal(readFunctionSelection(v1).entry, 'run');
    const block = await runtime.images.putBlock(IMG, {id: 'b-v1', code: objectRef(IMG, v1.id), environment: null});
    assert.deepEqual(await run(runtime, objectRef(IMG, block.id), [integerValue(1)]), integerValue(2));
    // A v1 whose mirror disagrees with the module is refused (the frozen contract's own rule).
    const lying = await runtime.images.putCodeArtifact(IMG, {
      id: 'fn-lie', representation: WASM_FUNCTION_V1, content: objectRef(IMG, moduleArtifact.id),
      derivedFrom: [objectRef(IMG, 'old:src'), objectRef(IMG, moduleArtifact.id)],
      metadata: {abi: descriptor.abi, entry: 'run', parameters: 7, captures: [], closurePrototypes: []},
    });
    assert.throws(() => resolveFunctionContract(lying, descriptor), /parameter metadata does not match/);
    // Nothing produces v1: the assembler writes v2.
    const {functionArtifact} = await assembleWasmFunctionArtifact({images: runtime.images, semanticRef: objectRef(IMG, 'old:src'), moduleRef: objectRef(IMG, moduleArtifact.id), functionId: 'fn-new', entry: 'run'});
    assert.equal(functionArtifact.representation, WASM_FUNCTION_V2);
  });
});

test('a v2 function is refused unless its content is the canonical selection and it names exactly one module', async () => {
  await withRuntime(async (runtime) => {
    const {moduleArtifact} = await compiled(runtime, 'c');
    const dep = [{role: 'module', artifact: objectRef(IMG, moduleArtifact.id)}];
    const put = (id, extra) => runtime.images.putCodeArtifact(IMG, {id, representation: WASM_FUNCTION_V2, ...extra});
    const pretty = await put('pretty', {content: textValue(JSON.stringify({entry: 'run', closurePrototypes: []}, null, 2)), dependencies: dep});
    assert.throws(() => readFunctionSelection(pretty), /not the canonical serialization/);
    const mirror = await put('mirror', {content: textValue(encodeFunctionSelectionContent({entry: 'run', closurePrototypes: []}).replace('{', '{"abi":"x",')), dependencies: dep});
    assert.throws(() => readFunctionSelection(mirror), /must contain exactly/);
    const noModule = await put('nomod', {content: textValue(encodeFunctionSelectionContent({entry: 'run', closurePrototypes: []})), dependencies: []});
    assert.throws(() => readFunctionSelection(noModule), /exactly one module dependency/);
    assert.throws(() => describeWasmFunctionV2({functionId: 'x', semanticRef: objectRef(IMG, 'c:src'), moduleRef: objectRef(IMG, moduleArtifact.id), entry: 'run', closurePrototypes: [{blockId: 'b', siteIndex: 0, derivedFromIndex: 2}]}), /names no supplied prototype/);
  });
});
