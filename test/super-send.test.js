import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  findSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  objectRef,
  reconcileMethodsFromSource,
} from '../src/runtime.js';

// ADR 0089. `super` at the Symmetric Smalltalk language owner.
//
// The one distinction every test here exists to hold: `super` is NOT another receiver. `self` is
// unchanged, and lookup starts at `superclass(the DEFINING Behavior of the running method)` — not
// at the receiver's class, not at the receiver's class's superclass, and not at a class named in
// source. Those three coincide whenever the receiver's class IS the defining class, which is why a
// two-level proof on an instance of the subclass proves almost nothing and is deliberately not the
// shape of the central tests below.

const IMAGE = 'app';

async function withRuntime(body, {lane = 'neutral'} = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: IMAGE});
    await installSymmetricSmalltalkStandardImage({
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, lane,
    });
    return await body(runtime, {
      images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, lane,
    });
  } finally {
    await runtime.close();
  }
}

const declare = (runtime, name, superclassRef = null, instanceVariables = []) => ensureClassFromDeclaration({
  images: runtime.images, imageId: IMAGE, name, superclassRef, instanceVariables,
});

async function evaluate(runtime, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId: IMAGE, id, source,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef(IMAGE, installed.block.id), args);
  return await runtime.executor.execute(activation, {dispatchImage: IMAGE});
}

const instanceOf = (runtime, id, classRef) => evaluate(runtime, id, '[ :k | k basicNew ]', [classRef]);

// --- the receiver ---------------------------------------------------------------------------------

// Kills "super changes the receiver to the superclass, to the class object, or to anything else".
// The superclass method answers `self`, so the answer is an identity rather than a number a method
// that never touched `self` could equally have produced.
test('a super send keeps the receiver: the superclass method answers the same object', async () => {
  await withRuntime(async (runtime, options) => {
    const parent = await declare(runtime, 'Parent');
    const child = await declare(runtime, 'Child', parent.classRef);
    await defineMethodsFromSource({
      ...options, classRef: parent.classRef, methods: [{selector: 'identity', source: '[ self ]'}],
    });
    await defineMethodsFromSource({
      ...options, classRef: child.classRef, methods: [{selector: 'throughSuper', source: '[ ^ super identity ]'}],
    });

    const receiver = await instanceOf(runtime, 'a-child', child.classRef);
    assert.equal(receiver.kind, 'ref');
    assert.deepEqual(
      await evaluate(runtime, 'send-through-super', '[ :o | o throughSuper ]', [receiver]),
      receiver,
      'the answer is the EXACT Child receiver, not a class object and not a new instance',
    );
  });
});

// --- lexical start, not dynamic start ---------------------------------------------------------------

// The central falsifier. Ordinary dynamic lookup of `answer` on a C instance begins at C and finds
// B's; a super send written INSIDE B's method must begin ABOVE B, at A. `super` lowered to `self`
// answers 2 here, and so does any implementation that starts from the receiver's own class.
test('super starts above the DEFINING class, not above the receiver class', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    const c = await declare(runtime, 'C', b.classRef);
    await defineMethodsFromSource({...options, classRef: a.classRef, methods: [{selector: 'answer', source: '[ 1 ]'}]});
    await defineMethodsFromSource({
      ...options,
      classRef: b.classRef,
      methods: [{selector: 'answer', source: '[ 2 ]'}, {selector: 'viaSuper', source: '[ ^ super answer ]'}],
    });

    const receiver = await instanceOf(runtime, 'a-c', c.classRef);
    // The control: ordinary dynamic lookup from C really does find B's override, so the two
    // starting points genuinely differ for this receiver.
    assert.deepEqual(
      await evaluate(runtime, 'dynamic', '[ :o | o answer ]', [receiver]),
      integerValue(2),
      'ordinary lookup on a C instance finds B',
    );
    assert.deepEqual(
      await evaluate(runtime, 'lexical', '[ :o | o viaSuper ]', [receiver]),
      integerValue(1),
      'the super send inside B starts above B, at A',
    );
  });
});

