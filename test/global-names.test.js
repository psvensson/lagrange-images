import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompilationService,
  booleanValue,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  createRuntime,
  defineClass,
  defineMethods,
  findSmalltalkGlobalNamespace,
  findSmalltalkKernel,
  globalBindingId,
  installSmalltalkAllocationProtocol,
  installSmalltalkBlockProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkGlobalNamespace,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  publishGlobal,
  publishSmalltalkClassGlobals,
  rebindGlobal,
  removeGlobal,
  renameGlobal,
  resolveGlobal,
  textValue,
} from '../src/runtime.js';
import {defineMethodsFromSource} from '../src/language/smalltalk-instance-variables.js';
import {installWasmBlockTree} from '../src/wasm/tree-installer.js';

// ADR 0057. Three things are kept apart — name, binding identity, current value — and most of what
// is worth testing is a way one of them could quietly collapse into another.

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  await installSmalltalkAllocationProtocol(options);
  await installSmalltalkEqualityProtocol(options);
  await installSmalltalkControlFlow(options);
  await installSmalltalkBlockProtocol({images: runtime.images, imageId});
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkGlobalNamespace(options);
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  return {kernel, options};
}

async function evaluate(runtime, imageId, id, source, args = [], installOptions = {}) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId, id, source, ...installOptions,
  });
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

// --- bootstrap and representation ------------------------------------------------------------------

// The concern that shaped the ADR: a first-class binding must not need the Association library.
test('the namespace bootstraps on the kernel and instance-variable machinery alone', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'bare'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'bare'});
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'bare'});

    // No allocation, equality, Block, Integer, condition or library protocol installed.
    const installed = await installSmalltalkGlobalNamespace({
      images: runtime.images, compilation: runtime.compilation, imageId: 'bare',
    });
    assert.ok(installed.ref);
    assert.ok(await resolveGlobal({images: runtime.images, imageId: 'bare', name: 'Object'}),
      'the kernel classes are published by the installer');
  });
});

test('the namespace mapping is durable graph data with real edges to bindings', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const namespace = await findSmalltalkGlobalNamespace({images: runtime.images, imageId: 'app'});
    const record = await runtime.images.getObject('app', 'smalltalk-global-namespace/v1');

    // Canonical name/binding pairs in an indexed part, not Shape slots — the Shape stays fixed while
    // the mapping mutates.
    assert.equal(record.indexed.length % 2, 0);
    assert.equal(record.indexed[0].kind, 'text');
    assert.equal(record.indexed[1].kind, 'ref');
    // Sorted, so two images that published in different orders hold the same record.
    const names = record.indexed.filter((entry, index) => index % 2 === 0).map(({value}) => value);
    assert.deepEqual(names, [...names].sort());

    // And the edges really point at GlobalBinding objects in the graph.
    for (const [name, binding] of namespace.entries) {
      const target = await runtime.images.getObject('app', binding.objectId);
      assert.ok(target, `${name} must point at a real object`);
      assert.equal(target.behavior.objectId, 'smalltalk/class/GlobalBinding');
      assert.ok(Object.hasOwn(target.slots, 'global-binding-value'));
    }
  });
});

test('a corrupt namespace is refused, and an absent one is simply absent', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    assert.equal(await findSmalltalkGlobalNamespace({images: runtime.images, imageId: 'app'}) === null, false);

    await runtime.images.createImage({id: 'none'});
    assert.equal(await findSmalltalkGlobalNamespace({images: runtime.images, imageId: 'none'}), null);

    const record = await runtime.images.getObject('app', 'smalltalk-global-namespace/v1');
    const authored = ['id', 'shape', 'behavior', 'slots', 'indexed', 'metadata']
      .filter((key) => Object.hasOwn(record, key))
      .reduce((carry, key) => ({...carry, [key]: record[key]}), {});
    // An odd number of entries cannot be a mapping.
    await runtime.images.putObject('app', {...authored, indexed: [textValue('Lonely')]},
      {expectedVersion: record._version});
    await assert.rejects(
      findSmalltalkGlobalNamespace({images: runtime.images, imageId: 'app'}),
      /odd number of entries/,
    );
  });
});

// --- identity is not name and not value ------------------------------------------------------------

