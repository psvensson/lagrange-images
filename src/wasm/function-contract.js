// The single decoder/describer for a compiled WASM FUNCTION artifact (ADR 0082, bead
// lagrange-images-o8a): the counterpart of module-contract.js one level up.
//
// A function artifact selects ONE exported entry of a compiled module and binds that entry's
// closure sites to prototype Blocks. Everything else the executors need (ABI, parameter count,
// captures, cellBindings, site indices) is the MODULE's function-table entry, resolved through the
// module accessor — it is never duplicated on the function.
//
// wasm-function/v2 (canonical): content = canonical JSON {entry, closurePrototypes:[{blockId,
// siteIndex, derivedFromIndex}]}; the module is reached through exactly ONE `role: module`
// dependency (single authority for the module binding, never repeated in JSON). Prototype Blocks
// are named by index into `derivedFrom` ([semantic, module, ...prototypes]) because a dependency
// edge must target a code artifact and a prototype is a Block; `derivedFrom` is preserved by the
// portable bundle, so the binding survives release.
//
// wasm-function/v1 (FROZEN): content = module ref; metadata mirrors {abi, entry, parameters,
// captures, [cellBindings], closurePrototypes}. Still executable in-image through this decoder,
// which cross-checks the mirrors against the module exactly as the executors used to; never
// produced; does not survive release (metadata is stripped).
import {canonicalizeValue, isObjectRef, textValue} from '../value/index.js';
import {
  WASM_FUNCTION_MODULE_DEPENDENCY_ROLE,
  WASM_FUNCTION_V1,
  WASM_FUNCTION_V2,
  assertWasmFunctionArtifact as assertWasmFunctionV1Artifact,
} from '../code/wasm-artifacts.js';
import {canonicalJson, moduleFunctionOf} from './module-contract.js';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requiredIndex(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(', ')}`);
  }
  return value;
}

// The function-owned selection: which entry, and which prototype Block binds each closure site.
function normalizeFunctionSelection(selection, label = 'WASM function selection') {
  exactKeys(selection, ['entry', 'closurePrototypes'], label);
  if (!Array.isArray(selection.closurePrototypes)) throw new TypeError(`${label}.closurePrototypes must be an array`);
  return Object.freeze({
    entry: requiredText(selection.entry, `${label}.entry`),
    closurePrototypes: Object.freeze(selection.closurePrototypes.map((entry, index) => {
      exactKeys(entry, ['blockId', 'siteIndex', 'derivedFromIndex'], `${label}.closurePrototypes[${index}]`);
      const derivedFromIndex = requiredIndex(entry.derivedFromIndex, `${label}.closurePrototypes[${index}].derivedFromIndex`);
      if (derivedFromIndex < 2) throw new TypeError(`${label}.closurePrototypes[${index}].derivedFromIndex must follow the semantic and module provenance entries`);
      return Object.freeze({
        blockId: requiredText(entry.blockId, `${label}.closurePrototypes[${index}].blockId`),
        siteIndex: requiredIndex(entry.siteIndex, `${label}.closurePrototypes[${index}].siteIndex`),
        derivedFromIndex,
      });
    })),
  });
}

function encodeFunctionSelectionContent(selection) {
  return canonicalJson(normalizeFunctionSelection(selection));
}

function moduleDependencyRef(artifact) {
  const deps = (artifact.dependencies ?? []).filter((d) => d.role === WASM_FUNCTION_MODULE_DEPENDENCY_ROLE);
  if (deps.length !== 1) throw new TypeError(`${WASM_FUNCTION_V2} must have exactly one ${WASM_FUNCTION_MODULE_DEPENDENCY_ROLE} dependency`);
  const ref = canonicalizeValue(deps[0].artifact);
  if (!isObjectRef(ref)) throw new TypeError(`${WASM_FUNCTION_V2} module must be an unpinned object ref`);
  return ref;
}

function assertWasmFunctionV2Artifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== WASM_FUNCTION_V2) {
    throw new TypeError(`artifact is not ${WASM_FUNCTION_V2}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError(`${WASM_FUNCTION_V2} content must be a canonical-JSON text Value`);
  let parsed;
  try {
    parsed = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError(`${WASM_FUNCTION_V2} content must be valid JSON`, {cause: error});
  }
  if (canonicalJson(normalizeFunctionSelection(parsed, `${WASM_FUNCTION_V2} content`)) !== artifact.content.value) {
    throw new TypeError(`${WASM_FUNCTION_V2} content is not the canonical serialization of its selection`);
  }
  moduleDependencyRef(artifact);
  return artifact;
}

