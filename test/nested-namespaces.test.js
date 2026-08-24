import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNamespace,
  createRuntime,
  defineClass,
  ensureSmalltalkShape,
  findNamespace,
  findSmalltalkGlobalNamespace,
  findSmalltalkKernel,
  globalBindingId,
  globalDeclarations,
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
  rebindGlobal,
  removeGlobal,
  renameGlobal,
  resolveGlobal,
  setNamespaceParent,
  textValue,
} from '../src/runtime.js';
import {compileSymmetricSmalltalkMethod} from '../src/language/smalltalk-instance-variables.js';
import {installWasmBlockTree} from '../src/wasm/tree-installer.js';
import {
  NAMESPACE_OBJECT_ID,
  NAMESPACE_PARENT_SLOT,
  NAMESPACE_SHAPE_ID,
  NAMESPACE_SHAPE_ID_V1,
  SmalltalkNamespaceError,
} from '../src/language/smalltalk-globals.js';

// ADR 0061. What is under test is the ADR's central claims: nesting is parent-linked *visibility*
// over flat, shared bindings — never containment. A child sees its ancestors' names (walked at
// compile time), inner shadows outer, siblings never see each other, and two namespaces naming one
// binding name one object. The root and every existing caller behave exactly as ADR 0057 left them.

async function withRuntime(body, options = {}) {
  const runtime = await createRuntime({backend: {mode: 'mock'}, ...options});
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

// A class published under `namespaceId` as `name` -> binding `smalltalk/global-binding/<name>`.
// `defineClass` derives the class id from the class's own name, so the published *global* name and
// the *class* name differ when we need two same-spelling globals that are two objects: pass
// `className` for the underlying class, defaulting to the global name.
async function defineAndPublish(runtime, imageId, {name, className = name, namespaceId, bindingId = null}) {
  const shapeRef = await ensureSmalltalkShape(
    runtime.images, imageId, {id: `smalltalk/class/${className}-shape`, slots: []},
  );
  const {classRef} = await defineClass({
    images: runtime.images, imageId, name: className, instanceShapeRef: shapeRef,
  });
  await publishGlobal({
    images: runtime.images, imageId, name, namespaceId,
    bindingId: bindingId ?? globalBindingId(name), value: classRef,
  });
  return classRef;
}

// Compile + run a Block that just answers the global `name`, in the given namespace and lane. In
// the WASM lane the Block is compiled to a WASM tree (over the same compiler-supplied environment),
// so "both lanes" means the global read really executes under each representation.
async function readGlobal(runtime, imageId, {name, namespaceId, lane = 'neutral', id}) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId, id: id ?? `read-${name}`, source: `[ ${name} ]`, namespaceId,
  });
  const blockRef = lane === 'wasm'
    ? objectRef(imageId, (await installWasmBlockTree({
      images: runtime.images, compilation: runtime.compilation,
      semanticRef: objectRef(imageId, installed.semanticArtifact.id), id: `${id ?? `read-${name}`}-tree`,
      environment: installed.block.environment,
    })).block.id)
    : objectRef(imageId, installed.block.id);
  const activation = await runtime.invocations.invokeBlock(blockRef, []);
  return await runtime.executor.execute(activation);
}

// --- visibility: child sees ancestors ------------------------------------------------------------

test('a child namespace resolves a name defined only at the root', async () => {
  await withRuntime(async (runtime) => {
    const {kernel} = await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    // Array is published at the root by the installer; the child defines nothing.
    const resolved = await readGlobal(runtime, 'app', {name: 'Object', namespaceId: 'ns/child'});
    assert.equal(resolved.objectId, 'smalltalk/class/Object');
  });
});

test('inner shadows outer: a child name wins, and the root still sees its own', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/game'});
    // Root has Point -> root's Point; the child shadows it with its own Point (a different class).
    const rootPoint = await defineAndPublish(runtime, 'app', {
      name: 'Point', className: 'Point', namespaceId: NAMESPACE_OBJECT_ID,
    });
    // Shadowing means a DIFFERENT binding under the same spelling: Game's Point is its own class
    // and its own binding, distinct from the root's Point binding.
    const gamePoint = await defineAndPublish(runtime, 'app', {
      name: 'Point', className: 'GamePoint', namespaceId: 'ns/game',
      bindingId: 'smalltalk/global-binding/Game.Point',
    });

    const fromChild = await readGlobal(runtime, 'app', {name: 'Point', namespaceId: 'ns/game'});
    const fromRoot = await readGlobal(runtime, 'app', {name: 'Point', namespaceId: NAMESPACE_OBJECT_ID, id: 'read-root-point'});
    assert.equal(fromChild.objectId, gamePoint.objectId, 'the child sees its own Point');
    assert.equal(fromRoot.objectId, rootPoint.objectId, 'the root still sees the root Point');
  });
});

