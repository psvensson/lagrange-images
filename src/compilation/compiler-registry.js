import {TupleMap} from '../support/tuple-map.js';

// Ordered by part, so ordering never depends on a separator either.
function compareTuples(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const order = left[index].localeCompare(right[index]);
    if (order !== 0) return order;
  }
  return 0;
}

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

class CodeCompilerRegistry {
  constructor(entries = []) {
    // Keyed by the (source, target) tuple rather than by a joined string. Representations are
    // arbitrary non-empty text, so no separator is safe to join on: see src/support/tuple-map.js.
    this.compilers = new TupleMap(2);
    for (const [source, target, compiler] of entries) this.register(source, target, compiler);
  }

  register(sourceRepresentation, targetRepresentation, compiler) {
    const source = normalizeRepresentation(sourceRepresentation, 'source representation');
    const target = normalizeRepresentation(targetRepresentation, 'target representation');
    assertCompiler(compiler);
    if (this.compilers.has([source, target])) throw new CodeCompilerRegistrationError(source, target);
    this.compilers.set([source, target], compiler);
    return compiler;
  }

  get(sourceRepresentation, targetRepresentation) {
    const source = normalizeRepresentation(sourceRepresentation, 'source representation');
    const target = normalizeRepresentation(targetRepresentation, 'target representation');
    const compiler = this.compilers.get([source, target]);
    if (!compiler) throw new CodeCompilerNotFoundError(source, target);
    return compiler;
  }

  has(sourceRepresentation, targetRepresentation) {
    const source = normalizeRepresentation(sourceRepresentation, 'source representation');
    const target = normalizeRepresentation(targetRepresentation, 'target representation');
    return this.compilers.has([source, target]);
  }

  list() {
    return [...this.compilers.keys()].sort(compareTuples);
  }
}

export {
  CodeCompilerNotFoundError,
  compareTuples,
  CodeCompilerRegistrationError,
  CodeCompilerRegistry,
  assertCompiler,
  normalizeRepresentation,
};
