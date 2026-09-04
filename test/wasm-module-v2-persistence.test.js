// ygi step 2: the compilation/persistence owner materializes a compiled WASM module as
//   ONE wasm-binary/v1 (exact bytes) + ONE wasm-module/v2 (canonical semantic contract)
//   + exactly ONE role:implementation dependency between them,
// through the generic result-graph path of CompilationService and ONE atomic createRecords batch.
// Compilers hand in facts; the module-contract owner describes the graph once; nothing else knows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import './ensure-node-crypto.test-helper.js';
import {
  LAGRANGE_CODE_V0,
  LAGRANGE_CODE_V1,
  WASM_MODULE_V1,
  WASM_MODULE_V2,
  WASM_INSTANCE_REUSE_STATELESS_V0,
  assembleWasmFunctionArtifact,
  bytesValue,
  createRuntime,
  integerValue,
  objectRef,
  readModuleDescriptor,
  textValue,
} from '../src/runtime.js';
import {assembleWasmV1FunctionArtifact} from '../src/wasm/tree-installer-v1.js';
import {CompilationService, CodeCompilerRegistry} from '../src/compilation/index.js';
import {exportGraphBundle} from '../src/graph/bundle.js';
import {WASM_MODULE_CONTRACT_KEYS, WASM_MODULE_SEMANTIC_MIRROR_KEYS, canonicalJson, encodeModuleContractContent} from '../src/wasm/module-contract.js';

const IMG = 'demo';
const CONTRACT_KEYS = [...WASM_MODULE_CONTRACT_KEYS].sort();

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: IMG});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

const ADD_PROGRAM = {
  parameters: [{id: 'arg:0:value', name: 'value'}],
  captures: [],
  body: {op: 'integer-add', left: {op: 'argument', index: 0}, right: {op: 'literal', value: integerValue(1)}},
};

async function semanticV0(runtime, id, program = ADD_PROGRAM) {
  return await runtime.images.putCodeArtifact(IMG, {id, representation: LAGRANGE_CODE_V0, content: textValue(JSON.stringify(program))});
}

const compileV2 = (runtime, sourceId, id) =>
  runtime.compilation.compileArtifact(objectRef(IMG, sourceId), {id, targetRepresentation: WASM_MODULE_V2});

async function artifactIds(runtime) {
  return (await runtime.images.listCodeArtifacts(IMG)).map((a) => a.id).sort();
}

async function run(runtime, blockRef, args = []) {
  return await runtime.executor.execute(await runtime.invocations.invokeBlock(blockRef, args));
}

test('one compilation persists exactly one wasm-binary/v1 + one wasm-module/v2 with exactly one implementation dependency', async () => {
  await withRuntime(async (runtime) => {
    await semanticV0(runtime, 'src');
    const before = await artifactIds(runtime);
    const module = await compileV2(runtime, 'src', 'mod');
    const after = await artifactIds(runtime);
    assert.deepEqual(after.filter((id) => !before.includes(id)), ['mod', 'mod:implementation'], 'exactly the pair, nothing else');

    assert.equal(module.representation, WASM_MODULE_V2);
    assert.equal(module.content.kind, 'text');
    const deps = module.dependencies;
    assert.equal(deps.length, 1, 'exactly one dependency');
    assert.equal(deps[0].role, 'implementation');
    assert.deepEqual(deps[0].artifact, objectRef(IMG, 'mod:implementation'));

    const binary = await runtime.images.getCodeArtifact(IMG, 'mod:implementation');
    assert.equal(binary.representation, 'wasm-binary/v1');
    assert.equal(binary.content.kind, 'bytes');
    assert.ok(Buffer.from(binary.content.base64, 'base64').length > 8, 'the binary holds the compiled bytes');
    assert.deepEqual(binary.dependencies, [], 'the binary depends on nothing');
    // Both records derive from the same source (provenance), but only the descriptor is the compilation's result.
    assert.deepEqual(module.derivedFrom, [objectRef(IMG, 'src')]);
    assert.deepEqual(binary.derivedFrom, [objectRef(IMG, 'src')]);
  });
});

