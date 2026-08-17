import {TupleMap} from '../support/tuple-map.js';
import {compareTuples} from './compiler-registry.js';

class CompilationGroupCompilerRegistrationError extends Error {
  constructor(policyId, targetRepresentation) {
    super(`group compiler already registered: ${policyId} -> ${targetRepresentation}`);
    this.name = 'CompilationGroupCompilerRegistrationError';
    this.policyId = policyId;
    this.targetRepresentation = targetRepresentation;
  }
}

class CompilationGroupCompilerNotFoundError extends Error {
  constructor(policyId, targetRepresentation) {
    super(`group compiler not registered: ${policyId} -> ${targetRepresentation}`);
    this.name = 'CompilationGroupCompilerNotFoundError';
    this.policyId = policyId;
    this.targetRepresentation = targetRepresentation;
  }
}

function normalizePolicyId(value, label = 'compilation group policyId') {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function assertGroupCompiler(compiler) {
  if (!compiler || typeof compiler !== 'object' || typeof compiler.compile !== 'function') {
    throw new TypeError('group compiler must implement compile(request, context)');
  }
  return compiler;
}

class CompilationGroupCompilerRegistry {
  constructor(entries = []) {
    // Keyed by the (policyId, target) tuple: policy ids and representations are arbitrary
    // non-empty text, so a joined key is not injective.
    this.compilers = new TupleMap(2);
    for (const [policyId, targetRepresentation, compiler] of entries) {
      this.register(policyId, targetRepresentation, compiler);
    }
  }

  register(policyId, targetRepresentation, compiler) {
    const policy = normalizePolicyId(policyId);
    if (typeof targetRepresentation !== 'string' || targetRepresentation.length === 0) {
      throw new TypeError('target representation must be a non-empty string');
    }
    assertGroupCompiler(compiler);
    if (this.compilers.has([policy, targetRepresentation])) {
      throw new CompilationGroupCompilerRegistrationError(policy, targetRepresentation);
    }
    this.compilers.set([policy, targetRepresentation], compiler);
    return compiler;
  }

  get(policyId, targetRepresentation) {
    const policy = normalizePolicyId(policyId);
    if (typeof targetRepresentation !== 'string' || targetRepresentation.length === 0) {
      throw new TypeError('target representation must be a non-empty string');
    }
    const compiler = this.compilers.get([policy, targetRepresentation]);
    if (!compiler) throw new CompilationGroupCompilerNotFoundError(policy, targetRepresentation);
    return compiler;
  }

  has(policyId, targetRepresentation) {
    const policy = normalizePolicyId(policyId);
    if (typeof targetRepresentation !== 'string' || targetRepresentation.length === 0) {
      throw new TypeError('target representation must be a non-empty string');
    }
    return this.compilers.has([policy, targetRepresentation]);
  }

  list() {
    return [...this.compilers.keys()].sort(compareTuples);
  }
}

export {
  CompilationGroupCompilerNotFoundError,
  CompilationGroupCompilerRegistrationError,
  CompilationGroupCompilerRegistry,
  assertGroupCompiler,
  normalizePolicyId,
};
