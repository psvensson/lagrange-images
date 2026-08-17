import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {VALUE_KIND, booleanValue, bytesFromBase64, bytesValue, canonicalizeValue, float64FromBits, float64ToNumber, float64Value, integerValue, textValue} from '../value/index.js';
import {LineProcessRunner} from './line-process-runner.js';

const OPENSMALLTALK_CUIS_PROVIDER_ID = 'smalltalk/opensmalltalk-cuis';
const OPENSMALLTALK_CUIS_PROVIDER_V0 = 'opensmalltalk-cuis-runtime/v0';
const CUIS_STDIO_BRIDGE_V0 = 'lagrange-cuis-stdio/v0';
const CUIS_STDIO_BRIDGE_V1 = 'lagrange-cuis-stdio/v1';
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SAFE_PACKAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.pck\.st$/;

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

function normalizePackageSpec(value, index) {
  exactKeys(value, ['identity', 'path'], `OpenSmalltalk Cuis package ${index}`);
  const path = resolve(requiredText(value.path, `OpenSmalltalk Cuis package ${index} path`));
  const fileName = basename(path);
  if (!SAFE_PACKAGE_FILE.test(fileName) || fileName.includes('..')) {
    throw new TypeError(`OpenSmalltalk Cuis package ${index} filename must be a safe .pck.st basename`);
  }
  return Object.freeze({
    identity: requiredText(value.identity, `OpenSmalltalk Cuis package ${index} identity`),
    path,
    fileName,
  });
}

function normalizeStartSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('OpenSmalltalk Cuis runtime spec must be an object');
  }
  const keys = Object.keys(spec);
  if (keys.some((key) => key !== 'packages')) {
    throw new TypeError('OpenSmalltalk Cuis runtime spec supports only packages');
  }
  const packages = spec.packages ?? [];
  if (!Array.isArray(packages)) throw new TypeError('OpenSmalltalk Cuis packages must be an array');
  const normalized = packages.map((entry, index) => normalizePackageSpec(entry, index));
  const identities = new Set();
  const fileNames = new Set();
  for (const entry of normalized) {
    if (identities.has(entry.identity)) throw new TypeError(`duplicate OpenSmalltalk Cuis package identity: ${entry.identity}`);
    if (fileNames.has(entry.fileName)) throw new TypeError(`duplicate OpenSmalltalk Cuis package filename: ${entry.fileName}`);
    identities.add(entry.identity);
    fileNames.add(entry.fileName);
  }
  return Object.freeze({packages: Object.freeze(normalized)});
}

function normalizeInterface(value) {
  exactKeys(value, ['operation', 'service'], 'OpenSmalltalk Cuis interface');
  const service = requiredText(value.service, 'OpenSmalltalk Cuis interface service');
  const operation = requiredText(value.operation, 'OpenSmalltalk Cuis interface operation');
  if (!SAFE_NAME.test(service)) throw new TypeError('OpenSmalltalk Cuis interface service contains unsafe characters');
  if (!SAFE_NAME.test(operation)) throw new TypeError('OpenSmalltalk Cuis interface operation contains unsafe characters');
  const exported = (service === 'proof' && ['add', 'echo', 'factorial'].includes(operation))
    || (service === 'json' && operation === 'package-proof')
    || (service === 'text' && operation === 'normalize');
  if (!exported) throw new TypeError(`OpenSmalltalk Cuis interface not exported: ${service}/${operation}`);
  return Object.freeze({service, operation});
}

function percentEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let result = '';
  for (const byte of bytes) {
    if ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
      || byte === 0x2D || byte === 0x2E || byte === 0x5F || byte === 0x7E) {
      result += String.fromCharCode(byte);
    } else {
      result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return result;
}

function percentDecodeUtf8(encoded) {
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

function float64ToHexPayload(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, '0');
}