test('single authority: bytes occur only in the binary, the implementation reference only in the dependency edge, and the descriptor is canonical JSON of exactly the contract', async () => {
  await withRuntime(async (runtime) => {
    await semanticV0(runtime, 'src');
    const module = await compileV2(runtime, 'src', 'mod');
    const binary = await runtime.images.getCodeArtifact(IMG, 'mod:implementation');
    const text = module.content.value;
    const decoded = JSON.parse(text);
    assert.deepEqual(Object.keys(decoded).sort(), CONTRACT_KEYS, 'content carries exactly the contract keys');
    assert.ok(!text.includes(binary.content.base64), 'no base64 copy of the bytes in the descriptor');
    assert.ok(!/"bytes"|"implementation"|"objectId"|"imageId"|mod:implementation/.test(text), 'no bytes field and no implementation reference in JSON');
    // Canonical: re-encoding the decoded contract reproduces the stored bytes exactly.
    assert.equal(encodeModuleContractContent(decoded), text);
    // And the accessor reads the same contract back (no independent decode path in the test).
    assert.deepEqual(readModuleDescriptor(module), JSON.parse(text));
  });
});

test('meaning-required fields live in content and are absent from provenance metadata; instanceReuse stays provenance only', async () => {
  await withRuntime(async (runtime) => {
    await semanticV0(runtime, 'src');
    const module = await compileV2(runtime, 'src', 'mod', {});
    const md = module.metadata;
    for (const key of [...WASM_MODULE_CONTRACT_KEYS, ...WASM_MODULE_SEMANTIC_MIRROR_KEYS]) {
      assert.ok(!Object.hasOwn(md, key), `semantic field ${key} must not be in v2 metadata`);
    }
    assert.equal(md.instanceReuse, WASM_INSTANCE_REUSE_STATELESS_V0, 'instanceReuse is emitted as provenance');
    assert.ok(!module.content.value.includes('instanceReuse'), 'and never enters the identity-bearing content');
    assert.equal(md.semanticRepresentation, LAGRANGE_CODE_V0);
    assert.ok(typeof md.compilerIdentity === 'string' && typeof md.derivationKey === 'string', 'cache metadata rides on the descriptor');
    const binary = await runtime.images.getCodeArtifact(IMG, 'mod:implementation');
    assert.deepEqual(binary.metadata, {}, 'the binary carries no metadata of its own');
    const contract = JSON.parse(module.content.value);
    assert.equal(contract.functions.length, 1);
    assert.equal(contract.functions[0].entry, 'run');
    assert.equal(contract.functions[0].parameters, 1);
  });
});

test('the v1 lexical-cell ABI keeps cellBindings inside the v2 function descriptors; the v0 ABI keeps them absent', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.putCodeArtifact(IMG, {
      id: 'src-v1', representation: LAGRANGE_CODE_V1,
      content: textValue(JSON.stringify({
        parameters: [], temporaries: [{id: 'root:temporary:0', name: 'a'}], captures: [],
        body: {op: 'sequence', statements: [
          {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(7)}},
          {op: 'binding', id: 'root:temporary:0'},
        ]},
      })),
    });
    const v1Module = await compileV2(runtime, 'src-v1', 'mod-v1');
    const cells = readModuleDescriptor(v1Module).functions[0];
    assert.ok(Array.isArray(cells.cellBindings) && cells.cellBindings.length === 1, 'cellBindings preserved in v2 content');
    assert.deepEqual(Object.keys(cells).sort(), ['captures', 'cellBindings', 'closureSiteIndices', 'entry', 'memberIndex', 'parameters', 'sendSiteIndices']);

    await semanticV0(runtime, 'src-v0');
    const v0Module = await compileV2(runtime, 'src-v0', 'mod-v0');
    const plain = readModuleDescriptor(v0Module).functions[0];
    assert.ok(!Object.hasOwn(plain, 'cellBindings'), 'the v0 ABI descriptor has no cellBindings key (exact-key contract)');
  });
});

