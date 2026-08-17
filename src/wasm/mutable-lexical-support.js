import {LAGRANGE_CODE_V1} from '../code/lagrange-code-v1.js';

// ADR 0043 decision 10: both execution lanes agree, or the semantics are not implemented. The
// common lexical-cell substrate landed first, so lagrange-code/v1 currently runs on the neutral
// lane only.
//
// The honest response to that is an explicit refusal, not a differential bug. A shared mutable cell
// cannot simply become a WASM local: the closure that writes it is a separate activation with its
// own frame, so the cell has to live host-side behind synchronous accessors — which is a compiler
// ABI change, and therefore a versioned one.
class WasmMutableLexicalStateUnsupportedError extends TypeError {
  constructor(representation) {
    super(
      `the Lagrange-WASM lane cannot yet compile ${representation}: mutable lexical cells need `
      + 'lagrange-value-handle/v1 accessors. Use the neutral execution lane for this program.',
    );
    this.name = 'WasmMutableLexicalStateUnsupportedError';
    this.representation = representation;
  }
}

function isWasmMutableLexicalStateUnsupportedError(error) {
  return error instanceof WasmMutableLexicalStateUnsupportedError;
}

// Called during preflight, before any derived artifact is written, so a rejected program leaves no
// half-installed module, function or prototype tree behind.
function assertWasmSupportedSemanticRepresentation(representation) {
  if (representation === LAGRANGE_CODE_V1) {
    throw new WasmMutableLexicalStateUnsupportedError(representation);
  }
  return representation;
}

export {
  WasmMutableLexicalStateUnsupportedError,
  assertWasmSupportedSemanticRepresentation,
  isWasmMutableLexicalStateUnsupportedError,
};