function hexPayloadToFloat64(hex) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`), false);
  return view.getFloat64(0, false);
}

function encodeBridgeValue(input) {
  const value = canonicalizeValue(input);
  if (value.kind === VALUE_KIND.INTEGER) return `i:${value.value}`;
  if (value.kind === VALUE_KIND.BOOLEAN) return `b:${value.value ? '1' : '0'}`;
  if (value.kind === VALUE_KIND.FLOAT64) return `f:${float64ToHexPayload(float64ToNumber(value))}`;
  if (value.kind === VALUE_KIND.TEXT) return `e:${percentEncodeUtf8(value.value)}`;
  if (value.kind === VALUE_KIND.BYTES) return `d:${value.base64}`;
  throw new TypeError(`OpenSmalltalk Cuis bridge does not support ${value.kind} Values yet`);
}

function decodeBridgeValue(token) {
  if (typeof token !== 'string') throw new TypeError('OpenSmalltalk Cuis bridge response value must be text');
  if (/^i:-?\d+$/.test(token)) return integerValue(token.slice(2));
  if (token === 'b:1') return booleanValue(true);
  if (token === 'b:0') return booleanValue(false);
  if (token.startsWith('f:')) return float64Value(hexPayloadToFloat64(token.slice(2)));
  if (token.startsWith('e:')) return textValue(percentDecodeUtf8(token.slice(2)));
  if (token.startsWith('d:')) return bytesFromBase64(token.slice(2));
  throw new TypeError(`invalid OpenSmalltalk Cuis bridge Value: ${token}`);
}

function expectedArity(service, operation) {
  if (service === 'proof' && operation === 'add') return 2;
  if (service === 'proof' && operation === 'echo') return 1;
  if (service === 'proof' && operation === 'factorial') return 1;
  if (service === 'json' && operation === 'package-proof') return 0;
  if (service === 'text' && operation === 'normalize') return 1;
  throw new TypeError(`OpenSmalltalk Cuis interface not exported: ${service}/${operation}`);
}

function encodeHexByte(byte) {
  const hex = '0123456789abcdef';
  return hex[byte >> 4] + hex[byte & 0x0f];
}

// Every bridge method is compiled separately so that one bad method cannot silence the
// whole bridge: Cuis compiles a doIt as a single unit, so a syntax error anywhere in a
// large script suppresses all output, including the BOOT lines used to diagnose it.
const BRIDGE_METHODS = Object.freeze([
`add: a to: b
    ^ a + b`,
// echo exists so every canonical scalar can be round-tripped through the real VM:
// it is the only exported operation that both decodes and re-encodes an arbitrary Value.
`echo: aValue
    ^ aValue`,
`factorial: n
    n < 0 ifTrue: [ ^ self error: 'factorial requires a non-negative integer' ].
    n = 0 ifTrue: [ ^ 1 ].
    ^ n * (self factorial: n - 1)`,
`jsonPackageProof
    | jsonClass parsed rendered reparsed numbers nested |
    jsonClass := Smalltalk at: #Json.
    parsed := jsonClass readFrom: '{"numbers":[3,5,8],"ok":true,"nested":{"name":"cuis"}}' readStream.
    rendered := jsonClass render: parsed.
    reparsed := jsonClass readFrom: rendered readStream.
    numbers := reparsed at: 'numbers'.
    nested := reparsed at: 'nested'.
    ^ (((numbers at: 1) + (numbers at: 2) + (numbers at: 3)) = 16)
        and: [ (reparsed at: 'ok') = true
        and: [ (nested at: 'name') = 'cuis' ]]`,
// normalize/v1: lowercase, collapse each whitespace run to one space, trim both ends.
// This is the shared specification the Component lane implements too.
`normalizeText: aString
    | outStream pendingSpace startedText |
    outStream := WriteStream on: (UnicodeString new: aString size).
    pendingSpace := false.
    startedText := false.
    aString asLowercase do: [ :eachChar |
        (self lagrangeIsWhitespace: eachChar)
            ifTrue: [ startedText ifTrue: [ pendingSpace := true ] ]
            ifFalse: [
                pendingSpace ifTrue: [ outStream nextPut: Character space ].
                pendingSpace := false.
                startedText := true.
                outStream nextPut: eachChar ] ].
    ^ outStream contents`,
`lagrangeIsWhitespace: aChar
    | code |
    code := aChar codePoint.
    ^ code = 32 or: [ code >= 9 and: [ code <= 13 ] ]`,
`lagrangeHexToInteger: hexText
    | total |
    total := 0.
    hexText asUppercase do: [ :eachChar |
        | digit |
        digit := eachChar digitValue.
        (digit < 0 or: [ digit > 15 ]) ifTrue: [ ^ self error: 'invalid hex payload' ].
        total := total * 16 + digit ].
    ^ total`,
`lagrangeIntegerToHex: anInteger digits: digitCount
    | alphabet outStream remaining slots |
    alphabet := '0123456789abcdef'.
    slots := Array new: digitCount.
    remaining := anInteger.
    digitCount to: 1 by: -1 do: [ :index |
        slots at: index put: (alphabet at: (remaining bitAnd: 15) + 1).
        remaining := remaining bitShift: -4 ].
    outStream := WriteStream on: (String new: digitCount).
    slots do: [ :eachChar | outStream nextPut: eachChar ].
    ^ outStream contents`,
`lagrangeIsUnreservedByte: aByte
    (aByte >= 48 and: [ aByte <= 57 ]) ifTrue: [ ^ true ].
    (aByte >= 65 and: [ aByte <= 90 ]) ifTrue: [ ^ true ].
    (aByte >= 97 and: [ aByte <= 122 ]) ifTrue: [ ^ true ].
    ^ aByte = 45 or: [ aByte = 46 or: [ aByte = 95 or: [ aByte = 126 ] ] ]`,
`lagrangePercentEncode: aString
    | outStream |
    outStream := WriteStream on: (String new: 64).
    aString asUtf8Bytes do: [ :eachByte |
        (self lagrangeIsUnreservedByte: eachByte)
            ifTrue: [ outStream nextPut: (Character value: eachByte) ]
            ifFalse: [
                outStream nextPut: (Character value: 37).
                outStream nextPutAll: (self lagrangeIntegerToHex: eachByte digits: 2) asUppercase ] ].
    ^ outStream contents`,
// Text is built as a UnicodeString, not a String: Cuis String holds only code points
// 0-255 and `String fromUtf8Bytes:` silently drops anything above that.
`lagrangePercentDecode: encodedText
    | byteStream position eachChar |
    byteStream := WriteStream on: (ByteArray new: 64).
    position := 1.
    [ position <= encodedText size ] whileTrue: [
        eachChar := encodedText at: position.
        eachChar codePoint = 37
            ifTrue: [
                byteStream nextPut: (self lagrangeHexToInteger: (encodedText copyFrom: position + 1 to: position + 2)).
                position := position + 3 ]
            ifFalse: [
                byteStream nextPut: eachChar codePoint.
                position := position + 1 ] ].
    ^ UnicodeString fromUtf8Bytes: byteStream contents`,
`lagrangeDecode: token
    | prefix payload |
    token size < 2 ifTrue: [ ^ self error: 'unsupported bridge value' ].
    prefix := token copyFrom: 1 to: 2.
    payload := token copyFrom: 3 to: token size.
    prefix = 'i:' ifTrue: [ ^ payload asNumber ].
    prefix = 'b:' ifTrue: [ ^ payload = '1' ].
    prefix = 'f:' ifTrue: [ ^ Float fromIEEE64Bit: (self lagrangeHexToInteger: payload) ].
    prefix = 'e:' ifTrue: [ ^ self lagrangePercentDecode: payload ].
    prefix = 'd:' ifTrue: [ ^ payload base64Decoded ].
    ^ self error: 'unsupported bridge value'`,
`lagrangeEncode: aValue
    aValue isInteger ifTrue: [ ^ 'i:', aValue printString ].
    aValue == true ifTrue: [ ^ 'b:1' ].
    aValue == false ifTrue: [ ^ 'b:0' ].
    aValue isFloat ifTrue: [ ^ 'f:', (self lagrangeIntegerToHex: aValue asIEEE64BitWord digits: 16) ].
    aValue isString ifTrue: [ ^ 'e:', (self lagrangePercentEncode: aValue) ].
    (aValue isKindOf: ByteArray) ifTrue: [ ^ 'd:', aValue base64Encoded ].
    ^ self error: 'unsupported result value'`,
`lagrangeDispatch: fields
    | serviceName operation |
    (fields size >= 4 and: [ (fields at: 1) = 'CALL' ]) ifFalse: [ ^ self error: 'bad request' ].
    serviceName := fields at: 3.
    operation := fields at: 4.
    (serviceName = 'proof' and: [ operation = 'add' ]) ifTrue: [
        fields size = 6 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self add: (self lagrangeDecode: (fields at: 5)) to: (self lagrangeDecode: (fields at: 6)) ].
    (serviceName = 'proof' and: [ operation = 'echo' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self echo: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'proof' and: [ operation = 'factorial' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self factorial: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'json' and: [ operation = 'package-proof' ]) ifTrue: [
        fields size = 4 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self jsonPackageProof ].
    (serviceName = 'text' and: [ operation = 'normalize' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self normalizeText: (self lagrangeDecode: (fields at: 5)) ].
    ^ self error: 'unknown operation'`,
]);

function smalltalkStringLiteral(source) {
  return `'${source.replace(/'/g, "''")}'`;
}

