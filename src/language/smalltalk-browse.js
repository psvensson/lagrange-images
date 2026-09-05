import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {shapeIndexedKind} from '../object/model.js';
import {isObjectRef} from '../value/index.js';
import {findSmalltalkKernel, isLocalRef, readBehavior} from './smalltalk-kernel.js';
import {methodBindings} from './smalltalk-class-builder.js';
import {sameRef} from './smalltalk-lookup.js';
import {smalltalkMethodPositionToken} from './smalltalk-method-position-token.js';

// The AUTHORIZED native Symmetric Smalltalk browsing seam (ADR 0087, bead lagrange-images-jtz,
// Object Environment E1).
//
// This is an IMAGES semantic API. It is not an Environment-shaped DTO and not a Cuis API: what it
// answers are ordinary native Smalltalk facts about ordinary native Classes, Metaclasses and
// methods, useful to any headless client, and identical whether the class was declared natively or
// arrived through the Cuis native-import adapter.
//
// COMPOSITION, NOT DECODING. Every fact here comes from the owner that already decides it:
//
//   Class/Metaclass identity, superclass, method-dictionary edge   readBehavior          (kernel)
//   the image's nil terminator and Metaclass identity              findSmalltalkKernel   (kernel)
//   selector -> Block bindings, representation-neutral             methodBindings        (class builder)
//   declared instance layout                                       the instance Shape    (object model)
//   authority operation + resource naming                          object-resource.js    (authority)
//
// Nothing in this module decodes a Behavior slot id, a MethodDictionary bucket, a Block's code
// artifact or a compiled WASM representation, and nothing here writes.
//
// WHAT DELIBERATELY DOES NOT ESCAPE. Behavior slot ids; the MethodDictionary's representation,
// buckets, tally or seal; backend `_version`; the semantic/WASM artifacts underneath a method; Spur
// oops or Cuis class objects; the import adapter's transient semantic-identity mapping. A caller
// receives names, refs and selectors — never a storage layout to decode.
//
// AUTHORITY. Two operations, two checks, no transitive authority (ADR 0039 §2):
//
//   class browsing   ONE `object/read` on the Class (or Metaclass) OBJECT.
//   method browsing  that SAME class check, AND an independent `object/read` on the method's Block.
//
// A class's own MethodDictionary is covered by the class's single check for the same reason a
// Project's member records are covered by the Project's (see project/working-state.js): it is the
// Class's storage representation, sitting at an id derived from the Class, carrying no behavior edge
// of its own (ADR 0049 decision 3), and it is not an independently addressable semantic object. The
// Blocks it BINDS are: a Block is executable, may legitimately sit in two dictionaries, and is
// exactly the kind of independent target ADR 0039 §2 refuses to reach by ref-following. So class
// authority yields selector NAMES and never the method behind one.
//
// Nothing is inferred from Project membership, from a class reference, or from graph reachability.
// A superclass ref, a class-side ref and a Block ref are LOCATORS: browsing what they name requires
// that object's own grant.
//
// AUTHORIZATION BEFORE EXISTENCE. Every entry point validates its caller-supplied inputs (which
// discloses nothing), then requires, then reads. A denied caller cannot tell an existing class from
// a missing one, or an existing method from a missing one: both are AuthorityError.
//
// PROVENANCE IS OPTIONAL METADATA, and today it is absent. Images owns no durable association from a
// native class or method back to a Cuis package, source or protocol/category: `importCuisNativePackage`
// returns transient associations and writes no side table, and the class builder installs a method's
// semantic program without retaining the text it was compiled from. So `provenance` and a method's
// `source` are reported as `null` rather than reconstructed from the importer or guessed from a
// deterministic id. That is the truthful answer, and it is exactly why a Cuis-imported class browses
// through this one seam like any other: there is no second lane for it to take.
//
// BROWSING ONLY. No edit, rename, recompile or removal semantics live here: a write lane needs its
// own consumer, its own owner decision and its own ADR.

const SMALLTALK_CLASS_DESCRIPTION_V1 = 'smalltalk-class-description/v1';
const SMALLTALK_METHOD_DESCRIPTION_V1 = 'smalltalk-method-description/v1';

// Instance side or class side. A Metaclass is recognized the way the kernel ties the knot —
// `behavior(aMetaclass) == Metaclass` — not by an object-id spelling.
const CLASS_SIDE = Object.freeze({INSTANCE: 'instance', CLASS: 'class'});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertRequire(require, label) {
  if (typeof require !== 'function') {
    throw new TypeError(`${label} requires a require(demand) authority-check function`);
  }
  return require;
}