test('binding identity is independent of the name and of the value', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const binding = await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Thing',
      bindingId: 'smalltalk/global-binding/thing-1', value: kernel.integerClass,
    });

    // Rebinding does not change identity.
    await rebindGlobal({images: runtime.images, imageId: 'app', bindingId: binding.objectId, value: kernel.objectClass});
    assert.deepEqual(await resolveGlobal({images: runtime.images, imageId: 'app', name: 'Thing'}), binding);

    // Renaming does not change identity either.
    await renameGlobal({images: runtime.images, imageId: 'app', from: 'Thing', to: 'Widget'});
    assert.deepEqual(await resolveGlobal({images: runtime.images, imageId: 'app', name: 'Widget'}), binding);
    assert.equal(await resolveGlobal({images: runtime.images, imageId: 'app', name: 'Thing'}), null);

    // And the id was supplied, not derived: removing and republishing the same *spelling* with a
    // different id gives a different identity, which is what stops a name accidentally recovering
    // an old binding.
    await removeGlobal({images: runtime.images, imageId: 'app', name: 'Widget'});
    const second = await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Widget',
      bindingId: 'smalltalk/global-binding/thing-2', value: kernel.integerClass,
    });
    assert.notEqual(second.objectId, binding.objectId,
      'a republished spelling must not recover the previous identity');
  });
});

test('GlobalBinding answers value and does not understand value:', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const binding = await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Thing',
      bindingId: globalBindingId('Thing'), value: kernel.integerClass,
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'read-binding', '[ :b | b value ]', [binding]),
      kernel.integerClass,
    );
    // Reference is not authority: holding the binding must not let ordinary source rebind it.
    await assert.rejects(
      evaluate(runtime, 'app', 'write-binding', '[ :b | b value: 1 ]', [binding]),
      /message not understood: value:/,
    );
  });
});

// --- resolution -------------------------------------------------------------------------------------

test('a class that exists but is not published is an unknown global', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'quiet-shape', slots: []})).id);
    await defineClass({images: runtime.images, imageId: 'app', name: 'Quiet', instanceShapeRef: shape});
    assert.ok(await runtime.images.getObject('app', 'smalltalk/class/Quiet'), 'the class exists');

    await assert.rejects(
      installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'app', id: 'quiet', source: '[ Quiet ]'}),
      /unbound Symmetric Smalltalk name: Quiet/,
      'existence is not publication',
    );
  });
});

test('every lexical form shadows an identically named global', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Shadowed',
      bindingId: globalBindingId('Shadowed'), value: kernel.integerClass,
    });

    // parameter, temporary and explicit capture
    assert.deepEqual(
      await evaluate(runtime, 'app', 'shadow-param', '[ :Shadowed | Shadowed ]', [integerValue(1)]),
      integerValue(1),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'shadow-temp', '[ | Shadowed | Shadowed := 2. Shadowed ]'),
      integerValue(2),
    );
    assert.deepEqual(
      await evaluate(runtime, 'app', 'shadow-capture', '[ Shadowed ]', [], {
        captures: {Shadowed: 'caller/shadowed'},
        environment: objectRef('app', (await runtime.images.putLexicalEnvironment('app', {
          id: 'shadow-env', bindings: {'caller/shadowed': {name: 'Shadowed', value: integerValue(3)}},
        })).id),
      }),
      integerValue(3),
    );

    // instance variable
    const shape = objectRef('app', (await runtime.images.putShape('app', {
      id: 'shadow-ivar-shape', slots: [{id: 'shadowed-slot', name: 'Shadowed'}],
    })).id);
    const holder = await defineClass({images: runtime.images, imageId: 'app', name: 'Holder', instanceShapeRef: shape});
    await defineMethodsFromSource({
      ...options,
      classRef: holder.classRef,
      methods: [{selector: 'read', source: '[ Shadowed := 4. Shadowed ]'}],
    });
    const instance = await evaluate(runtime, 'app', 'holder', '[ :c | c new ]', [holder.classRef]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'shadow-ivar', '[ :o | o read ]', [instance]),
      integerValue(4),
    );
  });
});

test('a nested Block can be the only user of a global', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Deep',
      bindingId: globalBindingId('Deep'), value: kernel.integerClass,
    });
    assert.deepEqual(
      await evaluate(runtime, 'app', 'deep', '[ [ [ Deep ] value ] value ]'),
      kernel.integerClass,
      'the root activation must acquire the binding and the capture chain carry it down',
    );
  });
});