// --- the callee's frame ---------------------------------------------------------------------------

// The frame proof, stated behaviourally because a frame is transient runtime state with no
// language-level reader. Sending `answer` to a C instance must walk C -> B -> A. That only
// terminates if B's activation is told `definingBehavior = B` — the Behavior that ACTUALLY supplied
// the method — rather than inheriting C's. A primitive that reuses the caller's frame makes B's own
// `super answer` start above C again, find B's `answer`, and recur until the depth limit.
test('the callee runs with the RESOLVED defining Behavior, so a chained super walks the chain', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    const c = await declare(runtime, 'C', b.classRef);
    await defineMethodsFromSource({...options, classRef: a.classRef, methods: [{selector: 'answer', source: '[ 1 ]'}]});
    await defineMethodsFromSource({...options, classRef: b.classRef, methods: [{selector: 'answer', source: '[ ^ super answer ]'}]});
    await defineMethodsFromSource({...options, classRef: c.classRef, methods: [{selector: 'answer', source: '[ ^ super answer ]'}]});

    const receiver = await instanceOf(runtime, 'chain-c', c.classRef);
    assert.deepEqual(
      await evaluate(runtime, 'chained', '[ :o | o answer ]', [receiver]),
      integerValue(1),
      'C -> B -> A, each hop starting above the class that supplied the running method',
    );
  });
});

// --- class side, which is the real consumer ---------------------------------------------------------

// The forcing consumer is `XMLDOMParser class>>parseDocumentFrom:`, whose body opens with a real
// super send. Nothing here is class-side-specific in the implementation: `readBehavior(defining
// Behavior).superclass` walks the metaclass hierarchy exactly as it walks the class hierarchy,
// because the metaclass chain is derived from the class chain (ADR 0044 decision 4).
test('a class-side super send resolves through the metaclass hierarchy', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    await defineMethodsFromSource({...options, classRef: a.metaclassRef, methods: [{selector: 'make', source: '[ 10 ]'}]});
    await defineMethodsFromSource({
      ...options, classRef: b.metaclassRef, methods: [{selector: 'make', source: '[ ^ (super make) + 5 ]'}],
    });

    assert.deepEqual(
      await evaluate(runtime, 'class-side', '[ :k | k make ]', [b.classRef]),
      integerValue(15),
      'B class>>make reached A class>>make and then did its own work, exactly as the upstream shape does',
    );
  });
});

// The class-side twin of the lexical-start proof, because an "instance class superclass"
// approximation would answer B's own `make` here rather than A's.
test('class-side super starts above the DEFINING metaclass, not above the receiver class', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    const c = await declare(runtime, 'C', b.classRef);
    await defineMethodsFromSource({...options, classRef: a.metaclassRef, methods: [{selector: 'make', source: '[ 10 ]'}]});
    await defineMethodsFromSource({
      ...options,
      classRef: b.metaclassRef,
      methods: [{selector: 'make', source: '[ 20 ]'}, {selector: 'viaSuper', source: '[ ^ super make ]'}],
    });

    assert.deepEqual(
      await evaluate(runtime, 'class-dynamic', '[ :k | k make ]', [c.classRef]),
      integerValue(20),
      'ordinary class-side lookup from C finds B class',
    );
    assert.deepEqual(
      await evaluate(runtime, 'class-lexical', '[ :k | k viaSuper ]', [c.classRef]),
      integerValue(10),
      'the super send inside B class starts above B class, at A class',
    );
  });
});

// --- the three send forms ---------------------------------------------------------------------------