// Caller-supplied input only: this rejects a malformed argument without touching the graph, so it
// cannot become an existence oracle.
function assertLocalClassRef(classRef, imageId, label) {
  if (!isObjectRef(classRef) || classRef.imageId !== imageId) {
    throw new TypeError(`${label} classRef must be an unpinned object ref in ${imageId}`);
  }
  return classRef;
}

const readDemand = (imageId, objectId) => ({
  operation: OBJECT_READ_OPERATION,
  resource: objectResource(imageId, objectId),
});

// The class's declared instance layout, or `null` when it declares none. `null` and `[]` are
// different answers: a Metaclass and the kernel's abstract classes carry the kernel `nil` instance
// shape (they declare no layout at all), while a class declaring zero instance variables has an
// empty one and its instances exist. Slot IDS never escape — a browser gets the ordered names and
// whether instances are indexable, which is what a class definition says.
async function describeLayout({images, instanceShape, nilRef, label}) {
  if (sameRef(instanceShape, nilRef)) return null;
  const shape = await images.getShape(instanceShape.imageId, instanceShape.objectId);
  if (!shape) {
    throw new TypeError(`${label} has a dangling instance shape edge to ${instanceShape.imageId}/${instanceShape.objectId}`);
  }
  return Object.freeze({
    instanceVariables: Object.freeze(shape.slots.map(({name}) => name)),
    indexed: shapeIndexedKind(shape),
  });
}

// ONE already-authorized, already-read Class/Metaclass record -> the canonical native class
// description. Every field comes from that one record (the selector bindings are read from the
// dictionary edge IT names), so a description can never be assembled from two versions of a class.
// `superclass` and `classSide` are refs the caller may browse NEXT, each under its own grant.
async function describeBehavior({images, imageId, classRef, behavior, kernel}) {
  const label = `native class ${classRef.imageId}/${classRef.objectId}`;
  const metaclass = sameRef(behavior.record.behavior, kernel.metaclassClass);
  return Object.freeze({
    format: SMALLTALK_CLASS_DESCRIPTION_V1,
    class: classRef,
    name: behavior.name.value,
    side: metaclass ? CLASS_SIDE.CLASS : CLASS_SIDE.INSTANCE,
    // The kernel's `nil` terminates the chain; a root class has no superclass, it does not have a
    // superclass named "nil".
    superclass: sameRef(behavior.superclass, kernel.nil) ? null : behavior.superclass,
    // The class side of an instance-side class is its metaclass — the class's own behavior edge, by
    // the kernel's decision 4 rule. Browsing it needs the metaclass's own `object/read`; this is a
    // locator, not a grant.
    //
    // A Metaclass gets `null`, and there is deliberately no inverse field: the kernel stores a
    // class -> metaclass edge and no metaclass -> sole-instance edge, so answering "which class is
    // this the metaclass of" would mean deriving one object id from another. A browser that wants
    // to toggle sides keeps the class ref it started from.
    classSide: metaclass || !isLocalRef(behavior.record.behavior, imageId) ? null : behavior.record.behavior,
    layout: await describeLayout({images, instanceShape: behavior.instanceShape, nilRef: kernel.nil, label}),
    // The selectors THIS class implements. Inherited protocol is deliberately absent: an inherited
    // selector is the declaring class's fact, and reporting it here would let one grant speak for
    // objects the caller was never authorized to read.
    selectors: Object.freeze((await methodBindings({images, imageId, classRef, behavior})).map(({selector}) => selector)),
    // Optional metadata; see the module header. Images owns no durable Cuis association today.
    provenance: null,
  });
}

// AUTHORIZED native class browsing.
//
// Requires ONE `object/read` on the Class (or Metaclass) object named by `classRef`, BEFORE any
// existence disclosure. Returns the frozen canonical description: identity/name, side, superclass,
// class side, declared native layout and the class's own selectors.
async function authorizedDescribeSmalltalkClass({images, imageId, classRef, require} = {}) {
  requiredText(imageId, 'imageId');
  assertLocalClassRef(classRef, imageId, 'authorizedDescribeSmalltalkClass');
  assertRequire(require, 'authorizedDescribeSmalltalkClass');

  require(readDemand(imageId, classRef.objectId));

  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const behavior = await readBehavior(images, classRef);
  return describeBehavior({images, imageId, classRef, behavior, kernel});
}

