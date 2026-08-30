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
const RESERVED_WORDS = Object.freeze(new Set(['self', 'true', 'false', 'nil']));

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

function isIdentifierStart(char) {
  return /[A-Za-z_]/.test(char ?? '');
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_]/.test(char ?? '');
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
  SymmetricSmalltalkSyntaxError,
  tokenizeSymmetricSmalltalk,
};
