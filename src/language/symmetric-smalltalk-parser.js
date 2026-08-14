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

  parseSource() {
    const expression = this.parseExpression();
    this.expect('eof', 'unexpected trailing input');
    return expression;
  }

  parseExpression() {
    return this.parseKeywordMessage();
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
    const body = this.parseExpression();
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