function assertWasmFunctionArtifactAnyVersion(artifact) {
  if (artifact?.representation === WASM_FUNCTION_V2) return assertWasmFunctionV2Artifact(artifact);
  if (artifact?.representation === WASM_FUNCTION_V1) return assertWasmFunctionV1Artifact(artifact);
  throw new TypeError(`not a WASM function artifact: ${artifact?.representation ?? 'missing'}`);
}

// The module a function executes in: the v2 dependency edge, or the frozen v1 content ref.
function functionModuleRef(artifact) {
  if (artifact?.representation === WASM_FUNCTION_V2) return moduleDependencyRef(assertWasmFunctionV2Artifact(artifact));
  if (artifact?.representation === WASM_FUNCTION_V1) {
    const ref = canonicalizeValue(assertWasmFunctionV1Artifact(artifact).content);
    if (!isObjectRef(ref)) throw new TypeError(`${WASM_FUNCTION_V1} content must reference a WASM module artifact`);
    return ref;
  }
  throw new TypeError(`not a WASM function artifact: ${artifact?.representation ?? 'missing'}`);
}

// The function's own selection {entry, closurePrototypes} plus, for frozen v1 only, the metadata
// mirrors that the v1 contract cross-checks against the module.
function readFunctionSelection(artifact) {
  if (artifact?.representation === WASM_FUNCTION_V2) {
    assertWasmFunctionV2Artifact(artifact);
    return Object.freeze({...normalizeFunctionSelection(JSON.parse(artifact.content.value)), mirrors: null});
  }
  if (artifact?.representation === WASM_FUNCTION_V1) {
    assertWasmFunctionV1Artifact(artifact);
    const md = artifact.metadata;
    const prototypes = md.closurePrototypes ?? [];
    if (!Array.isArray(prototypes)) throw new TypeError(`${WASM_FUNCTION_V1} metadata.closurePrototypes must be an array`);
    return Object.freeze({
      entry: md.entry,
      closurePrototypes: Object.freeze(prototypes.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`WASM closure prototype ${index} must be an object`);
        const keys = Object.keys(entry).sort().join(',');
        // The oldest v1 form omitted siteIndex (positional); the later one names it.
        if (keys !== 'blockId,derivedFromIndex' && keys !== 'blockId,derivedFromIndex,siteIndex') {
          throw new TypeError(`WASM closure prototype ${index} has unsupported fields`);
        }
        return Object.freeze({...entry});
      })),
      mirrors: Object.freeze({
        abi: md.abi,
        parameters: md.parameters,
        captures: Object.freeze([...(md.captures ?? [])]),
        ...(Object.hasOwn(md, 'cellBindings') ? {cellBindings: md.cellBindings} : {}),
      }),
    });
  }
  throw new TypeError(`not a WASM function artifact: ${artifact?.representation ?? 'missing'}`);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Resolve the function against its module's (already normalized) contract: the active function
