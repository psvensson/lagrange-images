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

const compilerKey = (policyId, targetRepresentation) => `${policyId}\u0000${targetRepresentation}`;

class CompilationGroupCompilerRegistry {
  constructor(entries = []) {
    this.compilers = new Map();
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
    const key = compilerKey(policy, targetRepresentation);
    if (this.compilers.has(key)) throw new CompilationGroupCompilerRegistrationError(policy, targetRepresentation);
    this.compilers.set(key, compiler);
    return compiler;
  }

  get(policyId, targetRepresentation) {
    const policy = normalizePolicyId(policyId);
    if (typeof targetRepresentation !== 'string' || targetRepresentation.length === 0) {
      throw new TypeError('target representation must be a non-empty string');
    }
    const compiler = this.compilers.get(compilerKey(policy, targetRepresentation));
    if (!compiler) throw new CompilationGroupCompilerNotFoundError(policy, targetRepresentation);
    return compiler;
  }

  has(policyId, targetRepresentation) {
    const policy = normalizePolicyId(policyId);
    if (typeof targetRepresentation !== 'string' || targetRepresentation.length === 0) {
      throw new TypeError('target representation must be a non-empty string');
    }
    return this.compilers.has(compilerKey(policy, targetRepresentation));
  }

  list() {
    return [...this.compilers.keys()]
      .map((key) => key.split('\u0000'))
      .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  }
}

export {
  CompilationGroupCompilerNotFoundError,
  CompilationGroupCompilerRegistrationError,
  CompilationGroupCompilerRegistry,
  assertGroupCompiler,
  normalizePolicyId,
};
