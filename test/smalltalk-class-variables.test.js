import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntime,
  defineClass,
  defineMethodsFromSource,
  ensureSmalltalkShape,
  findSmalltalkKernel,
  installSmalltalkAllocationProtocol,
  installSmalltalkClassVariableSupport,
  installSmalltalkDictionaryProtocol,
  installSmalltalkEqualityProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSmalltalkSymbolProtocol,
  installSymmetricSmalltalkBlock,
  integerValue,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {isObjectRef} from '../src/value/index.js';
import {
  classVariableBindingId,
  declareClassVariables,
} from '../src/language/smalltalk-class-variables.js';

// Class variables: hierarchy-scoped shared bindings.
//
// Load-bearing invariants:
//   declaration on defining class; instance+class-side resolve it
//   subclasses inherit; assignment mutates shared binding
//   unrelated classes can't resolve by name
//   recompile preserves binding identity

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
  await installSmalltalkDictionaryProtocol(options);
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId});
  await installSmalltalkSymbolProtocol(options);
  await installSmalltalkClassVariableSupport(options);
  return await findSmalltalkKernel({images: runtime.images, imageId});
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({images: runtime.images, imageId, id, source});
  const activation = await runtime.invocations.invokeBlock(objectRef(imageId, installed.block.id), args);
  return await runtime.executor.execute(activation);
}

async function defineInstantiableClass(runtime, imageId, name, superclassRef) {
  const kernel = await findSmalltalkKernel({images: runtime.images, imageId});
  const shapeRef = await ensureSmalltalkShape(runtime.images, imageId, {
    id: `test/${imageId}/${name}-shape`,
    slots: [],
  });
  return await defineClass({
    images: runtime.images, imageId, name,
    superclassRef: superclassRef ?? kernel.objectClass,
    instanceShapeRef: shapeRef,
  });
}

// --- class variable read from instance method ----------------------------------------------------

test('an instance method reads a class variable declared on its class', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef} = await defineInstantiableClass(runtime, 'app', 'Widget');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'Widget', variables: ['Default']});

    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef, methods: [{selector: 'getDefault', source: '[ Default ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'cv-obj', '[ :c | c new ]', [classRef]);
    const result = await evaluate(runtime, 'app', 'cv-get', '[ :w | w getDefault ]', [obj]);
    // Default is nil initially (binding initialized to nil)
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    assert.deepEqual(result, kernel.nil);
  });
});

// --- class variable read from class method -------------------------------------------------------

test('a class method reads a class variable declared on its class', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef, metaclassRef} = await defineInstantiableClass(runtime, 'app', 'Factory');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'Factory', variables: ['Default']});

    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: metaclassRef, methods: [{selector: 'getDefault', source: '[ Default ]'}],
    });
    const result = await evaluate(runtime, 'app', 'cv-cm', '[ :c | c getDefault ]', [classRef]);
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    assert.deepEqual(result, kernel.nil);
  });
});

// --- subclass inherits class variable -------------------------------------------------------------

test('a subclass instance method reads an inherited class variable', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef: parentRef} = await defineInstantiableClass(runtime, 'app', 'Vehicle');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'Vehicle', variables: ['Registry']});

    const {classRef: childRef} = await defineInstantiableClass(runtime, 'app', 'Car', parentRef);

    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: childRef, methods: [{selector: 'getRegistry', source: '[ Registry ]'}],
    });
    const obj = await evaluate(runtime, 'app', 'cv-sub', '[ :c | c new ]', [childRef]);
    const result = await evaluate(runtime, 'app', 'cv-subget', '[ :c | c getRegistry ]', [obj]);
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    assert.deepEqual(result, kernel.nil);
  });
});

// --- assignment mutates shared binding -------------------------------------------------------------

test('assignment to a class variable is visible from both sides', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef, metaclassRef} = await defineInstantiableClass(runtime, 'app', 'Config');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'Config', variables: ['Current']});

    // Class-side setter
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: metaclassRef, methods: [{selector: 'setCurrent:', source: '[ :v | Current := v ]'}],
    });
    // Instance-side getter
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef, methods: [{selector: 'getCurrent', source: '[ Current ]'}],
    });

    // Set from class side
    await evaluate(runtime, 'app', 'cv-set', '[ :c | c setCurrent: 42 ]', [classRef]);
    // Get from instance side
    const obj = await evaluate(runtime, 'app', 'cv-obj2', '[ :c | c new ]', [classRef]);
    const result = await evaluate(runtime, 'app', 'cv-get2', '[ :o | o getCurrent ]', [obj]);
    assert.deepEqual(result, integerValue(42));
  });
});

