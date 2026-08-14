import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {VALUE_KIND, booleanValue, canonicalizeValue, integerValue} from '../value/index.js';
import {LineProcessRunner} from './line-process-runner.js';

const OPENSMALLTALK_CUIS_PROVIDER_ID = 'smalltalk/opensmalltalk-cuis';
const OPENSMALLTALK_CUIS_PROVIDER_V0 = 'opensmalltalk-cuis-runtime/v0';
const CUIS_STDIO_BRIDGE_V0 = 'lagrange-cuis-stdio/v0';
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function providerIdentity(vmIdentity, imageIdentity) {
  const digest = createHash('sha256')
    .update(JSON.stringify({vmIdentity, imageIdentity}))
    .digest('hex');
  return `${OPENSMALLTALK_CUIS_PROVIDER_V0}/${digest}`;
}

function normalizeStartSpec(spec) {
  exactKeys(spec, [], 'OpenSmalltalk Cuis runtime spec');
  return spec;
}

function normalizeInterface(value) {
  exactKeys(value, ['operation', 'service'], 'OpenSmalltalk Cuis interface');
  const service = requiredText(value.service, 'OpenSmalltalk Cuis interface service');
  const operation = requiredText(value.operation, 'OpenSmalltalk Cuis interface operation');
  if (!SAFE_NAME.test(service)) throw new TypeError('OpenSmalltalk Cuis interface service contains unsafe characters');
  if (!SAFE_NAME.test(operation)) throw new TypeError('OpenSmalltalk Cuis interface operation contains unsafe characters');
  if (service !== 'proof') throw new TypeError(`OpenSmalltalk Cuis service not exported: ${service}`);
  if (!['add', 'factorial'].includes(operation)) {
    throw new TypeError(`OpenSmalltalk Cuis operation not exported: ${operation}`);
  }
  return Object.freeze({service, operation});
}

function encodeBridgeValue(input) {
  const value = canonicalizeValue(input);
  if (value.kind === VALUE_KIND.INTEGER) return `i:${value.value}`;
  if (value.kind === VALUE_KIND.BOOLEAN) return `b:${value.value ? '1' : '0'}`;
  throw new TypeError(`OpenSmalltalk Cuis bridge does not support ${value.kind} Values yet`);
}

function decodeBridgeValue(token) {
  if (typeof token !== 'string') throw new TypeError('OpenSmalltalk Cuis bridge response value must be text');
  if (/^i:-?\d+$/.test(token)) return integerValue(token.slice(2));
  if (token === 'b:1') return booleanValue(true);
  if (token === 'b:0') return booleanValue(false);
  throw new TypeError(`invalid OpenSmalltalk Cuis bridge Value: ${token}`);
}

function expectedArity(operation) {
  if (operation === 'add') return 2;
  if (operation === 'factorial') return 1;
  throw new TypeError(`OpenSmalltalk Cuis operation not exported: ${operation}`);
}

