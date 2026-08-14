import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  CUIS_STDIO_BRIDGE_V0,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  LineProcessRunner,
  booleanValue,
  createOpenSmalltalkCuisProvider,
  decodeCuisBridgeValue,
  encodeCuisBridgeValue,
  integerValue,
  textValue,
} from '../src/runtime.js';

class FakeCuisSession {
  constructor() {
    this.lines = [`READY\t${CUIS_STDIO_BRIDGE_V0}`];
    this.writes = [];
    this.killed = false;
    this.exited = false;
  }

  async writeLine(line) {
    this.writes.push(line);
    const fields = line.split('\t');
    if (fields[0] === 'QUIT') {
      this.lines.push('BYE');
      this.exited = true;
      return;
    }
    assert.equal(fields[0], 'CALL');
    const [, id, service, operation, ...args] = fields;
    const decode = (token) => BigInt(token.slice(2));
    if (service === 'proof' && operation === 'add') {
      this.lines.push(`OK\t${id}\ti:${decode(args[0]) + decode(args[1])}`);
    } else if (service === 'proof' && operation === 'factorial') {
      let value = decode(args[0]);
      let result = 1n;
      while (value > 1n) result *= value--;
      this.lines.push(`OK\t${id}\ti:${result}`);
    } else if (service === 'json' && operation === 'roundTripSum') {
      this.lines.push(`OK\t${id}\ti:${decode(args[0]) + decode(args[1])}`);
    } else {
      this.lines.push(`ERR\t${id}\tunknown-operation`);
    }
  }

  async nextLine() {
    if (this.lines.length === 0) throw new Error('fake Cuis session has no queued output');
    return this.lines.shift();
  }

  async waitForExit() {
    return {code: 0, signal: null, stderr: ''};
  }

  kill() {
    this.killed = true;
    this.exited = true;
  }

  stderrText() { return ''; }
}

class FakeCuisRunner {
  constructor() {
    this.starts = [];
    this.sessions = [];
  }

  async start(request) {
    this.starts.push(request);
    const session = new FakeCuisSession();
    this.sessions.push(session);
    return session;
  }
}

function createProvider(root, runner = new FakeCuisRunner()) {
  return {
    runner,
    provider: createOpenSmalltalkCuisProvider({
      vmPath: '/opt/opensmalltalk/squeak',
      imagePath: '/opt/cuis/Cuis7.9-8090.image',
      vmIdentity: 'opensmalltalk-vm/202606270913/sha256:dff5',
      imageIdentity: 'cuis/6bcee3f/Cuis7.9-8090.image/gitblob:523dc5',
      runner,
      workspaceRoot: root,
    }),
  };
}