test('identity matrix: bytes + contract bind module identity; provenance does not', async () => {
  await withRuntime(async (runtime) => {
    const A = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1]);
    const B = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2]);
    const contract = {abi: 'x/v0', literals: [1], functions: [{entry: 'run', memberIndex: 0, parameters: 0, captures: [], sendSiteIndices: [], closureSiteIndices: []}], sendSites: [], closureSites: [], effectSites: []};
    const contract2 = {...contract, literals: [2]};
    const mk = async (name, bytes, c, metadata = {}) => {
      await runtime.images.putCodeArtifact(IMG, {id: `${name}:bin`, representation: 'wasm-binary/v1', content: bytesValue(bytes)});
      await runtime.images.putCodeArtifact(IMG, {
        id: name, representation: WASM_MODULE_V2, content: textValue(encodeModuleContractContent(c)),
        dependencies: [{role: 'implementation', artifact: objectRef(IMG, `${name}:bin`)}], metadata,
      });
      return (await exportGraphBundle({images: runtime.images, roots: {root: objectRef(IMG, name)}})).contentIdentity;
    };
    const base = await mk('m1', A, contract);
    assert.equal(await mk('m2', A, contract), base, 'identical contract + identical bytes => identical identity');
    assert.notEqual(await mk('m3', B, contract), base, 'identical contract + different bytes => different identity');
    assert.notEqual(await mk('m4', A, contract2), base, 'different contract + identical bytes => different identity');
    assert.equal(await mk('m5', A, contract, {instanceReuse: 'stateless-v0', note: 'provenance'}), base, 'provenance-only difference => unchanged identity');
  });
});

test('canonical serialization is independent of JS insertion/key order at every depth', () => {
  const a = {abi: 'x', literals: [{b: 1, a: 2}], functions: [{entry: 'run', memberIndex: 0, parameters: 0, captures: [], cellBindings: [{source: 'temporary', id: 't', name: 'n'}], sendSiteIndices: [], closureSiteIndices: []}], sendSites: [{message: 'm', languageId: 'l', arity: 0}], closureSites: [], effectSites: []};
  const b = {effectSites: [], closureSites: [], sendSites: [{arity: 0, languageId: 'l', message: 'm'}], functions: [{closureSiteIndices: [], sendSiteIndices: [], cellBindings: [{name: 'n', id: 't', source: 'temporary'}], captures: [], parameters: 0, memberIndex: 0, entry: 'run'}], literals: [{a: 2, b: 1}], abi: 'x'};
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'plain JSON.stringify follows insertion order');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(encodeModuleContractContent(a), encodeModuleContractContent(b));
});

test('atomicity and convergence: the descriptor is never visible without its implementation; an identical pair is reused; a differing or partial pair is refused', async () => {
  await withRuntime(async (runtime) => {
    await semanticV0(runtime, 'src');
    // (a) the implementation id is already occupied by something else: ensureCodeArtifacts refuses
    //     the whole graph before any write, so the descriptor never appears.
    await runtime.images.putCodeArtifact(IMG, {id: 'taken:implementation', representation: 'wasm-binary/v1', content: bytesValue(new Uint8Array([1, 2, 3]))});
    await assert.rejects(compileV2(runtime, 'src', 'taken'), (e) => e?.name === 'RecordConflictError');
    assert.equal(await runtime.images.getCodeArtifact(IMG, 'taken'), null, 'no descriptor without its binary');
    // (b) a PARTIAL pair — the sibling already present and IDENTICAL to what the compile would
    //     write, the primary absent — is refused by the partial-graph rule, never completed in
    //     place (an implementation that filled in the missing half would pass this wrongly).
    const reference = await compileV2(runtime, 'src', 'ref');
    const referenceBinary = await runtime.images.getCodeArtifact(IMG, 'ref:implementation');
    await runtime.images.putCodeArtifact(IMG, {
      id: 'half:implementation', languageId: referenceBinary.languageId, representation: referenceBinary.representation,
      content: referenceBinary.content, derivedFrom: referenceBinary.derivedFrom, metadata: referenceBinary.metadata,
    });
    await assert.rejects(
      runtime.compilation.compileArtifact(objectRef(IMG, 'src'), {id: 'half', targetRepresentation: WASM_MODULE_V2, reuse: false}),
      (e) => e?.name === 'RecordConflictError',
    );
    assert.equal(await runtime.images.getCodeArtifact(IMG, 'half'), null, 'the descriptor was not created over a partial graph');
    assert.ok(reference);
    // (c) an identical pair converges: the second compile with reuse disabled writes nothing.
    const first = await runtime.compilation.compileArtifact(objectRef(IMG, 'src'), {id: 'mod', targetRepresentation: WASM_MODULE_V2, reuse: false});
    assert.equal(first.id, 'mod');
    const count = (await artifactIds(runtime)).length;
    const again = await runtime.compilation.compileArtifact(objectRef(IMG, 'src'), {id: 'mod', targetRepresentation: WASM_MODULE_V2, reuse: false});
    assert.equal(again.id, first.id);
    assert.equal((await artifactIds(runtime)).length, count, 'nothing new written');
    // (d) derivation reuse also finds the v2 descriptor (cache metadata rides on the primary).
    const reused = await runtime.compilation.compileArtifact(objectRef(IMG, 'src'), {id: 'other-id', targetRepresentation: WASM_MODULE_V2});
    assert.ok(['ref', 'mod'].includes(reused.id), 'the reusable derivation is an existing descriptor (never a fresh graph)');
    assert.equal(await runtime.images.getCodeArtifact(IMG, 'other-id'), null);
  });
});