test('global assignment is refused with a diagnosis that names the problem', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Fixed',
      bindingId: globalBindingId('Fixed'), value: kernel.integerClass,
    });
    await assert.rejects(
      installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: 'assign', source: '[ | x | Fixed := 1 ]',
      }),
      /global assignment is not supported: Fixed/,
      'a known global must not be reported as an unknown name',
    );
  });
});

test('an explicit capture colliding with a global binding id is refused', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Collide',
      bindingId: globalBindingId('Collide'), value: kernel.integerClass,
    });
    // Two different meanings must not collapse onto one environment key.
    await assert.rejects(
      installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: 'collide', source: '[ (Collide = Other) ]',
        captures: {Other: globalBindingId('Collide')},
      }),
      /collides with the global binding id/,
    );
  });
});

// The corollary of the collision test above: a capture id is not evidence of provenance. Whether a
// capture is a global is decided by what compilation *resolved*, not by which ids happen to be
// published. Inferring it from the id would silently swap the caller's value for the binding object
// in exactly this shape.
test('an explicit capture is bound to the caller value even when its id is a published binding id', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Collide',
      bindingId: globalBindingId('Collide'), value: kernel.integerClass,
    });

    // The source never mentions `Collide`, so no global is resolved here at all.
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'not-a-global', source: '[ Other ]',
      captures: {Other: globalBindingId('Collide')},
      environment: objectRef('app', (await runtime.images.putLexicalEnvironment('app', {
        id: 'caller-supplied-env',
        bindings: {[globalBindingId('Collide')]: {name: 'Other', value: textValue('caller value')}},
      })).id),
    });
    assert.deepEqual(installed.globalBindingIdsUsed, [], 'compilation resolved no globals');
    assert.deepEqual(
      await runtime.executor.execute(
        await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), []),
      ),
      textValue('caller value'),
      'the caller value must survive; the compiler must not substitute the GlobalBinding object',
    );
  });
});

test('a method capture is bound to the caller value even when its id is a published binding id', async () => {
  await withRuntime(async (runtime) => {
    const {kernel, options} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Collide',
      bindingId: globalBindingId('Collide'), value: kernel.integerClass,
    });
    const shape = objectRef('app', (await runtime.images.putShape('app', {id: 'capture-holder-shape', slots: []})).id);
    const holder = await defineClass({
      images: runtime.images, imageId: 'app', name: 'CaptureHolder', instanceShapeRef: shape,
    });
    await defineMethodsFromSource({
      ...options,
      classRef: holder.classRef,
      methods: [{
        selector: 'answer',
        source: '[ Other ]',
        captures: [{name: 'Other', id: globalBindingId('Collide'), value: textValue('caller value')}],
      }],
    });
    const instance = await evaluate(runtime, 'app', 'capture-holder', '[ :c | c new ]', [holder.classRef]);
    assert.deepEqual(
      await evaluate(runtime, 'app', 'ask-holder', '[ :o | o answer ]', [instance]),
      textValue('caller value'),
      'the caller value must survive; the compiler must not substitute the GlobalBinding object',
    );
  });
});

// The collision check distinguishes the compiler's own global captures from the caller's by exactly
// one thing: the `$global:` key prefix. A caller able to supply that prefix could name a capture
// that looks internal and walk straight past the check, so the whole prefix is refused as a name.
test('a caller cannot supply an internal-looking $global: capture name', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const bindingId = globalBindingId('Sneaky');
    await publishGlobal({images: runtime.images, imageId: 'app', name: 'Sneaky', bindingId, value: kernel.integerClass});

    for (const name of [`$global:${bindingId}`, '$global:anything', '$global:']) {
      await assert.rejects(
        installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'app', id: `sneak-${name}`, source: '[ Sneaky ]',
          captures: {[name]: 'caller/sneaky'},
        }),
        /belongs to the compiler/,
        `capture name ${name} must be refused`,
      );
    }
  });
});

test('two names resolving to one binding share a single capture', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const bindingId = globalBindingId('Primary');
    await publishGlobal({images: runtime.images, imageId: 'app', name: 'Primary', bindingId, value: kernel.integerClass});
    await publishGlobal({images: runtime.images, imageId: 'app', name: 'Alias', bindingId, value: kernel.integerClass});

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'alias', source: '[ (Primary = Alias) ]',
    });
    const captures = installed.semanticProgram.captures.filter(({id}) => id === bindingId);
    assert.equal(captures.length, 1, 'an alias must reuse the one binding capture, not duplicate its id');
    assert.deepEqual(
      await runtime.executor.execute(
        await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), []),
      ),
      booleanValue(true),
    );
  });
});

