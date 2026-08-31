import {
  SymmetricSmalltalkSyntaxError,
  tokenizeSymmetricSmalltalk,
  isReservedWord,
  isNegativeIntegerLiteralAt,
} from './symmetric-smalltalk-tokenizer.js';

// One rule, one message shape, for every site that would otherwise decide independently.
function assertNotReserved(token, action) {
  if (isReservedWord(token.value)) {
    throw new SymmetricSmalltalkSyntaxError(
      `cannot ${action} ${token.value}: it is a reserved word`, token.start,
    );
  }
}

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
      assertNotReserved(target, 'assign to');
      this.advance();
      return node('assign', {name: target.value, value: this.parseExpression()});
    }
    const expression = this.parseKeywordMessage();
    return this.parseCascadesAfter(expression);
  }

  // A cascade binds tighter than assignment: `x := self foo; bar` cascades on the *value*, so the
  // whole thing is the assigned expression, and `x` receives `self foo` — the first message's
  // answer, as Smalltalk defines a cascade's value.
  //
  // The cascaded receiver is the receiver of the first message, not the first message's answer:
  // `OrderedCollection new add: 1; add: 2` sends both `add:` to the *collection*, exactly as `;`
  // means in Smalltalk. So the cascade node keeps the receiver and each message's selector and
  // arguments, and the compiler decides how the receiver is evaluated once.
  parseCascadesAfter(expression) {
    if (expression.kind !== 'send' || this.current().type !== ';') return expression;
    const first = {selector: expression.selector, arguments: expression.arguments};
    const messages = [first];
    while (this.match(';')) {
      if (this.current().type === 'identifier') {
        messages.push({selector: this.advance().value, arguments: Object.freeze([])});
        continue;
      }
      if (this.current().type === 'binary') {
        const selector = this.advance().value;
        messages.push({selector, arguments: Object.freeze([this.parseUnaryMessage()])});
        continue;
      }
      if (this.current().type === 'keyword') {
        let selector = '';
        const argumentsList = [];
        while (this.current().type === 'keyword') {
          selector += this.advance().value;
          argumentsList.push(this.parseBinaryMessage());
        }
        messages.push({selector, arguments: Object.freeze(argumentsList)});
        continue;
      }
      throw new SymmetricSmalltalkSyntaxError('expected a message after ;', this.current().start);
    }
    return node('cascade', {receiver: expression.receiver, messages: Object.freeze(messages)});
  }

  // `| a b |` declarations followed by `.`-separated statements. A single statement with no
  // temporaries returns the bare expression, so programs that need none compile to exactly the
  // artifact they compile to today.
  parseBody(terminator) {
    const temporaries = this.parseTemporaries();
    const statements = [];
    for (;;) {
      if (this.current().type === terminator) break;
      // ADR 0055. A return is a *statement*, not an expression: `^ a foo` returns the whole send,
      // and `x := ^ 1` is not a thing. Parsing it here rather than in `parseExpression` is what
      // makes that true by construction.
      if (this.current().type === 'caret') {
        const caret = this.advance();
        statements.push(node('return', {value: this.parseExpression(), start: caret.start}));
      } else {
        statements.push(this.parseExpression());
      }
      // Statements after a return still *parse*: they are unreachable, not ill-formed, and the ADR
      // requires proving that they do not run rather than that they cannot be written.
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
      assertNotReserved(token, 'declare a temporary named');
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
    // Operand position only: a leading `-` here is a sign, never the binary
    // selector `parseBinaryMessage` consumes after a receiver. `5-3` and `a-3`
    // are unaffected because their `-` is read in binary-message position.
    if (isNegativeIntegerLiteralAt(this.tokens, this.index)) {
      this.advance(); // consume '-'
      const digits = this.advance(); // consume the integer
      return node('integer', {value: `-${digits.value}`});
    }
    if (token.type === 'integer') {
      this.advance();
      return node('integer', {value: token.value});
    }
    if (token.type === 'string') {
      this.advance();
      return node('string', {value: token.value});
    }
    if (token.type === 'symbol') {
      this.advance();
      return node('symbol', {value: token.value});
    }
    if (token.type === 'identifier') {
      this.advance();
      // The reserved words read as identifiers and are not names: each becomes its own syntax
      // node, so no later stage can mistake one for something bindable.
      if (token.value === 'self') return node('self');
      if (token.value === 'true') return node('true');
      if (token.value === 'false') return node('false');
      if (token.value === 'nil') return node('nil');
      return node('name', {name: token.value});
    }
    if (this.match('(')) {
      const expression = this.parseExpression();
      this.expect(')', 'expected )');
      return expression;
    }
    // Literal Array `#( ... )` (WS3). The authentic upstream MessagePack RED demands only the
    // empty form `#()`; element forms are a separate general facility, so a non-empty literal is
    // rejected deterministically here rather than half-parsed.
    if (this.match('arrayOpen')) {
      if (this.current().type !== ')') {
        throw new SymmetricSmalltalkSyntaxError(
          'literal Array element syntax is not supported; only the empty literal #() is', this.current().start,
        );
      }
      this.expect(')', 'expected ) to close a literal Array');
      return node('arrayLiteral', {elements: Object.freeze([])});
    }
    if (this.match('[')) return this.parseBlockAfterOpen(token.start);
    throw new SymmetricSmalltalkSyntaxError('expected expression', token.start);
  }

  parseBlockAfterOpen(start) {
    const parameters = [];
    while (this.match(':')) {
      const nameToken = this.expect('identifier', 'expected block parameter name');
      assertNotReserved(nameToken, 'declare a block parameter named');
      if (parameters.includes(nameToken.value)) {
        throw new SymmetricSmalltalkSyntaxError(`duplicate block parameter ${nameToken.value}`, nameToken.start);
      }
      parameters.push(nameToken.value);
    }
    if (parameters.length > 0) this.expect('|', 'expected | after block parameters');
    // WS3 (general language widening): an empty block `[]` is Standard Smalltalk
    // and answers nil when evaluated. Upstream dispatch uses it as the "no value"
    // idiom (`at: key ifAbsent: []`). This is block-level only: a program still
    // requires at least one statement.
    const body = this.current().type === ']' ? node('nil') : this.parseBody(']');
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