test('the result-graph path is generic: a non-WASM compiler can persist a sibling graph atomically, and malformed graphs are rejected before any write', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.putCodeArtifact(IMG, {id: 'src', representation: 'test-source/v1', content: textValue('x')});
    const compilers = new CodeCompilerRegistry();
    compilers.register('test-source/v1', 'test-pair/v1', {
      async compile({source}) {
        return {
          primary: 'main',
          artifacts: [
            {key: 'aux', representation: 'test-aux/v1', content: textValue(`aux of ${source.content.value}`)},
            {key: 'main', representation: 'test-pair/v1', content: textValue('main'), dependencies: [{role: 'implementation', artifact: 'aux'}]},
          ],
        };
      },
    });
    compilers.register('test-source/v1', 'bad-primary/v1', {async compile() { return {primary: 'nope', artifacts: [{key: 'a', representation: 'bad-primary/v1', content: textValue('a')}]}; }});
    compilers.register('test-source/v1', 'bad-sibling/v1', {async compile() { return {primary: 'a', artifacts: [{key: 'a', representation: 'bad-sibling/v1', content: textValue('a'), dependencies: [{role: 'x', artifact: 'missing'}]}]}; }});
    const service = new CompilationService({images: runtime.images, compilers});

    const main = await service.compileArtifact(objectRef(IMG, 'src'), {targetRepresentation: 'test-pair/v1', id: 'pair'});
    assert.equal(main.id, 'pair');
    assert.deepEqual(main.dependencies[0].artifact, objectRef(IMG, 'pair:aux'));
    assert.equal((await runtime.images.getCodeArtifact(IMG, 'pair:aux')).content.value, 'aux of x');

    const before = await artifactIds(runtime);
    await assert.rejects(service.compileArtifact(objectRef(IMG, 'src'), {targetRepresentation: 'bad-primary/v1', id: 'p1'}), /primary nope is not among/);
    await assert.rejects(service.compileArtifact(objectRef(IMG, 'src'), {targetRepresentation: 'bad-sibling/v1', id: 'p2'}), /unknown sibling missing/);
    assert.deepEqual(await artifactIds(runtime), before, 'a malformed graph writes nothing');
  });
});