function bridgeSource() {
  return `| input output service done line fields requestId operation result decode encode readLine |
Object subclass: #LagrangeProofService
    instanceVariableNames: ''
    classVariableNames: ''
    poolDictionaries: ''
    category: 'Lagrange-Bridge'.
LagrangeProofService compile: 'add: a to: b\n    ^ a + b'.
LagrangeProofService compile: 'factorial: n\n    n < 0 ifTrue: [ Error signal: ''factorial requires a non-negative integer'' ].\n    n = 0 ifTrue: [ ^ 1 ].\n    ^ n * (self factorial: n - 1)'.
service := LagrangeProofService new.
input := StdIOReadStream stdin.
output := StdIOWriteStream stdout.
readLine := [ | char stream |
    stream := WriteStream on: (String new: 64).
    [
        char := input next.
        char = Character lf
    ] whileFalse: [ stream nextPut: char ].
    stream contents ].
decode := [ :token |
    (token beginsWith: 'i:')
        ifTrue: [ (token copyFrom: 3 to: token size) asNumber ]
        ifFalse: [
            token = 'b:1'
                ifTrue: [ true ]
                ifFalse: [
                    token = 'b:0'
                        ifTrue: [ false ]
                        ifFalse: [ Error signal: 'unsupported bridge value' ] ] ] ].
encode := [ :value |
    value isInteger
        ifTrue: [ 'i:', value printString ]
        ifFalse: [
            value == true
                ifTrue: [ 'b:1' ]
                ifFalse: [
                    value == false
                        ifTrue: [ 'b:0' ]
                        ifFalse: [ Error signal: 'unsupported result value' ] ] ] ].
output
    nextPutAll: 'READY';
    nextPut: Character tab;
    nextPutAll: '${CUIS_STDIO_BRIDGE_V0}';
    newLine;
    flush.
done := false.
[ done ] whileFalse: [
    line := readLine value.
    line notEmpty ifTrue: [
        fields := line findTokens: Character tab asString.
        fields notEmpty ifTrue: [
            (fields at: 1) = 'QUIT'
                ifTrue: [
                    output nextPutAll: 'BYE'; newLine; flush.
                    done := true ]
                ifFalse: [
                    requestId := fields size > 1 ifTrue: [ fields at: 2 ] ifFalse: [ 'unknown' ].
                    [
                        ((fields at: 1) = 'CALL' and: [ fields size >= 4 ])
                            ifFalse: [ Error signal: 'bad request' ].
                        (fields at: 3) = 'proof' ifFalse: [ Error signal: 'unknown service' ].
                        operation := fields at: 4.
                        operation = 'add'
                            ifTrue: [
                                fields size = 6 ifFalse: [ Error signal: 'bad arity' ].
                                result := service
                                    add: (decode value: (fields at: 5))
                                    to: (decode value: (fields at: 6)) ]
                            ifFalse: [
                                operation = 'factorial'
                                    ifTrue: [
                                        fields size = 5 ifFalse: [ Error signal: 'bad arity' ].
                                        result := service factorial: (decode value: (fields at: 5)) ]
                                    ifFalse: [ Error signal: 'unknown operation' ] ].
                        output
                            nextPutAll: 'OK';
                            nextPut: Character tab;
                            nextPutAll: requestId;
                            nextPut: Character tab;
                            nextPutAll: (encode value: result);
                            newLine;
                            flush
                    ] on: Error do: [ :error |
                        output
                            nextPutAll: 'ERR';
                            nextPut: Character tab;
                            nextPutAll: requestId;
                            nextPut: Character tab;
                            nextPutAll: 'bridge-error';
                            newLine;
                            flush ] ] ] ] ].
Smalltalk quitPrimitive: 0.
`;
}

class OpenSmalltalkCuisCallError extends Error {
  constructor(code) {
    super(`OpenSmalltalk Cuis call failed: ${code}`);
    this.name = 'OpenSmalltalkCuisCallError';
    this.code = code;
  }
}

async function nextMatchingLine(session, predicate, {timeoutMs, action}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TypeError(`OpenSmalltalk Cuis timed out waiting for ${action}`);
    const line = await session.nextLine({timeoutMs: remaining, action});
    if (predicate(line)) return line;
  }
}

async function forceStopSession(session, timeoutMs) {
  session.kill('SIGKILL');
  try {
    await session.waitForExit({timeoutMs});
  } catch {
    // The original startup failure is more useful than a secondary cleanup error.
  }
}

function queueCall(handle, work) {
  const task = handle.tail.then(work, work);
  handle.tail = task.then(() => undefined, () => undefined);
  return task;
}