test('unary, binary and keyword super sends all fall out of one lowering', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    await defineMethodsFromSource({
      ...options,
      classRef: a.classRef,
      methods: [
        {selector: 'answer', source: '[ 1 ]'},
        {selector: '+', source: '[ :n | 100 + n ]'},
        {selector: 'at:put:', source: '[ :k :v | k + v ]'},
      ],
    });
    await defineMethodsFromSource({
      ...options,
      classRef: b.classRef,
      methods: [
        {selector: 'answer', source: '[ 2 ]'},
        {selector: 'unary', source: '[ ^ super answer ]'},
        {selector: 'binary:', source: '[ :n | ^ super + n ]'},
        {selector: 'keyword', source: '[ ^ super at: 3 put: 4 ]'},
      ],
    });

    const receiver = await instanceOf(runtime, 'forms', b.classRef);
    assert.deepEqual(await evaluate(runtime, 'f-u', '[ :o | o unary ]', [receiver]), integerValue(1));
    assert.deepEqual(await evaluate(runtime, 'f-b', '[ :o | o binary: 5 ]', [receiver]), integerValue(105));
    assert.deepEqual(await evaluate(runtime, 'f-k', '[ :o | o keyword ]', [receiver]), integerValue(7));
  });
});

// The WASM lane compiles the same semantic program, so `super` must answer identically there. It is
// also the lane every Cuis-imported method is installed in, which is what makes this the lane the
// M4 vertical actually runs.
test('the WASM lane answers identically', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    const c = await declare(runtime, 'C', b.classRef);
    await defineMethodsFromSource({...options, classRef: a.classRef, methods: [{selector: 'answer', source: '[ 1 ]'}]});
    await defineMethodsFromSource({
      ...options,
      classRef: b.classRef,
      methods: [{selector: 'answer', source: '[ 2 ]'}, {selector: 'viaSuper', source: '[ ^ super answer ]'}],
    });
    const receiver = await instanceOf(runtime, 'wasm-c', c.classRef);
    assert.deepEqual(await evaluate(runtime, 'wasm-dyn', '[ :o | o answer ]', [receiver]), integerValue(2));
    assert.deepEqual(await evaluate(runtime, 'wasm-lex', '[ :o | o viaSuper ]', [receiver]), integerValue(1));
  }, {lane: 'wasm'});
});

// The Cuis-free instrument the M4 harness names, run here as an ordinary unit proof so it is not
// gated behind the integration environment: the ORDINARY native method compiler, reached through
// `reconcileMethodsFromSource` — the exact path the Cuis adapter uses — accepts `super` and the
// installed method answers the superclass implementation.
test('reconcileMethodsFromSource compiles and installs a working super send', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    await defineMethodsFromSource({...options, classRef: a.classRef, methods: [{selector: 'probe', source: '[ 7 ]'}]});
    await reconcileMethodsFromSource({
      ...options, classRef: b.classRef, methods: [{selector: 'probeSuper', source: '[\n^ super probe.\nself\n]'}],
    });
    const receiver = await instanceOf(runtime, 'recon', b.classRef);
    assert.deepEqual(
      await evaluate(runtime, 'recon-send', '[ :o | o probeSuper ]', [receiver]),
      integerValue(7),
    );
  }, {lane: 'wasm'});
});

// --- failure taxonomy -------------------------------------------------------------------------------

// An ordinary selector miss stays an ordinary selector miss. Not an unbound name, not a dangling
// edge, not a host TypeError from an internal assumption — the three-way split ADR 0044 keeps is
// the same split a super send must land in.
test('a super send that reaches the top is an ordinary message-not-understood', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    await defineMethodsFromSource({
      ...options, classRef: b.classRef, methods: [{selector: 'nope', source: '[ ^ super notImplementedAnywhere ]'}],
    });
    const receiver = await instanceOf(runtime, 'miss', b.classRef);
    await assert.rejects(
      evaluate(runtime, 'miss-send', '[ :o | o nope ]', [receiver]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError'
        && error.selector === 'notImplementedAnywhere',
    );
  });
});

