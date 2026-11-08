import {canonicalizeValue, integerValue} from '../value/index.js';

function requiredPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Computes the set of ANF/CPS plan variable identifiers that are free (live)
 * in `plan`. Used at each suspension point (`effect`) to retain only Value
 * handles that are actually referenced in `plan.next`.
 */
function collectFreePlanVariables(plan, bound = new Set()) {
  const free = new Set();

  const use = (id) => {
    if (typeof id === 'string' && id.length > 0 && !bound.has(id)) {
      free.add(id);
    }
  };

  const visit = (node, currentBound) => {
    if (!node || typeof node !== 'object') return;
    switch (node.kind) {
      case 'let': {
        if (node.op === 'cell-set') {
          if ( !currentBound.has(node.value)) free.add(node.value);
        } else if (node.op === 'integer-add' || node.op === 'equals') {
          if (!currentBound.has(node.left)) free.add(node.left);
          if (!currentBound.has(node.right)) free.add(node.right);
        } else if (node.op === 'direct-call') {
          for (const argId of node.callValues ?? []) {
            if (!currentBound.has(argId)) free.add(argId);
          }
        }
        const nextBound = new Set(currentBound);
        nextBound.add(node.id);
        visit(node.next, nextBound);
        return;
      }
      case 'if': {
        if (!currentBound.has(node.condition)) free.add(node.condition);
        visit(node.then, currentBound);
        visit(node.else, currentBound);
        return;
      }
      case 'return': {
        use(node.value);
        if (!currentBound.has(node.value)) free.add(node.value);
        return;
      }
      case 'effect': {
        for (const reqId of node.requestValues ?? []) {
          if (!currentBound.has(reqId)) free.add(reqId);
        }
        const nextBound = new Set(currentBound);
        nextBound.add(node.resultId);
        visit(node.next, nextBound);
        return;
      }
      case 'effect-terminal': {
        for (const reqId of node.requestValues ?? []) {
          if (!currentBound.has(reqId)) free.add(reqId);
        }
        for (const savedId of node.savedValues ?? []) {
          if (!currentBound.has(savedId)) free.add(savedId);
        }
        return;
      }
      default:
        return;
    }
  };

  visit(plan, bound);
  return free;
}

/**
 * Given a continuation plan (`plan.next` at an `effect` suspension point) and
 * the ordered list of `available` variables in scope, returns the subset of
 * `available` variables that are genuinely live across the suspension point,
 * along with the eliminated dead variables.
 */
function analyzeLivePlanVariables(continuationPlan, available) {
  if (!Array.isArray(available)) {
    throw new TypeError('available variables must be an array');
  }
  const free = collectFreePlanVariables(continuationPlan);
  const seen = new Set();
  const savedValues = [];
  const eliminatedValues = [];
  for (const id of available) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (free.has(id)) {
      savedValues.push(id);
    } else {
      eliminatedValues.push(id);
    }
  }
  return Object.freeze({
    savedValues: Object.freeze(savedValues),
    eliminatedValues: Object.freeze(eliminatedValues),
    freeVariables: Object.freeze([...free]),
  });
}

function smalltalkValueSelectorArity(message) {
  if (!message || message.kind !== 'text' || typeof message.value !== 'string') return null;
  if (message.value === 'value') return 0;
  if (/^(value:)+$/.test(message.value)) {
    return message.value.split(':').length - 1;
  }
  return null;
}

function isPureSubstitutionExpression(expr) {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return false;
  return expr.op === 'literal'
    || expr.op === 'argument'
    || expr.op === 'receiver'
    || expr.op === 'binding';
}

function cloneExpression(expr) {
  return JSON.parse(JSON.stringify(expr));
}

