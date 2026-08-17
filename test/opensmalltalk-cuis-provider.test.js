import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  CUIS_STDIO_BRIDGE_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  LineProcessRunner,
  booleanValue,
  bytesValue,
  createOpenSmalltalkCuisProvider,
  decodeCuisBridgeValue,
  encodeCuisBridgeValue,
  float64Value,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';

class FakeCuisSession {
  constructor() {
    this.lines = [`READY\t${CUIS_STDIO_BRIDGE_V1}`];
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
    const decode = (token) => {
      if (token.startsWith('i:')) return BigInt(token.slice(2));
      if (token.startsWith('f:')) return {__floatHex: token.slice(2)};
      if (token.startsWith('e:')) return {__text: decodePercent(token.slice(2))};
      if (token.startsWith('d:')) return {__bytes: Buffer.from(token.slice(2), 'base64')};
      if (token === 'b:1') return true;
      if (token === 'b:0') return false;
      throw new Error(`unexpected token: ${token}`);
    };
    const encode = (value) => {
      if (typeof value === 'bigint') return `i:${value}`;
      if (value === true) return 'b:1';
      if (value === false) return 'b:0';
      if (value && value.__floatHex) return `f:${value.__floatHex}`;
      if (value && value.__text !== undefined) return `e:${encodePercent(value.__text)}`;
      if (value && value.__bytes) return `d:${value.__bytes.toString('base64')}`;
      throw new Error(`unexpected value: ${JSON.stringify(value)}`);
    };
    if (service === 'proof' && operation === 'add') {
      this.lines.push(`OK\t${id}\ti:${decode(args[0]) + decode(args[1])}`);
    } else if (service === 'proof' && operation === 'factorial') {
      let value = decode(args[0]);
      let result = 1n;
      while (value > 1n) result *= value--;
      this.lines.push(`OK\t${id}\ti:${result}`);
    } else if (service === 'json' && operation === 'package-proof') {
      this.lines.push(`OK\t${id}\tb:1`);
    } else if (service === 'text' && operation === 'normalize') {
      const input = decode(args[0]);
      const normalized = input.__text.toLowerCase().replace(/\s+/g, ' ').trim();
      this.lines.push(`OK\t${id}\te:${encodePercent(normalized)}`);
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

function encodePercent(str) {
  return Array.from(new TextEncoder().encode(str), (b) =>
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
    || b === 0x2D || b === 0x2E || b === 0x5F || b === 0x7E
      ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('');
}

function decodePercent(encoded) {
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%' && i + 2 < encoded.length) {
      bytes.push(parseInt(encoded.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
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
      interface: {service: 'proof', operation: 'factorial'}, arguments: [objectRef('x', 'y')],
    }), /does not support ref Values/);
    assert.equal(runner.sessions[0].writes.length, 0);
    await provider.stop(started.handle);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Cuis bridge v1 Value encoding covers boolean, integer, float64, text and bytes', () => {
  assert.equal(encodeCuisBridgeValue(integerValue(-123)), 'i:-123');
  assert.equal(encodeCuisBridgeValue(booleanValue(true)), 'b:1');
  assert.deepEqual(decodeCuisBridgeValue('i:900719925474099312345'), integerValue('900719925474099312345'));
  assert.deepEqual(decodeCuisBridgeValue('b:0'), booleanValue(false));

  const f15 = encodeCuisBridgeValue(float64Value(1.5));
  assert.match(f15, /^f:/);
  assert.deepEqual(decodeCuisBridgeValue(f15), float64Value(1.5));
  const fzero = encodeCuisBridgeValue(float64Value(0));
  assert.deepEqual(decodeCuisBridgeValue(fzero), float64Value(0));
  const fneg = encodeCuisBridgeValue(float64Value(-2.5));
  assert.deepEqual(decodeCuisBridgeValue(fneg), float64Value(-2.5));

  const t1 = encodeCuisBridgeValue(textValue('hello'));
  assert.equal(t1, 'e:hello');
  assert.deepEqual(decodeCuisBridgeValue(t1), textValue('hello'));
  const t2 = encodeCuisBridgeValue(textValue('with spaces & special=chars'));
  assert.match(t2, /^e:/);
  assert.deepEqual(decodeCuisBridgeValue(t2), textValue('with spaces & special=chars'));
  const t3 = encodeCuisBridgeValue(textValue('line\nbreak'));
  assert.deepEqual(decodeCuisBridgeValue(t3), textValue('line\nbreak'));
  const t4 = encodeCuisBridgeValue(textValue(''));
  assert.equal(t4, 'e:');
  assert.deepEqual(decodeCuisBridgeValue(t4), textValue(''));

  const b1 = encodeCuisBridgeValue(bytesValue(new Uint8Array([0, 1, 2, 255])));
  assert.match(b1, /^d:/);
  assert.deepEqual(decodeCuisBridgeValue(b1), bytesValue(new Uint8Array([0, 1, 2, 255])));
  const b2 = encodeCuisBridgeValue(bytesValue(new Uint8Array([])));
  assert.equal(b2, 'd:');
  assert.deepEqual(decodeCuisBridgeValue(b2), bytesValue(new Uint8Array([])));

  assert.throws(() => encodeCuisBridgeValue(objectRef('x', 'y')), /does not support ref Values/);
});

test('Cuis bridge v1 text encoding round-trips through percent encoding', () => {
  const samples = [
    'plain ASCII',
    'unicode: \u00e9\u00e8\u00ea',
    'tabs\there',
    'new\nlines',
    'percent%sign',
    '\u0000null\u0000',
    '\ud83d\ude00',
  ];
  for (const sample of samples) {
    const encoded = encodeCuisBridgeValue(textValue(sample));
    assert.match(encoded, /^e:/, `encoding should produce e: prefix for: ${JSON.stringify(sample)}`);
    assert.deepEqual(decodeCuisBridgeValue(encoded), textValue(sample), `round-trip failed for: ${JSON.stringify(sample)}`);
  }
});

test('Cuis bridge v1 session round-trip with text, bytes and float64', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lagrange-cuis-v1-roundtrip-'));
  const runner = new FakeCuisRunner();
  const provider = createOpenSmalltalkCuisProvider({
    vmPath: '/vm', imagePath: '/image', vmIdentity: 'vm/v1', imageIdentity: 'image/v1', runner, workspaceRoot: root,
  });
  try {
    const started = await provider.start({spec: {}});

    const textResult = await provider.call(started.handle, {
      interface: {service: 'text', operation: 'normalize'},
      arguments: [textValue('  Hello   World  ')],
    });
    assert.deepEqual(textResult, textValue('hello world'));

    const addResult = await provider.call(started.handle, {
      interface: {service: 'proof', operation: 'add'},
      arguments: [integerValue(10), integerValue(20)],
    });
    assert.deepEqual(addResult, integerValue(30));

    await provider.stop(started.handle);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
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
