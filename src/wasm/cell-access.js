import {EscapingMutableClosureError} from '../execution/lexical-cells.js';

// Both WASM ABIs reach lexical cells through synchronous, cell-only operations that raise when a
// binding is not a cell of the running activation. That single failure covers two situations the
// language treats differently, and the cell binding's `source` distinguishes them:
//
//   source: 'temporary'  a slot this activation should have declared. Its absence is a malformed
//                        artifact, and MissingLexicalCellError says exactly that.
//
//   source: 'capture'    a cell that belonged to the frame that declared it. Its absence means the
//                        closure outlived the execution owning that cell — ADR 0043 decision 5's
//                        unsupported escaping mutable closure, which the neutral lane reports as
//                        EscapingMutableClosureError when it meets the durable {cell: true} record.
//
// The lanes must agree on which failure this is, so the WASM side translates rather than inventing
// a durable fallback. A fallback would be asynchronous, unusable from a WASM import, and would
// reopen the snapshot channel the cell-only rule exists to close.
function translateMissingCell(error, binding) {
  if (error?.name === 'MissingLexicalCellError' && binding.source === 'capture') {
    return new EscapingMutableClosureError(binding.id, binding.name);
  }
  return error;
}

function readCellThrough(readCell, binding) {
  try {
    return readCell(binding.id);
  } catch (error) {
    throw translateMissingCell(error, binding);
  }
}

function writeCellThrough(writeCell, binding, value) {
  try {
    return writeCell(binding.id, value);
  } catch (error) {
    throw translateMissingCell(error, binding);
  }
}

export {readCellThrough, translateMissingCell, writeCellThrough};
