import {WASM_VALUE_HANDLE_ABI_V0, WASM_VALUE_HANDLE_ABI_V1} from './abi.js';
import {createWasmFunctionV1Executor as createTailWasmFunctionV1Executor} from './executor.js';
import {WasmInstancePool} from './instance-pool.js';
import {WasmModuleCache} from './module-cache.js';
import {WASM_RESUMABLE_VALUE_HANDLE_ABI_V1} from './resumable-abi.js';
import {createResumableWasmFunctionV1Executor} from './resumable-executor.js';
import {createWasmFunctionV1CellExecutor} from './executor-v1.js';

function createWasmFunctionV1Executor({
  moduleCache = new WasmModuleCache(),
  instancePool = new WasmInstancePool(),
} = {}) {
  const tail = createTailWasmFunctionV1Executor({moduleCache, instancePool});
  const resumable = createResumableWasmFunctionV1Executor({moduleCache, instancePool});
  const cells = createWasmFunctionV1CellExecutor({moduleCache, instancePool});

  return Object.freeze({
    moduleCache,
    instancePool,
    async execute(request, context) {
      const abi = request?.code?.metadata?.abi;
      if (abi === WASM_VALUE_HANDLE_ABI_V0) return await tail.execute(request, context);
      // The representation stays wasm-function/v1; the declared ABI decides which contract the
      // artifact is read under, so no normalizer has to accept two shapes.
      if (abi === WASM_VALUE_HANDLE_ABI_V1) return await cells.execute(request, context);
      if (abi === WASM_RESUMABLE_VALUE_HANDLE_ABI_V1) return await resumable.execute(request, context);
      throw new TypeError(`unsupported WASM function ABI: ${abi}`);
    },
  });
}

export {createWasmFunctionV1Executor};