function rewriteInlinedBody(expr, {argumentMap, bindingMap, receiverExpr}) {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return expr;
  switch (expr.op) {
    case 'literal':
      return cloneExpression(expr);
    case 'receiver':
      return receiverExpr ? cloneExpression(receiverExpr) : cloneExpression(expr);
    case 'argument': {
      const replacement = argumentMap.get(expr.index);
      if (!replacement) {
        throw new TypeError(`inlined closure argument index out of range: ${expr.index}`);
      }
      return cloneExpression(replacement);
    }
    case 'binding': {
      const mapped = bindingMap.get(expr.id);
      if (mapped) return cloneExpression(mapped);
      return cloneExpression(expr);
    }
    case 'binding-write': {
      const mapped = bindingMap.get(expr.id);
      const targetId = mapped && mapped.op === 'binding' ? mapped.id : expr.id;
      return {
        op: 'binding-write',
        id: targetId,
        value: rewriteInlinedBody(expr.value, {argumentMap, bindingMap, receiverExpr}),
      };
    }
    case 'sequence':
      return {
        op: 'sequence',
        statements: expr.statements.map((stmt) =>
          rewriteInlinedBody(stmt, {argumentMap, bindingMap, receiverExpr})),
      };
    case 'integer-add':
    case 'equals':
      return {
        op: expr.op,
        left: rewriteInlinedBody(expr.left, {argumentMap, bindingMap, receiverExpr}),
        right: rewriteInlinedBody(expr.right, {argumentMap, bindingMap, receiverExpr}),
      };
    case 'if':
      return {
        op: 'if',
        condition: rewriteInlinedBody(expr.condition, {argumentMap, bindingMap, receiverExpr}),
        then: rewriteInlinedBody(expr.then, {argumentMap, bindingMap, receiverExpr}),
        else: rewriteInlinedBody(expr.else, {argumentMap, bindingMap, receiverExpr}),
      };
    case 'send':
      return {
        op: 'send',
        languageId: expr.languageId,
        message: cloneExpression(expr.message),
        receiver: rewriteInlinedBody(expr.receiver, {argumentMap, bindingMap, receiverExpr}),
        arguments: (expr.arguments ?? []).map((arg) =>
          rewriteInlinedBody(arg, {argumentMap, bindingMap, receiverExpr})),
      };
    case 'apply':
      return {
        op: 'apply',
        callee: rewriteInlinedBody(expr.callee, {argumentMap, bindingMap, receiverExpr}),
        arguments: (expr.arguments ?? []).map((arg) =>
          rewriteInlinedBody(arg, {argumentMap, bindingMap, receiverExpr})),
      };
    case 'block':
    case 'make-block':
      return {
        ...cloneExpression(expr),
        captures: (expr.captures ?? []).map((cap) => {
          if (cap.mode === 'cell') {
            const mapped = bindingMap.get(cap.id);
            return mapped && mapped.op === 'binding'
              ? {...cap, id: mapped.id}
              : cloneExpression(cap);
          }
          if (cap.value) {
            return {
              ...cap,
              value: rewriteInlinedBody(cap.value, {argumentMap, bindingMap, receiverExpr}),
            };
          }
          return cloneExpression(cap);
        }),
      };
    default:
      return cloneExpression(expr);
  }
}

function containsNestedBlock(expr) {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return false;
  switch (expr.op) {
    case 'block':
    case 'make-block':
      return true;
    case 'binding-write':
      return containsNestedBlock(expr.value);
    case 'sequence':
      return (expr.statements ?? []).some(containsNestedBlock);
    case 'integer-add':
    case 'equals':
      return containsNestedBlock(expr.left) || containsNestedBlock(expr.right);
    case 'if':
      return containsNestedBlock(expr.condition)
        || containsNestedBlock(expr.then)
        || containsNestedBlock(expr.else);
    case 'send':
      return containsNestedBlock(expr.receiver)
        || (expr.arguments ?? []).some(containsNestedBlock);
    case 'apply':
      return containsNestedBlock(expr.callee)
        || (expr.arguments ?? []).some(containsNestedBlock);
    default:
      return false;
  }
}