// descriptor, the ABI, and the closure-site -> prototype Block binding. `moduleContract.functions`
// must be the executor-normalized function table (exact keys, validated site indices) and
// `moduleContract.closureSites` the normalized sites, so the checks here are the last word.
function resolveFunctionContract(artifact, moduleContract) {
  const selection = readFunctionSelection(artifact);
  const descriptor = moduleFunctionOf(moduleContract, {entry: selection.entry});
  if (selection.mirrors) {
    // Frozen v1: the mirrors must agree with the module, exactly as the executors always required.
    const m = selection.mirrors;
    if (m.abi !== moduleContract.abi) throw new TypeError(`WASM function ABI ${m.abi} does not match module ABI ${moduleContract.abi}`);
    if (descriptor.parameters !== m.parameters) throw new TypeError('WASM function parameter metadata does not match module entry');
    if (!sameStrings(descriptor.captures, m.captures)) throw new TypeError('WASM function capture metadata does not match module entry');
    if (descriptor.cellBindings !== undefined || m.cellBindings !== undefined) {
      if (canonicalJson(descriptor.cellBindings ?? []) !== canonicalJson(m.cellBindings ?? [])) {
        throw new TypeError('WASM function cell binding metadata does not match module entry');
      }
    }
  }
  const closureSites = moduleContract.closureSites;
  const entries = selection.closurePrototypes;
  if (entries.length !== descriptor.closureSiteIndices.length) {
    throw new TypeError('WASM closure prototype count does not match module function closure sites');
  }
  const closurePrototypes = new Map();
  entries.forEach((entry, localIndex) => {
    const siteIndex = entry.siteIndex === undefined
      ? descriptor.closureSiteIndices[localIndex]
      : requiredIndex(entry.siteIndex, `WASM closure prototype ${localIndex} siteIndex`);
    if (siteIndex !== descriptor.closureSiteIndices[localIndex]) {
      throw new TypeError(`WASM closure prototype ${localIndex} does not match module function closure site index`);
    }
    const site = closureSites[siteIndex];
    if (!site || entry.blockId !== site.blockId) {
      throw new TypeError(`WASM closure prototype ${localIndex} does not match closure site ${site?.blockId ?? siteIndex}`);
    }
    const derivedFromIndex = requiredIndex(entry.derivedFromIndex, `WASM closure prototype ${localIndex} derivedFromIndex`);
    const derivedFrom = artifact.derivedFrom ?? [];
    if (derivedFromIndex < 2 || derivedFromIndex >= derivedFrom.length) {
      throw new TypeError(`WASM closure prototype ${localIndex} derivedFromIndex is out of range`);
    }
    const ref = canonicalizeValue(derivedFrom[derivedFromIndex]);
    if (!isObjectRef(ref)) throw new TypeError(`WASM closure prototype ${localIndex} must resolve to an unpinned Block ref`);
    closurePrototypes.set(siteIndex, ref);
  });
  return Object.freeze({entry: selection.entry, abi: moduleContract.abi, descriptor, closurePrototypes});
}

// THE durable v2 function artifact, described once. `prototypeRefs` are the Block refs the closure
// prototypes index into (derivedFrom = [semantic, module, ...prototypeRefs]).
function describeWasmFunctionV2({functionId, languageId, semanticRef, moduleRef, entry, closurePrototypes = [], prototypeRefs = []} = {}) {
  requiredText(functionId, 'WASM function id');
  const semantic = canonicalizeValue(semanticRef);
  const module = canonicalizeValue(moduleRef);
  if (!isObjectRef(semantic)) throw new TypeError('WASM function semanticRef must be an unpinned object ref');
  if (!isObjectRef(module)) throw new TypeError('WASM function moduleRef must be an unpinned object ref');
  const selection = normalizeFunctionSelection({entry, closurePrototypes});
  for (const [index, prototype] of selection.closurePrototypes.entries()) {
    if (prototype.derivedFromIndex >= 2 + prototypeRefs.length) {
      throw new TypeError(`WASM closure prototype ${index} derivedFromIndex names no supplied prototype`);
    }
  }
  return Object.freeze({
    id: functionId,
    languageId,
    representation: WASM_FUNCTION_V2,
    content: textValue(canonicalJson(selection)),
    dependencies: [{role: WASM_FUNCTION_MODULE_DEPENDENCY_ROLE, artifact: module}],
    derivedFrom: [semantic, module, ...prototypeRefs.map((ref) => canonicalizeValue(ref))],
    metadata: {},
  });
}

export {
  WASM_FUNCTION_MODULE_DEPENDENCY_ROLE,
  WASM_FUNCTION_V1,
  WASM_FUNCTION_V2,
  assertWasmFunctionArtifactAnyVersion,
  assertWasmFunctionV2Artifact,
  describeWasmFunctionV2,
  encodeFunctionSelectionContent,
  functionModuleRef,
  normalizeFunctionSelection,
  readFunctionSelection,
  resolveFunctionContract,
};
