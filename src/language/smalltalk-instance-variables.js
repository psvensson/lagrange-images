import {objectRef, textValue} from '../value/index.js';
import {
  defineMethods,
  ensureBlock,
  ensureCodeArtifact,
} from './smalltalk-class-builder.js';
import {findSmalltalkKernel, readBehavior} from './smalltalk-kernel.js';
import {sameRef} from './smalltalk-lookup.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {
  INSTANCE_SLOT_READ_CAPTURE,
  INSTANCE_SLOT_WRITE_CAPTURE,
  compileSymmetricSmalltalkSemanticBlock,
} from './symmetric-smalltalk-semantic.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0050: the class-scoped compilation entry point, and the primitive Blocks it binds against.
//
// This is a *sibling* of `compileSymmetricSmalltalkSemanticBlock`, not a stage above it. That
// compiler already resolves names and already rejects an unbound root name at that moment, so there
// is no later point where an unresolved name survives for someone else to bind. The class arrives as
// an argument, exactly as `captures` already does, and the Block compiler is untouched.
const PRIMITIVE_BLOCK_ID = Object.freeze({
  [SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ]: 'smalltalk/primitive/instance-slot-read',
  [SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE]: 'smalltalk/primitive/instance-slot-write',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

async function installPrimitiveBlock({images, imageId, primitive}) {
  const id = PRIMITIVE_BLOCK_ID[primitive];
  const code = await ensureCodeArtifact(images, imageId, {
    id: `${id}:code`,
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: SMALLTALK_KERNEL_PRIMITIVE_V1,
    content: textValue(primitiveCodeContent(primitive)),
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  const block = await ensureBlock(images, imageId, {
    id,
    code: objectRef(imageId, code.id),
    environment: null,
    metadata: {smalltalk: 'kernel-primitive', primitive},
  });
  return objectRef(imageId, block.id);
}

async function installSmalltalkInstanceVariableProtocol({images, imageId} = {}) {
  requiredText(imageId, 'image id');
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const installed = {};
  for (const primitive of [SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ, SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE]) {
    installed[primitive] = await installPrimitiveBlock({images, imageId, primitive});
  }
  return Object.freeze({
    readPrimitive: installed[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ],
    writePrimitive: installed[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE],
  });
}

// ADR 0050 decision 5, corrected: the defining Behavior's *visible* layout. A `nil` layout declares
// nothing of its own and cancels nothing above it, so an abstract intermediate class's methods may
// still name ancestor-declared slots — which is exactly the rule `nearestDeclaredInstanceShape`
// already encodes for class definition.
async function visibleInstanceShape({images, classRef, kernel}) {
  let currentRef = classRef;
  const visited = new Set();
  while (currentRef && !sameRef(currentRef, kernel.nil)) {
    const key = `${currentRef.imageId}/${currentRef.objectId}`;
    if (visited.has(key)) return null;
    visited.add(key);
    const behavior = await readBehavior(images, currentRef);
    if (!sameRef(behavior.instanceShape, kernel.nil)) {
      const shape = await images.getShape(behavior.instanceShape.imageId, behavior.instanceShape.objectId);
      if (!shape) {
        throw new TypeError(
          `class ${currentRef.imageId}/${currentRef.objectId} has a dangling instanceShape: `
          + `${behavior.instanceShape.imageId}/${behavior.instanceShape.objectId}`,
        );
      }
      return shape;
    }
    currentRef = behavior.superclass;
  }
  return null;
}

// name -> stable slot id, for the names a method of this class may see. The *name* lives here and in
// the Shape; the compiled method carries only the id (ADR 0050 decision 2), which is why a rename
// that preserves the id leaves existing methods working.
async function instanceVariableBindings({images, imageId, classRef} = {}) {
  requiredText(imageId, 'image id');
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const shape = await visibleInstanceShape({images, classRef, kernel});
  if (!shape) return Object.freeze({});
  const bindings = {};
  for (const {id, name} of shape.slots) {
    if (Object.hasOwn(bindings, name)) {
      throw new TypeError(`instance shape ${shape.id} declares duplicate slot name: ${name}`);
    }
    bindings[name] = id;
  }
  return Object.freeze(bindings);
}

// The class-scoped entry point: parse -> compile *with the defining class* -> semantic program.
async function compileSymmetricSmalltalkMethod({
  images,
  imageId,
  classRef,
  selector,
  source,
  captures = {},
} = {}) {
  requiredText(selector, 'selector');
  const instanceVariables = await instanceVariableBindings({images, imageId, classRef});
  // The primitives arrive as ordinary root captures, so an instance-variable reference lowers to an
  // ordinary send and nothing downstream of the compiler learns a new concept. They are added only
  // when the source actually names an instance variable, so a method that uses none carries none.
  const compiled = compileSymmetricSmalltalkSemanticBlock(source, {
    captures: {
      ...captures,
      [INSTANCE_SLOT_READ_CAPTURE]: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ],
      [INSTANCE_SLOT_WRITE_CAPTURE]: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE],
    },
    instanceVariables,
  });
  const used = compiled.program.captures.filter(({id}) => Object.values(PRIMITIVE_BLOCK_ID).includes(id));
  return Object.freeze({
    selector,
    program: compiled.program,
    representation: compiled.representation,
    instanceVariables,
    captures: used.map(({id, name}) => ({id, name, value: objectRef(imageId, id)})),
  });
}

// Compile a method from source against its defining class and install it.
async function defineMethodsFromSource({images, compilation, imageId, classRef, methods, lane = 'neutral'} = {}) {
  if (!Array.isArray(methods) || methods.length === 0) throw new TypeError('methods must be a non-empty array');
  const compiled = [];
  for (const {selector, source, captures} of methods) {
    const method = await compileSymmetricSmalltalkMethod({images, imageId, classRef, selector, source, captures});
    compiled.push({selector: method.selector, program: method.program, captures: method.captures});
  }
  return await defineMethods({images, compilation, imageId, classRef, lane, methods: compiled});
}

export {
  PRIMITIVE_BLOCK_ID as SMALLTALK_INSTANCE_SLOT_PRIMITIVE_BLOCK_ID,
  compileSymmetricSmalltalkMethod,
  defineMethodsFromSource,
  installSmalltalkInstanceVariableProtocol,
  instanceVariableBindings,
  visibleInstanceShape,
};
