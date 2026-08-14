import {
  VALUE_KIND,
  booleanValue,
  canonicalizeValue,
  integerValue,
} from '../value/index.js';

const WASM_VALUE_HANDLE_ABI_V0 = 'lagrange-value-handle/v0';
const WASM_IMPORT_MODULE = 'lagrange';
const WASM_ENTRY_V0 = 'run';

function sameValue(left, right) {
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

class ValueHandleArena {
  constructor() {
    this.values = [null];
  }

  put(value) {
    this.values.push(canonicalizeValue(value));
    return this.values.length - 1;
  }

  get(handle, label = 'WASM value handle') {
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
  WASM_IMPORT_MODULE,
  WASM_VALUE_HANDLE_ABI_V0,
  ValueHandleArena,
};
