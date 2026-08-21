import {booleanValue, isObjectRef, textValue} from '../value/index.js';
import {defineMethods} from './smalltalk-class-builder.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {SYMMETRIC_SMALLTALK_ID} from './symmetric-smalltalk.js';

// ADR 0045: Symmetric Smalltalk's conditionals, as ordinary methods on True and False.
//
// Nothing here is a primitive. Each method either evaluates one of its block arguments through an
// ordinary `value` send — which ADR 0044 decision 11 answers without a class — or answers `nil`,
// which it names through an ordinary captured binding rather than through an operation in the
// common IR. The compiler recognizes none of these selectors; a source conditional is a keyword
// send like any other, and the branch is taken by dispatch choosing True's method or False's.
//
// This is an installer, deliberately separate from `installSmalltalkKernel`. The kernel bootstrap
// creates identity; protocol arrives afterwards, per lane, exactly as `+` does. An image with a
// kernel and no control-flow protocol fails as message-not-understood, which is a coherent state.
const NIL_CAPTURE = Object.freeze({id: 'smalltalk/control-flow/nil', name: 'nil'});

// What each class does for each selector. Written as one table rather than hand-built programs so
// the symmetry is checkable by reading it: every selector appears once per class, and no two entries
// can drift apart in shape.
//
//   a number   evaluate that argument, by sending it `value`
//   null       answer nil
//   a boolean  answer that canonical boolean Value (ADR 0056)
//
// The Boolean protocol needed no second publication surface: `and:`/`or:` are the same shape as the
// conditionals — evaluate an argument, or answer without mentioning it — and their laziness falls
// out of that rather than being arranged. An arm that answers a literal never names the argument, so
// the Block simply is not evaluated.
const CONDITIONAL_PROTOCOL = Object.freeze([
  {selector: 'ifTrue:', parameters: ['aBlock'], True: 0, False: null},
  {selector: 'ifFalse:', parameters: ['aBlock'], True: null, False: 0},
  {selector: 'ifTrue:ifFalse:', parameters: ['trueBlock', 'falseBlock'], True: 0, False: 1},
  {selector: 'ifFalse:ifTrue:', parameters: ['falseBlock', 'trueBlock'], True: 1, False: 0},
  // ADR 0056 decision 4. Ordinary methods through ADR 0045's bridge; the compiler learns nothing.
  {selector: 'not', parameters: [], True: false, False: true},
  {selector: 'and:', parameters: ['aBlock'], True: 0, False: false},
  {selector: 'or:', parameters: ['aBlock'], True: true, False: 0},
]);

const SMALLTALK_CONDITIONAL_SELECTORS = Object.freeze(CONDITIONAL_PROTOCOL.map(({selector}) => selector));

// The kernel slot naming each singleton, and the class it is an instance of. `True` and `False` have
// no kernel slot of their own, so the class is read from the singleton rather than named here.
const SINGLETONS = Object.freeze([
  {kernelSlot: 'true', className: 'True'},
  {kernelSlot: 'false', className: 'False'},
]);

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

// One method, as a semantic program plus the capture values its bindings need. `lagrange-code/v0`
// carries capture *descriptors*; the values live in the Block's lexical environment, which is what
// keeps `nil` an object in the graph rather than a meaning taught to the IR.
function conditionalMethod({selector, parameters, evaluate, nilRef}) {
  const parameterDescriptors = parameters.map((name, index) => ({
    id: `${selector}:parameter:${index}`,
    name,
  }));
  // ADR 0056: an arm that answers a boolean answers the canonical *Value*, not the singleton — the
  // singleton is a dispatch personality (ADR 0045), and a boolean-answering method must not quietly
  // convert one into the other.
  if (typeof evaluate === 'boolean') {
    return {
      selector,
      program: {
        parameters: parameterDescriptors,
        captures: [],
        body: {op: 'literal', value: booleanValue(evaluate)},
      },
      captures: [],
    };
  }
  if (evaluate === null) {
    return {
      selector,
      program: {
        parameters: parameterDescriptors,
        captures: [{...NIL_CAPTURE}],
        body: {op: 'binding', id: NIL_CAPTURE.id},
      },
      captures: [{...NIL_CAPTURE, value: nilRef}],
    };
  }
  return {
    selector,
    program: {
      parameters: parameterDescriptors,
      captures: [],
      // The block is invoked through the existing ordinary value path, so the whole conditional is
      // two sends: one that chose this method, and this one.
      body: {
        op: 'send',
        languageId: SYMMETRIC_SMALLTALK_ID,
        receiver: {op: 'argument', index: evaluate},
        message: textValue('value'),
        arguments: [],
      },
    },
    captures: [],
  };
}

// The class of a singleton, read from the singleton itself rather than from a kernel slot. `True`
// and `False` have no kernel slot of their own, and going through the object is also the exact path
// the dispatcher's boolean bridge takes — so installing onto anything else would install onto a
// class the bridge does not reach.
async function classOfSingleton(images, singletonRef, label) {
  const record = await images.getObject(singletonRef.imageId, singletonRef.objectId);
  if (!record) throw new TypeError(`Smalltalk kernel ${label} not found: ${singletonRef.imageId}/${singletonRef.objectId}`);
  if (!isObjectRef(record.behavior)) {
    throw new TypeError(`Smalltalk kernel ${label} has no behavior: ${singletonRef.imageId}/${singletonRef.objectId}`);
  }
  return record.behavior;
}

async function installSmalltalkControlFlow({images, compilation, imageId, lane = 'neutral'} = {}) {
  requiredText(imageId, 'image id');
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);

  const installed = {};
  for (const {kernelSlot, className} of SINGLETONS) {
    const classRef = await classOfSingleton(images, kernel[kernelSlot], kernelSlot);
    await defineMethods({
      images,
      compilation,
      imageId,
      classRef,
      lane,
      methods: CONDITIONAL_PROTOCOL.map((entry) => conditionalMethod({
        selector: entry.selector,
        parameters: entry.parameters,
        evaluate: entry[className],
        nilRef: kernel.nil,
      })),
    });
    installed[className] = classRef;
  }
  return Object.freeze({
    trueClass: installed.True,
    falseClass: installed.False,
    selectors: SMALLTALK_CONDITIONAL_SELECTORS,
  });
}

export {
  NIL_CAPTURE as SMALLTALK_CONTROL_FLOW_NIL_CAPTURE,
  SMALLTALK_CONDITIONAL_SELECTORS,
  installSmalltalkControlFlow,
};