function collectLocalBlockBindings(body, temporaries) {
  const tempIds = new Set((temporaries ?? []).map((t) => t.id));
  const writeCounts = new Map();
  const blockDefs = new Map();
  const totalReads = new Map();
  const callReads = new Map();
  const capturedByBlock = new Set();

  const visit = (expr) => {
    if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return;
    switch (expr.op) {
      case 'binding':
        if (tempIds.has(expr.id)) {
          totalReads.set(expr.id, (totalReads.get(expr.id) ?? 0) + 1);
        }
        return;
      case 'binding-write':
        if (tempIds.has(expr.id)) {
          writeCounts.set(expr.id, (writeCounts.get(expr.id) ?? 0) + 1);
          if (expr.value?.op === 'block' && !containsNestedBlock(expr.value.program?.body)) {
            blockDefs.set(expr.id, expr.value);
          }
        }
        visit(expr.value);
        return;
      case 'sequence':
        for (const stmt of expr.statements ?? []) visit(stmt);
        return;
      case 'integer-add':
      case 'equals':
        visit(expr.left);
        visit(expr.right);
        return;
      case 'if':
        visit(expr.condition);
        visit(expr.then);
        visit(expr.else);
        return;
      case 'apply':
        if (expr.callee?.op === 'binding' && tempIds.has(expr.callee.id)) {
          callReads.set(expr.callee.id, (callReads.get(expr.callee.id) ?? 0) + 1);
        }
        visit(expr.callee);
        for (const arg of expr.arguments ?? []) visit(arg);
        return;
      case 'send': {
        const arity = smalltalkValueSelectorArity(expr.message);
        if (
          arity !== null
          && expr.receiver?.op === 'binding'
          && tempIds.has(expr.receiver.id)
          && (expr.arguments ?? []).length === arity
        ) {
          callReads.set(expr.receiver.id, (callReads.get(expr.receiver.id) ?? 0) + 1);
        }
        visit(expr.receiver);
        for (const arg of expr.arguments ?? []) visit(arg);
        return;
      }
      case 'block':
      case 'make-block':
        for (const cap of expr.captures ?? []) {
          if (cap.mode === 'cell' && tempIds.has(cap.id)) {
            capturedByBlock.add(cap.id);
          } else if (cap.value) {
            visit(cap.value);
          }
        }
        if (expr.program?.body) visit(expr.program.body);
        return;
      default:
        return;
    }
  };

  visit(body);

  const nonEscaping = new Map();
  for (const [tempId, blockExpr] of blockDefs.entries()) {
    const writes = writeCounts.get(tempId) ?? 0;
    const reads = totalReads.get(tempId) ?? 0;
    const calls = callReads.get(tempId) ?? 0;
    if (writes === 1 && reads > 0 && reads === calls && !capturedByBlock.has(tempId)) {
      nonEscaping.set(tempId, blockExpr);
    }
  }
  return nonEscaping;
}

/**
 * Analyzes nested Blocks in `program` to identify closures that do not escape
 * (immediate inline Block applications or single-assignment local Block
 * bindings applied only in-place) vs closures that require full runtime
 * materialization.
 */
