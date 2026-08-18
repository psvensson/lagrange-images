const WASM_RESUMABLE_VALUE_HANDLE_ABI_V1 = 'lagrange-value-handle-resumable/v1';
// The resumable ABI is versioned independently of the simple one, so mutable lexical state
// advances it separately. A cell must stay correct across a non-tail send and its resumption,
// which is a property of the continuation machinery rather than of the cell operations.
const WASM_RESUMABLE_VALUE_HANDLE_ABI_V2 = 'lagrange-value-handle-resumable/v2';

export {WASM_RESUMABLE_VALUE_HANDLE_ABI_V1, WASM_RESUMABLE_VALUE_HANDLE_ABI_V2};