// AUTHORIZED native method browsing.
//
// Two independent checks, in this order:
//   1. `object/read` on the CLASS object — before any existence disclosure, and the same check
//      class browsing makes. It authorizes resolving the selector against the class's own method
//      dictionary, which is the class's storage representation.
//   2. `object/read` on the method's BLOCK object — before the Block is read. A Block is an
//      independent semantic object, so class authority does not reach it.
//
// A caller holding only (1) can already see the selector, so learning "this selector exists but you
// may not read its method" discloses nothing new; a caller holding neither learns only AuthorityError.
// ONE authorized resolution of a current method position, so the read that DESCRIBES a method and
// the read that prepares to REPLACE one cannot assemble different revisions by accident. Everything
// below it is the same as it has always been; factoring it is what makes "the descriptor and the
// token describe the same resolved binding, from one binding read" a structural fact rather than a
// convention two call sites have to keep.
//
// The authority sequence is ADR 0087's and is unchanged: validate caller input, authorize the
// Class/Metaclass read, resolve, then authorize the method's Block INDEPENDENTLY. Class-read
// authority yields selector names and never the Block behind one, and a caller denied either half
// cannot tell an existing method from a missing one.
async function authorizedMethodPosition({images, imageId, classRef, selector, require, operation}) {
  requiredText(imageId, 'imageId');
  assertLocalClassRef(classRef, imageId, operation);
  requiredText(selector, 'selector');
  assertRequire(require, operation);

  require(readDemand(imageId, classRef.objectId));

  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const behavior = await readBehavior(images, classRef);
  // The SAME Behavior record answers the side and the selector bindings: one read of the Class, so a
  // description can never be assembled from two different versions of it.
  const binding = (await methodBindings({images, imageId, classRef, behavior}))
    .find((entry) => entry.selector === selector);
  if (!binding) {
    throw new TypeError(`native class ${classRef.imageId}/${classRef.objectId} does not implement ${selector}`);
  }

  require(readDemand(binding.method.imageId, binding.method.objectId));

  // The binding is only truthful if the Block it names is actually there; a dangling method edge is
  // corrupt graph state, correctly disclosed to a caller authorized for both ends of it.
  const block = await images.getBlock(binding.method.imageId, binding.method.objectId);
  if (!block) {
    throw new TypeError(
      `native class ${classRef.imageId}/${classRef.objectId} binds ${selector} to a missing Block: `
      + `${binding.method.imageId}/${binding.method.objectId}`,
    );
  }

  return Object.freeze({
    binding,
    descriptor: Object.freeze({
      format: SMALLTALK_METHOD_DESCRIPTION_V1,
      // The Behavior that DECLARES this method, not the receiver class a send happened to start from.
      class: classRef,
      side: sameRef(behavior.record.behavior, kernel.metaclassClass) ? CLASS_SIDE.CLASS : CLASS_SIDE.INSTANCE,
      selector,
      // The exact Block ref the dictionary binds. It is the method's identity for a caller that
      // wants to pin or re-read it; the code, lexical environment and compiled lane behind it are
      // the execution owners' business and stay there.
      method: binding.method,
      // Absent, not empty: the class builder installs a method's semantic program and keeps no
      // durable text it was compiled from, so there is no native method source for this seam to
      // report. See the module header.
      source: null,
      provenance: null,
    }),
  });
}

// ADR 0087, unchanged and gaining nothing. It answers the canonical method description and no
// version token: a reader is not a writer, and a caller that only wants to look at a method has no
// business holding a replacement assumption.
async function authorizedDescribeSmalltalkMethod({images, imageId, classRef, selector, require} = {}) {
  return (await authorizedMethodPosition({
    images, imageId, classRef, selector, require, operation: 'authorizedDescribeSmalltalkMethod',
  })).descriptor;
}

// THE WRITER-FACING READ (bead lagrange-images-qax, Object Environment E3). The smallest possible
// addition: exactly the canonical ADR 0087 descriptor, plus an opaque token for the method position
// it just resolved.
//
// Both halves come from ONE resolution, so they cannot describe different revisions — the token is
// minted from the very binding the descriptor reports, not from a second read of the same position.
// That matters because the whole point of the token is to represent what the caller was shown.
//
// It demands exactly what ADR 0087's method read demands and nothing more. Reading in order to
// write is still only reading, so this grants no write authority and asserts none; the replacement
// operation authorizes its own write when it is called. `descriptor.source` stays `null` — this
// seam is not a source editor and E3 is replacement from explicitly supplied source.
async function authorizedReadSmalltalkMethodForUpdate({images, imageId, classRef, selector, require} = {}) {
  const {descriptor, binding} = await authorizedMethodPosition({
    images, imageId, classRef, selector, require, operation: 'authorizedReadSmalltalkMethodForUpdate',
  });
  return Object.freeze({
    descriptor,
    versionToken: smalltalkMethodPositionToken({
      imageId, classRef, selector, method: binding.method,
    }),
  });
}

export {
  CLASS_SIDE,
  SMALLTALK_CLASS_DESCRIPTION_V1,
  SMALLTALK_METHOD_DESCRIPTION_V1,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
};
