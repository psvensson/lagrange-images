import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  integerValue,
} from '../value/index.js';

const WASM_VALUE_HANDLE_ABI_V0 = 'lagrange-value-handle/v0';
// ADR 0043's lexical cells. v0 stays frozen: it resolves every capture to a Value handle before
// entry and gives make_block_site one handle per capture, neither of which can express a live
// cell. v1 adds synchronous cell_get/cell_set and mixed-mode closure sites.
const WASM_VALUE_HANDLE_ABI_V1 = 'lagrange-value-handle/v1';
const WASM_IMPORT_MODULE = 'lagrange';
const WASM_ENTRY_V0 = 'run';

function sameValue(left, right) {
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

class ValueHandleArena {
  #receiverAbsent;

  // Handle 0 is reserved, and in a well-formed module the only way it reaches a value position is
  // an activation reading a receiver it does not have. Reporting "invalid handle" there would leak
  // the handle ABI in place of the program's actual error, and would make the WASM lane disagree
  // with the neutral lane about *why* the program failed — not merely about wording.
  constructor({receiverAbsent = false} = {}) {
    this.values = [null];
    this.#receiverAbsent = receiverAbsent;
  }

  put(value) {
    this.values.push(canonicalizeValue(value));
    return this.values.length - 1;
  }

  get(handle, label = 'WASM value handle') {
    if (handle === 0 && this.#receiverAbsent) throw new TypeError('activation has no receiver');
    if (!Number.isInteger(handle) || handle <= 0 || handle >= this.values.length) {
      throw new TypeError(`${label} is invalid: ${handle}`);
    }
    return this.values[handle];
  }

  integerAdd(leftHandle, rightHandle) {
    const left = this.get(leftHandle, 'integer-add left handle');
    const right = this.get(rightHandle, 'integer-add right handle');
    if (left.kind !== VALUE_KIND.INTEGER || right.kind !== VALUE_KIND.INTEGER) {
      throw new TypeError('WASM integer_add operands must be integer Values');
    }
    return this.put(integerValue(BigInt(left.value) + BigInt(right.value)));
  }

  equals(leftHandle, rightHandle) {
    return this.put(booleanValue(sameValue(
      this.get(leftHandle, 'equals left handle'),
      this.get(rightHandle, 'equals right handle'),
    )));
  }

  isTrue(handle) {
    const value = this.get(handle, 'boolean handle');
    if (value.kind !== VALUE_KIND.BOOLEAN) throw new TypeError('WASM condition must be a boolean Value');
    return value.value ? 1 : 0;
  }
}

export {
  WASM_ENTRY_V0,
  WASM_VALUE_HANDLE_ABI_V1,
  WASM_IMPORT_MODULE,
  WASM_VALUE_HANDLE_ABI_V0,
  ValueHandleArena,
};
