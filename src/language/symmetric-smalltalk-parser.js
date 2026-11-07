import {
  SymmetricSmalltalkSyntaxError,
  tokenizeSymmetricSmalltalk,
  isAssignmentToken,
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
  constructor(source, {allowLegacyAssign = false, allowEmpty = false} = {}) {
    this.source = source;
    this.tokens = tokenizeSymmetricSmalltalk(source);
    this.index = 0;
    this.allowLegacyAssign = allowLegacyAssign === true;
    this.allowEmpty = allowEmpty === true;
    // The Cuis legacy assignment arrow is dialect syntax, never native syntax. The tokenizer keeps
    // it a DISTINCT token precisely so that no grammar position can absorb it (before this, `a _ b`
    // parsed as the unary-send chain `((a _) b)` and compiled). The refusal lives here, once, for
    // every position the token could appear in — direct native source has only canonical `:=`.
    // The Cuis import adapter parses dialect source with `allowLegacyAssign: true` so the arrow
    // produces a canonical `assign` AST node at the import boundary; that is the one loud division
    // between the two languages.
    if (!this.allowLegacyAssign) {
      const legacyArrow = this.tokens.find((token) => token.type === 'legacyAssign');
      if (legacyArrow) {
        throw new SymmetricSmalltalkSyntaxError(
          'the legacy assignment arrow `_` is Cuis dialect syntax, not native Symmetric Smalltalk; native assignment is `:=`',
          legacyArrow.start,
        );
      }
    }
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
    const body = this.parseBody('eof', {allowEmpty: this.allowEmpty});
    this.expect('eof', 'unexpected trailing input');
    return body;
  }

  // Assignment binds loosest and is right-associative, so `a := b := 1` assigns both and
  // `x := a foo: b` assigns the whole message result.
  parseExpression() {
    const next = this.peek();
    const isAssign = this.allowLegacyAssign ? isAssignmentToken(next) : next.type === 'assign';
    if (this.current().type === 'identifier' && isAssign) {
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
        const token = this.advance();
        assertNotReserved(token, 'send unary message');
        messages.push({selector: token.value, arguments: Object.freeze([])});
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
  parseBody(terminator, {allowEmpty = false} = {}) {
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
      if (allowEmpty) {
        return node('sequence', {
          temporaries: Object.freeze(temporaries),
          statements: Object.freeze([]),
        });
      }
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
      const token = this.advance();
      assertNotReserved(token, 'send unary message');
      receiver = node('send', {
        receiver,
        selector: token.value,
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
    if (token.type === 'character') {
      this.advance();
      return node('character', {value: token.value});
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
      // ADR 0089. `super` becomes its own node exactly as `self` does, and deliberately carries no
      // value of its own: the compiler consumes it only as a send's receiver and refuses it
      // anywhere else. Making it a node here is what stops a later stage mistaking it for a name.
      if (token.value === 'super') return node('super');
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
    // Literal Array `#( ... )` (WS3 empty form; elements demanded by the M4 vertical, bead
    // lagrange-images-x4i). An element position accepts only true literals — integers (with an
    // optional minus sign), Strings, Characters, symbols (hash-marked or, per Smalltalk's literal-array
    // rule, bare identifiers), the boolean/nil reserved words, and nested literal Arrays. Bare
    // identifiers are SYMBOLS here, never variable references, and any other construct (sends,
    // blocks, parentheses) is refused deterministically rather than half-parsed.
    if (this.match('arrayOpen')) {
      const elements = [];
      while (this.current().type !== ')') {
        elements.push(this.parseArrayLiteralElement());
      }
      this.expect(')', 'expected ) to close a literal Array');
      return node('arrayLiteral', {elements: Object.freeze(elements)});
    }
    if (this.match('byteArrayOpen')) {
      return this.parseByteArrayLiteralAfterOpen();
    }
    if (this.match('[')) return this.parseBlockAfterOpen(token.start);
    throw new SymmetricSmalltalkSyntaxError('expected expression', token.start);
  }

  parseByteArrayLiteralAfterOpen() {
    const bytes = [];
    while (this.current().type !== ']') {
      const token = this.current();
      if (token.type === 'eof') {
        throw new SymmetricSmalltalkSyntaxError('expected ] to close a literal ByteArray', token.start);
      }
      if (token.type !== 'integer') {
        throw new SymmetricSmalltalkSyntaxError(
          'byte-array literal elements must be integers in 0..255',
          token.start,
        );
      }
      const parsed = BigInt(token.value);
      if (parsed < 0n || parsed > 255n) {
        throw new SymmetricSmalltalkSyntaxError(
          'byte-array literal elements must be integers in 0..255',
          token.start,
        );
      }
      this.advance();
      bytes.push(Number(parsed));
    }
    this.expect(']', 'expected ] to close a literal ByteArray');
    return node('byteArrayLiteral', {bytes: Object.freeze(bytes)});
  }

  parseArrayLiteralElement() {
    const token = this.current();
    if (isNegativeIntegerLiteralAt(this.tokens, this.index)) {
      this.advance();
      const digits = this.advance();
      return node('integer', {value: `-${digits.value}`});
    }
    if (token.type === 'integer' || token.type === 'string' || token.type === 'character' || token.type === 'symbol') {
      this.advance();
      return node(token.type, {value: token.value});
    }
    if (token.type === 'identifier') {
      this.advance();
      if (token.value === 'true') return node('true');
      if (token.value === 'false') return node('false');
      if (token.value === 'nil') return node('nil');
      // Smalltalk's literal-array rule: a bare identifier element is a Symbol.
      return node('symbol', {value: token.value});
    }
    if (token.type === 'arrayOpen') {
      this.advance();
      const elements = [];
      while (this.current().type !== ')') {
        elements.push(this.parseArrayLiteralElement());
      }
      this.expect(')', 'expected ) to close a nested literal Array');
      return node('arrayLiteral', {elements: Object.freeze(elements)});
    }
    if (token.type === 'byteArrayOpen') {
      this.advance();
      return this.parseByteArrayLiteralAfterOpen();
    }
    throw new SymmetricSmalltalkSyntaxError(
      'literal Array elements must be literals: integers, Strings, Characters, symbols, '
      + 'true/false/nil or a nested literal Array', token.start,
    );
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

function parseSymmetricSmalltalkDialect(source, {allowEmpty = true} = {}) {
  return new Parser(source, {allowLegacyAssign: true, allowEmpty}).parseSource();
}

function parseSymmetricSmalltalkBlock(source) {
  const syntax = parseSymmetricSmalltalk(source);
  if (syntax.kind !== 'block') {
    throw new SymmetricSmalltalkSyntaxError('expected a block as the compilation unit', 0);
  }
  return syntax;
}

function formatArrayLiteralElement(element) {
  switch (element.kind) {
    case 'integer':
      return element.value;
    case 'string':
      return `'${element.value.replaceAll("'", "''")}'`;
    case 'character':
      return `$${element.value}`;
    case 'symbol':
      return `#${element.value}`;
    case 'true':
    case 'false':
    case 'nil':
      return element.kind;
    case 'arrayLiteral':
      return `#(${element.elements.map(formatArrayLiteralElement).join(' ')})`;
    case 'byteArrayLiteral':
      return `#[${element.bytes.join(' ')}]`;
    default:
      throw new TypeError(`unexpected array literal element kind: ${element.kind}`);
  }
}

function parenthesizeIf(condition, text) {
  return condition ? `(${text})` : text;
}

function formatMessageSendChain(selector, args) {
  if (args.length === 0) return selector;
  if (!selector.endsWith(':')) {
    const arg = args[0];
    const needsParens = arg.kind === 'assign'
      || arg.kind === 'cascade'
      || (arg.kind === 'send' && arg.arguments.length > 0);
    return `${selector} ${parenthesizeIf(needsParens, formatAstExpression(arg))}`;
  }
  const parts = selector.match(/[^:]+:/g);
  return parts.map((part, index) => {
    const arg = args[index];
    const needsParens = arg.kind === 'assign'
      || arg.kind === 'cascade'
      || (arg.kind === 'send' && arg.selector.endsWith(':'));
    return `${part} ${parenthesizeIf(needsParens, formatAstExpression(arg))}`;
  }).join(' ');
}

function formatSendExpression(receiver, selector, args) {
  const receiverNeedsParens = args.length === 0
    ? (receiver.kind === 'assign' || receiver.kind === 'cascade' || (receiver.kind === 'send' && receiver.arguments.length > 0))
    : (receiver.kind === 'assign' || receiver.kind === 'cascade' || (receiver.kind === 'send' && receiver.selector.endsWith(':')));
  const recvText = parenthesizeIf(receiverNeedsParens, formatAstExpression(receiver));
  return `${recvText} ${formatMessageSendChain(selector, args)}`;
}

function formatInlineBody(bodyAst) {
  const temporaries = bodyAst.kind === 'sequence' ? bodyAst.temporaries : [];
  const statements = bodyAst.kind === 'sequence' ? bodyAst.statements : [bodyAst];
  const parts = [];
  if (temporaries.length > 0) parts.push(`| ${temporaries.join(' ')} |`);
  if (statements.length > 0) {
    parts.push(statements.map(formatAstStatement).join('. '));
  }
  return parts.join(' ');
}

function formatAstExpression(node) {
  switch (node.kind) {
    case 'integer':
      return node.value;
    case 'string':
      return `'${node.value.replaceAll("'", "''")}'`;
    case 'character':
      return `$${node.value}`;
    case 'symbol':
      return `#${node.value}`;
    case 'self':
    case 'super':
    case 'true':
    case 'false':
    case 'nil':
      return node.kind;
    case 'name':
      return node.name;
    case 'arrayLiteral':
      return `#(${node.elements.map(formatArrayLiteralElement).join(' ')})`;
    case 'byteArrayLiteral':
      return `#[${node.bytes.join(' ')}]`;
    case 'block': {
      if (node.parameters.length === 0 && node.body.kind === 'nil') return '[]';
      const params = node.parameters.length === 0
        ? ''
        : ` ${node.parameters.map((param) => `:${param}`).join(' ')} |`;
      return `[${params} ${formatInlineBody(node.body)} ]`;
    }
    case 'assign':
      return `${node.name} := ${formatAstExpression(node.value)}`;
    case 'send':
      return formatSendExpression(node.receiver, node.selector, node.arguments);
    case 'cascade': {
      const first = formatSendExpression(
        node.receiver,
        node.messages[0].selector,
        node.messages[0].arguments,
      );
      const rest = node.messages
        .slice(1)
        .map(({selector, arguments: args}) => formatMessageSendChain(selector, args));
      return `${first}; ${rest.join('; ')}`;
    }
    default:
      throw new TypeError(`unexpected AST expression kind: ${node.kind}`);
  }
}

function formatAstStatement(statement) {
  if (statement.kind === 'return') {
    return `^ ${formatAstExpression(statement.value)}`;
  }
  return formatAstExpression(statement);
}

function formatSymmetricSmalltalkMethodBlock(parameters, bodyAst) {
  const parameterSource = parameters.length === 0
    ? ''
    : ` ${parameters.map((name) => `:${name}`).join(' ')} |`;
  const temporaries = bodyAst.kind === 'sequence' ? bodyAst.temporaries : [];
  const statements = bodyAst.kind === 'sequence' ? bodyAst.statements : [bodyAst];
  const lines = [];
  if (temporaries.length > 0) {
    lines.push(`| ${temporaries.join(' ')} |`);
  }
  for (const statement of statements) {
    lines.push(`${formatAstStatement(statement)}.`);
  }
  lines.push('self');
  return `[${parameterSource}\n${lines.join('\n')}\n]`;
}

export {
  formatSymmetricSmalltalkMethodBlock,
  parseSymmetricSmalltalk,
  parseSymmetricSmalltalkBlock,
  parseSymmetricSmalltalkDialect,
};