function analyzeClosureEscape(program) {
  if (!program || typeof program !== 'object') {
    throw new TypeError('program must be an object');
  }
  const hasTemporaries = Array.isArray(program.temporaries);
  const nonEscapingLocals = hasTemporaries
    ? collectLocalBlockBindings(program.body, program.temporaries)
    : new Map();

  const nonEscapingBlockIds = [];
  const escapingBlockIds = [];
  const localBindingBlockIds = new Set(
    [...nonEscapingLocals.values()].map((b) => b.blockId),
  );

  const scan = (expr, inImmediateCallPosition = false) => {
    if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return;
    switch (expr.op) {
      case 'block': {
        if (inImmediateCallPosition || localBindingBlockIds.has(expr.blockId)) {
          nonEscapingBlockIds.push(expr.blockId);
        } else {
          escapingBlockIds.push(expr.blockId);
        }
        for (const cap of expr.captures ?? []) {
          if (cap.value) scan(cap.value, false);
        }
        if (expr.program?.body) scan(expr.program.body, false);
        return;
      }
      case 'apply': {
        const directBlock = expr.callee?.op === 'block'
          && (expr.callee.program?.parameters?.length ?? 0) === (expr.arguments ?? []).length
          && !containsNestedBlock(expr.callee.program?.body);
        scan(expr.callee, directBlock);
        for (const arg of expr.arguments ?? []) scan(arg, false);
        return;
      }
      case 'send': {
        const arity = smalltalkValueSelectorArity(expr.message);
        const directBlock = arity !== null
          && expr.receiver?.op === 'block'
          && (expr.receiver.program?.parameters?.length ?? 0) === arity
          && (expr.arguments ?? []).length === arity
          && !containsNestedBlock(expr.receiver.program?.body);
        scan(expr.receiver, directBlock);
        for (const arg of expr.arguments ?? []) scan(arg, false);
        return;
      }
      case 'binding-write':
        scan(expr.value, false);
        return;
      case 'sequence':
        for (const stmt of expr.statements ?? []) scan(stmt, false);
        return;
      case 'integer-add':
      case 'equals':
        scan(expr.left, false);
        scan(expr.right, false);
        return;
      case 'if':
        scan(expr.condition, false);
        scan(expr.then, false);
        scan(expr.else, false);
        return;
      default:
        return;
    }
  };

  scan(program.body, false);
  return Object.freeze({
    nonEscapingBlockIds: Object.freeze(nonEscapingBlockIds),
    escapingBlockIds: Object.freeze(escapingBlockIds),
  });
}

/**
 * Inlines non-escaping nested Blocks in `program` so that full closure
 * materialization (`make_block_site_*`) and host Block invocation (`apply` /
 * `value:`) are unnecessary when a Block is only applied locally.
 */
