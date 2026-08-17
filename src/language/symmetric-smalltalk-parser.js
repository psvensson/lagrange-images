import {
  SymmetricSmalltalkSyntaxError,
  tokenizeSymmetricSmalltalk,
} from './symmetric-smalltalk-tokenizer.js';

function node(kind, fields = {}) {
  return Object.freeze({kind, ...fields});
}

class Parser {
  constructor(source) {
    this.source = source;
    this.tokens = tokenizeSymmetricSmalltalk(source);
    this.index = 0;
  }

  current() {
    return this.tokens[this.index];
  }

  advance() {
    const token = this.current();
    if (token.type !== 'eof') this.index += 1;
    return token;
  }

  match(type) {
    if (this.current().type !== type) return null;
    return this.advance();
  }

  expect(type, message = `expected ${type}`) {
    const token = this.current();
    if (token.type !== type) throw new SymmetricSmalltalkSyntaxError(message, token.start);
    return this.advance();
  }

  peek(offset = 1) {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  parseSource() {
    const body = this.parseBody('eof');
    this.expect('eof', 'unexpected trailing input');
    return body;
  }

  // Assignment binds loosest and is right-associative, so `a := b := 1` assigns both and
  // `x := a foo: b` assigns the whole message result.
  parseExpression() {
    if (this.current().type === 'identifier' && this.peek().type === 'assign') {
      const target = this.advance();
      if (target.value === 'self') {
        throw new SymmetricSmalltalkSyntaxError('cannot assign to self', target.start);
      }
      this.advance();
      return node('assign', {name: target.value, value: this.parseExpression()});
    }
    return this.parseKeywordMessage();
  }

  // `| a b |` declarations followed by `.`-separated statements. A single statement with no
  // temporaries returns the bare expression, so programs that need none compile to exactly the
  // artifact they compile to today.
  parseBody(terminator) {
    const temporaries = this.parseTemporaries();
    const statements = [];
    for (;;) {
      if (this.current().type === terminator) break;
      statements.push(this.parseExpression());
      if (!this.match('.')) break;
    }
    if (statements.length === 0) {
      throw new SymmetricSmalltalkSyntaxError('expected at least one statement', this.current().start);
    }
    if (temporaries.length === 0 && statements.length === 1) return statements[0];
    return node('sequence', {
      temporaries: Object.freeze(temporaries),
      statements: Object.freeze(statements),
    });
  }

  parseTemporaries() {
    if (this.current().type !== '|') return [];
    this.advance();
    const names = [];
    while (this.current().type === 'identifier') {
      const token = this.advance();
      if (token.value === 'self') {
        throw new SymmetricSmalltalkSyntaxError('cannot declare a temporary named self', token.start);
      }
      if (names.includes(token.value)) {
        throw new SymmetricSmalltalkSyntaxError(`duplicate temporary ${token.value}`, token.start);
      }
      names.push(token.value);
    }
    this.expect('|', 'expected | after temporary declarations');
    return names;
  }

  parseKeywordMessage() {
    let receiver = this.parseBinaryMessage();
    if (this.current().type !== 'keyword') return receiver;

    let selector = '';
    const argumentsList = [];
    while (this.current().type === 'keyword') {
      selector += this.advance().value;
      argumentsList.push(this.parseBinaryMessage());
    }
    receiver = node('send', {receiver, selector, arguments: Object.freeze(argumentsList)});
    return receiver;
  }

  parseBinaryMessage() {
    let receiver = this.parseUnaryMessage();
    while (this.current().type === 'binary') {
      const selector = this.advance().value;
      const argument = this.parseUnaryMessage();
      receiver = node('send', {
        receiver,
        selector,
        arguments: Object.freeze([argument]),
      });
    }
    return receiver;
  }

  parseUnaryMessage() {
    let receiver = this.parsePrimary();
    while (this.current().type === 'identifier') {
      const selector = this.advance().value;
      receiver = node('send', {
        receiver,
        selector,
        arguments: Object.freeze([]),
      });
    }
    return receiver;
  }

  parsePrimary() {
    const token = this.current();
    if (token.type === 'integer') {
      this.advance();
      return node('integer', {value: token.value});
    }
    if (token.type === 'string') {
      this.advance();
      return node('string', {value: token.value});
    }
    if (token.type === 'identifier') {
      this.advance();
      return token.value === 'self'
        ? node('self')
        : node('name', {name: token.value});
    }
    if (this.match('(')) {
      const expression = this.parseExpression();
      this.expect(')', 'expected )');
      return expression;
    }
    if (this.match('[')) return this.parseBlockAfterOpen(token.start);
    throw new SymmetricSmalltalkSyntaxError('expected expression', token.start);
  }

  parseBlockAfterOpen(start) {
    const parameters = [];
    while (this.match(':')) {
      const nameToken = this.expect('identifier', 'expected block parameter name');
      if (parameters.includes(nameToken.value)) {
        throw new SymmetricSmalltalkSyntaxError(`duplicate block parameter ${nameToken.value}`, nameToken.start);
      }
      parameters.push(nameToken.value);
    }
    if (parameters.length > 0) this.expect('|', 'expected | after block parameters');
    const body = this.parseBody(']');
    const close = this.expect(']', 'expected ]');
    return node('block', {
      parameters: Object.freeze(parameters),
      body,
      start,
      end: close.end,
    });
  }
}

function parseSymmetricSmalltalk(source) {
  return new Parser(source).parseSource();
}

function parseSymmetricSmalltalkBlock(source) {
  const syntax = parseSymmetricSmalltalk(source);
  if (syntax.kind !== 'block') {
    throw new SymmetricSmalltalkSyntaxError('expected a block as the compilation unit', 0);
  }
  return syntax;
}

export {
  parseSymmetricSmalltalk,
  parseSymmetricSmalltalkBlock,
};