// --- lifecycle ---------------------------------------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`rebinding through the trusted seam changes already-compiled ${lane} code`, async () => {
    await withRuntime(async (runtime) => {
      const {kernel, options} = await seed(runtime, 'app', {lane});
      const bindingId = globalBindingId('Current');
      await publishGlobal({images: runtime.images, imageId: 'app', name: 'Current', bindingId, value: kernel.integerClass});

      // A method, compiled once.
      await defineMethodsFromSource({
        ...options,
        classRef: kernel.objectClass,
        methods: [{selector: 'currentGlobal', source: '[ Current ]'}],
      });
      const readMethod = async (id) => await evaluate(runtime, 'app', id, '[ :o | o currentGlobal ]', [kernel.nil]);
      assert.deepEqual(await readMethod(`m-before-${lane}`), kernel.integerClass);

      // A Block, compiled once, in the WASM lane where relevant.
      const installed = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'app', id: `blk-${lane}`, source: '[ Current ]',
      });
      const blockRef = lane === 'wasm'
        ? objectRef('app', (await installWasmBlockTree({
          images: runtime.images, compilation: runtime.compilation,
          semanticRef: objectRef('app', installed.semanticArtifact.id), id: `blk-${lane}-tree`,
          // The tree installer is a lower-level API: its caller supplies the environment, so the
          // compiler-supplied one from the source install has to be passed along.
          environment: installed.block.environment,
        })).block.id)
        : objectRef('app', installed.block.id);
      const readBlock = async () => await runtime.executor.execute(
        await runtime.invocations.invokeBlock(blockRef, []),
      );
      assert.deepEqual(await readBlock(), kernel.integerClass);

      // Rebind through the management seam — not source assignment, and not a setter.
      await rebindGlobal({images: runtime.images, imageId: 'app', bindingId, value: kernel.objectClass});

      assert.deepEqual(await readMethod(`m-after-${lane}`), kernel.objectClass, 'the method sees the new value');
      assert.deepEqual(await readBlock(), kernel.objectClass, 'and so does the already-compiled Block');
    });
  });
}

test('renaming keeps compiled code working; removal breaks only future compilation', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const bindingId = globalBindingId('Movable');
    await publishGlobal({images: runtime.images, imageId: 'app', name: 'Movable', bindingId, value: kernel.integerClass});

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'movable', source: '[ Movable ]',
    });
    const read = async () => await runtime.executor.execute(
      await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), []),
    );
    assert.deepEqual(await read(), kernel.integerClass);

    await renameGlobal({images: runtime.images, imageId: 'app', from: 'Movable', to: 'Renamed'});
    assert.deepEqual(await read(), kernel.integerClass, 'compiled code never held the name');
    await assert.rejects(
      installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'app', id: 'old-name', source: '[ Movable ]'}),
      /unbound Symmetric Smalltalk name: Movable/,
    );

    await removeGlobal({images: runtime.images, imageId: 'app', name: 'Renamed'});
    assert.deepEqual(await read(), kernel.integerClass,
      'removal withdraws a name, not an identity someone already holds');
    await assert.rejects(
      installSymmetricSmalltalkBlock({images: runtime.images, imageId: 'app', id: 'gone', source: '[ Renamed ]'}),
      /unbound Symmetric Smalltalk name: Renamed/,
    );
  });
});

// --- management idempotence ---------------------------------------------------------------------------