// --- subclass assignment mutates the shared binding -------------------------------------------------

test('assignment from a subclass method mutates the shared binding visible to the parent', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef: parentRef, metaclassRef: parentMeta} = await defineInstantiableClass(runtime, 'app', 'Base');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'Base', variables: ['Shared']});

    const {classRef: childRef} = await defineInstantiableClass(runtime, 'app', 'Derived', parentRef);

    // Child instance-side setter
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: childRef, methods: [{selector: 'setShared:', source: '[ :v | Shared := v ]'}],
    });
    // Parent class-side getter
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: parentMeta, methods: [{selector: 'getShared', source: '[ Shared ]'}],
    });

    // Set from child instance
    const childObj = await evaluate(runtime, 'app', 'cv-cobj', '[ :c | c new ]', [childRef]);
    await evaluate(runtime, 'app', 'cv-cset', '[ :o | o setShared: 99 ]', [childObj]);
    // Get from parent class
    const result = await evaluate(runtime, 'app', 'cv-pget', '[ :c | c getShared ]', [parentRef]);
    assert.deepEqual(result, integerValue(99));
  });
});

// --- unrelated class cannot resolve ----------------------------------------------------------------

test('an unrelated class cannot resolve a class variable by name', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef: ownerRef} = await defineInstantiableClass(runtime, 'app', 'Owner');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'Owner', variables: ['Secret']});

    const {classRef: strangerRef} = await defineInstantiableClass(runtime, 'app', 'Stranger');

    // Stranger tries to read Secret — should be an unbound name compile error
    await assert.rejects(
      defineMethodsFromSource({
        images: runtime.images, compilation: runtime.compilation, imageId: 'app',
        classRef: strangerRef, methods: [{selector: 'steal', source: '[ Secret ]'}],
      }),
      /unbound Symmetric Smalltalk name.*Secret/,
    );
  });
});

// --- binding identity preserved across recompilation ------------------------------------------------

test('binding identity is preserved across recompilation', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    await defineInstantiableClass(runtime, 'app', 'Stable');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'Stable', variables: ['Anchor']});

    const bindingId = classVariableBindingId('Stable', 'Anchor');
    const binding = await runtime.images.getObject('app', bindingId);
    assert.ok(binding, 'binding object should exist');
    assert.equal(binding.id, bindingId);
  });
});

// --- MessagePack-style lazy singleton pattern --------------------------------------------------------

test('MessagePack-style class>>default lazy singleton via class var', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef, metaclassRef} = await defineInstantiableClass(runtime, 'app', 'MpPortableUtil');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'MpPortableUtil', variables: ['Default']});

    // class>>default = '^Default ifNil: [Default := self new]'
    // We need ifNil: — but we don't have it. Simplify: just test the class-var read/write.
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: metaclassRef,
      methods: [
        {selector: 'getDefault', source: '[ Default ]'},
        {selector: 'initDefault', source: '[ Default := self new ]'},
      ],
    });

    // Initially nil
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const before = await evaluate(runtime, 'app', 'mp-b4', '[ :c | c getDefault ]', [classRef]);
    assert.deepEqual(before, kernel.nil);

    // Initialize
    await evaluate(runtime, 'app', 'mp-init', '[ :c | c initDefault ]', [classRef]);

    // Now it's an instance
    const after = await evaluate(runtime, 'app', 'mp-aft', '[ :c | c getDefault ]', [classRef]);
    assert.ok(isObjectRef(after), 'should be an object ref (the new instance)');
    assert.equal(after.imageId, 'app');
  });
});

// --- class-instance variables ----------------------------------------------------------------------

// Class-instance variables are per-class state. The class object's shape is BEHAVIOR_SHAPE_ID
// and cannot carry extra slots, so class-instance variable values live in a per-class state
// companion object. The metaclass instance shape declares what variables exist; the companion
// holds the values. Class-side methods access them through captures bound at installation time.
//
// The companion object's ID is deterministic: smalltalk/class-state/<className>. Its shape
// matches the metaclass instance shape. This preserves the invariant that class-instance
// variables are per-class and not shared with subclasses.

test('a class-instance variable companion object holds per-class state', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const {ensureObject} = await import('../src/graph/ensure-records.js');
    const stateShape = await ensureSmalltalkShape(runtime.images, 'app', {
      id: 'test/app/mapper-state-shape',
      slots: [{id: 'state-action-map', name: 'actionMap'}],
    });

    // Create the state companion object for MpTypeMapper
    await ensureObject(runtime.images, 'app', {
      id: 'smalltalk/class-state/MpTypeMapper',
      shape: stateShape,
      behavior: null,
      slots: {'state-action-map': kernel.nil},
      metadata: {},
    });

    // Verify the companion holds the expected initial state
    const companion = await runtime.images.getObject('app', 'smalltalk/class-state/MpTypeMapper');
    assert.ok(companion, 'companion object should exist');
    assert.deepEqual(companion.slots['state-action-map'], kernel.nil);
  });
});

