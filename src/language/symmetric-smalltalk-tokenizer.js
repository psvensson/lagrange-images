const BINARY_SELECTOR_CHARS = new Set('+-*/=<>~&,@%?!\\'.split(''));

// Symbol literal characters. `#` begins a symbol; what follows determines the form:
// identifier chars (unary), keyword sequence (`#at:put:`), or binary selector chars (`#+`).
// Quoted symbols are deliberately not supported.

// ADR 0056 decision 3. Reserved pseudo-literals: they read as identifiers but are not names, so
// nothing may declare, capture, shadow or assign to one.
//
// Owned here, in one place, because the checks that enforce it are spread across block parameters,
// temporaries, assignment targets and explicit captures — four sites that would otherwise drift, as
// they already had: `self` was refused as a temporary and as an assignment target but accepted as a
// block parameter.
//
// ADR 0089 adds `super` to exactly this set rather than to the identifier path. Leaving it an
// ordinary name is the pre-0089 defect — it resolved as nothing and reported `unbound Symmetric
// Smalltalk name: super` — and binding it as a global would be worse, because `super` names no
// object at all: it is a receiver MARKER whose only effect is to move where lookup starts. Being
// reserved here is what makes a parameter, temporary, assignment target or explicit capture called
// `super` a refusal at all four existing sites instead of a fifth rule.
const RESERVED_WORDS = Object.freeze(new Set(['self', 'super', 'true', 'false', 'nil']));

function isReservedWord(name) {
  return RESERVED_WORDS.has(name);
}

class SymmetricSmalltalkSyntaxError extends SyntaxError {
  constructor(message, position) {
    super(`${message} at ${position}`);
    this.name = 'SymmetricSmalltalkSyntaxError';
    this.position = position;
  }
}

// WS3 (general language widening): a negative integer literal such as `-32` is
// Standard Smalltalk syntax, and the runtime's `0 - 32` already evaluates to a
// negative Value, so the literal is not new semantics — it is the canonical
// spelling of a value that already exists. The tokenizer still emits `-` as a
// binary selector so that `5-3`, `a-3` and `5 - 3` keep their binary-send
// meaning; the parser calls this only at an operand position (the start of a
// primary), where a leading `-` can only be a sign. `-16r1F` is covered too.
function isNegativeIntegerLiteralAt(tokens, index) {
  const minus = tokens[index];
  const next = tokens[index + 1];
  return Boolean(
    minus && minus.type === 'binary' && minus.value === '-'
    && next && next.type === 'integer',
  );
}

function isIdentifierStart(char) {
  return /[A-Za-z_]/.test(char ?? '');
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_]/.test(char ?? '');
}

// The two assignment spellings a token stream can carry: native `:=` and the Cuis legacy arrow,
// which the tokenizer keeps as the DISTINCT `legacyAssign` token below. Token-level
// declaration/binding scans (the Cuis import adapter's bound-names analysis) must recognize both
// through this ONE predicate rather than re-deciding the pair at every scan site.
function isAssignmentToken(token) {
  return token?.type === 'assign' || token?.type === 'legacyAssign';
}

// The Cuis legacy assignment arrow, measured against the pinned Cuis scanner/parser (bead
// lagrange-images-xxm.3, oracle executed on the pinned Cuis7.9-8090 image): at a token boundary,
// a standalone `_` token scans as the assignment arrow IFF the next character is NOT a letter,
// digit, underscore or colon (Scanner>>xUnderscore, stamp jmv 26/Apr/2023: #leftArrow when the following
// character's type is outside {xLetter, xDigit, xUnderscore, xColon}). Every other underscore form
// is a Cuis-legal identifier/keyword form — `_foo`, `_7`, `__`, `foo_`, `a_b`, the `_:` keyword —
// and stays on the ordinary identifier path, which is why `_` remains an identifier character
// above. Measured: `a _ b` assigns 7; `a _7` SENDS the unary selector `_7`; `a_7` is ONE
// identifier; a bare `_` is not a legal selector. The tokenizer emits the arrow as a distinct
// token and decides nothing further: the native parser refuses it outright, and the Cuis import
// adapter translates it to canonical `:=` at the import boundary.
function isLegacyAssignmentArrowAt(source, index) {
  return source[index] === '_' && !/[A-Za-z0-9_:]/.test(source[index + 1] ?? '');
}