test('OpenSmalltalk Cuis provider materializes a headless bridge and keeps runtime paths out of identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-provider-test-'));
  const {runner, provider} = createProvider(root);
  try {
    assert.match(provider.identity, /^opensmalltalk-cuis-runtime\/v1\/[0-9a-f]{64}$/);
    assert.equal(provider.identity.includes('/opt/'), false);
    assert.equal(OPENSMALLTALK_CUIS_PROVIDER_ID, 'smalltalk/opensmalltalk-cuis');

    const started = await provider.start({spec: {}});
    assert.deepEqual(started.metadata, {
      runtime: 'OpenSmalltalkVM',
      image: 'Cuis',
      bridgeProtocol: CUIS_STDIO_BRIDGE_V0,
      vmIdentity: 'opensmalltalk-vm/202606270913/sha256:dff5',
      imageIdentity: 'cuis/6bcee3f/Cuis7.9-8090.image/gitblob:523dc5',
      packages: [],
    });
    assert.equal(runner.starts.length, 1);
    assert.deepEqual(runner.starts[0].args.slice(0, 3), [
      '-vm-sound-null',
      '-vm-display-null',
      '/opt/cuis/Cuis7.9-8090.image',
    ]);
    assert.equal(runner.starts[0].args[3], '-s');
    const scriptPath = runner.starts[0].args[4];
    const script = await readFile(scriptPath, 'utf8');
    assert.match(script, /Object subclass: #LagrangeProofService/);
    assert.match(script, /LagrangeProofService compile: 'add: a to: b/);
    assert.match(script, /LagrangeProofService compile: 'factorial: n/);
    assert.match(script, /StdIOReadStream stdin/);
    assert.match(script, /StdIOWriteStream stdout/);
    assert.match(script, /char := input next/);
    assert.equal(script.includes('input upTo:'), false);
    assert.equal(script.includes('CodePackageFile installPackage:'), false);
    assert.equal(script.includes('jsonRoundTripSum:'), false);
    assert.match(script, /Smalltalk quitPrimitive: 0/);
    assert.equal(script.includes('perform:'), false);

    assert.deepEqual(await provider.call(started.handle, {
      interface: {service: 'proof', operation: 'add'},
      arguments: [integerValue(12), integerValue(30)],
    }), integerValue(42));
    assert.deepEqual(await provider.call(started.handle, {
      interface: {service: 'proof', operation: 'factorial'},
      arguments: [integerValue(6)],
    }), integerValue(720));

    assert.deepEqual(runner.sessions[0].writes.slice(0, 2), [
      'CALL\t1\tproof\tadd\ti:12\ti:30',
      'CALL\t2\tproof\tfactorial\ti:6',
    ]);
    await provider.stop(started.handle);
    assert.equal(runner.sessions[0].writes.at(-1), 'QUIT');
    await assert.rejects(readFile(scriptPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('OpenSmalltalk Cuis provider copies exact package bytes, records content identity and enables a package-backed service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-package-test-'));
  const packagePath = join(root, 'upstream-JSON.pck.st');
  const packageBytes = Buffer.from("'From Cuis'!\n!provides: 'JSON' 1 1!\n", 'utf8');
  await writeFile(packagePath, packageBytes);
  const sha256 = createHash('sha256').update(packageBytes).digest('hex');
  const {runner, provider} = createProvider(root);
  try {
    const started = await provider.start({
      spec: {packages: [{name: 'JSON', path: packagePath}]},
    });
    assert.deepEqual(started.metadata.packages, [{
      name: 'JSON',
      sha256,
      size: packageBytes.length,
    }]);
    assert.equal(JSON.stringify(started.metadata).includes(packagePath), false);
    assert.equal(provider.identity.includes(packagePath), false);

    const scriptPath = runner.starts[0].args[4];
    const script = await readFile(scriptPath, 'utf8');
    assert.match(script, /FeatureRequirement name: 'JSON'/);
    assert.match(script, /pathName: packageEntry pathName/);
    assert.match(script, /packageRequirement satisfyRequirementsAndInstall/);
    assert.equal(script.includes('CodePackageFile installPackage:'), false);
    assert.match(script, /nextPutAll: 'JSON'; nextPut: Character tab;\n    nextPutAll: 'install'/);
    assert.match(script, /nextPutAll: 'JSON'; nextPut: Character tab;\n    nextPutAll: 'installed'/);
    assert.match(script, /LagrangeProofService compile: 'jsonRoundTripSum: a with: b/);
    assert.match(script, /rendered := Json render:/);
    assert.match(script, /parsed := Json readFrom: rendered readStream/);
    const materialized = await readFile(join(runner.starts[0].cwd, 'packages', 'JSON.pck.st'));
    assert.deepEqual(materialized, packageBytes);

    const result = await provider.call(started.handle, {
      interface: {service: 'json', operation: 'roundTripSum'},
      arguments: [integerValue(17), integerValue(25)],
    });
    assert.deepEqual(result, integerValue(42));
    assert.equal(runner.sessions[0].writes.at(-1), 'CALL\t1\tjson\troundTripSum\ti:17\ti:25');

    await provider.stop(started.handle);
    await assert.rejects(readFile(scriptPath, 'utf8'), /ENOENT/);
    assert.deepEqual(await readFile(packagePath), packageBytes);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('OpenSmalltalk Cuis bridge rejects undeclared interfaces, absent packages, wrong arity and unsupported Values before transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-provider-validation-'));
  const {runner, provider} = createProvider(root);
  try {
    const started = await provider.start({spec: {}});
    await assert.rejects(
      provider.call(started.handle, {
        interface: {service: 'Smalltalk', operation: 'eval'},
        arguments: [],
      }),
      /service not exported/,
    );
    await assert.rejects(
      provider.call(started.handle, {
        interface: {service: 'json', operation: 'roundTripSum'},
        arguments: [integerValue(1), integerValue(2)],
      }),
      /requires Cuis package JSON/,
    );
    await assert.rejects(
      provider.call(started.handle, {
        interface: {service: 'proof', operation: 'factorial'},
        arguments: [integerValue(1), integerValue(2)],
      }),
      /expects 1 arguments/,
    );
    await assert.rejects(
      provider.call(started.handle, {
        interface: {service: 'proof', operation: 'factorial'},
        arguments: [textValue('6')],
      }),
      /does not support text Values/,
    );
    assert.equal(runner.sessions[0].writes.length, 0);
    await provider.stop(started.handle);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('OpenSmalltalk Cuis package start inputs reject unsafe and duplicate package names before VM launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-package-validation-'));
  const packagePath = join(root, 'package.pck.st');
  await writeFile(packagePath, 'package');
  const {runner, provider} = createProvider(root);
  try {
    await assert.rejects(
      provider.start({spec: {packages: [{name: '../JSON', path: packagePath}]}}),
      /name contains unsafe characters/,
    );
    await assert.rejects(
      provider.start({spec: {packages: [
        {name: 'JSON', path: packagePath},
        {name: 'JSON', path: packagePath},
      ]}}),
      /duplicate OpenSmalltalk Cuis package name: JSON/,
    );
    assert.equal(runner.starts.length, 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Cuis bridge Value encoding is explicit and does not expose refs or arbitrary JSON', () => {
  assert.equal(encodeCuisBridgeValue(integerValue(-123)), 'i:-123');
  assert.equal(encodeCuisBridgeValue(booleanValue(true)), 'b:1');
  assert.deepEqual(decodeCuisBridgeValue('i:900719925474099312345'), integerValue('900719925474099312345'));
  assert.deepEqual(decodeCuisBridgeValue('b:0'), booleanValue(false));
  assert.throws(() => encodeCuisBridgeValue(textValue('hello')), /does not support text Values/);
  assert.throws(() => decodeCuisBridgeValue('s:hello'), /invalid OpenSmalltalk Cuis bridge Value/);
});

test('LineProcessRunner provides a persistent shell-free line transport', async () => {
  const runner = new LineProcessRunner();
  const script = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({input: process.stdin});",
    "rl.on('line', (line) => {",
    "  if (line === 'quit') { console.log('bye'); process.exit(0); }",
    "  console.log('echo:' + line);",
    "});",
  ].join('\n');
  const session = await runner.start({
    command: process.execPath,
    args: ['-e', script],
    environment: {},
  });
  await session.writeLine('hello');
  assert.equal(await session.nextLine({timeoutMs: 2_000}), 'echo:hello');
  await session.writeLine('quit');
  assert.equal(await session.nextLine({timeoutMs: 2_000}), 'bye');
  const exited = await session.waitForExit({timeoutMs: 2_000});
  assert.equal(exited.code, 0);
});