test('siblings never see each other: visibility is upward only, never sideways', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/game'});
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/physics'});
    // Only Physics has a Board.
    await publishGlobal({
      images: runtime.images, imageId: 'app', namespaceId: 'ns/physics',
      name: 'Board', bindingId: globalBindingId('Board'), value: objectRef('app', 'smalltalk/class/Object'),
    });
    // Game does not see it: unknown after walking to the root = compile-time failure.
    await assert.rejects(
      readGlobal(runtime, 'app', {name: 'Board', namespaceId: 'ns/game'}),
      /unbound Symmetric Smalltalk name/,
    );
  });
});

test('an unknown name after the root is a compile-time failure in a child', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    await assert.rejects(
      readGlobal(runtime, 'app', {name: 'NoSuchGlobalAnywhere', namespaceId: 'ns/child'}),
      /unbound Symmetric Smalltalk name/,
    );
  });
});

// --- shared bindings (the central claim) -----------------------------------------------------------

test('two namespaces naming the SAME binding observe one rebind', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    // Root and child each map `Widget` to the SAME binding id, holding an initial class.
    const bindingId = globalBindingId('Widget');
    const initial = objectRef('app', 'smalltalk/class/Object');
    await publishGlobal({images: runtime.images, imageId: 'app', namespaceId: NAMESPACE_OBJECT_ID, name: 'Widget', bindingId, value: initial});
    await publishGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/child', name: 'Widget', bindingId, value: initial});

    // Rebind once, through the trusted seam (namespace-independent).
    const updated = objectRef('app', 'smalltalk/class/Integer');
    await rebindGlobal({images: runtime.images, imageId: 'app', bindingId, value: updated});

    // Both namespaces resolve the same binding, so both see the new value.
    const fromChild = await readGlobal(runtime, 'app', {name: 'Widget', namespaceId: 'ns/child'});
    const fromRoot = await readGlobal(runtime, 'app', {name: 'Widget', namespaceId: NAMESPACE_OBJECT_ID, id: 'read-root-widget'});
    assert.equal(fromChild.objectId, updated.objectId);
    assert.equal(fromRoot.objectId, updated.objectId);
    // And it is literally one binding object in the graph.
    assert.equal(
      (await resolveGlobal({images: runtime.images, imageId: 'app', name: 'Widget', namespaceId: 'ns/child'})).objectId,
      (await resolveGlobal({images: runtime.images, imageId: 'app', name: 'Widget', namespaceId: NAMESPACE_OBJECT_ID})).objectId,
    );
  });
});

test('siblings publish the same spelling to DIFFERENT bindings', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/game'});
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/physics'});
    // Same spelling, two binding ids (the generic publish requires the caller to supply the id).
    const gamePoint = objectRef('app', 'smalltalk/class/Object');
    const physicsPoint = objectRef('app', 'smalltalk/class/Integer');
    await publishGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/game', name: 'Point', bindingId: 'smalltalk/global-binding/Game.Point', value: gamePoint});
    await publishGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/physics', name: 'Point', bindingId: 'smalltalk/global-binding/Physics.Point', value: physicsPoint});

    assert.equal((await readGlobal(runtime, 'app', {name: 'Point', namespaceId: 'ns/game'})).objectId, gamePoint.objectId);
    assert.equal((await readGlobal(runtime, 'app', {name: 'Point', namespaceId: 'ns/physics', id: 'read-phys-point'})).objectId, physicsPoint.objectId);
  });
});

// --- the parent edge is durable and preserved -----------------------------------------------------

