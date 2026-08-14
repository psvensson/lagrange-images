# ADR 0006: Symmetric Smalltalk seed

Status: accepted for the first language seed.

## Purpose

The first language implementation should prove that a language personality can use the shared image graph, Block/CodeArtifact model, dispatch protocol and activation executor without adding Smalltalk concepts to persistence.

## Syntax seed

The seed accepts Smalltalk-shaped expressions with the normal message precedence:

```text
primary -> unary message -> binary message -> keyword message
```

Implemented primaries are integer literals, single-quoted strings, names, `self`, parentheses and block literals. Double-quoted text is a comment. A block uses square brackets and colon parameters, for example:

```smalltalk
[ :target | target echo: 'hello' ]
```

Nested block literals are parsed now so the syntax tree has the intended shape, but only the outer compilation-unit Block is executable in this iteration. Assignment, temporaries, statement sequences, cascades, symbols and literal arrays are deferred.

## Compilation

`compileSymmetricSmalltalkBlock()` compiles one outer Block to `neutral-expression/v0`.

- block parameters become positional `argument` expressions
- `self` becomes the separate activation `receiver`
- integer/string literals become tagged Values
- explicitly supplied captured names become stable lexical `binding` IDs
- message sends become neutral `send` expressions carrying the `symmetric-smalltalk` language ID and selector as a text Value

An unbound source name is an error. The compiler does not silently create globals.

Installation preserves a provenance chain:

```text
symmetric-smalltalk/source-v0
        |
        v
symmetric-smalltalk/syntax-v0
        |
        v
neutral-expression/v0
        |
        v
Block
```

Source, parsed syntax and executable code are separate CodeArtifacts linked with `derivedFrom`. This keeps source/tooling identity while allowing execution to use a shared representation.

## Message lookup bootstrap

The first dispatcher uses ordinary image objects instead of introducing Class/Method records prematurely.

A receiver object's `behavior` ref points to a behavior object. The behavior object's shape slot **names** are selectors; each corresponding slot Value is a Block ref. The dispatcher finds the selector in the shape and returns that Block to the existing neutral invocation path.

This is deliberately a bootstrap convention, not the final Class/Metaclass design. It already makes method lookup image-resident and inspectable while leaving room to replace the lookup policy above the same graph objects.

V0 lookup currently has no inheritance and accepts only object-ref receivers and text selector Values. Immediate-value dispatch is deferred.

## Neutral execution consequence

`neutral-expression/v0` gains a `send` expression. The representation executor evaluates receiver and argument expressions, delegates lookup to the existing invocation service, and recursively executes the resolved activation. Activation recursion has the same bounded runtime discipline as expression recursion.

The neutral executor still does not know Smalltalk selector lookup rules; it only knows how to request a language-tagged send.

## Deferred

- runtime creation of nested closures and capture analysis
- assignments, temporaries, sequences and cascades
- symbols, literal arrays, booleans and `nil` language objects
- Object/Behavior/Class/Metaclass bootstrap
- inheritance and `super`
- method objects and source-level method definitions
- immediate-value dispatch and primitives
- exceptions/non-local returns
- self-hosted parser/compiler
