import {getDefaultCryptoProvider} from '../support/default-crypto.js';
import {utf8Encode} from '../support/portable-bytes.js';
import {CALLABLE_TYPES} from './interface-artifacts.js';

// The callable-interface/v2 type grammar.
//
// A type position is either a string — a primitive, or the name of a type declared in the
// descriptor's `types` map — or a structural object for a type constructor. String type
// *expressions* such as "list<string>" are rejected on purpose: they would require a
// type-expression parser inside the descriptor that every future constructor has to extend.
//
//   type        := primitive | declared-name | {kind: 'list', element: type}
//   declaration := {kind: 'record', fields: [{name, type}]}
//
// `list<u8>` stays a primitive atom meaning canonical bytes. It is deliberately NOT
// respelled as {kind:'list', element:'u8'}: `u8` is not a primitive here, and a second
// spelling for bytes would be worse than the inconsistency.
const CALLABLE_PRIMITIVE_TYPES = CALLABLE_TYPES;

// Bounds exist so a malformed or hostile descriptor cannot cost unbounded work. They are
// generous relative to anything a real interface should need.
const MAX_TYPE_DEPTH = 16;
const MAX_RECORD_FIELDS = 256;
const MAX_DECLARATIONS = 256;

const TYPE_EXPRESSION_SHAPE = /[<>]/;
const DECLARED_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function isPrimitiveType(type) {
  return typeof type === 'string' && CALLABLE_PRIMITIVE_TYPES.includes(type);
}

function isCompositeType(type) {
  // A composite is anything that does not map directly to one canonical Value: a list
  // constructor, or a reference to a declared record. Primitives are not composites, and
  // `list<u8>` is a primitive because canonical bytes already carries it.
  return !isPrimitiveType(type);
}

function normalizeTypeExpression(type, declaredNames, label, depth = 0) {
  if (depth > MAX_TYPE_DEPTH) throw new TypeError(`${label} exceeds the maximum type depth of ${MAX_TYPE_DEPTH}`);

  if (typeof type === 'string') {
    if (isPrimitiveType(type)) return type;
    if (TYPE_EXPRESSION_SHAPE.test(type)) {
      throw new TypeError(
        `${label} uses the string type expression ${JSON.stringify(type)}; v2 type constructors must be structural, e.g. {"kind":"list","element":"string"}`,
      );
    }
    if (!DECLARED_NAME.test(type)) throw new TypeError(`${label} is not a valid type name: ${JSON.stringify(type)}`);
    if (!declaredNames.has(type)) throw new TypeError(`${label} references undeclared type ${JSON.stringify(type)}`);
    return type;
  }

  plainObject(type, label);
  const kind = requiredText(type.kind, `${label} kind`);
  if (kind !== 'list') {
    throw new TypeError(`${label} has unsupported type constructor ${JSON.stringify(kind)}; v2 supports list`);
  }
  exactKeys(type, ['kind', 'element'], label);
  return Object.freeze({
    kind: 'list',
    element: normalizeTypeExpression(type.element, declaredNames, `${label} element`, depth + 1),
  });
}

function normalizeRecordDeclaration(declaration, name, declaredNames) {
  exactKeys(declaration, ['kind', 'fields'], `type ${name}`);
  if (declaration.kind !== 'record') {
    throw new TypeError(`type ${name} has unsupported declaration kind ${JSON.stringify(declaration.kind)}; v2 supports record`);
  }
  if (!Array.isArray(declaration.fields)) throw new TypeError(`type ${name} fields must be an array`);
  if (declaration.fields.length === 0) throw new TypeError(`type ${name} must declare at least one field`);
  if (declaration.fields.length > MAX_RECORD_FIELDS) {
    throw new TypeError(`type ${name} exceeds the maximum of ${MAX_RECORD_FIELDS} fields`);
  }
  const seen = new Set();
  // Field order is preserved: it is part of the type's meaning and of the encoding layout.
  const fields = declaration.fields.map((field, index) => {
    exactKeys(field, ['name', 'type'], `type ${name} field ${index}`);
    const fieldName = requiredText(field.name, `type ${name} field ${index} name`);
    if (!DECLARED_NAME.test(fieldName)) {
      throw new TypeError(`type ${name} field name is not valid: ${JSON.stringify(fieldName)}`);
    }
    if (seen.has(fieldName)) throw new TypeError(`type ${name} declares duplicate field ${fieldName}`);
    seen.add(fieldName);
    return Object.freeze({
      name: fieldName,
      type: normalizeTypeExpression(field.type, declaredNames, `type ${name} field ${fieldName}`),
    });
  });
  return Object.freeze({kind: 'record', fields: Object.freeze(fields)});
}