function tokenizeSymmetricSmalltalk(source) {
  if (typeof source !== 'string') throw new TypeError('source must be text');
  const tokens = [];
  let index = 0;

  const push = (type, value, start = index) => tokens.push(Object.freeze({type, value, start, end: index}));

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== '"') index += 1;
      if (index >= source.length) throw new SymmetricSmalltalkSyntaxError('unterminated comment', start);
      index += 1;
      continue;
    }

    // Symbol literal: `#` followed by identifier chars (unary), a keyword sequence
    // (`#at:put:`), or binary selector chars (`#+`). The token carries the canonical
    // selector text. No quoted/arbitrary symbol syntax.
    if (char === '#') {
      const start = index;
      index += 1; // consume '#'
      if (index >= source.length) {
        throw new SymmetricSmalltalkSyntaxError('bare # is not a valid symbol literal', start);
      }
      const next = source[index];
      // Literal Array `#( ... )` (WS3): `#(` opens a literal Array, distinct from a symbol.
      // `#[ ... ]` (byte-array literal) is deliberately NOT this facility — its resulting class
      // and element restrictions differ, and it is classified separately when upstream demands it.
      if (next === '(') {
        index += 1; // consume '('
        push('arrayOpen', '(', start);
        continue;
      }
      if (next === '[') {
        throw new SymmetricSmalltalkSyntaxError(
          '#[ is byte-array literal syntax, which is not the #() literal-Array facility', start,
        );
      }
      if (isIdentifierStart(next)) {
        // Unary or keyword symbol: read identifier chars, then optionally ':' sequences
        let value = '';
        while (index < source.length) {
          if (isIdentifierPart(source[index])) {
            value += source[index];
            index += 1;
            continue;
          }
          if (source[index] === ':' && source[index + 1] !== '=') {
            value += ':';
            index += 1;
            continue;
          }
          break;
        }
        push('symbol', value, start);
        continue;
      }
      if (BINARY_SELECTOR_CHARS.has(next)) {
        let value = '';
        while (index < source.length && BINARY_SELECTOR_CHARS.has(source[index])) {
          value += source[index];
          index += 1;
        }
        push('symbol', value, start);
        continue;
      }
      throw new SymmetricSmalltalkSyntaxError(
        `invalid symbol literal: #${next}`, start,
      );
    }

    if (char === "'") {
      const start = index;
      index += 1;
      let value = '';
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        value += source[index];
        index += 1;
      }
      if (!closed) throw new SymmetricSmalltalkSyntaxError('unterminated string', start);
      push('string', value, start);
      continue;
    }

    if (/[0-9]/.test(char)) {
      const start = index;
      while (/[0-9]/.test(source[index] ?? '')) index += 1;
      // ADR 0057 workstream 3. `<base>r<digits>` is a radix integer literal (`16rFF`, `2r1010`).
      // Radix is source syntax, never runtime representation: the token carries the canonical
      // decimal text an ordinary literal would, so the parser, the semantic layer and the durable
      // Value model (which accepts only `/^-?\d+$/`) never learn a radix existed. A leading `-` is
      // a binary selector send in source order (`0 - 16r80`), not part of the literal.
      if (source[index] === 'r' || source[index] === 'R') {
        const baseText = source.slice(start, index);
        const base = Number.parseInt(baseText, 10);
        index += 1; // consume the `r`
        const digitsStart = index;
        while (/[0-9A-Za-z]/.test(source[index] ?? '')) index += 1;
        const digits = source.slice(digitsStart, index);
        if (digits === '' || !/^\d+$/.test(baseText) || base < 2 || base > 36) {
          throw new SymmetricSmalltalkSyntaxError(`malformed radix literal ${baseText}r${digits}`, start);
        }
        // Per-digit validation catches `2r102`, which a bulk parse would silently truncate.
        let value = 0n;
        const radix = BigInt(base);
        for (const digitChar of digits) {
          const digit = Number.parseInt(digitChar, 36);
          if (digit >= base) {
            throw new SymmetricSmalltalkSyntaxError(
              `digit ${digitChar} is out of range for radix ${base} in ${baseText}r${digits}`, start,
            );
          }
          value = value * radix + BigInt(digit);
        }
        push('integer', value.toString(10), start);
        continue;
      }
      push('integer', source.slice(start, index), start);
      continue;
    }

    // The measured legacy assignment arrow comes first once `_` is at a token boundary: a bare
    // `_` NOT followed by an identifier character is never an identifier. `_foo` and friends fall
    // through to the ordinary identifier path below, exactly as the pinned Cuis oracle answers;
    // an underscore already reached inside `a_b` was consumed by that identifier's scan.
    if (isLegacyAssignmentArrowAt(source, index)) {
      const start = index;
      index += 1;
      push('legacyAssign', '_', start);
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(source[index])) index += 1;
      const name = source.slice(start, index);
      // `:` only makes a keyword when it is not the start of `:=`.
      if (source[index] === ':' && source[index + 1] !== '=') {
        index += 1;
        push('keyword', `${name}:`, start);
      } else {
        push('identifier', name, start);
      }
      continue;
    }

    if (BINARY_SELECTOR_CHARS.has(char)) {
      const start = index;
      index += 1;
      while (BINARY_SELECTOR_CHARS.has(source[index])) index += 1;
      push('binary', source.slice(start, index), start);
      continue;
    }

    if (char === ':' && source[index + 1] === '=') {
      const start = index;
      index += 2;
      push('assign', ':=', start);
      continue;
    }

    // ADR 0055: `^` is syntax, not a binary selector, so it gets its own token and cannot be
    // absorbed into an adjacent operator the way `^=` otherwise would be.
    if (char === '^') {
      const start = index;
      index += 1;
      push('caret', '^', start);
      continue;
    }

    if ('[]()|:.;'.includes(char)) {
      const start = index;
      index += 1;
      push(char, char, start);
      continue;
    }

    throw new SymmetricSmalltalkSyntaxError(`unexpected character ${JSON.stringify(char)}`, index);
  }

  tokens.push(Object.freeze({type: 'eof', value: '', start: index, end: index}));
  return Object.freeze(tokens);
}

export {
  RESERVED_WORDS,
  isReservedWord,
  isAssignmentToken,
  isNegativeIntegerLiteralAt,
  SymmetricSmalltalkSyntaxError,
  tokenizeSymmetricSmalltalk,
};