function createOpenSmalltalkCuisProvider({
  vmPath,
  imagePath,
  vmIdentity,
  imageIdentity,
  runner = new LineProcessRunner(),
  workspaceRoot = tmpdir(),
  startupTimeoutMs = 15_000,
  callTimeoutMs = 10_000,
  stopTimeoutMs = 5_000,
} = {}) {
  const executable = resolve(requiredText(vmPath, 'OpenSmalltalk VM path'));
  const image = resolve(requiredText(imagePath, 'Cuis image path'));
  const stableVmIdentity = requiredText(vmIdentity, 'OpenSmalltalk VM identity');
  const stableImageIdentity = requiredText(imageIdentity, 'Cuis image identity');
  if (!runner || typeof runner.start !== 'function') throw new TypeError('OpenSmalltalk runner must implement start(request)');
  const root = resolve(requiredText(workspaceRoot, 'OpenSmalltalk workspaceRoot'));
  positiveInteger(startupTimeoutMs, 'OpenSmalltalk startupTimeoutMs');
  positiveInteger(callTimeoutMs, 'OpenSmalltalk callTimeoutMs');
  positiveInteger(stopTimeoutMs, 'OpenSmalltalk stopTimeoutMs');
  const identity = providerIdentity(stableVmIdentity, stableImageIdentity);

  return Object.freeze({
    identity,
    vmIdentity: stableVmIdentity,
    imageIdentity: stableImageIdentity,
    async start(request) {
      normalizeStartSpec(request.spec);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cuis-runtime-'));
      const scriptPath = join(workspace, 'lagrange-bridge.st');
      let session = null;
      try {
        await writeFile(scriptPath, bridgeSource(), 'utf8');
        session = await runner.start({
          command: executable,
          args: ['-vm-sound-null', '-vm-display-null', image, '-s', scriptPath],
          cwd: workspace,
          environment: {},
        });
        await nextMatchingLine(
          session,
          (line) => line === `READY\t${CUIS_STDIO_BRIDGE_V0}`,
          {timeoutMs: startupTimeoutMs, action: 'Cuis bridge readiness'},
        );
        return Object.freeze({
          handle: {
            session,
            workspace,
            nextRequestId: 1,
            tail: Promise.resolve(),
            terminated: false,
          },
          metadata: Object.freeze({
            runtime: 'OpenSmalltalkVM',
            image: 'Cuis',
            bridgeProtocol: CUIS_STDIO_BRIDGE_V0,
            vmIdentity: stableVmIdentity,
            imageIdentity: stableImageIdentity,
          }),
        });
      } catch (error) {
        if (session) await forceStopSession(session, stopTimeoutMs);
        await rm(workspace, {recursive: true, force: true});
        throw error;
      }
    },
    async call(handle, request) {
      const callable = normalizeInterface(request.interface);
      const arity = expectedArity(callable.operation);
      if (request.arguments.length !== arity) {
        throw new TypeError(`OpenSmalltalk Cuis ${callable.operation} expects ${arity} arguments`);
      }
      const encoded = request.arguments.map(encodeBridgeValue);
      return await queueCall(handle, async () => {
        if (handle.terminated) throw new TypeError('OpenSmalltalk Cuis runtime is terminated');
        const id = String(handle.nextRequestId++);
        await handle.session.writeLine(['CALL', id, callable.service, callable.operation, ...encoded].join('\t'));
        const response = await nextMatchingLine(
          handle.session,
          (line) => line.startsWith(`OK\t${id}\t`) || line.startsWith(`ERR\t${id}\t`),
          {timeoutMs: callTimeoutMs, action: `Cuis response ${id}`},
        );
        const fields = response.split('\t');
        if (fields[0] === 'ERR') throw new OpenSmalltalkCuisCallError(fields[2] ?? 'unknown');
        if (fields.length !== 3) throw new TypeError('malformed OpenSmalltalk Cuis success response');
        return decodeBridgeValue(fields[2]);
      });
    },
    async stop(handle) {
      await handle.tail;
      if (!handle.terminated) {
        try {
          await handle.session.writeLine('QUIT');
          await nextMatchingLine(
            handle.session,
            (line) => line === 'BYE',
            {timeoutMs: stopTimeoutMs, action: 'Cuis bridge shutdown'},
          );
          const exited = await handle.session.waitForExit({timeoutMs: stopTimeoutMs});
          if (exited.code !== 0) throw new TypeError(`OpenSmalltalk Cuis VM exited with code ${exited.code}`);
        } catch (error) {
          handle.session.kill('SIGKILL');
          try {
            await handle.session.waitForExit({timeoutMs: stopTimeoutMs});
          } catch (killError) {
            throw new AggregateError([error, killError], 'failed to stop OpenSmalltalk Cuis runtime');
          }
        } finally {
          handle.terminated = true;
        }
      }
      await rm(handle.workspace, {recursive: true, force: true});
    },
  });
}

export {
  CUIS_STDIO_BRIDGE_V0,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_PROVIDER_V0,
  OpenSmalltalkCuisCallError,
  bridgeSource as createCuisStdioBridgeSource,
  createOpenSmalltalkCuisProvider,
  decodeBridgeValue as decodeCuisBridgeValue,
  encodeBridgeValue as encodeCuisBridgeValue,
};