function referencedNames(type, into = new Set()) {
  if (typeof type === 'string') {
    if (!isPrimitiveType(type)) into.add(type);
    return into;
  }
  return referencedNames(type.element, into);
}

// A record that reaches itself would describe an infinite value, and ADR 0035 makes
// acyclicity a hard rule rather than an encoder concern.
function assertAcyclicDeclarations(types) {
  const state = new Map();
  const visit = (name, trail) => {
    const status = state.get(name);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new TypeError(`type declarations are cyclic: ${[...trail, name].join(' -> ')}`);
    }
    state.set(name, 'visiting');
    for (const field of types[name].fields) {
      for (const referenced of referencedNames(field.type)) {
        visit(referenced, [...trail, name]);
      }
    }
    state.set(name, 'done');
  };
  for (const name of Object.keys(types)) visit(name, []);
}

function normalizeTypeDeclarations(input) {
  if (input === undefined) return Object.freeze({});
  plainObject(input, 'callable interface types');
  const names = Object.keys(input);
  if (names.length > MAX_DECLARATIONS) {
    throw new TypeError(`callable interface declares more than ${MAX_DECLARATIONS} types`);
  }
  for (const name of names) {
    if (!DECLARED_NAME.test(name)) throw new TypeError(`type name is not valid: ${JSON.stringify(name)}`);
    if (isPrimitiveType(name)) throw new TypeError(`type name ${JSON.stringify(name)} shadows a primitive`);
  }
  const declaredNames = new Set(names);
  const normalized = {};
  // Declaration names are sorted: `types` is a set of declarations, not a sequence, so its
  // key order must not affect the canonical form or the fingerprint.
  for (const name of [...names].sort()) {
    normalized[name] = normalizeRecordDeclaration(input[name], name, declaredNames);
  }
  assertAcyclicDeclarations(normalized);
  return Object.freeze(normalized);
}

// Deterministic serialization. Object key order is never semantically significant, so it is
// erased here before hashing; arrays keep their order because record fields are ordered.
function canonicalTypeJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTypeJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalTypeJson(value[key])}`).join(',')}}`;
}

function reachableDeclarations(type, types) {
  const reachable = {};
  const pending = [...referencedNames(type)];
  while (pending.length > 0) {
    const name = pending.pop();
    if (reachable[name]) continue;
    const declaration = types[name];
    if (!declaration) throw new TypeError(`type ${JSON.stringify(name)} is not declared`);
    reachable[name] = declaration;
    for (const field of declaration.fields) {
      for (const referenced of referencedNames(field.type)) pending.push(referenced);
    }
  }
  const sorted = {};
  for (const name of Object.keys(reachable).sort()) sorted[name] = reachable[name];
  return sorted;
}

// The fingerprint identifies the type, not the artifact that happens to declare it. Hashing
// artifact identity would hide a graph relationship inside the envelope bytes.
function typeFingerprint(type, types = {}) {
  const schema = {type, types: reachableDeclarations(type, types)};
  return getDefaultCryptoProvider().sha256(utf8Encode(canonicalTypeJson(schema)));
}

function resolveDeclaredType(type, types) {
  if (typeof type === 'string' && !isPrimitiveType(type)) {
    const declaration = types[type];
    if (!declaration) throw new TypeError(`type ${JSON.stringify(type)} is not declared`);
    return declaration;
  }
  return type;
}

export {
  CALLABLE_PRIMITIVE_TYPES,
  MAX_RECORD_FIELDS,
  MAX_TYPE_DEPTH,
  canonicalTypeJson,
  isCompositeType,
  isPrimitiveType,
  normalizeTypeDeclarations,
  normalizeTypeExpression,
  reachableDeclarations,
  resolveDeclaredType,
  typeFingerprint,
};