function optimizeNonEscapingClosures(program) {
  if (!program || typeof program !== 'object') {
    throw new TypeError('program must be an object');
  }
  const hasTemporaries = Array.isArray(program.temporaries);
  const addedTemporaries = [];
  const existingTempIds = new Set((program.temporaries ?? []).map((t) => t.id));
  let inlineCounter = 0;
  const inlinedBlockIds = [];
  let eliminatedApplySites = 0;

  const allocateTemp = (prefix, name) => {
    let candidate = `${prefix}:${inlineCounter}`;
    inlineCounter += 1;
    while (existingTempIds.has(candidate)) {
      candidate = `${prefix}:${inlineCounter}`;
      inlineCounter += 1;
    }
    existingTempIds.add(candidate);
    addedTemporaries.push({id: candidate, name});
    return candidate;
  };

  const nonEscapingLocals = hasTemporaries
    ? collectLocalBlockBindings(program.body, program.temporaries)
    : new Map();

  const inlineBlockApplication = (blockExpr, argExprs) => {
    const childProgram = blockExpr.program;
    if (!childProgram || typeof childProgram !== 'object') return null;
    const paramCount = childProgram.parameters?.length ?? 0;
    if (paramCount !== argExprs.length) return null;
    if (containsNestedBlock(childProgram.body)) return null;

    if (!hasTemporaries) {
      // lagrange-code/v0: only inline when all arguments and captures are pure substitution expressions
      const captures = blockExpr.captures ?? [];
      if (!argExprs.every(isPureSubstitutionExpression)) return null;
      if (!captures.every((c) => isPureSubstitutionExpression(c.value))) return null;
      const argumentMap = new Map(argExprs.map((arg, index) => [index, arg]));
      const bindingMap = new Map(captures.map((cap) => [cap.id, cap.value]));
      inlinedBlockIds.push(blockExpr.blockId);
      eliminatedApplySites += 1;
      return rewriteInlinedBody(childProgram.body, {
        argumentMap,
        bindingMap,
        receiverExpr: {op: 'receiver'},
      });
    }

    // lagrange-code/v1 or v2: lower arguments, snapshot captures, and child temporaries into temporaries + sequence
    const setupStatements = [];
    const argumentMap = new Map();
    argExprs.forEach((argExpr, index) => {
      const paramDesc = childProgram.parameters[index];
      const paramName = paramDesc?.name ?? `arg_${index}`;
      const tempId = allocateTemp(`inline:${blockExpr.blockId}:param:${index}`, paramName);
      setupStatements.push({
        op: 'binding-write',
        id: tempId,
        value: transform(argExpr),
      });
      argumentMap.set(index, {op: 'binding', id: tempId});
    });

    const bindingMap = new Map();
    for (const cap of blockExpr.captures ?? []) {
      if (cap.mode === 'cell') {
        bindingMap.set(cap.id, {op: 'binding', id: cap.id});
      } else {
        const capValue = transform(cap.value);
        if (isPureSubstitutionExpression(capValue)) {
          bindingMap.set(cap.id, capValue);
        } else {
          const capTempId = allocateTemp(`inline:${blockExpr.blockId}:cap:${cap.id}`, cap.name ?? cap.id);
          setupStatements.push({
            op: 'binding-write',
            id: capTempId,
            value: capValue,
          });
          bindingMap.set(cap.id, {op: 'binding', id: capTempId});
        }
      }
    }

    for (const childTemp of childProgram.temporaries ?? []) {
      const mappedTempId = allocateTemp(`inline:${blockExpr.blockId}:temp:${childTemp.id}`, childTemp.name ?? childTemp.id);
      bindingMap.set(childTemp.id, {op: 'binding', id: mappedTempId});
    }

    inlinedBlockIds.push(blockExpr.blockId);
    eliminatedApplySites += 1;
    const rewrittenBody = rewriteInlinedBody(childProgram.body, {
      argumentMap,
      bindingMap,
      receiverExpr: {op: 'receiver'},
    });

    if (setupStatements.length === 0) {
      return rewrittenBody;
    }
    const bodyStatements = rewrittenBody.op === 'sequence'
      ? rewrittenBody.statements
      : [rewrittenBody];
    return {
      op: 'sequence',
      statements: [...setupStatements, ...bodyStatements],
    };
  };

  function transform(expr) {
    if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return expr;
    switch (expr.op) {
      case 'binding-write': {
        if (nonEscapingLocals.has(expr.id)) {
          return {op: 'literal', value: canonicalizeValue(integerValue(0))};
        }
        return {
          op: 'binding-write',
          id: expr.id,
          value: transform(expr.value),
        };
      }
      case 'sequence':
        return {
          op: 'sequence',
          statements: expr.statements.map(transform),
        };
      case 'integer-add':
      case 'equals':
        return {
          op: expr.op,
          left: transform(expr.left),
          right: transform(expr.right),
        };
      case 'if':
        return {
          op: 'if',
          condition: transform(expr.condition),
          then: transform(expr.then),
          else: transform(expr.else),
        };
      case 'apply': {
        const args = expr.arguments ?? [];
        if (expr.callee?.op === 'block') {
          const inlined = inlineBlockApplication(expr.callee, args);
          if (inlined) return inlined;
        }
        if (expr.callee?.op === 'binding' && nonEscapingLocals.has(expr.callee.id)) {
          const targetBlock = nonEscapingLocals.get(expr.callee.id);
          const inlined = inlineBlockApplication(targetBlock, args);
          if (inlined) return inlined;
        }
        return {
          op: 'apply',
          callee: transform(expr.callee),
          arguments: args.map(transform),
        };
      }
      case 'send': {
        const args = expr.arguments ?? [];
        const arity = smalltalkValueSelectorArity(expr.message);
        if (arity !== null && args.length === arity) {
          if (expr.receiver?.op === 'block') {
            const inlined = inlineBlockApplication(expr.receiver, args);
            if (inlined) return inlined;
          }
          if (expr.receiver?.op === 'binding' && nonEscapingLocals.has(expr.receiver.id)) {
            const targetBlock = nonEscapingLocals.get(expr.receiver.id);
            const inlined = inlineBlockApplication(targetBlock, args);
            if (inlined) return inlined;
          }
        }
        return {
          op: 'send',
          languageId: expr.languageId,
          message: cloneExpression(expr.message),
          receiver: transform(expr.receiver),
          arguments: args.map(transform),
        };
      }
      case 'block':
      case 'make-block':
        return {
          ...cloneExpression(expr),
          captures: (expr.captures ?? []).map((cap) =>
            cap.value ? {...cap, value: transform(cap.value)} : cloneExpression(cap)),
          ...(expr.program ? {program: optimizeNonEscapingClosures(expr.program).program} : {}),
        };
      default:
        return cloneExpression(expr);
    }
  }

  const transformedBody = transform(program.body);
  const retainedTemporaries = hasTemporaries
    ? [
      ...program.temporaries.filter((t) => !nonEscapingLocals.has(t.id)),
      ...addedTemporaries,
    ]
    : undefined;

  const uniqueInlinedIds = [...new Set(inlinedBlockIds)];
  return Object.freeze({
    program: Object.freeze({
      ...program,
      ...(hasTemporaries ? {temporaries: retainedTemporaries} : {}),
      body: transformedBody,
    }),
    inlinedBlockIds: Object.freeze(uniqueInlinedIds),
    eliminatedClosureSites: uniqueInlinedIds.length,
    eliminatedApplySites,
  });
}

