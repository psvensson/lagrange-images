import test from 'node:test';
import assert from 'node:assert/strict';
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
  }

  async writeLine(line) {
    this.writes.push(line);
    const fields = line.split('\t');
    if (fields[0] === 'QUIT') {
      this.lines.push('BYE');
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
    } else if (service === 'json' && operation === 'package-proof') {
      this.lines.push(`OK\t${id}\tb:1`);
    } else {
      this.lines.push(`ERR\t${id}\tunknown-operation`);
    }
  }

  async nextLine() {
    if (this.lines.length === 0) throw new Error('fake Cuis session has no queued output');
    return this.lines.shift();
  }

  async waitForExit() { return {code: 0, signal: null, stderr: ''}; }
  kill() {}
  stderrText() { return ''; }
}

class FakeCuisRunner {
  constructor() { this.starts = []; this.sessions = []; }
  async start(request) {
    this.starts.push(request);
    const session = new FakeCuisSession();
    this.sessions.push(session);
    return session;
  }
}

test('OpenSmalltalk Cuis provider preserves safe package basenames but hides host paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-provider-test-'));
  const packagePath = join(root, 'JSON.pck.st');
  await writeFile(packagePath, "'fake package fixture'!", 'utf8');
  const runner = new FakeCuisRunner();
  const provider = createOpenSmalltalkCuisProvider({
    vmPath: '/opt/opensmalltalk/squeak',
    imagePath: '/opt/cuis/Cuis7.9-8090.image',
    vmIdentity: 'opensmalltalk-vm/202606270913/sha256:dff5',
    imageIdentity: 'cuis/6bcee3f/Cuis7.9-8090.image/gitblob:523dc5',
    runner,
    workspaceRoot: root,
  });
  try {
    assert.match(provider.identity, /^opensmalltalk-cuis-runtime\/v0\/[0-9a-f]{64}$/);
    assert.equal(provider.identity.includes('/opt/'), false);
    assert.equal(OPENSMALLTALK_CUIS_PROVIDER_ID, 'smalltalk/opensmalltalk-cuis');

    const started = await provider.start({spec: {packages: [{
      path: packagePath,
      identity: 'cuis-package/JSON/gitblob:47fab65d0d9017d706aa07d39ab0451619488ccd',
    }]}});
    assert.deepEqual(started.metadata.packages, [{
      identity: 'cuis-package/JSON/gitblob:47fab65d0d9017d706aa07d39ab0451619488ccd',
      fileName: 'JSON.pck.st',
    }]);
    assert.equal(JSON.stringify(started.metadata).includes(packagePath), false);

    const scriptPath = runner.starts[0].args[4];
    const script = await readFile(scriptPath, 'utf8');
    assert.match(script, /CodePackageFile installPackage: DirectoryEntry currentDirectory \/\/ 'JSON\.pck\.st'/);
    assert.match(script, /jsonPackageProof/);
    assert.match(script, /Smalltalk at: #Json/);
    assert.match(script, /char := input next/);
    assert.equal(script.includes('input upTo:'), false);
    assert.equal(script.includes('perform:'), false);
    assert.equal(await readFile(join(runner.starts[0].cwd, 'JSON.pck.st'), 'utf8'), "'fake package fixture'!");

    assert.deepEqual(await provider.call(started.handle, {
      interface: {service: 'proof', operation: 'add'},
      arguments: [integerValue(12), integerValue(30)],
    }), integerValue(42));
    assert.deepEqual(await provider.call(started.handle, {
      interface: {service: 'json', operation: 'package-proof'},
      arguments: [],
    }), booleanValue(true));

    await provider.stop(started.handle);
    await assert.rejects(readFile(scriptPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('OpenSmalltalk Cuis package specs and interfaces are explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-provider-validation-'));
  const runner = new FakeCuisRunner();
  const provider = createOpenSmalltalkCuisProvider({
    vmPath: '/vm', imagePath: '/image', vmIdentity: 'vm/v1', imageIdentity: 'image/v1', runner, workspaceRoot: root,
  });
  try {
    await assert.rejects(provider.start({spec: {packages: 'JSON'}}), /packages must be an array/);
    await assert.rejects(provider.start({spec: {packages: [{
      path: '/tmp/not-a-package.txt', identity: 'bad',
    }]}}), /safe \.pck\.st basename/);
    await assert.rejects(provider.start({spec: {packages: [
      {path: '/tmp/A.pck.st', identity: 'same'}, {path: '/tmp/B.pck.st', identity: 'same'},
    ]}}), /duplicate OpenSmalltalk Cuis package identity/);

    const started = await provider.start({spec: {}});
    await assert.rejects(provider.call(started.handle, {
      interface: {service: 'Smalltalk', operation: 'eval'}, arguments: [],
    }), /interface not exported/);
    await assert.rejects(provider.call(started.handle, {
      interface: {service: 'json', operation: 'package-proof'}, arguments: [integerValue(1)],
    }), /expects 0 arguments/);
    await assert.rejects(provider.call(started.handle, {
      interface: {service: 'proof', operation: 'factorial'}, arguments: [textValue('6')],
    }), /does not support text Values/);
    assert.equal(runner.sessions[0].writes.length, 0);
    await provider.stop(started.handle);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Cuis bridge Value encoding remains narrow', () => {
  assert.equal(encodeCuisBridgeValue(integerValue(-123)), 'i:-123');
  assert.equal(encodeCuisBridgeValue(booleanValue(true)), 'b:1');
  assert.deepEqual(decodeCuisBridgeValue('i:900719925474099312345'), integerValue('900719925474099312345'));
  assert.deepEqual(decodeCuisBridgeValue('b:0'), booleanValue(false));
  assert.throws(() => encodeCuisBridgeValue(textValue('hello')), /does not support text Values/);
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
  const session = await runner.start({command: process.execPath, args: ['-e', script], environment: {}});
  await session.writeLine('hello');
  assert.equal(await session.nextLine({timeoutMs: 2_000}), 'echo:hello');
  await session.writeLine('quit');
  assert.equal(await session.nextLine({timeoutMs: 2_000}), 'bye');
  assert.equal((await session.waitForExit({timeoutMs: 2_000})).code, 0);
});