test('a v2-compiled module executes through the v0 lane and the v1 lexical-cell lane, reading bytes only via the implementation dependency', async () => {
  await withRuntime(async (runtime) => {
    // v0 lane
    await semanticV0(runtime, 'src');
    const module = await compileV2(runtime, 'src', 'mod');
    const {functionArtifact} = await assembleWasmFunctionArtifact({
      images: runtime.images, semanticRef: objectRef(IMG, 'src'), moduleRef: objectRef(IMG, module.id), functionId: 'fn', entry: 'run',
    });
    const block = await runtime.images.putBlock(IMG, {id: 'blk', code: objectRef(IMG, functionArtifact.id), environment: null});
    assert.deepEqual(await run(runtime, objectRef(IMG, block.id), [integerValue(41)]), integerValue(42));

    // v1 lexical-cell lane
    await runtime.images.putCodeArtifact(IMG, {
      id: 'src-v1', representation: LAGRANGE_CODE_V1,
      content: textValue(JSON.stringify({
        parameters: [], temporaries: [{id: 'root:temporary:0', name: 'a'}], captures: [],
        body: {op: 'sequence', statements: [
          {op: 'binding-write', id: 'root:temporary:0', value: {op: 'literal', value: integerValue(7)}},
          {op: 'binding', id: 'root:temporary:0'},
        ]},
      })),
    });
    const v1Module = await compileV2(runtime, 'src-v1', 'mod-v1');
    const assembled = await assembleWasmV1FunctionArtifact({
      images: runtime.images, semanticRef: objectRef(IMG, 'src-v1'), moduleRef: objectRef(IMG, v1Module.id), functionId: 'fn-v1', entry: 'run',
    });
    const block2 = await runtime.images.putBlock(IMG, {id: 'blk-v1', code: objectRef(IMG, assembled.functionArtifact.id), environment: null});
    assert.deepEqual(await run(runtime, objectRef(IMG, block2.id)), integerValue(7));

    // The executor recovered the bytes only through the dependency: stripping the module's
    // metadata entirely changes nothing about execution (meaning is in content + edge).
    const stripped = {...module, metadata: {}};
    assert.deepEqual(readModuleDescriptor(stripped), readModuleDescriptor(module));
  });
});

test('frozen v1 stays readable and behavior-identical: a v1 artifact built from the same contract and bytes decodes to the same contract and still executes; nothing produces new v1', async () => {
  await withRuntime(async (runtime) => {
    await semanticV0(runtime, 'src');
    const v2 = await compileV2(runtime, 'src', 'm2');
    const binary = await runtime.images.getCodeArtifact(IMG, 'm2:implementation');
    // The frozen v1 form (contract in metadata, bytes as content), as an older image persisted it.
    const v1 = await runtime.images.putCodeArtifact(IMG, {
      id: 'm1', representation: WASM_MODULE_V1, content: binary.content,
      metadata: {...JSON.parse(v2.content.value), semanticRepresentation: LAGRANGE_CODE_V0, instanceReuse: WASM_INSTANCE_REUSE_STATELESS_V0},
    });
    assert.equal(canonicalJson(readModuleDescriptor(v1)), canonicalJson(readModuleDescriptor(v2)), 'identical executable contract through the one accessor');
    // The v1 artifact still executes in-image through the frozen path.
    const {functionArtifact} = await assembleWasmFunctionArtifact({
      images: runtime.images, semanticRef: objectRef(IMG, 'src'), moduleRef: objectRef(IMG, v1.id), functionId: 'fn1', entry: 'run',
    });
    const block = await runtime.images.putBlock(IMG, {id: 'b1', code: objectRef(IMG, functionArtifact.id), environment: null});
    assert.deepEqual(await run(runtime, objectRef(IMG, block.id), [integerValue(1)]), integerValue(2));
    // No compiler produces v1 any more: the target is not registered (no dual-write).
    assert.equal(runtime.codeCompilers.has(LAGRANGE_CODE_V0, WASM_MODULE_V1), false);
    assert.equal(runtime.codeCompilers.has(LAGRANGE_CODE_V0, WASM_MODULE_V2), true);
    await assert.rejects(
      runtime.compilation.compileArtifact(objectRef(IMG, 'src'), {id: 'never', targetRepresentation: WASM_MODULE_V1}),
      (e) => e?.name === 'CodeCompilerNotFoundError',
    );
  });
});

