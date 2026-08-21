import {objectRef, textValue} from '../value/index.js';
import {
  defineMethods,
  ensureBlock,
  ensureCodeArtifact,
} from './smalltalk-class-builder.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {visibleInstanceShape} from './smalltalk-lookup.js';
import {
  SMALLTALK_KERNEL_PRIMITIVE_V1,
  SMALLTALK_PRIMITIVE,
  primitiveCodeContent,
} from './smalltalk-primitives.js';
import {
  INSTANCE_SLOT_READ_CAPTURE,
  NON_LOCAL_RETURN_CAPTURE,
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
  // ADR 0055. `^` lowers to a send to this, bound through the same seam and reserved the same way.
  [SMALLTALK_PRIMITIVE.NON_LOCAL_RETURN]: 'smalltalk/primitive/non-local-return',
});

// Owned by the class-scoped binder, which injects them for instance-variable access and for `^`.
const RESERVED_CAPTURE_NAMES = new Set([
  INSTANCE_SLOT_READ_CAPTURE, INSTANCE_SLOT_WRITE_CAPTURE, NON_LOCAL_RETURN_CAPTURE,
]);
const RESERVED_CAPTURE_IDS = new Set(Object.values(PRIMITIVE_BLOCK_ID));

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
  for (const primitive of Object.keys(PRIMITIVE_BLOCK_ID)) {
    installed[primitive] = await installPrimitiveBlock({images, imageId, primitive});
  }
  return Object.freeze({
    readPrimitive: installed[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ],
    writePrimitive: installed[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE],
    nonLocalReturnPrimitive: installed[SMALLTALK_PRIMITIVE.NON_LOCAL_RETURN],
  });
}

// name -> stable slot id, for the names a method of this class may see. The *name* lives here and in
// the Shape; the compiled method carries only the id (ADR 0050 decision 2), which is why a rename
// that preserves the id leaves existing methods working.
async function instanceVariableBindings({images, imageId, classRef} = {}) {
  requiredText(imageId, 'image id');
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  // The same strict walk the runtime permission check uses, so the binder cannot offer a name
  // the primitive would then refuse, and neither can report corruption as an unbound name.
  const shape = await visibleInstanceShape({images, behaviorRef: classRef, nilRef: kernel.nil});
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

// A method may capture named values, exactly as a Block may. This is how a method names anything
// that is not a parameter, temporary or instance variable — a class, for instance, since source has
// no global namespace: `Array` is a captured ref, not a resolvable global.
//
// Compilation and installation are kept apart. What the *compiler* needs is a declaration — a name
// bound to a stable capture id — and it answers the program's capture list. Every declaration is in
// that list, referenced or not. Binding values is installation's job, because a value is per image
// while a declaration is not.
//
// Two forms are accepted and both mean the same thing to the compiler:
//
//   {name: captureId}                  a declaration map
//   [{name, id, value?}]               declarations, optionally carrying installation values
//
// Duplicates are refused in either form rather than resolved by position. A repeated name would make
// the meaning of that name in source depend on declaration order, and a repeated id would collapse
// two declarations into one binding — the same first-wins defect this substrate rejects everywhere.
function normalizeCaptureDeclarations(captures) {
  const entries = Array.isArray(captures)
    ? captures.map((entry) => {
      if (!entry || typeof entry !== 'object') throw new TypeError('a capture declaration must be an object');
      return {name: entry.name, id: entry.id, value: entry.value};
    })
    : Object.entries(captures ?? {}).map(([name, id]) => ({name, id, value: undefined}));

  const names = new Set();
  const ids = new Set();
  for (const entry of entries) {
    requiredText(entry.name, 'capture name');
    requiredText(entry.id, 'capture id');
    // The binder adds its own captures for the slot primitives, and they are spread *after* the
    // caller's — so a colliding declaration would be silently replaced, value and all, which is
    // exactly what the uniform capture contract is supposed to prevent. Refuse instead.
    if (RESERVED_CAPTURE_NAMES.has(entry.name)) {
      throw new TypeError(`capture name ${entry.name} is reserved for instance-variable access`);
    }
    if (RESERVED_CAPTURE_IDS.has(entry.id)) {
      throw new TypeError(`capture id ${entry.id} is reserved for instance-variable access`);
    }
    if (names.has(entry.name)) throw new TypeError(`method declares capture name ${entry.name} twice`);
    if (ids.has(entry.id)) throw new TypeError(`method declares capture id ${entry.id} twice`);
    names.add(entry.name);
    ids.add(entry.id);
  }
  return entries;
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
  const declared = normalizeCaptureDeclarations(captures);
  const instanceVariables = await instanceVariableBindings({images, imageId, classRef});
  // The primitives arrive as ordinary root captures, so an instance-variable reference lowers to an
  // ordinary send and nothing downstream of the compiler learns a new concept. They are added only
  // when the source actually names an instance variable, so a method that uses none carries none.
  const compiled = compileSymmetricSmalltalkSemanticBlock(source, {
    captures: {
      ...Object.fromEntries(declared.map(({name, id}) => [name, id])),
      [INSTANCE_SLOT_READ_CAPTURE]: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_READ],
      [INSTANCE_SLOT_WRITE_CAPTURE]: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.INSTANCE_SLOT_WRITE],
      // ADR 0055: injected unconditionally rather than only when `^` occurs, for the same reason
      // the slot primitives are declared per method — a declaration that nothing references still
      // becomes a binding, and deciding by inspection would mean two places that must agree about
      // whether the source contains a return.
      [NON_LOCAL_RETURN_CAPTURE]: PRIMITIVE_BLOCK_ID[SMALLTALK_PRIMITIVE.NON_LOCAL_RETURN],
    },
    instanceVariables,
    // This entry point is the class-scoped one, so its compilations have a method to return from.
    methodHome: true,
  });

  // Every declaration becomes a program capture, referenced or not — that is the block compiler's
  // existing behaviour for root captures and this path does not change it. What is returned is the
  // program's own capture list, in its own order, with no values: this is compilation, and a value
  // is an installation concern.
  return Object.freeze({
    selector,
    program: compiled.program,
    representation: compiled.representation,
    instanceVariables,
    captures: compiled.program.captures.map(({id, name}) => Object.freeze({id, name})),
  });
}