function isPureDirectCallableBody(expr) {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return false;
  switch (expr.op) {
    case 'literal':
    case 'argument':
    case 'receiver':
    case 'binding':
      return true;
    case 'integer-add':
    case 'equals':
      return isPureDirectCallableBody(expr.left) && isPureDirectCallableBody(expr.right);
    case 'if':
      return isPureDirectCallableBody(expr.condition)
        && isPureDirectCallableBody(expr.then)
        && isPureDirectCallableBody(expr.else);
    case 'sequence':
      return (expr.statements ?? []).every(isPureDirectCallableBody);
    default:
      return false;
  }
}

/**
 * Discovers and normalizes intra-module direct call targets between entries in
 * a shared WASM compilation group. When entry A invokes a pure sibling entry B
 * in the same module (either via a nested Block in the same group or an
 * explicit `intraModuleCallTargets` binding map), the compiler can emit a
 * native WebAssembly `call` instruction (`0x10 <funcIdx>`) directly between
 * the module's internal functions without host suspension or closure creation.
 */
function planIntraModuleDirectCalls(entries, {intraModuleCallTargets = null} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('entries must be a non-empty array');
  }
  const byEntry = new Map();
  const byMemberIndex = new Map();
  const bySemanticBlockId = new Map();

  entries.forEach((entry, index) => {
    const program = entry.program;
    const hasCells = Array.isArray(program?.temporaries) && program.temporaries.length > 0
      || Array.isArray(program?.captures) && program.captures.some((c) => c.mode === 'cell');
    const directCallable = Boolean(program && !hasCells && isPureDirectCallableBody(program.body));
    const info = Object.freeze({
      entry: entry.entry,
      memberIndex: entry.memberIndex,
      functionOffset: index,
      parameterCount: Array.isArray(program?.parameters) ? program.parameters.length : 0,
      captures: Object.freeze((program?.captures ?? []).filter((c) => c.mode !== 'cell')),
      directCallable,
      semanticBlockId: entry.semanticBlockId ?? null,
    });
    byEntry.set(entry.entry, info);
    byMemberIndex.set(entry.memberIndex, info);
    if (typeof entry.semanticBlockId === 'string' && entry.semanticBlockId.length > 0) {
      bySemanticBlockId.set(entry.semanticBlockId, info);
    }
  });

  const bindingTargets = new Map();
  if (intraModuleCallTargets && typeof intraModuleCallTargets === 'object') {
    for (const [bindingId, spec] of Object.entries(intraModuleCallTargets)) {
      const targetInfo = spec.targetEntry !== undefined
        ? byEntry.get(spec.targetEntry)
        : byMemberIndex.get(spec.targetMemberIndex);
      if (!targetInfo) {
        throw new TypeError(`intraModuleCallTargets[${bindingId}] references unknown module entry`);
      }
      bindingTargets.set(bindingId, Object.freeze({
        ...targetInfo,
        captureExpressions: Object.freeze(spec.captureExpressions ?? []),
      }));
    }
  }

  return Object.freeze({
    byEntry,
    byMemberIndex,
    bySemanticBlockId,
    bindingTargets,
  });
}

