import {defineMethods} from './smalltalk-class-builder.js';
import {installSmalltalkAllocationProtocol} from './smalltalk-allocation.js';
import {installSmalltalkBlockProtocol} from './smalltalk-block-protocol.js';
import {installSmalltalkConditionProtocol, CONDITION_CLASSES} from './smalltalk-conditions.js';
import {installSmalltalkControlFlow} from './smalltalk-control-flow.js';
import {installSmalltalkDictionaryProtocol, installSmalltalkEqualityProtocol} from './smalltalk-dictionary.js';
import {
  installSmalltalkGlobalNamespace,
  publishSmalltalkClassGlobals,
} from './smalltalk-globals.js';
import {installSmalltalkIndexedProtocol} from './smalltalk-indexed.js';
import {installSmalltalkInstanceVariableProtocol} from './smalltalk-instance-variables.js';
import {installSmalltalkIntegerProtocol} from './smalltalk-integer.js';
import {findSmalltalkKernel, installSmalltalkKernel} from './smalltalk-kernel.js';
import {installSmalltalkLibrary} from './smalltalk-library.js';

// The normal, complete Symmetric Smalltalk image. This is composition, not a new semantic layer:
// every record is still owned by the installer that defines it, and all of those low-level
// installers remain public for tests, partial personalities and future bootstrap work.
const SYMMETRIC_SMALLTALK_STANDARD_IMAGE_V1 = 'symmetric-smalltalk-standard-image/v1';

// `+` predates the protocol installers and is deliberately still the old `integer-add` semantic op.
// Many suites install this exact method by hand. The standard image makes that established behavior
// part of the normal composition without adding a primitive, selector special case or new IR op.
const INTEGER_PLUS_METHOD = Object.freeze({
  selector: '+',
  program: Object.freeze({
    parameters: Object.freeze([Object.freeze({id: 'plus:arg', name: 'n'})]),
    captures: Object.freeze([]),
    body: Object.freeze({
      op: 'integer-add',
      left: Object.freeze({op: 'receiver'}),
      right: Object.freeze({op: 'argument', index: 0}),
    }),
  }),
});

const PRE_LIBRARY_PUBLIC_CLASSES = Object.freeze([
  'Array',
  ...CONDITION_CLASSES.map(({name}) => name),
  'Dictionary',
]);
const LIBRARY_PUBLIC_CLASSES = Object.freeze(['Association', 'OrderedCollection']);

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

async function installIntegerAddition({images, compilation, imageId, lane, kernel}) {
  await defineMethods({
    images,
    compilation,
    imageId,
    lane,
    classRef: kernel.integerClass,
    methods: [INTEGER_PLUS_METHOD],
  });
  return Object.freeze({integerClass: kernel.integerClass});
}

async function installSymmetricSmalltalkStandardImage({
  images,
  compilation,
  imageId,
  lane = 'neutral',
} = {}) {
  requiredText(imageId, 'image id');
  if (lane !== 'neutral' && lane !== 'wasm') throw new TypeError(`unknown method lane: ${lane}`);
  // Composition has stronger requirements than any one low-level installer, so validate them before
  // publishing the first kernel record. A missing dependency is a caller error, not a recoverable
  // partial standard-image installation.
  if (!images || typeof images.getImage !== 'function' || typeof images.getObject !== 'function') {
    throw new TypeError('images service with getImage/getObject is required');
  }
  if (!compilation || typeof compilation.compileArtifact !== 'function') {
    throw new TypeError('compilation service with compileArtifact is required');
  }

  // The image lifecycle belongs to the caller. `getImage` owns the missing-image diagnosis; this
  // installer merely requires the image to exist and never creates one as a side effect.
  await images.getImage(imageId);

  const options = {images, compilation, imageId, lane};

  // Bootstrap and standard-image replay are intentionally different operations. Once the kernel
  // exists its method dictionaries are expected to grow, so rerunning the bootstrap installer would
  // incorrectly compare those live dictionaries with bootstrap's empty definitions. Rediscover an
  // existing kernel instead. If an interrupted bootstrap never published the kernel record, rerun
  // the bootstrap installer from the start and let its ensure-exact writes converge.
  let kernel = await findSmalltalkKernel({images, imageId});
  let kernelInstall = null;
  if (!kernel) {
    kernelInstall = await installSmalltalkKernel({images, imageId});
    kernel = await findSmalltalkKernel({images, imageId});
  }
  if (!kernel) throw new TypeError(`image ${imageId} has no Smalltalk kernel after installation`);

  // This order is intentionally boring and mirrors the dependency order the first real library
  // forced tests to spell by hand. A stage may assume everything above it, and nothing below it.
  const allocation = await installSmalltalkAllocationProtocol(options);
  const equality = await installSmalltalkEqualityProtocol(options);
  const controlFlow = await installSmalltalkControlFlow(options);
  const indexed = await installSmalltalkIndexedProtocol(options);
  const instanceVariables = await installSmalltalkInstanceVariableProtocol({images, imageId});
  const blocks = await installSmalltalkBlockProtocol({images, imageId});
  const integers = await installSmalltalkIntegerProtocol(options);
  const integerAddition = await installIntegerAddition({...options, kernel});
  const conditions = await installSmalltalkConditionProtocol(options);
  const dictionary = await installSmalltalkDictionaryProtocol(options);

  // Namespace publication is deliberately separate from class creation. Installing the namespace
  // publishes the kernel classes; the public post-kernel classes are named explicitly here. In
  // particular GlobalBinding stays implementation machinery rather than becoming a user global.
  const globals = await installSmalltalkGlobalNamespace(options);
  await publishSmalltalkClassGlobals({images, imageId, names: [...PRE_LIBRARY_PUBLIC_CLASSES]});

  const library = await installSmalltalkLibrary(options);
  await publishSmalltalkClassGlobals({images, imageId, names: [...LIBRARY_PUBLIC_CLASSES]});

  return Object.freeze({
    protocol: SYMMETRIC_SMALLTALK_STANDARD_IMAGE_V1,
    imageId,
    lane,
    kernel,
    kernelInstall,
    protocols: Object.freeze({
      allocation,
      equality,
      controlFlow,
      indexed,
      instanceVariables,
      blocks,
      integers,
      integerAddition,
      conditions,
      dictionary,
      globals,
    }),
    classes: Object.freeze({
      Array: indexed.arrayClass,
      Dictionary: dictionary.classRef,
      Association: library.association,
      OrderedCollection: library.orderedCollection,
      ...Object.fromEntries(CONDITION_CLASSES.map(({name}) => [name, conditions[name]])),
    }),
    library,
  });
}

export {
  INTEGER_PLUS_METHOD as SMALLTALK_STANDARD_INTEGER_PLUS_METHOD,
  LIBRARY_PUBLIC_CLASSES as SMALLTALK_STANDARD_LIBRARY_PUBLIC_CLASSES,
  PRE_LIBRARY_PUBLIC_CLASSES as SMALLTALK_STANDARD_PRE_LIBRARY_PUBLIC_CLASSES,
  SYMMETRIC_SMALLTALK_STANDARD_IMAGE_V1,
  installSymmetricSmalltalkStandardImage,
};