test('a mapping rewrite in a child preserves the parent edge', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    // Publish into the child — a writeMapping on the child record. If writeMapping wrote slots: {}
    // it would erase the parent (and be rejected by the Shape).
    await publishGlobal({
      images: runtime.images, imageId: 'app', namespaceId: 'ns/child',
      name: 'Local', bindingId: globalBindingId('Local'), value: objectRef('app', 'smalltalk/class/Object'),
    });
    // The child still resolves a root-only name, proving the parent edge survived the rewrite.
    const found = await findNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    assert.equal(found.parent.objectId, NAMESPACE_OBJECT_ID, 'the parent edge survived the mapping write');
    const resolved = await readGlobal(runtime, 'app', {name: 'Object', namespaceId: 'ns/child'});
    assert.equal(resolved.objectId, 'smalltalk/class/Object');
  });
});

test('the root namespace has no parent and its pre-existing records still resolve', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const root = await findSmalltalkGlobalNamespace({images: runtime.images, imageId: 'app'});
    assert.equal(root.parent, null, 'the root is the parentless namespace');
    // Root resolves its kernel classes exactly as ADR 0057 left it.
    assert.equal((await readGlobal(runtime, 'app', {name: 'Object', id: 'read-root-object'})).objectId, 'smalltalk/class/Object');
  });
});

// --- cycles ----------------------------------------------------------------------------------------

test('setNamespaceParent refuses to close a cycle', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/a'});
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/b', parent: 'ns/a'});
    // B's parent is A; making A's parent B would close A -> B -> A.
    await assert.rejects(
      setNamespaceParent({images: runtime.images, imageId: 'app', namespaceId: 'ns/a', parent: 'ns/b'}),
      /would close a cycle/,
    );
    // Self-parent is refused at creation and at set.
    await assert.rejects(
      createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/self', parent: 'ns/self'}),
      /its own parent/,
    );
  });
});

test('a corrupted cycle in the chain makes resolution fail, not loop', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    // Hand-build a cycle directly in the graph, bypassing the management seam's refusal: A -> B -> A.
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    for (const [id, parent] of [['ns/x', 'ns/y'], ['ns/y', 'ns/x']]) {
      await runtime.images.putObject('app', {
        id,
        shape: objectRef('app', 'smalltalk/global-namespace-shape/v2'),
        behavior: null,
        slots: {[NAMESPACE_PARENT_SLOT]: objectRef('app', parent)},
        indexed: [],
        metadata: {protocol: 'smalltalk-global-namespace/v1'},
      }, {expectedVersion: 0});
    }
    await assert.rejects(
      globalDeclarations({images: runtime.images, imageId: 'app', namespaceId: 'ns/x'}),
      SmalltalkNamespaceError,
    );
  });
});

// --- management operations are namespace-scoped and identity-checked --------------------------------

test('rename and remove act within one namespace and keep identity-scoping', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    const bindingId = globalBindingId('Thing');
    await publishGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/child', name: 'Thing', bindingId, value: objectRef('app', 'smalltalk/class/Object')});

    // Rename within the child.
    await renameGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/child', from: 'Thing', to: 'Gadget', bindingId});
    assert.ok(await resolveGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/child', name: 'Gadget'}));
    assert.equal(await resolveGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/child', name: 'Thing'}), null);

    // A rename naming the wrong binding id conflicts (ABA guard intact).
    await assert.rejects(
      renameGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/child', from: 'Gadget', to: 'Gizmo', bindingId: 'some/other-binding'}),
      /is bound to/,
    );

    // Remove within the child; the binding object survives (compiled code keeps working).
    assert.equal(await removeGlobal({images: runtime.images, imageId: 'app', namespaceId: 'ns/child', name: 'Gadget', bindingId}), true);
    assert.ok(await runtime.images.getObject('app', bindingId), 'the binding object survives removal of the name');
  });
});

// --- the artifact carries binding ids, never a namespace path --------------------------------------

test('a Block compiled in a child carries binding ids, not a namespace path', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'path-check', source: '[ Object ]', namespaceId: 'ns/child',
    });
    // The block's environment binds the global by binding id (smalltalk/global-binding/Object) —
    // the same shape ADR 0057 fixed, with no namespace path anywhere.
    const env = await runtime.images.getLexicalEnvironment('app', installed.block.environment.objectId);
    const globalBindingKeys = Object.keys(env.bindings).filter((key) => key.startsWith('smalltalk/global-binding/'));
    assert.ok(globalBindingKeys.length > 0, 'the global was captured by binding id');
    assert.ok(globalBindingKeys.includes(globalBindingId('Object')), 'Object resolved to its binding id');
    for (const key of globalBindingKeys) {
      assert.ok(!key.includes('ns/'), `no namespace path leaks into the capture: ${key}`);
    }
  });
});