class WasmModuleBudgetExceededError extends RangeError {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WasmModuleBudgetExceededError';
    this.details = Object.freeze({...details});
  }
}

/**
 * Splits a logical compilation group's entries into bounded physical WASM
 * module shards according to `maxMembersPerModule` and/or `maxByteBudget`.
 */
function partitionCompilationGroupByBudget({
  entries,
  maxMembersPerModule = Infinity,
  maxByteBudget = Infinity,
  compileEntries,
  strictSingleMemberBudget = false,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('entries must be a non-empty array');
  }
  if (typeof compileEntries !== 'function') {
    throw new TypeError('compileEntries function is required');
  }
  if (maxMembersPerModule !== Infinity) {
    requiredPositiveInteger(maxMembersPerModule, 'maxMembersPerModule');
  }
  if (maxByteBudget !== Infinity) {
    requiredPositiveInteger(maxByteBudget, 'maxByteBudget');
  }

  const shards = [];
  let currentEntries = [];
  let currentCompiled = null;

  const flushShard = () => {
    if (currentEntries.length === 0) return;
    const compiled = currentCompiled ?? compileEntries(currentEntries);
    shards.push(Object.freeze({
      shardIndex: shards.length,
      memberIndices: Object.freeze(currentEntries.map((e) => e.memberIndex)),
      entries: Object.freeze([...currentEntries]),
      compiled,
      byteLength: compiled.bytes.byteLength,
    }));
    currentEntries = [];
    currentCompiled = null;
  };

  for (const entry of entries) {
    if (currentEntries.length >= maxMembersPerModule) {
      flushShard();
    }
    const candidateEntries = [...currentEntries, entry];
    const candidateCompiled = compileEntries(candidateEntries);
    if (candidateCompiled.bytes.byteLength > maxByteBudget) {
      if (currentEntries.length === 0) {
        if (strictSingleMemberBudget) {
          throw new WasmModuleBudgetExceededError(
            `Single compilation group member ${entry.entry} (${candidateCompiled.bytes.byteLength} bytes) exceeds maxByteBudget (${maxByteBudget} bytes)`,
            {
              entry: entry.entry,
              memberIndex: entry.memberIndex,
              byteLength: candidateCompiled.bytes.byteLength,
              maxByteBudget,
            },
          );
        }
        currentEntries = candidateEntries;
        currentCompiled = candidateCompiled;
        flushShard();
        continue;
      }
      flushShard();
      const singleCompiled = compileEntries([entry]);
      if (strictSingleMemberBudget && singleCompiled.bytes.byteLength > maxByteBudget) {
        throw new WasmModuleBudgetExceededError(
          `Single compilation group member ${entry.entry} (${singleCompiled.bytes.byteLength} bytes) exceeds maxByteBudget (${maxByteBudget} bytes)`,
          {
            entry: entry.entry,
            memberIndex: entry.memberIndex,
            byteLength: singleCompiled.bytes.byteLength,
            maxByteBudget,
          },
        );
      }
      currentEntries = [entry];
      currentCompiled = singleCompiled;
    } else {
      currentEntries = candidateEntries;
      currentCompiled = candidateCompiled;
    }
  }
  flushShard();

  return Object.freeze({
    shardCount: shards.length,
    maxMembersPerModule: maxMembersPerModule === Infinity ? null : maxMembersPerModule,
    maxByteBudget: maxByteBudget === Infinity ? null : maxByteBudget,
    shards: Object.freeze(shards),
  });
}

export {
  WasmModuleBudgetExceededError,
  analyzeClosureEscape,
  analyzeLivePlanVariables,
  collectFreePlanVariables,
  optimizeNonEscapingClosures,
  partitionCompilationGroupByBudget,
  planIntraModuleDirectCalls,
};
