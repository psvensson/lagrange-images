import {VALUE_KIND, canonicalizeValue, isObjectRef} from '../value/index.js';

const WASM_MODULE_V1 = 'wasm-module/v1';
const WASM_FUNCTION_V1 = 'wasm-function/v1';

function assertWasmModuleArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_MODULE_V1) {
    throw new TypeError(`artifact is not ${WASM_MODULE_V1}`);
  }
  if (artifact.content?.kind !== VALUE_KIND.BYTES) {
    throw new TypeError(`${WASM_MODULE_V1} content must be a bytes Value`);
  }
  return artifact;
}

function assertWasmFunctionArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_FUNCTION_V1) {
    throw new TypeError(`artifact is not ${WASM_FUNCTION_V1}`);
  }
  const moduleRef = canonicalizeValue(artifact.content);
  if (!isObjectRef(moduleRef)) throw new TypeError(`${WASM_FUNCTION_V1} content must reference a WASM module artifact`);
  if (typeof artifact.metadata?.entry !== 'string' || artifact.metadata.entry.length === 0) {
    throw new TypeError(`${WASM_FUNCTION_V1} metadata.entry must name a function entry`);
  }
  return artifact;
}

export {
  WASM_FUNCTION_V1,
  WASM_MODULE_V1,
  assertWasmFunctionArtifact,
  assertWasmModuleArtifact,
};