function bridgeSelector(methodSource) {
  const header = methodSource.split('\n', 1)[0].trim();
  const tokens = header.split(/\s+/);
  if (!tokens[0].endsWith(':')) return tokens[0];
  return tokens.filter((_, index) => index % 2 === 0).join('');
}

function packageInstallSource(packages) {
  return packages
    .map(({fileName}) => `output nextPutAll: 'BOOT\tPACKAGE\t${fileName}\tSTART'; newLine; flush.\nCodePackageFile installPackage: DirectoryEntry currentDirectory // '${fileName}'.\noutput nextPutAll: 'BOOT\tPACKAGE\t${fileName}\tDONE'; newLine; flush.`)
    .join('\n');
}

function bridgeSource(packages = []) {
  const installPackages = packageInstallSource(packages);
  const compileCalls = BRIDGE_METHODS
    .map((methodSource) => `compileMethod value: ${smalltalkStringLiteral(methodSource)}.`)
    .join('\n');
  const selectorList = BRIDGE_METHODS.map((methodSource) => bridgeSelector(methodSource)).join(' ');
  return `| input output service done line fields requestId callResult readLine compileMethod missing |
output := StdIOWriteStream stdout.
output nextPutAll: 'BOOT\tBRIDGE\tSTART'; newLine; flush.
output nextPutAll: 'BOOT\tBRIDGE\tCOMPILE'; newLine; flush.
Object subclass: #LagrangeProofService
    instanceVariableNames: ''
    classVariableNames: ''
    poolDictionaries: ''
    category: 'Lagrange-Bridge'.
compileMethod := [ :methodSource |
    [ LagrangeProofService compile: methodSource ] on: Error do: [ :compileError | nil ] ].
${compileCalls}
missing := #(${selectorList}) reject: [ :selector | LagrangeProofService includesSelector: selector ].
missing isEmpty
    ifTrue: [ output nextPutAll: 'BOOT\tBRIDGE\tCOMPILED'; newLine; flush ]
    ifFalse: [
        output nextPutAll: 'BOOT\tBRIDGE\tUNCOMPILED\t'; nextPutAll: missing printString; newLine; flush ].
service := LagrangeProofService new.
${installPackages}
input := StdIOReadStream stdin.
readLine := [ | char stream |
    stream := WriteStream on: (String new: 64).
    [
        char := input next.
        char = Character lf
    ] whileFalse: [ stream nextPut: char ].
    stream contents ].
output
    nextPutAll: 'READY';
    nextPut: Character tab;
    nextPutAll: '${CUIS_STDIO_BRIDGE_V1}';
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
                        callResult := service lagrangeDispatch: fields.
                        output
                            nextPutAll: 'OK';
                            nextPut: Character tab;
                            nextPutAll: requestId;
                            nextPut: Character tab;
                            nextPutAll: (service lagrangeEncode: callResult);
                            newLine;
                            flush
                    ] on: Error do: [ :callError |
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
  const boot = [];
  const allLines = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const suffix = allLines.length > 0 ? `; saw: ${allLines.join(' -> ')}` : '';
      throw new TypeError(`OpenSmalltalk Cuis timed out waiting for ${action}${suffix}`);
    }
    let line;
    try {
      line = await session.nextLine({timeoutMs: remaining, action});
    } catch (error) {
      const suffix = allLines.length > 0 ? `; saw: ${allLines.join(' -> ')}` : '';
      if (boot.length === 0 && allLines.length === 0) throw error;
      throw new TypeError(`${error.message}${suffix}`, {cause: error});
    }
    allLines.push(line);
    if (line.startsWith('BOOT\t')) boot.push(line);
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
      const spec = normalizeStartSpec(request.spec);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cuis-runtime-'));
      const scriptPath = join(workspace, 'lagrange-bridge.st');
      let session = null;
      try {
        for (const packageSpec of spec.packages) {
          await copyFile(packageSpec.path, join(workspace, packageSpec.fileName));
        }
        await writeFile(scriptPath, bridgeSource(spec.packages), 'utf8');
        session = await runner.start({
          command: executable,
          args: ['-vm-sound-null', '-vm-display-null', image, '-s', scriptPath],
          cwd: workspace,
          environment: {},
        });
        await nextMatchingLine(
          session,
          (line) => line === `READY\t${CUIS_STDIO_BRIDGE_V1}`,
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
            bridgeProtocol: CUIS_STDIO_BRIDGE_V1,
            vmIdentity: stableVmIdentity,
            imageIdentity: stableImageIdentity,
            packages: spec.packages.map(({identity: packageIdentity, fileName}) => Object.freeze({
              identity: packageIdentity,
              fileName,
            })),
          }),
        });
      } catch (error) {
        const stderrText = session ? session.stderrText() : '';
        if (session) await forceStopSession(session, stopTimeoutMs);
        await rm(workspace, {recursive: true, force: true});
        const detail = stderrText.trim().length > 0 ? `; stderr: ${stderrText.trim().slice(0, 500)}` : '';
        throw new TypeError(`${error.message}${detail}`, {cause: error});
      }
    },
    async call(handle, request) {
      const callable = normalizeInterface(request.interface);
      const arity = expectedArity(callable.service, callable.operation);
      if (request.arguments.length !== arity) {
        throw new TypeError(`OpenSmalltalk Cuis ${callable.service}/${callable.operation} expects ${arity} arguments`);
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
  CUIS_STDIO_BRIDGE_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_PROVIDER_V0,
  OpenSmalltalkCuisCallError,
  bridgeSource as createCuisStdioBridgeSource,
  createOpenSmalltalkCuisProvider,
  decodeBridgeValue as decodeCuisBridgeValue,
  encodeBridgeValue as encodeCuisBridgeValue,
  encodeHexByte,
};