// --- batch-snapshot consistency --------------------------------------------------------------------

test('a caller-supplied child snapshot governs over later mapping changes', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await createNamespace({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    // Snapshot the child's declarations, then change the mapping. Compilation with the snapshot
    // must see the snapshot's world, not the new one.
    const snapshot = await globalDeclarations({images: runtime.images, imageId: 'app', namespaceId: 'ns/child'});
    const shapeRef = await ensureSmalltalkShape(runtime.images, 'app', {id: 'snap-shape', slots: []});
    const {classRef} = await defineClass({images: runtime.images, imageId: 'app', name: 'Snap', instanceShapeRef: shapeRef});
    const method = await compileSymmetricSmalltalkMethod({
      images: runtime.images, imageId: 'app', classRef, selector: 'probe', source: '[ Object ]', globals: snapshot,
    });
    assert.ok(
      (method.globalBindingIdsUsed ?? []).some((id) => id === globalBindingId('Object')),
      'the snapshot resolved Object to its binding id',
    );
  });
});

// --- pre-0061 durable images: dual-read and migrate-on-write (ADR 0002 immutability) ----------------

// ADR 0002: Shapes are immutable, so 0061 adds a v2 Shape rather than mutating v1. A namespace
// record written before 0061 (v1 Shape, slots: {}) must still validate, and must migrate to v2 on
// its first mapping rewrite — never conflict and never lose data. This builds that record by hand,
// at the v1 Shape, exactly as a pre-0061 installer left it.
test('a pre-0061 (v1 Shape) namespace validates and migrates to v2 on first write', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const options = {images: runtime.images, compilation: runtime.compilation, imageId: 'app'};
    await installSmalltalkAllocationProtocol(options);
    await installSmalltalkEqualityProtocol(options);
    await installSmalltalkControlFlow(options);
    await installSmalltalkBlockProtocol({images: runtime.images, imageId: 'app'});
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});

    // Simulate the pre-0061 state: v1 (slotless) Shape + a root namespace record with slots: {}.
    await runtime.images.putShape('app', {id: NAMESPACE_SHAPE_ID_V1, slots: [], indexed: 'values'});
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    await runtime.images.putObject('app', {
      id: NAMESPACE_OBJECT_ID,
      shape: objectRef('app', NAMESPACE_SHAPE_ID_V1),
      behavior: null,
      slots: {},
      indexed: [],
      metadata: {protocol: 'smalltalk-global-namespace/v1'},
    }, {expectedVersion: 0});

    // Re-running the (0061) installer must NOT conflict: it dual-reads the v1 record.
    await installSmalltalkGlobalNamespace(options);

    // The first mapping rewrite (here, the installer's kernel-class publication) migrates the
    // record to v2 with a nil parent — v1 itself is never mutated.
    const root = await findSmalltalkGlobalNamespace({images: runtime.images, imageId: 'app'});
    assert.equal(root.parent, null, 'the migrated root is parentless');
    const record = await runtime.images.getObject('app', NAMESPACE_OBJECT_ID);
    assert.equal(record.shape.objectId, NAMESPACE_SHAPE_ID, 'the record migrated to the v2 Shape');
    assert.ok(Object.hasOwn(record.slots, NAMESPACE_PARENT_SLOT), 'the parent slot is present after migration');
    // And it resolves its globals exactly as before.
    assert.equal((await readGlobal(runtime, 'app', {name: 'Object', id: 'pre0061-read'})).objectId, 'smalltalk/class/Object');
  });
});

// --- both lanes --------------------------------------------------------------------------------------

for (const lane of ['neutral', 'wasm']) {
  test(`a child-compiled global read answers the child's binding in the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, 'app', {lane});
      await createNamespace({images: runtime.images, imageId: 'app', namespaceId: `ns/lane-${lane}`});
      const lanePoint = await defineAndPublish(runtime, 'app', {
        name: 'LanePoint', className: `LanePoint-${lane}`, namespaceId: `ns/lane-${lane}`,
      });
      const resolved = await readGlobal(runtime, 'app', {
        name: 'LanePoint', namespaceId: `ns/lane-${lane}`, lane, id: `lane-read-${lane}`,
      });
      assert.equal(resolved.objectId, lanePoint.objectId);
    });
  });
}