test('publish, rebind, rename and remove are retry-safe', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const images = runtime.images;
    const bindingId = globalBindingId('Retry');

    const first = await publishGlobal({images, imageId: 'app', name: 'Retry', bindingId, value: kernel.integerClass});
    // Re-running an installer must not reset a legitimate rebind: publish keeps the current value.
    await rebindGlobal({images, imageId: 'app', bindingId, value: kernel.objectClass});
    const second = await publishGlobal({images, imageId: 'app', name: 'Retry', bindingId, value: kernel.integerClass});
    assert.deepEqual(second, first, 'publishing the same name to the same binding is a no-op');
    assert.deepEqual(
      (await images.getObject('app', bindingId)).slots['global-binding-value'],
      kernel.objectClass,
      'a re-published installer must not undo a rebind',
    );

    // The same name to a different binding is a conflict, not a silent rebind.
    await assert.rejects(
      publishGlobal({images, imageId: 'app', name: 'Retry', bindingId: 'other/binding', value: kernel.nil}),
      /is already bound to/,
    );

    // Rebinding to the value it already has writes nothing.
    const before = (await images.getObject('app', bindingId))._version;
    await rebindGlobal({images, imageId: 'app', bindingId, value: kernel.objectClass});
    assert.equal((await images.getObject('app', bindingId))._version, before, 'a no-op rebind must not write');

    // A rename retried after a lost acknowledgement converges -- but only because the retry names the
    // identity it was moving. Convergence is "the binding I moved is now at the destination", not
    // "something is at the destination".
    await renameGlobal({images, imageId: 'app', from: 'Retry', to: 'Retried', bindingId});
    const again = await renameGlobal({images, imageId: 'app', from: 'Retry', to: 'Retried', bindingId});
    assert.deepEqual(again, first, 'the rename already landed; the retry converges');

    // Removing an already-removed name is a no-op rather than a failure.
    assert.equal(await removeGlobal({images, imageId: 'app', name: 'Retried'}), true);
    assert.equal(await removeGlobal({images, imageId: 'app', name: 'Retried'}), false);
  });
});

test('rename convergence is decided by binding identity, not by the destination being occupied', async () => {
  await withRuntime(async (runtime) => {
    const {images} = runtime;
    const {kernel} = await seed(runtime, 'app');

    const moved = await publishGlobal({images, imageId: 'app', name: 'Moved', bindingId: 'b/moved', value: kernel.objectClass});
    const other = await publishGlobal({images, imageId: 'app', name: 'Other', bindingId: 'b/other', value: kernel.integerClass});

    // The destination is occupied by an unrelated binding. A rename whose source is absent must not
    // read that as "my rename already landed": nothing ever moved b/moved there.
    await assert.rejects(
      renameGlobal({images, imageId: 'app', from: 'NeverExisted', to: 'Other', bindingId: 'b/moved'}),
      /is bound to b\/other, not the renamed binding/,
      'an occupied destination is not evidence that this rename landed',
    );

    // Without an expected identity there is nothing to converge on, so an absent source stays an
    // error even when the destination is occupied.
    await assert.rejects(
      renameGlobal({images, imageId: 'app', from: 'NeverExisted', to: 'Other'}),
      /is bound to b\/other, not the renamed binding/,
    );

    // The source exists but holds a different binding than the caller expected: refuse rather than
    // move whatever happens to be under the name now.
    await assert.rejects(
      renameGlobal({images, imageId: 'app', from: 'Moved', to: 'Elsewhere', bindingId: 'b/other'}),
      /is bound to b\/moved, not b\/other/,
    );

    // The genuine converged case still converges.
    await renameGlobal({images, imageId: 'app', from: 'Moved', to: 'Elsewhere', bindingId: 'b/moved'});
    assert.deepEqual(
      await renameGlobal({images, imageId: 'app', from: 'Moved', to: 'Elsewhere', bindingId: 'b/moved'}),
      moved,
    );
    assert.deepEqual(await resolveGlobal({images, imageId: 'app', name: 'Other'}), other, 'the bystander is untouched');
  });
});

test('a rejected publication leaves no orphan binding behind', async () => {
  await withRuntime(async (runtime) => {
    const {images} = runtime;
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({images, imageId: 'app', name: 'Taken', bindingId: 'b/taken', value: kernel.objectClass});

    // The conflict is decided before any record is minted, so the losing binding is never created.
    await assert.rejects(
      publishGlobal({images, imageId: 'app', name: 'Taken', bindingId: 'b/loser', value: kernel.integerClass}),
      /is already bound to smalltalk\/global-binding|is already bound to b\/taken/,
    );
    assert.equal(await images.getObject('app', 'b/loser'), null, 'no orphan GlobalBinding was created');
  });
});

