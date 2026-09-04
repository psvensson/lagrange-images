// Common Lisp through the existing foreign-runtime contracts (bead lagrange-images-9p4): the
// language-neutrality falsifier, proven here with a fake SBCL session so the GENERIC wiring is
// the thing under test — definition resolution, provider binding, callable installation and
// execution, the neutral stdio value bridge — while the real SBCL proof lives in
// test/common-lisp-sbcl-real.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, stat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  COMMON_LISP_SBCL_PROVIDER_ID,
  COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1,
  COMMON_LISP_SOURCE_V1,
  COMMON_LISP_STDIO_BRIDGE_V1,
  CommonLispCallError,
  createArtifactBackedCommonLispSbclProvider,
  createCommonLispRuntimeDefinitionContent,
  createCommonLispStdioBridgeSource,
  createRuntime,
  decodeBridgeValue,
  encodeBridgeValue,
  installForeignRuntimeCallable,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

// A stand-in for the SBCL process: answers the framing the generated bridge would, computes the
// two demo exports, and records everything the provider asked of the process.
class FakeSbclSession {
  constructor(request) {
    this.request = request;
    this.written = [];
    this.lines = [`READY\t${COMMON_LISP_STDIO_BRIDGE_V1}`];
  }
  async writeLine(line) {
    this.written.push(line);
    const fields = line.split('\t');
    if (fields[0] === 'QUIT') { this.lines.push('BYE'); return; }
    const [, id, service, operation, ...args] = fields;
    if (service === 'demo' && operation === 'add') { this.lines.push(`OK\t${id}\ti:${BigInt(args[0].slice(2)) + BigInt(args[1].slice(2))}`); return; }
    if (service === 'demo' && operation === 'shout') { this.lines.push(`OK\t${id}\t${encodeBridgeValue(textValue(`${decodeBridgeValue(args[0]).value.toUpperCase()}!`))}`); return; }
    this.lines.push(`ERR\t${id}\tnot-exported`);
  }
  async nextLine() {
    if (this.lines.length === 0) throw new Error('fake SBCL session has no queued output');
    return this.lines.shift();
  }
  async waitForExit() { return {code: 0, signal: null, stderr: ''}; }
  kill() {}
  stderrText() { return ''; }
}
class FakeSbclRunner {
  constructor() { this.starts = []; this.sessions = []; }
  async start(request) {
    this.starts.push(request);
    const session = new FakeSbclSession(request);
    this.sessions.push(session);
    return session;
  }
}

const EXPORTS = [
  {service: 'demo', operation: 'add', function: 'demo-add', arity: 2},
  {service: 'demo', operation: 'shout', function: 'demo-shout', arity: 1},
];
const SOURCE = '(defun demo-add (a b) (+ a b))\n(defun demo-shout (s) (string-upcase (concatenate (quote string) s "!")))\n';

async function author(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  const source = await runtime.images.putCodeArtifact(imageId, {
    id: 'demo-source', languageId: 'common-lisp', representation: COMMON_LISP_SOURCE_V1, content: textValue(SOURCE), logicalPath: 'demo.lisp',
  });
  const definition = await runtime.images.putCodeArtifact(imageId, {
    id: 'demo-runtime', languageId: 'common-lisp', representation: COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1,
    content: textValue(createCommonLispRuntimeDefinitionContent({exports: EXPORTS})),
    dependencies: [{role: 'source', artifact: objectRef(imageId, source.id)}],
  });
  return {source, definition};
}

function composeRuntime(runner) {
  const provider = createArtifactBackedCommonLispSbclProvider({sbclPath: '/usr/bin/sbcl', sbclIdentity: 'sbcl/test', runner, workspaceRoot: '/tmp/claude-test-lisp'});
  return createRuntime({
    backend: {mode: 'mock'},
    foreignRuntimeProviders: [[COMMON_LISP_SBCL_PROVIDER_ID, provider]],
    foreignRuntimeDefinitionBindings: [[COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1, COMMON_LISP_SBCL_PROVIDER_ID]],
  });
}

