// Map and Set keyed by a tuple of strings, nested one Map level per part.
//
// This exists because joining a multi-part identity into one string key is not injective. Image
// ids, object ids, representations, roles and authority operations are all arbitrary non-empty
// text, so no separator is safe: for any separator `s`, the parts `a+s+b` and `c` join to the same
// string as `a` and `b+s+c`. That has already produced three real defects in this repo — a
// non-injective authority resource name (ADR 0039), closure cells resolving to the wrong closure
// (ADR 0043), and the grant key below.
//
// A nested lookup has no encoding to audit, so the mistake becomes unavailable rather than
// discouraged. Prefer this to inventing another separator; reach for `objectResource()` only when a
// single *durable* string is genuinely required, and make that one injective by construction.
class TupleMap {
  #arity;
  #root = new Map();
  #size = 0;

  constructor(arity) {
    if (!Number.isInteger(arity) || arity < 1) throw new TypeError('tuple arity must be a positive integer');
    this.#arity = arity;
  }

  get arity() { return this.#arity; }
  get size() { return this.#size; }

  #assertParts(parts) {
    if (!Array.isArray(parts) || parts.length !== this.#arity) {
      throw new TypeError(`tuple key must have exactly ${this.#arity} parts`);
    }
    for (const part of parts) {
      if (typeof part !== 'string') throw new TypeError('tuple key parts must be strings');
    }
    return parts;
  }

  #resolve(parts, create) {
    let level = this.#root;
    for (let index = 0; index < this.#arity - 1; index += 1) {
      let next = level.get(parts[index]);
      if (!next) {
        if (!create) return null;
        next = new Map();
        level.set(parts[index], next);
      }
      level = next;
    }
    return level;
  }

  set(parts, value) {
    this.#assertParts(parts);
    const leaf = this.#resolve(parts, true);
    const last = parts[this.#arity - 1];
    if (!leaf.has(last)) this.#size += 1;
    leaf.set(last, value);
    return this;
  }

  get(parts) {
    this.#assertParts(parts);
    return this.#resolve(parts, false)?.get(parts[this.#arity - 1]);
  }

  has(parts) {
    this.#assertParts(parts);
    return this.#resolve(parts, false)?.has(parts[this.#arity - 1]) ?? false;
  }

  // Prunes the intermediate levels it empties, so a long-lived cache that deletes as often as it
  // inserts does not accumulate empty Maps forever.
  delete(parts) {
    this.#assertParts(parts);
    const path = [];
    let level = this.#root;
    for (let index = 0; index < this.#arity - 1; index += 1) {
      const next = level.get(parts[index]);
      if (!next) return false;
      path.push([level, parts[index]]);
      level = next;
    }
    if (!level.delete(parts[this.#arity - 1])) return false;
    this.#size -= 1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const [parent, part] = path[index];
      if (parent.get(part).size > 0) break;
      parent.delete(part);
    }
    return true;
  }

  clear() {
    this.#root.clear();
    this.#size = 0;
  }

  // Insertion-ordered, like Map, and each key is handed back as its parts rather than as a string
  // an accidental `split` could re-derive wrongly.
  *entries() {
    const walk = function* walk(level, depth, prefix) {
      if (depth === 0) {
        for (const [last, value] of level) yield [[...prefix, last], value];
        return;
      }
      for (const [part, next] of level) yield* walk(next, depth - 1, [...prefix, part]);
    };
    yield* walk(this.#root, this.#arity - 1, []);
  }

  *keys() {
    for (const [parts] of this.entries()) yield parts;
  }

  *values() {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

const PRESENT = Symbol('lagrange.tuple-set.present');

class TupleSet {
  #entries;

  constructor(arity, parts = []) {
    this.#entries = new TupleMap(arity);
    for (const entry of parts) this.add(entry);
  }

  get arity() { return this.#entries.arity; }
  get size() { return this.#entries.size; }

  add(parts) {
    this.#entries.set(parts, PRESENT);
    return this;
  }

  has(parts) {
    return this.#entries.has(parts);
  }

  delete(parts) {
    return this.#entries.delete(parts);
  }

  clear() {
    this.#entries.clear();
  }

  *values() {
    yield* this.#entries.keys();
  }

  [Symbol.iterator]() {
    return this.values();
  }
}

export {TupleMap, TupleSet};
