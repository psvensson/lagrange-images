import {objectRef, textValue} from '../value/index.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {ensureNamedClass, ensureSmalltalkShape} from './smalltalk-class-builder.js';
import {ensureObject} from '../graph/ensure-records.js';
import {isObjectRef} from '../value/index.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// Class variables for Symmetric Smalltalk: hierarchy-scoped shared bindings.
//
// A ClassVariableBinding is an ordinary object with one slot (value), analogous to
// GlobalBinding but scoped to a class hierarchy. Unlike GlobalBinding, it has both
// `value` and `value:` methods — class variables are mutable shared state.
//
// The deterministic ID is `smalltalk/class-variable/<className>/<varName>`, so the same
// class + same variable name always yields the same binding identity. Subclasses inherit
// the binding by resolving through the superclass chain at compile time.
//
// The compiler resolves a class-var name to the binding's stable identity and lowers:
//   read:  $classVar:<bindingId> value
//   write: $classVar:<bindingId> value: newValue
// Both are ordinary sends, exactly like globals (ADR 0057). No new lagrange-code op.

const CLASS_VARIABLE_BINDING_SHAPE_ID = 'smalltalk/class-variable-binding-shape/v1';
const CLASS_VARIABLE_BINDING_CLASS_NAME = 'ClassVariableBinding';
const CLASS_VARIABLE_VALUE_SLOT = 'class-variable-value';

const classVariableBindingId = (className, varName) =>
  `smalltalk/class-variable/${className}/${varName}`;

async function installSmalltalkClassVariableSupport({images, compilation, imageId, lane = 'neutral'} = {}) {
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  const bindingShapeRef = await ensureSmalltalkShape(images, imageId, {
    id: CLASS_VARIABLE_BINDING_SHAPE_ID,
    slots: [{id: CLASS_VARIABLE_VALUE_SLOT, name: 'value'}],
  });
  const {classRef} = await ensureNamedClass({
    images, imageId, name: CLASS_VARIABLE_BINDING_CLASS_NAME,
    instanceShapeRef: bindingShapeRef,
  });
  // `value` reads the slot; `value:` writes it. Both are ordinary Smalltalk using the
  // instance variable protocol — no new primitive.
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef,
    methods: [
      {selector: 'value', source: '[ value ]'},
      {selector: 'value:', source: '[ :newValue | value := newValue ]'},
    ],
  });
  return Object.freeze({bindingClass: classRef});
}

// Declare class variables on a class. Creates the binding objects and returns a
// name -> binding-id map for the compiler. Stores the declared variable names in the
// class record's metadata so the hierarchy walk can find them.
//
// Each binding is ensure-exact-or-create at its deterministic ID, so re-running
// converges. The initial value is nil unless specified.
async function declareClassVariables({images, imageId, className, variables = []} = {}) {
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const declarations = {};
  for (const varName of variables) {
    const bindingId = classVariableBindingId(className, varName);
    await ensureObject(images, imageId, {
      id: bindingId,
      shape: objectRef(imageId, CLASS_VARIABLE_BINDING_SHAPE_ID),
      behavior: objectRef(imageId, `smalltalk/class/${CLASS_VARIABLE_BINDING_CLASS_NAME}`),
      slots: {[CLASS_VARIABLE_VALUE_SLOT]: kernel.nil},
      metadata: {},
    });
    declarations[varName] = bindingId;
  }

  // Store the declared variable names in the class record's metadata so the
  // hierarchy walk can find them without scanning.
  const classObjectId = `smalltalk/class/${className}`;
  const classRecord = await images.getObject(imageId, classObjectId);
  if (classRecord) {
    const existingVars = classRecord.metadata?.classVariables ?? [];
    const mergedVars = [...new Set([...existingVars, ...variables])];
    if (mergedVars.length > 0) {
      await images.putObject(imageId, {
        id: classObjectId,
        shape: classRecord.shape,
        behavior: classRecord.behavior,
        slots: classRecord.slots,
        metadata: {...classRecord.metadata, classVariables: mergedVars},
      }, {expectedVersion: classRecord._version});
    }
  }
  return Object.freeze(declarations);
}

// Walk the superclass chain to collect all class variable declarations visible from
// a class. Returns a merged name -> binding-id map. Inner (subclass) declarations
// shadow outer (superclass) declarations of the same name.
//
// This is the class-scoped analog of `globalDeclarations`: read asynchronously before
// compilation, handed to the synchronous compiler as a flat name -> binding-id map.
async function classVariableDeclarations({images, imageId, classRef} = {}) {
  if (!isObjectRef(classRef)) return Object.freeze({});
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) return Object.freeze({});

  // When called with a metaclass ref, start from the corresponding class instead.
  // A metaclass's metadata has `name` like "Foo class"; the class record has "Foo".
  // Class variables are declared on classes, not metaclasses, so the hierarchy walk
  // must start from the class side.
  let startRef = classRef;
  const startRecord = await images.getObject(classRef.imageId, classRef.objectId);
  if (startRecord?.metadata?.name?.endsWith(' class')) {
    // This is a metaclass: find the class it is the metaclass of. The class record's
    // behavior edge points back to this metaclass.
    const classObjectId = classRef.objectId.replace('smalltalk/metaclass/', 'smalltalk/class/');
    const classRecord = await images.getObject(imageId, classObjectId);
    if (classRecord) startRef = objectRef(imageId, classObjectId);
  }

  const merged = new Map();
  let currentRef = startRef;
  const visited = new Set();

  while (isObjectRef(currentRef) && currentRef.objectId !== kernel.nil.objectId) {
    const key = `${currentRef.imageId}/${currentRef.objectId}`;
    if (visited.has(key)) break;
    visited.add(key);

    const record = await images.getObject(currentRef.imageId, currentRef.objectId);
    if (!record) break;

    // Read declared class variable names from this class's metadata.
    const className = record.metadata?.name;
    const declaredVars = record.metadata?.classVariables;
    if (className && Array.isArray(declaredVars)) {
      for (const varName of declaredVars) {
        if (!merged.has(varName)) {
          merged.set(varName, classVariableBindingId(className, varName));
        }
      }
    }

    // Walk to superclass
    const superclassSlot = record.slots?.['behavior-superclass'];
    if (!isObjectRef(superclassSlot)) break;
    currentRef = superclassSlot;
  }
  return Object.fromEntries(merged);
}

export {
  CLASS_VARIABLE_BINDING_CLASS_NAME,
  CLASS_VARIABLE_BINDING_SHAPE_ID,
  CLASS_VARIABLE_VALUE_SLOT,
  classVariableBindingId,
  classVariableDeclarations,
  declareClassVariables,
  installSmalltalkClassVariableSupport,
};