test('a Common Lisp function is reachable through the GENERIC path: source artifact -> definition -> binding -> callable Block -> foreign runtime -> Value', async () => {
  const runner = new FakeSbclRunner();
  const runtime = await composeRuntime(runner);
  try {
    const {definition, source} = await author(runtime, 'img');
    const {interfaceArtifact, block} = await installForeignRuntimeCallable({
      images: runtime.images, imageId: 'img', runtimeDefinition: objectRef('img', definition.id),
      interface: {service: 'demo', operation: 'add'}, argumentCount: 2, interfaceId: 'add-interface', blockId: 'add-block',
    });
    assert.equal(interfaceArtifact.representation, 'foreign-runtime-callable-interface/v1');
    const activation = await runtime.invocations.invokeBlock(objectRef('img', block.id), [integerValue(40), integerValue(2)]);
    assert.deepEqual(await runtime.executor.execute(activation), integerValue(42));

    // What the provider asked of the process: the pinned executable, the generated bridge, the
    // materialized source in the transient workspace — and nothing else.
    assert.equal(runner.starts.length, 1, 'one runtime instance for the definition');
    const start = runner.starts[0];
    assert.equal(start.command, '/usr/bin/sbcl');
    assert.deepEqual(start.args.slice(0, 5), ['--noinform', '--non-interactive', '--no-userinit', '--no-sysinit', '--disable-debugger']);
    assert.equal(start.args[5], '--load');
    assert.ok(start.args[6].endsWith('/lagrange-bridge.lisp'));
    assert.equal(await readFile(join(start.cwd, 'demo.lisp'), 'utf8'), SOURCE, 'the durable source artifact was materialized verbatim');
    const bridge = await readFile(start.args[6], 'utf8');
    assert.ok(bridge.includes('(load "demo.lisp")'));
    assert.ok(bridge.includes('"DEMO-ADD"') && bridge.includes('"DEMO-SHOUT"'), 'exports are declared by name');
    assert.ok(!/\beval\b|read-from-string/.test(bridge), 'the guest bridge evaluates no caller text');
    // The exact framing crossed the bridge.
    assert.deepEqual(runner.sessions[0].written, ['CALL\t1\tdemo\tadd\ti:40\ti:2']);

    // A second callable over the SAME definition reuses the instance (definition instance cache).
    const shout = await installForeignRuntimeCallable({
      images: runtime.images, imageId: 'img', runtimeDefinition: objectRef('img', definition.id),
      interface: {service: 'demo', operation: 'shout'}, argumentCount: 1, interfaceId: 'shout-interface', blockId: 'shout-block',
    });
    const shouted = await runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('img', shout.block.id), [textValue('hällo')]));
    assert.deepEqual(shouted, textValue('HÄLLO!'));
    assert.equal(runner.starts.length, 1);
    assert.ok(source);
  } finally {
    await runtime.close();
  }
});

test('the definition\'s exports table is the allowlist: an undeclared operation or a wrong arity is refused by the provider before any line crosses; a guest ERR is the Lisp call error', async () => {
  const runner = new FakeSbclRunner();
  const runtime = await composeRuntime(runner);
  try {
    const {definition} = await author(runtime, 'img');
    const instance = await runtime.foreignRuntimeDefinitions.start({providerId: COMMON_LISP_SBCL_PROVIDER_ID, definition: objectRef('img', definition.id)});
    await assert.rejects(runtime.foreignRuntimes.call({runtimeId: instance.runtimeId, interface: {service: 'demo', operation: 'eval'}, arguments: []}), /not exported by its runtime definition/);
    await assert.rejects(runtime.foreignRuntimes.call({runtimeId: instance.runtimeId, interface: {service: 'demo', operation: 'add'}, arguments: [integerValue(1)]}), /expects 2 arguments/);
    assert.deepEqual(runner.sessions[0].written, [], 'nothing crossed the bridge for refused calls');
    // A declared operation the guest itself refuses surfaces as the Lisp call error with the guest's code.
    runner.sessions[0].lines.length = 0;
    const pending = runtime.foreignRuntimes.call({runtimeId: instance.runtimeId, interface: {service: 'demo', operation: 'add'}, arguments: [integerValue(1), integerValue(2)]});
    runner.sessions[0].lines.push('ERR\t1\tundefined-function');
    await assert.rejects(pending, (e) => e instanceof CommonLispCallError && e.code === 'undefined-function');
    await runtime.foreignRuntimes.stop(instance.runtimeId);
    assert.equal(runner.sessions[0].written.at(-1), 'QUIT');
    assert.deepEqual(instance.metadata.exports, EXPORTS.map(({service, operation, arity}) => ({service, operation, arity})));
  } finally {
    await runtime.close();
  }
});