// A super send from a method whose defining Behavior is the root: the walk starts at the kernel
// `nil` terminator and ends immediately. Still an ordinary miss, with no special case anywhere.
test('a super send from a root-defined method is a miss, not a structural failure', async () => {
  await withRuntime(async (runtime, options) => {
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: IMAGE});
    // `Object class` is the metaclass whose own superclass is `Class`; the class-side root whose
    // superclass IS kernel nil is reached through the ordinary Behavior graph rather than invented.
    const rootBehavior = await runtime.images.getObject(IMAGE, kernel.objectClass.objectId);
    assert.ok(rootBehavior, 'the kernel Object class exists');
    await defineMethodsFromSource({
      ...options, classRef: kernel.objectClass, methods: [{selector: 'aboveTheRoot', source: '[ ^ super anything ]'}],
    });
    const a = await declare(runtime, 'A');
    const receiver = await instanceOf(runtime, 'root', a.classRef);
    await assert.rejects(
      evaluate(runtime, 'root-send', '[ :o | o aboveTheRoot ]', [receiver]),
      (error) => error.name === 'SmalltalkMessageNotUnderstoodError' && error.selector === 'anything',
    );
  });
});

// Structural corruption stays distinct from a selector miss, exactly as the lookup owner already
// distinguishes them — because the super facility routes through that same owner rather than
// walking the chain itself.
test('a dangling superclass edge above the defining class is corrupt graph state, not a miss', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    await defineMethodsFromSource({...options, classRef: a.classRef, methods: [{selector: 'answer', source: '[ 1 ]'}]});
    await defineMethodsFromSource({...options, classRef: b.classRef, methods: [{selector: 'viaSuper', source: '[ ^ super answer ]'}]});
    const receiver = await instanceOf(runtime, 'dangle', b.classRef);

    const record = await runtime.images.getObject(IMAGE, b.classRef.objectId);
    await runtime.images.putObject(IMAGE, {
      id: record.id,
      shape: record.shape,
      behavior: record.behavior,
      slots: {...record.slots, 'behavior-superclass': objectRef(IMAGE, 'smalltalk/class/Vanished')},
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    await assert.rejects(
      evaluate(runtime, 'dangle-send', '[ :o | o viaSuper ]', [receiver]),
      (error) => error.name === 'SmalltalkDanglingEdgeError',
    );
  });
});

// --- syntax: `super` is reserved, and it is not a value -----------------------------------------------

test('super is a reserved word at every site a name could be introduced', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const attempt = async (selector, source) => await defineMethodsFromSource({
      ...options, classRef: a.classRef, methods: [{selector, source}],
    });
    for (const [selector, what, source] of [
      ['asTemporary', 'a temporary', '[ | super | super ]'],
      ['asBlockParameter', 'a block parameter', '[ :super | super ]'],
      ['asAssignmentTarget', 'an assignment target', '[ super := 1 ]'],
    ]) {
      await assert.rejects(
        attempt(selector, source),
        (error) => error.name === 'SymmetricSmalltalkSyntaxError' && /super: it is a reserved word/.test(error.message),
        `${what} named super is refused`,
      );
    }
    // The site the parser cannot reach: captures are supplied programmatically.
    await assert.rejects(
      defineMethodsFromSource({
        ...options,
        classRef: a.classRef,
        methods: [{selector: 'captured', source: '[ 1 ]', captures: {super: 'caller/super'}}],
      }),
      /capture name super is a reserved word/,
    );
  });
});

test('super is not a value: only a send receiver', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const attempt = async (label, source) => await defineMethodsFromSource({
      ...options, classRef: a.classRef, methods: [{selector: label, source}],
    });
    for (const [label, source] of [
      ['bare', '[ ^ super ]'],
      ['assigned', '[ | t | t := super. t ]'],
      ['argument', '[ ^ self foo: super ]'],
    ]) {
      await assert.rejects(
        attempt(label, source),
        /super is not a value: it may only be the receiver of a message send/,
        `${label} super is refused rather than answering a proxy object`,
      );
    }
    // The recorded boundary, refused deterministically rather than half-supported: the cascade
    // lowering evaluates its receiver once into a temporary, and `super` denotes nothing to put
    // there.
    await assert.rejects(
      attempt('cascaded', '[ super foo; bar ]'),
      /a cascade receiver may not be super/,
    );
  });
});