test("a group compilation inherits the members' common languageId (the describer states none, the service falls back)", async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.putCodeArtifact(IMG, {id: 'src-lang', languageId: 'symmetric-smalltalk', representation: LAGRANGE_CODE_V0, content: textValue(JSON.stringify(ADD_PROGRAM))});
    const module = await runtime.compilation.compileArtifact(objectRef(IMG, 'src-lang'), {id: 'mod-lang', targetRepresentation: WASM_MODULE_V2});
    assert.equal(module.languageId, 'symmetric-smalltalk');
    assert.equal((await runtime.images.getCodeArtifact(IMG, 'mod-lang:implementation')).languageId, 'symmetric-smalltalk');
    const {installWasmBlockTree} = await import('../src/runtime.js');
    await runtime.images.putCodeArtifact(IMG, {id: 'tree-src', languageId: 'symmetric-smalltalk', representation: LAGRANGE_CODE_V0, content: textValue(JSON.stringify(ADD_PROGRAM))});
    const tree = await installWasmBlockTree({images: runtime.images, compilation: runtime.compilation, semanticRef: objectRef(IMG, 'tree-src'), id: 'tree'});
    assert.equal(tree.moduleArtifact.languageId, 'symmetric-smalltalk', "group compilers state no languageId; the service derives the members' common one");
  });
});

test('the frozen v1 decoder also reads the oldest v1 sub-form (no functions table) exactly as the executors used to', async () => {
  await withRuntime(async (runtime) => {
    await semanticV0(runtime, 'src');
    const v2 = await compileV2(runtime, 'src', 'm2');
    const binary = await runtime.images.getCodeArtifact(IMG, 'm2:implementation');
    const contract = JSON.parse(v2.content.value);
    const [fn] = contract.functions;
    const old = await runtime.images.putCodeArtifact(IMG, {
      id: 'm-old', representation: WASM_MODULE_V1, content: binary.content,
      metadata: {abi: contract.abi, entry: fn.entry, parameters: fn.parameters, captures: fn.captures, literals: contract.literals, sendSites: contract.sendSites, closureSites: contract.closureSites},
    });
    assert.deepEqual(readModuleDescriptor(old).functions, contract.functions, 'the single entry is synthesized from the top-level mirrors');
    const {functionArtifact} = await assembleWasmFunctionArtifact({images: runtime.images, semanticRef: objectRef(IMG, 'src'), moduleRef: objectRef(IMG, old.id), functionId: 'fn-old', entry: 'run'});
    const block = await runtime.images.putBlock(IMG, {id: 'b-old', code: objectRef(IMG, functionArtifact.id), environment: null});
    assert.deepEqual(await run(runtime, objectRef(IMG, block.id), [integerValue(1)]), integerValue(2));
  });
});

test('a v2 descriptor is refused unless its content IS the canonical serialization of a valid contract', async () => {
  await withRuntime(async (runtime) => {
    await semanticV0(runtime, 'src');
    const v2 = await compileV2(runtime, 'src', 'm2');
    const contract = JSON.parse(v2.content.value);
    const dep = v2.dependencies;
    const put = (id, text) => runtime.images.putCodeArtifact(IMG, {id, representation: WASM_MODULE_V2, content: textValue(text), dependencies: dep});
    // Same contract, pretty-printed: same meaning, different bytes -> not canonical -> not a v2 module.
    const pretty = await put('pretty', JSON.stringify(contract, null, 2));
    assert.throws(() => readModuleDescriptor(pretty), /not the canonical serialization/);
    // An extra descriptor key survives parsing but not normalization -> refused rather than silently dropped.
    const extra = await put('extra', canonicalJson({...contract, functions: [{...contract.functions[0], extra: 1}]}));
    assert.throws(() => readModuleDescriptor(extra), /not the canonical serialization/);
    // Non-finite numbers cannot enter identity-bearing content at all.
    assert.throws(() => encodeModuleContractContent({...contract, functions: [{...contract.functions[0], parameters: Number.NaN}]}), /parameters must be a non-negative integer/);
    assert.throws(() => canonicalJson({a: Infinity}), /must be a finite number/);
    assert.throws(() => canonicalJson({a: undefined}), /undefined/);
  });
});
