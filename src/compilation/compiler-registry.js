class CodeCompilerRegistrationError extends Error {
  constructor(sourceRepresentation, targetRepresentation) {
    super(`compiler already registered: ${sourceRepresentation} -> ${targetRepresentation}`);
    this.name = 'CodeCompilerRegistrationError';
    this.sourceRepresentation = sourceRepresentation;
    this.targetRepresentation = targetRepresentation;
  }
}

class CodeCompilerNotFoundError extends Error {
  constructor(sourceRepresentation, targetRepresentation) {
    super(`compiler not registered: ${sourceRepresentation} -> ${targetRepresentation}`);
    this.name = 'CodeCompilerNotFoundError';
    this.sourceRepresentation = sourceRepresentation;
    this.targetRepresentation = targetRepresentation;
  }
}

function normalizeRepresentation(value, label = 'representation') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertCompiler(compiler) {
  if (!compiler || typeof compiler !== 'object' || typeof compiler.compile !== 'function') {
    throw new TypeError('compiler must implement compile(request, context)');
  }
  return compiler;
}

const compilerKey = (source, target) => `${source}\u0000${target}`;

class CodeCompilerRegistry {
  constructor(entries = []) {
    this.compilers = new Map();
    for (const [source, target, compiler] of entries) this.register(source, target, compiler);
  }

  register(sourceRepresentation, targetRepresentation, compiler) {
    const source = normalizeRepresentation(sourceRepresentation, 'source representation');
    const target = normalizeRepresentation(targetRepresentation, 'target representation');
    assertCompiler(compiler);
    const key = compilerKey(source, target);
    if (this.compilers.has(key)) throw new CodeCompilerRegistrationError(source, target);
    this.compilers.set(key, compiler);
    return compiler;
  }

  get(sourceRepresentation, targetRepresentation) {
    const source = normalizeRepresentation(sourceRepresentation, 'source representation');
    const target = normalizeRepresentation(targetRepresentation, 'target representation');
    const compiler = this.compilers.get(compilerKey(source, target));
    if (!compiler) throw new CodeCompilerNotFoundError(source, target);
    return compiler;
  }

  has(sourceRepresentation, targetRepresentation) {
    const source = normalizeRepresentation(sourceRepresentation, 'source representation');
    const target = normalizeRepresentation(targetRepresentation, 'target representation');
    return this.compilers.has(compilerKey(source, target));
  }

  list() {
    return [...this.compilers.keys()].map((key) => key.split('\u0000')).sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  }
}

export {
  CodeCompilerNotFoundError,
  CodeCompilerRegistrationError,
  CodeCompilerRegistry,
  assertCompiler,
  normalizeRepresentation,
};
