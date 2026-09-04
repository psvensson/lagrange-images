// The neutral stdio VALUE-CALL bridge: the one owner of how a host talks to a foreign runtime
// process over lines (bead lagrange-images-9p4). It was extracted from the OpenSmalltalk/Cuis
// provider when a second, unrelated runtime (Common Lisp) needed exactly the same framing and
// Value transport — the point at which a provider-private protocol becomes a shared owner.
//
// Framing (`lagrange-stdio-value-bridge/v1`, tab-separated, one message per line):
//
//   guest -> host   READY\t<bridge protocol id>          the guest serves calls from now on
//   host  -> guest  CALL\t<id>\t<service>\t<operation>\t<arg>*
//   guest -> host   OK\t<id>\t<value>  |  ERR\t<id>\t<code>
//   host  -> guest  QUIT                                   guest -> host  BYE
//   guest -> host   BOOT\t...                              informational, ignored by the host
//
// Values cross as canonical Lagrange Values in a prefixed textual form — i:<integer>, b:0|1,
// f:<16 hex digits of the IEEE-754 bits>, e:<percent-encoded UTF-8 text>, d:<base64 bytes>.
// Refs never cross: a foreign heap is not the image, and a runtime handle is not a capability.
//
// A provider still owns everything language-specific: which services/operations it exports,
// how the guest is started, and how the guest-side bridge is generated. This module owns only
// the protocol and the per-handle call queue that serializes requests on one session.
import {VALUE_KIND, booleanValue, bytesFromBase64, canonicalizeValue, float64ToNumber, float64Value, integerValue, textValue} from '../value/index.js';

const STDIO_VALUE_BRIDGE_FRAMING_V1 = 'lagrange-stdio-value-bridge/v1';

class StdioValueBridgeCallError extends Error {
  constructor(runtimeLabel, code) {
    super(`${runtimeLabel} call failed: ${code}`);
    this.name = 'StdioValueBridgeCallError';
    this.code = code;
  }
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
  throw new TypeError(`stdio value bridge does not support ${value.kind} Values`);
}

function decodeBridgeValue(token) {
  if (typeof token !== 'string') throw new TypeError('stdio value bridge response value must be text');
  if (/^i:-?\d+$/.test(token)) return integerValue(token.slice(2));
  if (token === 'b:1') return booleanValue(true);
  if (token === 'b:0') return booleanValue(false);
  if (token.startsWith('f:')) return float64Value(hexPayloadToFloat64(token.slice(2)));
  if (token.startsWith('e:')) return textValue(percentDecodeUtf8(token.slice(2)));
  if (token.startsWith('d:')) return bytesFromBase64(token.slice(2));
  throw new TypeError(`invalid stdio value bridge Value: ${token}`);
}

// Read lines until `predicate` accepts one, within `timeoutMs`; BOOT lines are informational and
// every line seen is reported on timeout so a stuck guest is diagnosable.
async function nextMatchingLine(session, predicate, {timeoutMs, action, runtimeLabel = 'foreign runtime'}) {
  const deadline = Date.now() + timeoutMs;
  const allLines = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const suffix = allLines.length > 0 ? `; saw: ${allLines.join(' -> ')}` : '';
      throw new TypeError(`${runtimeLabel} timed out waiting for ${action}${suffix}`);
    }
    let line;
    try {
      line = await session.nextLine({timeoutMs: remaining, action});
    } catch (error) {
      const suffix = allLines.length > 0 ? `; saw: ${allLines.join(' -> ')}` : '';
      if (allLines.length === 0) throw error;
      throw new TypeError(`${error.message}${suffix}`, {cause: error});
    }
    allLines.push(line);
    if (predicate(line)) return line;
  }
}

async function forceStopSession(session, timeoutMs) {
  session.kill('SIGKILL');
  try {
    await session.waitForExit({timeoutMs});
  } catch {
  }
}

// One handle per started guest: the session plus the request counter and the call queue that
// serializes CALLs on it (a line protocol has no interleaving).
function createBridgeHandle(session, extra = {}) {
  return {session, nextRequestId: 1, tail: Promise.resolve(), terminated: false, ...extra};
}

function queueCall(handle, work) {
  const task = handle.tail.then(work, work);
  handle.tail = task.then(() => undefined, () => undefined);
  return task;
}

async function awaitBridgeReady(session, protocolId, {timeoutMs, runtimeLabel}) {
  await nextMatchingLine(session, (line) => line === `READY\t${protocolId}`, {timeoutMs, action: `${runtimeLabel} bridge readiness`, runtimeLabel});
}

// CALL <service> <operation> with canonical Value arguments; answers the decoded Value or throws
// the bridge call error carrying the guest's error code.
async function bridgeCall(handle, {service, operation, arguments: args, timeoutMs, runtimeLabel}) {
  const encoded = args.map(encodeBridgeValue);
  return await queueCall(handle, async () => {
    if (handle.terminated) throw new TypeError(`${runtimeLabel} is terminated`);
    const id = String(handle.nextRequestId++);
    await handle.session.writeLine(['CALL', id, service, operation, ...encoded].join('\t'));
    const response = await nextMatchingLine(
      handle.session,
      (line) => line.startsWith(`OK\t${id}\t`) || line.startsWith(`ERR\t${id}\t`),
      {timeoutMs, action: `${runtimeLabel} response ${id}`, runtimeLabel},
    );
    const fields = response.split('\t');
    if (fields[0] === 'ERR') throw new StdioValueBridgeCallError(runtimeLabel, fields[2] ?? 'unknown');
    if (fields.length !== 3) throw new TypeError(`malformed ${runtimeLabel} success response`);
    return decodeBridgeValue(fields[2]);
  });
}

// QUIT, wait for BYE and a clean exit; on any failure kill the guest. Marks the handle terminated.
async function bridgeQuit(handle, {timeoutMs, runtimeLabel}) {
  await handle.tail;
  if (handle.terminated) return;
  try {
    await handle.session.writeLine('QUIT');
    await nextMatchingLine(handle.session, (line) => line === 'BYE', {timeoutMs, action: `${runtimeLabel} bridge shutdown`, runtimeLabel});
    const exited = await handle.session.waitForExit({timeoutMs});
    if (exited.code !== 0) throw new TypeError(`${runtimeLabel} exited with code ${exited.code}`);
  } catch (error) {
    handle.session.kill('SIGKILL');
    try {
      await handle.session.waitForExit({timeoutMs});
    } catch (killError) {
      throw new AggregateError([error, killError], `failed to stop ${runtimeLabel}`);
    }
  } finally {
    handle.terminated = true;
  }
}

export {
  STDIO_VALUE_BRIDGE_FRAMING_V1,
  StdioValueBridgeCallError,
  awaitBridgeReady,
  bridgeCall,
  bridgeQuit,
  createBridgeHandle,
  decodeBridgeValue,
  encodeBridgeValue,
  forceStopSession,
  nextMatchingLine,
  queueCall,
};