// Compile methods from source against their defining class and install them. This is where a
// capture declaration acquires its value: the slot primitives resolve to their well-known Blocks in
// this image, and anything else must have been supplied by the caller.
async function defineMethodsFromSource({images, compilation, imageId, classRef, methods, lane = 'neutral'} = {}) {
  if (!Array.isArray(methods) || methods.length === 0) throw new TypeError('methods must be a non-empty array');
  const primitiveIds = new Set(Object.values(PRIMITIVE_BLOCK_ID));
  const compiled = [];
  for (const {selector, source, captures} of methods) {
    const declared = normalizeCaptureDeclarations(captures ?? {});
    const supplied = new Map(declared.map(({id, value}) => [id, value]));
    const method = await compileSymmetricSmalltalkMethod({images, imageId, classRef, selector, source, captures});
    const bound = method.captures.map(({id, name}) => {
      if (primitiveIds.has(id)) return {id, name, value: objectRef(imageId, id)};
      const value = supplied.get(id);
      if (value === undefined) {
        throw new TypeError(
          `method ${selector} declares capture ${name} without a value; every declared capture `
          + 'becomes a binding in the installed method, so installation needs a value for each',
        );
      }
      return {id, name, value};
    });
    compiled.push({selector: method.selector, program: method.program, captures: bound});
  }
  return await defineMethods({images, compilation, imageId, classRef, lane, methods: compiled});
}

export {
  PRIMITIVE_BLOCK_ID as SMALLTALK_INSTANCE_SLOT_PRIMITIVE_BLOCK_ID,
  compileSymmetricSmalltalkMethod,
  defineMethodsFromSource,
  installSmalltalkInstanceVariableProtocol,
  instanceVariableBindings,
};
