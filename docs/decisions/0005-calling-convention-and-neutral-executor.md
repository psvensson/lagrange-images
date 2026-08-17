# ADR 0005: calling convention and neutral executor

Status: accepted — the bootstrap execution substrate.

## Calling convention

An `activation-request` is executed with three language-neutral inputs:

```text
receiver     Value | null
arguments    Value[]       # positional, zero based
environment  ref | null    # captured lexical environment
```

The receiver is never an implicit argument. Captured variables are addressed by stable binding ID and resolved from the Block's environment outward through parent environments. The current Value of a binding is read when the activation executes.

The neutral substrate does not put parameter names or arity on Block. A code representation owns those details. This keeps Block as code identity plus captured environment and lets different language personalities use different calling conventions above the common receiver/argument/environment frame.

Execution returns exactly one tagged Value. Mutation, multiple values, conditions/exceptions and continuation semantics are deferred.

## Executor registry

`CodeExecutorRegistry` maps a CodeArtifact `representation` string to a representation executor. `ActivationExecutor` revalidates the activation against the durable Block, CodeArtifact and environment before delegating to that executor. Unknown representations fail explicitly.

This separates dispatch from execution:

```text
message lookup -> Block -> activation-request -> representation executor -> Value
```

A language dispatcher may therefore resolve to code in its own representation, neutral IR or eventually WASM without changing message lookup or Block semantics.

## First executable representation

The built-in `neutral-expression/v0` representation stores a JSON encoded expression program inside a text Value. The persistence layer treats that content as opaque representation data.

A program has an exact positional parameter count and one expression body. v0 supports:

- `literal`
- `argument`
- `receiver`
- `binding`
- `integer-add`
- `equals`
- `if`

This is deliberately an expression evaluator, not a bytecode or a language. It exists to prove the calling convention, captured lexical lookup, tagged results and pluggable execution boundary with the smallest useful executable surface.

## Runtime consequence

Durable Blocks/environments still do not dictate runtime allocation. A compiler may inline a Block, flatten or eliminate environments, unbox Values, or lower a CodeArtifact to WASM while preserving the same observable calling convention.

## Deferred

- mutation and assignment
- nested Block invocation from neutral IR
- multiple return values
- condition/exception propagation
- durable activation/debug records
- tail calls and continuations
- WASM/host FFI execution
- local versus distributed execution policy
