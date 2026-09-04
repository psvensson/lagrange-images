import {VALUE_KIND, canonicalizeValue, isObjectRef} from '../value/index.js';

const WASM_MODULE_V1 = 'wasm-module/v1';
const WASM_FUNCTION_V1 = 'wasm-function/v1';
// wasm-function/v2 (ADR 0082): entry selection + closure-prototype binding as canonical-JSON
// content, the module reached through exactly one `role: module` dependency. v1 is FROZEN.
const WASM_FUNCTION_V2 = 'wasm-function/v2';
const WASM_FUNCTION_MODULE_DEPENDENCY_ROLE = 'module';
// wasm-binary/v1 is the NEUTRAL raw-WASM byte owner: exact compiled bytes and nothing else (no
// ABI, no call semantics). It is the implementation dependency of BOTH the foreign
// wasm-callable-interface/v1 and the compiled wasm-module/v2, so its identity lives here, in the
// language-neutral representation module, not in the foreign lane.
const WASM_BINARY_V1 = 'wasm-binary/v1';
const WASM_IMPLEMENTATION_DEPENDENCY_ROLE = 'implementation';

function assertWasmBinaryArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_BINARY_V1) {
    throw new TypeError(`artifact must be ${WASM_BINARY_V1}`);
  }
  if (artifact.content?.kind !== VALUE_KIND.BYTES) throw new TypeError('WASM binary content must be a bytes Value');
  return artifact;
}

function assertWasmModuleArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_MODULE_V1) {
    throw new TypeError(`artifact is not ${WASM_MODULE_V1}`);
  }
  if (artifact.content?.kind !== VALUE_KIND.BYTES) {
    throw new TypeError(`${WASM_MODULE_V1} content must be a bytes Value`);
  }
  if (typeof artifact.metadata?.abi !== 'string' || artifact.metadata.abi.length === 0) {
    throw new TypeError(`${WASM_MODULE_V1} metadata.abi must name an ABI`);
  }
  if (!Array.isArray(artifact.metadata?.literals)) {
    throw new TypeError(`${WASM_MODULE_V1} metadata.literals must be an array`);
  }
  if (artifact.metadata?.instanceReuse !== undefined
      && (typeof artifact.metadata.instanceReuse !== 'string' || artifact.metadata.instanceReuse.length === 0)) {
    throw new TypeError(`${WASM_MODULE_V1} metadata.instanceReuse must be non-empty text when present`);
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
  if (typeof artifact.metadata?.abi !== 'string' || artifact.metadata.abi.length === 0) {
    throw new TypeError(`${WASM_FUNCTION_V1} metadata.abi must name an ABI`);
  }
  if (!Number.isInteger(artifact.metadata?.parameters) || artifact.metadata.parameters < 0) {
    throw new TypeError(`${WASM_FUNCTION_V1} metadata.parameters must be a non-negative integer`);
  }
  if (!Array.isArray(artifact.metadata?.captures)) {
    throw new TypeError(`${WASM_FUNCTION_V1} metadata.captures must be an array`);
  }
  return artifact;
}

export {
  WASM_BINARY_V1,
  WASM_FUNCTION_MODULE_DEPENDENCY_ROLE,
  WASM_FUNCTION_V1,
  WASM_FUNCTION_V2,
  WASM_IMPLEMENTATION_DEPENDENCY_ROLE,
  WASM_MODULE_V1,
  assertWasmBinaryArtifact,
  assertWasmFunctionArtifact,
  assertWasmModuleArtifact,
};
