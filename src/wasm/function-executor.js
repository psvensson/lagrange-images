import {WASM_VALUE_HANDLE_ABI_V0, WASM_VALUE_HANDLE_ABI_V1} from './abi.js';
import {createWasmFunctionV1Executor as createTailWasmFunctionV1Executor} from './executor.js';
import {WasmInstancePool} from './instance-pool.js';
import {WasmModuleCache} from './module-cache.js';
import {
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V1,
  WASM_RESUMABLE_VALUE_HANDLE_ABI_V2,
} from './resumable-abi.js';
import {createResumableWasmFunctionV1Executor} from './resumable-executor.js';
import {createWasmFunctionV1CellExecutor} from './executor-v1.js';
import {createResumableWasmFunctionV2Executor} from './resumable-executor-v2.js';
import {assertWasmFunctionArtifactAnyVersion, functionModuleRef} from './function-contract.js';
import {readModuleDescriptor} from './module-contract.js';

function createWasmFunctionV1Executor({
  moduleCache = new WasmModuleCache(),
  instancePool = new WasmInstancePool(),
} = {}) {
  const tail = createTailWasmFunctionV1Executor({moduleCache, instancePool});
  const resumable = createResumableWasmFunctionV1Executor({moduleCache, instancePool});
  const cells = createWasmFunctionV1CellExecutor({moduleCache, instancePool});
  const resumableCells = createResumableWasmFunctionV2Executor({moduleCache, instancePool});

  return Object.freeze({
    moduleCache,
    instancePool,
    async execute(request, context) {
      // The MODULE's ABI decides which contract the pair is read under (ADR 0082): a function
      // artifact selects an entry and carries no ABI of its own. The module is resolved once here
      // and handed to the chosen executor, so a dispatch costs no second read.
      const code = request?.code;
      assertWasmFunctionArtifactAnyVersion(code);
      const moduleRef = functionModuleRef(code);
      const moduleArtifact = await context.images.getCodeArtifact(moduleRef.imageId, moduleRef.objectId);
      if (!moduleArtifact) throw new TypeError(`WASM module not found: ${moduleRef.imageId}/${moduleRef.objectId}`);
      const abi = readModuleDescriptor(moduleArtifact).abi;
      const resolved = Object.freeze({moduleArtifact});
      if (abi === WASM_VALUE_HANDLE_ABI_V0) return await tail.execute(request, context, resolved);
      if (abi === WASM_VALUE_HANDLE_ABI_V1) return await cells.execute(request, context, resolved);
      if (abi === WASM_RESUMABLE_VALUE_HANDLE_ABI_V1) return await resumable.execute(request, context, resolved);
      if (abi === WASM_RESUMABLE_VALUE_HANDLE_ABI_V2) return await resumableCells.execute(request, context, resolved);
      throw new TypeError(`unsupported WASM module ABI: ${abi}`);
    },
  });
}

export {createWasmFunctionV1Executor};