test('a stored mapping in non-canonical order is corrupt, not silently normalised', async () => {
  await withRuntime(async (runtime) => {
    const {images} = runtime;
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({images, imageId: 'app', name: 'Alpha', bindingId: 'b/alpha', value: kernel.objectClass});
    await publishGlobal({images, imageId: 'app', name: 'Beta', bindingId: 'b/beta', value: kernel.integerClass});

    const record = await images.getObject('app', 'smalltalk-global-namespace/v1');
    const pairs = [];
    for (let index = 0; index < record.indexed.length; index += 2) pairs.push(record.indexed.slice(index, index + 2));
    const last = pairs.length - 1;
    [pairs[last - 1], pairs[last]] = [pairs[last], pairs[last - 1]];

    // Same content, an order the writer would never have produced.
    await images.putObject('app', {
      id: record.id,
      shape: record.shape,
      behavior: record.behavior,
      slots: record.slots,
      indexed: pairs.flat(),
      metadata: record.metadata,
    }, {expectedVersion: record._version});

    await assert.rejects(
      resolveGlobal({images, imageId: 'app', name: 'Alpha'}),
      /not in canonical order/,
      'reading must reject an order two writers could disagree about',
    );
  });
});

// --- portability -------------------------------------------------------------------------------------

test('the same source in two images yields one semantic program and image-local refs', async () => {
  await withRuntime(async (runtime) => {
    for (const imageId of ['first', 'second']) {
      const {kernel} = await seed(runtime, imageId);
      await publishGlobal({
        images: runtime.images, imageId, name: 'Shared',
        bindingId: globalBindingId('Shared'), value: kernel.integerClass,
      });
      await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId, id: 'shared', source: '[ Shared ]',
      });
    }

    const artifacts = await Promise.all(['first', 'second'].map(async (imageId) =>
      (await runtime.images.getCodeArtifact(imageId, 'shared:semantic')).content.value));
    assert.equal(artifacts[0], artifacts[1], 'the semantic program is image-independent');
    assert.ok(!/"kind":"ref"/.test(artifacts[0]), 'and carries no ref at all');

    // The image-local ref lives in the environment, not the artifact.
    for (const imageId of ['first', 'second']) {
      const block = await runtime.images.getBlock(imageId, 'shared');
      const environment = await runtime.images.getLexicalEnvironment(imageId, block.environment.objectId);
      assert.deepEqual(
        environment.bindings[globalBindingId('Shared')].value,
        objectRef(imageId, globalBindingId('Shared')),
        `${imageId} must bind its own binding object`,
      );
    }
  });
});

// The sharp one: the same spelling in another image is not the same identity, and installation must
// say so rather than substituting.
test('installing against a binding identity the target image lacks fails, naming it', async () => {
  await withRuntime(async (runtime) => {
    const {kernel: firstKernel} = await seed(runtime, 'first');
    const {kernel: secondKernel, options: secondOptions} = await seed(runtime, 'second');

    await publishGlobal({
      images: runtime.images, imageId: 'first', name: 'Ambiguous',
      bindingId: 'smalltalk/global-binding/identity-X', value: firstKernel.integerClass,
    });
    // Image B has the same *spelling*, mapped to a different identity, and lacks X entirely.
    await publishGlobal({
      images: runtime.images, imageId: 'second', name: 'Ambiguous',
      bindingId: 'smalltalk/global-binding/identity-Y', value: secondKernel.objectClass,
    });
    assert.equal(await runtime.images.getObject('second', 'smalltalk/global-binding/identity-X'), null);

    const compiledInFirst = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'first', id: 'ambiguous', source: '[ Ambiguous ]',
    });
    const program = compiledInFirst.semanticProgram;
    assert.ok(program.captures.some(({id}) => id === 'smalltalk/global-binding/identity-X'));

    // Installing that program as a method in image B must fail naming X, never bind Y.
    await assert.rejects(
      defineMethods({
        ...secondOptions,
        classRef: secondKernel.objectClass,
        methods: [{selector: 'ambiguous', program, captures: []}],
      }),
      /identity-X/,
      'a matching name is not evidence the identity is the same one',
    );
  });
});

// --- environments -------------------------------------------------------------------------------------

