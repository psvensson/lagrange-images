import {objectRef} from '../value/index.js';
import {methodBlockRef} from './smalltalk-class-builder.js';
import {defineMethodsFromSource} from './smalltalk-instance-variables.js';
import {findSmalltalkKernel} from './smalltalk-kernel.js';
import {SYMBOL_CLASS_NAME} from './smalltalk-primitives-symbol.js';

// YAXO compares an interned element name with tokenizer Text. Equality and hash must move
// together, while Object's default relation, reference identity and interning stay unchanged.
// Spelling and its hash are obtained through ordinary protocol, never by decoding Symbol records.
async function installSmalltalkStringEqualityProtocol({images, compilation, imageId, lane = 'neutral'} = {}) {
  if (!images || typeof images.getObject !== 'function') throw new TypeError('images service is required');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  const kernel = await findSmalltalkKernel({images, imageId});
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel`);
  const symbolClass = objectRef(imageId, `smalltalk/class/${SYMBOL_CLASS_NAME}`);
  const trueClass = (await images.getObject(kernel.true.imageId, kernel.true.objectId)).behavior;
  const falseClass = (await images.getObject(kernel.false.imageId, kernel.false.objectId)).behavior;
  // Check every required stage before the first method publication. The class builder owns
  // selector storage and corruption checks; this owner only states its protocol prerequisites.
  for (const [classRef, name, selectors] of [
    [kernel.objectClass, 'Object', ['==', 'hash', 'isString']],
    [kernel.textClass, 'Text', ['asString', 'isString']],
    [symbolClass, 'Symbol', ['asString', 'isString']],
    [trueClass, 'True', ['and:']], [falseClass, 'False', ['and:']],
  ]) for (const selector of selectors) {
    if (!await methodBlockRef({images, imageId, classRef, selector})) {
      throw new TypeError(`image ${imageId} has no ${name} ${selector} method`);
    }
  }
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: kernel.textClass,
    methods: [{selector: '=', source: '[ :other | other isString and: [ self == other asString ] ]'}],
  });
  await defineMethodsFromSource({
    images, compilation, imageId, lane, classRef: symbolClass,
    methods: [
      {selector: '=', source: '[ :other | self asString = other ]'},
      {selector: 'hash', source: '[ self asString hash ]'},
    ],
  });
}

export {installSmalltalkStringEqualityProtocol};