test('the definition contract is validated: unsafe symbol names, duplicate exports, a non-.lisp source and a foreign dependency role are refused', async () => {
  assert.throws(() => createCommonLispRuntimeDefinitionContent({exports: [{service: 'demo', operation: 'x', function: '(eval x)', arity: 0}]}), /symbol name/);
  assert.throws(() => createCommonLispRuntimeDefinitionContent({exports: [...EXPORTS, EXPORTS[0]]}), /twice/);
  assert.throws(() => createCommonLispRuntimeDefinitionContent({exports: []}), /at least one export/);
  const runner = new FakeSbclRunner();
  const runtime = await composeRuntime(runner);
  try {
    await runtime.images.createImage({id: 'img'});
    const bad = await runtime.images.putCodeArtifact('img', {id: 'bad-source', representation: COMMON_LISP_SOURCE_V1, content: textValue('(defun f () 1)'), logicalPath: 'demo.txt'});
    const definition = await runtime.images.putCodeArtifact('img', {
      id: 'bad-runtime', representation: COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1,
      content: textValue(createCommonLispRuntimeDefinitionContent({exports: EXPORTS})),
      dependencies: [{role: 'source', artifact: objectRef('img', bad.id)}],
    });
    await assert.rejects(runtime.foreignRuntimeDefinitions.start({providerId: COMMON_LISP_SBCL_PROVIDER_ID, definition: objectRef('img', definition.id)}), /safe \.lisp basename/);
    const other = await runtime.images.putCodeArtifact('img', {id: 'other', representation: 'x/v1', content: textValue('x')});
    const definition2 = await runtime.images.putCodeArtifact('img', {
      id: 'bad-runtime-2', representation: COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1,
      content: textValue(createCommonLispRuntimeDefinitionContent({exports: EXPORTS})),
      dependencies: [{role: 'image', artifact: objectRef('img', other.id)}],
    });
    await assert.rejects(runtime.foreignRuntimeDefinitions.start({providerId: COMMON_LISP_SBCL_PROVIDER_ID, definition: objectRef('img', definition2.id)}), /unsupported Common Lisp runtime dependency role/);
    assert.equal(runner.starts.length, 0, 'no process was started for a refused definition');
  } finally {
    await runtime.close();
  }
});

test('NEUTRALITY: no generic owner knows Common Lisp exists', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const generic = [
    'runtime.js', 'portable-runtime.js',
    'foreign-runtime/service.js', 'foreign-runtime/definition-service.js', 'foreign-runtime/callable-artifacts.js',
    'foreign-runtime/callable-executor.js', 'foreign-runtime/provider-registry.js', 'foreign-runtime/definition-binding-registry.js',
    'foreign-runtime/line-process-runner.js', 'foreign-runtime/stdio-value-bridge.js',
  ];
  for (const dir of ['execution', 'project', 'graph', 'image', 'object', 'value', 'callable', 'compilation', 'toolchain', 'code', 'authority']) {
    for (const file of await readdir(join(root, dir))) if (file.endsWith('.js')) generic.push(`${dir}/${file}`);
  }
  const offenders = [];
  for (const file of generic) {
    const source = await readFile(join(root, file), 'utf8');
    if (/lisp|sbcl/i.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a generic owner mentions Common Lisp / SBCL');
  // And the whole Lisp-specific surface is exactly one provider module.
  const lispModules = (await readdir(join(root, 'foreign-runtime'))).filter((f) => /lisp|sbcl/i.test(f));
  assert.deepEqual(lispModules, ['common-lisp-sbcl-provider.js']);
  assert.ok((await stat(join(root, 'foreign-runtime', 'common-lisp-sbcl-provider.js'))).isFile());
});

test('the generated guest bridge only dispatches declared exports and carries no evaluator', () => {
  const source = createCommonLispStdioBridgeSource({sources: [{fileName: 'a.lisp'}, {fileName: 'b.lisp'}], exports: [{service: 's', operation: 'o', function: 'my-pkg:my-fn', arity: 1}]});
  assert.ok(source.includes('(load "a.lisp")\n(load "b.lisp")'), 'sources load in declared order');
  assert.ok(source.includes('(list "s" "o" "MY-PKG" "MY-FN" 1)'), 'package-qualified symbol resolved by name, at call time');
  assert.ok(!/\(eval |read-from-string|\(compile |\(funcall \(intern/.test(source));
  assert.ok(source.includes(`READY~a~a" #\\Tab "${COMMON_LISP_STDIO_BRIDGE_V1}"`));
});