test('super needs a method home, exactly as `^` does', async () => {
  await withRuntime(async (runtime) => {
    await assert.rejects(
      installSymmetricSmalltalkBlock({images: runtime.images, imageId: IMAGE, id: 'homeless', source: '[ super foo ]'}),
      /super requires a method home/,
    );
  });
});

// --- nested Blocks: the boundary this slice actually supports ------------------------------------------

// Honest scope. A Block created inside a method activation has that method's frame restored while
// the execution that created it is still running (ADR 0050 decision 10), so a `super` written there
// starts above the DEFINING method's Behavior — genuinely lexical, with no new durable state. A
// closure that outlives its execution has no frame to restore and fails closed (decision 10a); it
// is not lent the caller's frame and does not fall back to the receiver's class.
test('super inside a nested Block starts above the defining method, within the creating execution', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    const c = await declare(runtime, 'C', b.classRef);
    await defineMethodsFromSource({...options, classRef: a.classRef, methods: [{selector: 'answer', source: '[ 1 ]'}]});
    await defineMethodsFromSource({
      ...options,
      classRef: b.classRef,
      methods: [{selector: 'answer', source: '[ 2 ]'}, {selector: 'inBlock', source: '[ ^ [ super answer ] value ]'}],
    });
    const receiver = await instanceOf(runtime, 'nested-c', c.classRef);
    assert.deepEqual(
      await evaluate(runtime, 'nested', '[ :o | o inBlock ]', [receiver]),
      integerValue(1),
      'the Block restored B\'s frame, so its super send still started above B',
    );
  });
});

test('super inside a closure that outlived its execution fails closed', async () => {
  await withRuntime(async (runtime, options) => {
    const a = await declare(runtime, 'A');
    const b = await declare(runtime, 'B', a.classRef);
    await defineMethodsFromSource({...options, classRef: a.classRef, methods: [{selector: 'answer', source: '[ 1 ]'}]});
    await defineMethodsFromSource({
      ...options, classRef: b.classRef, methods: [{selector: 'escaper', source: '[ [ super answer ] ]'}],
    });
    const receiver = await instanceOf(runtime, 'escape', b.classRef);
    const escaped = await evaluate(runtime, 'get-closure', '[ :o | o escaper ]', [receiver]);
    await assert.rejects(
      evaluate(runtime, 'run-closure', '[ :blk | blk value ]', [escaped]),
      (error) => error.name === 'SmalltalkSuperFrameMissingError',
      'no frame is invented, borrowed from the caller, or recovered from the receiver',
    );
  });
});

// --- ownership ------------------------------------------------------------------------------------------

// The architectural condition, checked structurally because the behavioural tests above cannot see
// a duplicated walk that happens to agree: the super facility must DELEGATE selector lookup, not
// reimplement it. A second superclass walker or a second MethodDictionary reader here would be two
// owners for one rule, and would drift the first time either changes.
test('STRUCTURAL: the super facility delegates lookup and owns no walk of its own', async () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'language', 'smalltalk-primitives-super.js');
  const source = await readFile(file, 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

  assert.match(code, /import \{[^}]*lookupSelector[^}]*\} from '\.\/smalltalk-lookup\.js'/, 'lookup comes from the lookup owner');
  assert.match(code, /import \{[^}]*readBehavior[^}]*\} from '\.\/smalltalk-kernel\.js'/, 'the Behavior comes from the Behavior owner');
  assert.match(code, /requireInvokeResolvedMethod/, 'activation comes from the invocation owner');

  for (const forbidden of [/\bwhile\s*\(/, /\bfor\s*\(/, /\.methods\b/, /MethodDictionary/, /behavior-methods/, /getShape\(/]) {
    assert.doesNotMatch(code, forbidden, `the super facility must not contain ${forbidden}`);
  }
});