test('compiler-supplied environments hold exactly what the program uses', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Env',
      bindingId: globalBindingId('Env'), value: kernel.integerClass,
    });

    // Neither nil nor a global: today's path exactly, and no extra record.
    const plain = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'env-plain', source: '[ 1 ]',
    });
    assert.equal(plain.block.environment, null);

    // nil only: ADR 0056's identity is preserved, so reinstalling a pre-0057 Block still converges.
    const nilOnly = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'env-nil', source: '[ nil ]',
    });
    assert.equal(nilOnly.block.environment.objectId, 'env-nil:nil-environment');

    // A global: the broader identity, holding just that binding.
    const globalOnly = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'env-global', source: '[ Env ]',
    });
    assert.equal(globalOnly.block.environment.objectId, 'env-global:compiler-environment');
    const globalEnv = await runtime.images.getLexicalEnvironment('app', 'env-global:compiler-environment');
    assert.deepEqual(Object.keys(globalEnv.bindings), [globalBindingId('Env')]);

    // Both: ONE environment holding both, not two wrappers.
    const both = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'env-both', source: '[ (Env = nil) ]',
    });
    assert.equal(both.block.environment.objectId, 'env-both:compiler-environment');
    const bothEnv = await runtime.images.getLexicalEnvironment('app', 'env-both:compiler-environment');
    assert.deepEqual(
      Object.keys(bothEnv.bindings).sort(),
      [globalBindingId('Env'), 'smalltalk/intrinsic/nil'].sort(),
    );
    assert.equal(bothEnv.parent, null);
  });
});

test('a compiler-supplied environment parents a caller environment without mutating it', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Parented',
      bindingId: globalBindingId('Parented'), value: kernel.integerClass,
    });
    const caller = await runtime.images.putLexicalEnvironment('app', {
      id: 'parent-env', bindings: {'caller:x': {name: 'x', value: integerValue(5)}},
    });

    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'parented', source: '[ (Parented = nil) ifTrue: [ x ] ifFalse: [ x ] ]',
      captures: {x: 'caller:x'},
      environment: objectRef('app', 'parent-env'),
    });
    assert.deepEqual(
      await runtime.executor.execute(
        await runtime.invocations.invokeBlock(objectRef('app', installed.block.id), []),
      ),
      integerValue(5),
      'both the caller capture and the compiler-supplied bindings resolve',
    );

    const supplied = await runtime.images.getLexicalEnvironment('app', 'parented:compiler-environment');
    assert.deepEqual(supplied.parent, objectRef('app', 'parent-env'));
    assert.ok(!Object.hasOwn(supplied.bindings, 'caller:x'), 'it must not copy the caller bindings');

    const after = await runtime.images.getLexicalEnvironment('app', 'parent-env');
    assert.equal(after._version, caller._version, 'the caller environment is untouched');
  });
});

// --- what must not have changed -----------------------------------------------------------------------

test('the compiler knows no class name and no deterministic class id', async () => {
  const {readFileSync} = await import('node:fs');
  for (const path of [
    'src/language/symmetric-smalltalk-semantic.js',
    'src/language/symmetric-smalltalk-parser.js',
    'src/language/symmetric-smalltalk-tokenizer.js',
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    // Quoted, so ordinary JavaScript like `Array.isArray` is not a false positive: what must not
    // appear is a Smalltalk class *name* or a deterministic class id.
    for (const name of ['Array', 'Dictionary', 'IndexOutOfRange', 'EmptyCollection']) {
      assert.ok(!source.includes(`'${name}'`), `${path} must not name the class ${name}`);
    }
    assert.ok(!source.includes('smalltalk/class/'), `${path} must not know a deterministic class id`);
  }
  // And a global read is an ordinary send, with no new IR operation.
  const ir = readFileSync(new URL('../src/execution/neutral-expression-v0.js', import.meta.url), 'utf8');
  assert.ok(!/case 'global'/.test(ir), 'lagrange-code/v0 must gain no global op');
});

test('a global read lowers to an ordinary value send against the binding', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await publishGlobal({
      images: runtime.images, imageId: 'app', name: 'Shape',
      bindingId: globalBindingId('Shape'), value: kernel.integerClass,
    });
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'shape-check', source: '[ Shape ]',
    });
    assert.deepEqual(installed.semanticProgram.body, {
      op: 'send',
      languageId: 'symmetric-smalltalk',
      receiver: {op: 'binding', id: globalBindingId('Shape')},
      message: textValue('value'),
      arguments: [],
    });
  });
});

// --- publication recovery -------------------------------------------------------------------------------

const WRITE_METHODS = ['putCodeArtifact', 'putBlock', 'putShape', 'putObject', 'putLexicalEnvironment'];

