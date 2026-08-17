import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {parseAnyCallableInterfaceArtifact} from './interface-v2-artifacts.js';

// Every implementation binding points at the callable interface it implements through
// this role. The interface never points back, so one interface artifact can be shared
// by any number of lanes without knowing they exist.
const CALLABLE_INTERFACE_DEPENDENCY_ROLE = 'interface';

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

function bindingDependencyRef(artifact, role, label) {
  const matches = (artifact.dependencies ?? []).filter((dependency) => dependency.role === role);
  if (matches.length !== 1) {
    throw new TypeError(`${label} must declare exactly one ${role} dependency`);
  }
  return normalizeObjectRef(matches[0].artifact, `${label} ${role}`);
}

function assertBindingDependencies(artifact, roles, label) {
  const actual = (artifact.dependencies ?? []).map((dependency) => dependency.role).sort();
  const expected = [...roles].sort();
  if (actual.length !== expected.length || actual.some((role, index) => role !== expected[index])) {
    throw new TypeError(`${label} must declare exactly the dependencies ${expected.join(', ')}`);
  }
  return artifact;
}

async function resolveCallableInterface(images, bindingArtifact, label) {
  const ref = bindingDependencyRef(bindingArtifact, CALLABLE_INTERFACE_DEPENDENCY_ROLE, label);
  const artifact = await images.getCodeArtifact(ref.imageId, ref.objectId);
  if (!artifact) throw new TypeError(`${label} interface not found: ${ref.imageId}/${ref.objectId}`);
  return Object.freeze({descriptor: parseAnyCallableInterfaceArtifact(artifact), ref});
}

async function resolveBindingDependency(images, bindingArtifact, role, label) {
  const ref = bindingDependencyRef(bindingArtifact, role, label);
  const artifact = await images.getCodeArtifact(ref.imageId, ref.objectId);
  if (!artifact) throw new TypeError(`${label} ${role} not found: ${ref.imageId}/${ref.objectId}`);
  return Object.freeze({artifact, ref});
}

export {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  bindingDependencyRef,
  normalizeObjectRef,
  resolveBindingDependency,
  resolveCallableInterface,
};
