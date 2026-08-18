// WebAssembly binary-format encoders, shared by the v0 and v1 backends.
//
// Extracted verbatim so the v1 backend can be a separate module rather than a set of branches
// inside the v0 one. ADR 0043's WASM lane advances the ABI, and the surest way to leave
// lagrange-value-handle/v0 byte-identical is for its compiler not to change at all.
const I32 = 0x7f;
const FUNC = 0x60;

function u32(value) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError('u32 LEB value must be a non-negative integer');
  const out = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    out.push(byte);
  } while (current !== 0);
  return out;
}

function s32(value) {
  if (!Number.isInteger(value)) throw new TypeError('s32 LEB value must be an integer');
  const out = [];
  let current = value | 0;
  while (true) {
    let byte = current & 0x7f;
    current >>= 7;
    const sign = byte & 0x40;
    const done = (current === 0 && sign === 0) || (current === -1 && sign !== 0);
    if (!done) byte |= 0x80;
    out.push(byte);
    if (done) return out;
  }
}

function text(value) {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
}

function vector(entries) {
  return [...u32(entries.length), ...entries.flat()];
}

function section(id, payload) {
  return [id, ...u32(payload.length), ...payload];
}

function functionType(parameters, results) {
  return [FUNC, ...vector(parameters.map((value) => [value])), ...vector(results.map((value) => [value]))];
}

function functionImport(module, name, typeIndex) {
  return [...text(module), ...text(name), 0x00, ...u32(typeIndex)];
}

function functionExport(name, functionIndex) {
  return [...text(name), 0x00, ...u32(functionIndex)];
}

export {
  FUNC,
  I32,
  functionExport,
  functionImport,
  functionType,
  s32,
  section,
  text,
  u32,
  vector,
};