function faultingImages(images, {failAt = null, commitThenThrow = false} = {}) {
  let writes = 0;
  const wrapped = Object.create(Object.getPrototypeOf(images));
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(images))) {
    if (typeof images[key] !== 'function' || key === 'constructor') continue;
    wrapped[key] = (...args) => images[key](...args);
  }
  for (const [key, value] of Object.entries(images)) {
    wrapped[key] = typeof value === 'function' ? (...args) => images[key](...args) : value;
  }
  for (const method of WRITE_METHODS) {
    wrapped[method] = async (imageId, input, options) => {
      writes += 1;
      const hit = writes === failAt;
      if (hit && !commitThenThrow) throw new Error(`injected failure at write ${writes} (${input?.id})`);
      const result = await images[method](imageId, input, options);
      if (hit && commitThenThrow) throw new Error(`injected post-commit failure at write ${writes} (${input?.id})`);
      return result;
    };
  }
  return {images: wrapped, writeCount: () => writes};
}

const servicesFor = (images) => new CompilationService({
  images,
  compilers: createDefaultCodeCompilerRegistry(),
  groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
});

async function namespaceBase(runtime, imageId) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  return {images: runtime.images, compilation: runtime.compilation, imageId};
}

// The sweep above covers installation. Rename, rebind and removal are the operations a *running*
// image performs, and each is one mapping write whose acknowledgement can be lost. What has to hold
// is that the identical retry converges rather than reporting a conflict against its own effect.
test('rename, rebind and removal converge after a lost acknowledgement', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    const bindingId = globalBindingId('Subject');
    await publishGlobal({images: runtime.images, imageId: 'app', name: 'Subject', bindingId, value: kernel.integerClass});

    // Fail after the mapping write commits: the effect landed, the caller never heard so.
    const lose = () => faultingImages(runtime.images, {failAt: 1, commitThenThrow: true}).images;

    await assert.rejects(
      renameGlobal({images: lose(), imageId: 'app', from: 'Subject', to: 'Renamed', bindingId}),
      /injected post-commit/,
    );
    assert.deepEqual(
      await renameGlobal({images: runtime.images, imageId: 'app', from: 'Subject', to: 'Renamed', bindingId}),
      objectRef('app', bindingId),
      'the retry sees its own committed rename and converges',
    );

    await assert.rejects(
      rebindGlobal({images: lose(), imageId: 'app', bindingId, value: kernel.objectClass}),
      /injected post-commit/,
    );
    // Rebinding to the value already stored writes nothing at all, so the retry is a plain no-op.
    await rebindGlobal({images: runtime.images, imageId: 'app', bindingId, value: kernel.objectClass});
    assert.deepEqual(
      await evaluate(runtime, 'app', 'lost-ack-read', '[ Renamed ]'),
      kernel.objectClass,
    );

    await assert.rejects(
      removeGlobal({images: lose(), imageId: 'app', name: 'Renamed'}),
      /injected post-commit/,
    );
    assert.equal(
      await removeGlobal({images: runtime.images, imageId: 'app', name: 'Renamed'}),
      false,
      'the name is already gone; the retry reports "nothing to do", not a failure',
    );
  });
});

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing the ${lane} global namespace`, async () => {
    const total = await withRuntime(async (runtime) => {
      const options = await namespaceBase(runtime, 'count');
      const {images, writeCount} = faultingImages(runtime.images);
      await installSmalltalkGlobalNamespace({...options, images, compilation: servicesFor(images), lane});
      return writeCount();
    });
    assert.ok(total > 10, `expected many writes across the class, its method and the mapping, saw ${total}`);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      for (const commitThenThrow of [false, true]) {
        await withRuntime(async (runtime) => {
          const options = await namespaceBase(runtime, 'app');
          const {images} = faultingImages(runtime.images, {failAt, commitThenThrow});

          await assert.rejects(
            installSmalltalkGlobalNamespace({...options, images, compilation: servicesFor(images), lane}),
            /injected/,
            `${lane} write ${failAt} (${commitThenThrow ? 'lost ack' : 'pre-commit'}) should have failed`,
          );

          // The retry converges, and the namespace is then exercised rather than inspected.
          await installSmalltalkGlobalNamespace({...options, lane});
          const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
          assert.deepEqual(
            await evaluate(runtime, 'app', `rec-${lane}-${failAt}-${commitThenThrow}`, '[ Integer ]'),
            kernel.integerClass,
          );
        });
      }
    }
  });
}