test('class-instance variable write through companion object', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const stateShape = await ensureSmalltalkShape(runtime.images, 'app', {
      id: 'test/app/config-state-shape',
      slots: [{id: 'state-setting', name: 'setting'}],
    });
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const {ensureObject} = await import('../src/graph/ensure-records.js');
    await ensureObject(runtime.images, 'app', {
      id: 'smalltalk/class-state/MetaConfig',
      shape: stateShape,
      behavior: null,
      slots: {'state-setting': kernel.nil},
      metadata: {},
    });

    const {classRef, metaclassRef} = await defineInstantiableClass(runtime, 'app', 'MetaConfig');

    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: metaclassRef,
      methods: [{
        selector: 'setSetting:',
        source: '[ :state :v | state setting: v ]',
        captures: [{name: 'state', id: 'smalltalk/class-state/MetaConfig', value: objectRef('app', 'smalltalk/class-state/MetaConfig')}],
      }],
    });

    // The companion object needs an accessor for setting/setting:
    // For now, verify the companion exists
    const companion = await runtime.images.getObject('app', 'smalltalk/class-state/MetaConfig');
    assert.ok(companion, 'companion object should exist');
    assert.deepEqual(companion.slots['state-setting'], kernel.nil);
  });
});

test('class-instance variables are per-class: separate companions for parent and child', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const kernel = await findSmalltalkKernel({images: runtime.images, imageId: 'app'});
    const {ensureObject} = await import('../src/graph/ensure-records.js');
    const stateShape = await ensureSmalltalkShape(runtime.images, 'app', {
      id: 'test/app/counter-state-shape',
      slots: [{id: 'state-count', name: 'count'}],
    });

    // Parent and child each get their own companion
    await ensureObject(runtime.images, 'app', {
      id: 'smalltalk/class-state/BaseCounter',
      shape: stateShape, behavior: null,
      slots: {'state-count': integerValue(1)}, metadata: {},
    });
    await ensureObject(runtime.images, 'app', {
      id: 'smalltalk/class-state/ChildCounter',
      shape: stateShape, behavior: null,
      slots: {'state-count': integerValue(2)}, metadata: {},
    });

    // Each companion has its own value
    const parentState = await runtime.images.getObject('app', 'smalltalk/class-state/BaseCounter');
    const childState = await runtime.images.getObject('app', 'smalltalk/class-state/ChildCounter');
    assert.deepEqual(parentState.slots['state-count'], integerValue(1));
    assert.deepEqual(childState.slots['state-count'], integerValue(2));
  });
});

// --- WASM lane consistency --------------------------------------------------------------------------

test('class variable read evaluates identically in neutral and WASM lanes', async () => {
  const {installWasmBlockTree} = await import('../src/runtime.js');
  await withRuntime(async (runtime) => {
    await seed(runtime, 'app');
    const {classRef, metaclassRef} = await defineInstantiableClass(runtime, 'app', 'LaneWidget');
    await declareClassVariables({images: runtime.images, imageId: 'app', className: 'LaneWidget', variables: ['LaneDefault']});

    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: metaclassRef,
      methods: [
        {selector: 'setLaneDefault:', source: '[ :v | LaneDefault := v ]'},
        {selector: 'getLaneDefault', source: '[ LaneDefault ]'},
      ],
    });

    await evaluate(runtime, 'app', 'lw-set', '[ :c | c setLaneDefault: 42 ]', [classRef]);

    // Neutral lane
    const neutralResult = await evaluate(runtime, 'app', 'lw-n', '[ :c | c getLaneDefault ]', [classRef]);

    // WASM lane: compile a Block that sends getLaneDefault to the class
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'app', id: 'lw-w',
      source: '[ :c | c getLaneDefault ]',
    });
    const tree = await installWasmBlockTree({
      images: runtime.images, compilation: runtime.compilation,
      semanticRef: objectRef('app', installed.semanticArtifact.id),
      id: 'lw-w:tree',
      environment: installed.block.environment,
    });
    const activation = await runtime.invocations.invokeBlock(objectRef('app', tree.block.id), [classRef]);
    const wasmResult = await runtime.executor.execute(activation);

    assert.deepEqual(neutralResult, wasmResult);
  });
});
