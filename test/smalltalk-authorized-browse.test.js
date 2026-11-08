import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
  CUIS_SEMANTIC_EXPORT_V2,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  SMALLTALK_METHOD_READ_OPERATION,
  SMALLTALK_CLASS_DESCRIPTION_V1,
  SMALLTALK_METHOD_DESCRIPTION_V1,
  SYMMETRIC_SMALLTALK_SOURCE_V0,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  importCuisNativePackage,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  methodBindings,
  objectRef,
  objectResource,
  reconcileMethodsFromSource,
  smalltalkMethodPositionResource,
} from '../src/runtime.js';
import {collectStaticModuleClosure} from '../src/portable-artifact/module-closure.js';
import {createNodeSourceReader} from '../src/portable-artifact/node-source-reader.js';

// The AUTHORIZED native Symmetric Smalltalk browsing seam (bead lagrange-images-jtz, Object
// Environment E1 prerequisite).
//
// What this file proves:
//   * class browsing answers ordinary native facts (identity/name, side, superclass, class side,
//     declared layout, the class's OWN selectors) and nothing about storage;
//   * method browsing answers the native method facts an inspector needs, and reports source and
//     Cuis provenance as ABSENT because Images owns no durable association for either today;
//   * two independent authority checks — class read, then the exact logical method position — with
//     no transitive authority through a superclass, class-side, selector or method ref;
//   * authorization strictly precedes existence disclosure, so a denied caller cannot use the seam
//     as an existence oracle;
//   * a Cuis-imported native class browses through the SAME public function as a hand-declared one,
//     with no Cuis runtime, provider, adapter module or identity anywhere in the lane.

async function withImage(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    // No toolchain and no foreign-runtime provider exist in this runtime at all: browsing a
    // Cuis-imported class cannot reach a Cuis VM even by accident.
    assert.deepEqual(runtime.toolchainProviders.list(), []);
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
    await runtime.images.createImage({id: 'app'});
    await installSmalltalkKernel({images: runtime.images, imageId: 'app'});
    await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: 'app'});
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

// The caller-side require closure over a freshly issued LIVE authority context, exactly as an
// Object Environment host would build it.
function requireFor(runtime, grants) {
  const context = runtime.authority.issue({principal: 'alice', grants});
  return (demand) => runtime.authority.require(context, demand);
}

const readGrant = (imageId, objectId) => ({
  operation: OBJECT_READ_OPERATION,
  resource: objectResource(imageId, objectId),
});

const methodPositionGrant = (imageId, classRef, selector) => ({
  operation: SMALLTALK_METHOD_READ_OPERATION,
  resource: smalltalkMethodPositionResource(imageId, classRef, selector),
});

// Two native classes with a real inheritance edge, real instance state and real methods on each.
async function declareNativeClasses(runtime) {
  const base = await ensureClassFromDeclaration({
    images: runtime.images, imageId: 'app', name: 'BrowseBase', instanceVariables: ['baseValue'],
  });
  const child = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId: 'app',
    name: 'BrowseChild',
    superclassRef: base.classRef,
    instanceVariables: ['childFirst', 'childSecond'],
  });
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    classRef: base.classRef,
    methods: [{selector: 'baseValue', source: '[ ^baseValue ]'}],
  });
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: 'app',
    classRef: child.classRef,
    // Deliberately declared in NON-alphabetical order, so the canonical selector order in the
    // description is observably a decision rather than an accident of insertion.
    methods: [
      {selector: 'childSecond', source: '[ ^childSecond ]'},
      {selector: 'childFirst', source: '[ ^childFirst ]'},
    ],
  });
  return {base, child};
}

// Nothing that is a storage-layout fact may appear anywhere in a description, at any depth.
// Behavior slot ids, MethodDictionary representation, instance-Shape ids and the backend version
// are each spelled out rather than approximated, so a future field that leaks one goes red here.
//
// Unambiguous storage prefixes/forms are checked across the entire serialized description; bare
// English words (`buckets`, `tally`, `oop`, `JSON`, `cuis`, `Cuis`) are checked after redacting
// caller-controlled identifiers (class name, selector names, declared instance-variable names,
// retained method source, and the `<ClassName>` / `/method/<base64url>` segments of native refs) so
// legitimate user names like `buckets`, `tally`, `asJSON` or base64url segments containing `oop`
// never trigger false-positive storage-leak failures (bead lagrange-images-jtz.4).
const FORBIDDEN_UNAMBIGUOUS_IN_DESCRIPTION = [
  '_version',
  'behavior-name', 'behavior-superclass', 'behavior-methods', 'behavior-instance-shape', 'behavior-',
  'method-dictionary-tally', 'method-dictionary-shape', 'method-dictionary', 'selector:',
  'instance-shape', 'instance-slot', '/methods',
  'cuis-class/', 'cuis-method/', 'gitblob',
];

const FORBIDDEN_STRUCTURAL_TOKENS = [
  ...FORBIDDEN_UNAMBIGUOUS_IN_DESCRIPTION,
  'buckets', 'tally', 'oop', 'JSON', 'cuis', 'Cuis',
];

function redactCallerControlledRef(ref) {
  if (!ref || typeof ref !== 'object' || typeof ref.objectId !== 'string') return ref;
  const redactedObjectId = ref.objectId.replace(
    /^smalltalk\/(class|metaclass)\/[A-Za-z_][A-Za-z0-9_]*(\/method\/[A-Za-z0-9_-]+)?$/,
    (_match, kind, methodPart) => `smalltalk/${kind}/<class>${methodPart ? '/method/<selector>' : ''}`,
  );
  return {...ref, objectId: redactedObjectId};
}

function stripCallerControlledDescriptionText(description) {
  if (!description || typeof description !== 'object') return description;
  const clone = structuredClone(description);
  if (typeof clone.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(clone.name)) {
    clone.name = '<class>';
  }
  if (typeof clone.selector === 'string' && !clone.selector.startsWith('selector:')) {
    clone.selector = '<selector>';
  }
  if (Array.isArray(clone.selectors)) {
    clone.selectors = clone.selectors.map((s) => (
      typeof s === 'string' && !s.startsWith('selector:') ? '<selector>' : s
    ));
  }
  if (typeof clone.source === 'string') {
    clone.source = '<source>';
  }
  if (clone.layout && typeof clone.layout === 'object' && Array.isArray(clone.layout.instanceVariables)) {
    clone.layout.instanceVariables = clone.layout.instanceVariables.map((v) => (
      typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? '<ivar>' : v
    ));
  }
  for (const refKey of ['class', 'superclass', 'classSide', 'method']) {
    if (clone[refKey]) clone[refKey] = redactCallerControlledRef(clone[refKey]);
  }
  return clone;
}

function assertNoStorageLayout(description, label) {
  const rawText = JSON.stringify(description);
  for (const token of FORBIDDEN_UNAMBIGUOUS_IN_DESCRIPTION) {
    assert.equal(rawText.includes(token), false, `${label} must not expose ${token}: ${rawText}`);
  }
  const structuralText = JSON.stringify(stripCallerControlledDescriptionText(description));
  for (const token of FORBIDDEN_STRUCTURAL_TOKENS) {
    assert.equal(structuralText.includes(token), false, `${label} must not expose ${token}: ${rawText}`);
  }
}

test('an authorized class browse answers ordinary native facts and no storage layout', async () => {
  await withImage(async (runtime) => {
    const {base, child} = await declareNativeClasses(runtime);

    const description = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: child.classRef,
      require: requireFor(runtime, [readGrant('app', child.classRef.objectId)]),
    });

    assert.deepEqual(Object.keys(description).sort(), [
      'class', 'classSide', 'format', 'layout', 'name', 'provenance', 'selectors', 'side', 'superclass',
    ]);
    assert.equal(description.format, SMALLTALK_CLASS_DESCRIPTION_V1);
    // Exact ref identity: the description's subject is the very ref the caller named, which is also
    // the ref the class builder and the native-import adapter hand out.
    assert.deepEqual(description.class, child.classRef);
    assert.equal(description.name, 'BrowseChild');
    assert.equal(description.side, 'instance');
    assert.deepEqual(description.superclass, base.classRef);
    assert.deepEqual(description.classSide, child.metaclassRef);
    // The complete native instance layout, inherited slots included and in layout order — names
    // only, never slot ids.
    assert.deepEqual(description.layout, {
      instanceVariables: ['baseValue', 'childFirst', 'childSecond'],
      indexed: 'none',
    });
    // Canonical order, NOT the order the methods were defined in.
    assert.deepEqual(description.selectors, ['childFirst', 'childSecond']);
    assert.equal(description.provenance, null, 'Images owns no durable provenance association today');

    assert.ok(Object.isFrozen(description));
    assert.ok(Object.isFrozen(description.selectors));
    assert.ok(Object.isFrozen(description.layout));
    assert.ok(Object.isFrozen(description.layout.instanceVariables));
    assertNoStorageLayout(description, 'class description');
  });
});

test('a class browse answers what the class itself implements, never what it inherits', async () => {
  await withImage(async (runtime) => {
    const {base, child} = await declareNativeClasses(runtime);

    const childDescription = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'app', classRef: child.classRef,
      require: requireFor(runtime, [readGrant('app', child.classRef.objectId)]),
    });
    // `baseValue` is reachable from a BrowseChild instance by ordinary lookup, and it is still not
    // BrowseChild's fact: reporting it would let one grant speak for an object the caller was never
    // authorized to read.
    assert.equal(childDescription.selectors.includes('baseValue'), false);

    const baseDescription = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'app', classRef: base.classRef,
      require: requireFor(runtime, [readGrant('app', base.classRef.objectId)]),
    });
    assert.deepEqual(baseDescription.selectors, ['baseValue']);
    assert.equal(baseDescription.superclass.objectId, 'smalltalk/class/Object');
  });
});

test('the class side is an ordinary Behavior browsed through the same seam', async () => {
  await withImage(async (runtime) => {
    const {base, child} = await declareNativeClasses(runtime);
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: child.metaclassRef,
      methods: [{selector: 'describe', source: '[ ^7 ]'}],
    });

    const description = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'app', classRef: child.metaclassRef,
      require: requireFor(runtime, [readGrant('app', child.metaclassRef.objectId)]),
    });
    assert.equal(description.name, 'BrowseChild class');
    assert.equal(description.side, 'class');
    // The metaclass chain follows the instance chain (kernel decision 4); a Metaclass has no
    // further class side of its own.
    assert.deepEqual(description.superclass, base.metaclassRef);
    assert.equal(description.classSide, null);
    // A Metaclass declares no instance layout at all. That is `null`, and it is a different answer
    // from a class whose declared layout happens to be empty.
    assert.equal(description.layout, null);
    assert.deepEqual(description.selectors, ['describe']);
  });
});

test('a class declaring no instance variables has an EMPTY layout, not an absent one', async () => {
  await withImage(async (runtime) => {
    const plain = await ensureClassFromDeclaration({
      images: runtime.images, imageId: 'app', name: 'BrowsePlain', instanceVariables: [],
    });
    const description = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'app', classRef: plain.classRef,
      require: requireFor(runtime, [readGrant('app', plain.classRef.objectId)]),
    });
    assert.deepEqual(description.layout, {instanceVariables: [], indexed: 'none'});
  });
});

test('an authorized method browse answers the native method, and absent source/provenance truthfully', async () => {
  await withImage(async (runtime) => {
    const {child} = await declareNativeClasses(runtime);
    const bindings = await methodBindings({images: runtime.images, imageId: 'app', classRef: child.classRef});
    const binding = bindings.find(({selector}) => selector === 'childFirst');

    const description = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: child.classRef,
      selector: 'childFirst',
      require: requireFor(runtime, [
        readGrant('app', child.classRef.objectId),
        methodPositionGrant('app', child.classRef, 'childFirst'),
      ]),
    });

    assert.deepEqual(Object.keys(description).sort(), [
      'class', 'format', 'method', 'provenance', 'selector', 'side', 'source',
    ]);
    assert.equal(description.format, SMALLTALK_METHOD_DESCRIPTION_V1);
    assert.deepEqual(description.class, child.classRef);
    assert.equal(description.selector, 'childFirst');
    assert.equal(description.side, 'instance');
    // Exact ref equality with the binding the class builder owns — the seam reports the method, it
    // does not mint a second identity for it.
    assert.deepEqual(description.method, binding.method);
    // Absent, not empty. The class builder installs a method's semantic program and keeps no
    // durable text it was compiled from, and no durable Cuis association exists either; the seam
    // says so rather than reconstructing one.
    assert.equal(description.source, null);
    assert.equal(description.provenance, null);
    assert.ok(Object.isFrozen(description));
    assertNoStorageLayout(description, 'method description');
  });
});

test('a class-side method browses as side "class" through the same seam', async () => {
  await withImage(async (runtime) => {
    const {child} = await declareNativeClasses(runtime);
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: child.metaclassRef, methods: [{selector: 'describe', source: '[ ^7 ]'}],
    });
    const description = await authorizedDescribeSmalltalkMethod({
      images: runtime.images, imageId: 'app', classRef: child.metaclassRef, selector: 'describe',
      require: requireFor(runtime, [
        readGrant('app', child.metaclassRef.objectId),
        methodPositionGrant('app', child.metaclassRef, 'describe'),
      ]),
    });
    assert.equal(description.side, 'class');
    assert.deepEqual(description.class, child.metaclassRef);
  });
});

test('CLASS authority is not METHOD authority: the logical position needs its own grant', async () => {
  await withImage(async (runtime) => {
    const {child} = await declareNativeClasses(runtime);
    const [binding] = await methodBindings({images: runtime.images, imageId: 'app', classRef: child.classRef});

    const classOnly = requireFor(runtime, [readGrant('app', child.classRef.objectId)]);
    // The class grant DOES authorize the class's own protocol: the selector list comes from the
    // class's own MethodDictionary, which is the Class's storage representation.
    const description = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'app', classRef: child.classRef, require: classOnly,
    });
    assert.ok(description.selectors.includes(binding.selector));
    // It does NOT authorize the method behind a selector. The logical position has an independent
    // semantic read operation, so this is exactly the transitive ref-follow ADR 0039 §2 refuses.
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images: runtime.images, imageId: 'app', classRef: child.classRef,
        selector: binding.selector, require: classOnly,
      }),
      (error) => error?.name === 'AuthorityError',
    );

    // The position grant alone is not enough either: the class check comes first.
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images: runtime.images, imageId: 'app', classRef: child.classRef, selector: binding.selector,
        require: requireFor(runtime, [methodPositionGrant('app', child.classRef, binding.selector)]),
      }),
      (error) => error?.name === 'AuthorityError',
    );

    // Both grants together, and only then, describe the method.
    const both = await authorizedDescribeSmalltalkMethod({
      images: runtime.images, imageId: 'app', classRef: child.classRef, selector: binding.selector,
      require: requireFor(runtime, [
        readGrant('app', child.classRef.objectId),
        methodPositionGrant('app', child.classRef, binding.selector),
      ]),
    });
    assert.deepEqual(both.method, binding.method);
  });
});

test('authority never follows a superclass, class-side or method ref out of the described class', async () => {
  await withImage(async (runtime) => {
    const {base, child} = await declareNativeClasses(runtime);
    const childOnly = requireFor(runtime, [readGrant('app', child.classRef.objectId)]);
    const description = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'app', classRef: child.classRef, require: childOnly,
    });

    // The description hands out locators, not authority. Browsing either of them is a new grant.
    for (const ref of [description.superclass, description.classSide]) {
      await assert.rejects(
        authorizedDescribeSmalltalkClass({images: runtime.images, imageId: 'app', classRef: ref, require: childOnly}),
        (error) => error?.name === 'AuthorityError',
        `browsing ${ref.objectId} must need its own object/read`,
      );
    }
    // And the superclass IS browsable with its own grant, so the refusal above is authority, not a
    // structural inability to describe it.
    assert.equal(
      (await authorizedDescribeSmalltalkClass({
        images: runtime.images, imageId: 'app', classRef: base.classRef,
        require: requireFor(runtime, [readGrant('app', base.classRef.objectId)]),
      })).name,
      'BrowseBase',
    );
  });
});

test('a WRITE grant on the class is not a read grant', async () => {
  await withImage(async (runtime) => {
    const {child} = await declareNativeClasses(runtime);
    await assert.rejects(
      authorizedDescribeSmalltalkClass({
        images: runtime.images, imageId: 'app', classRef: child.classRef,
        require: requireFor(runtime, [{
          operation: OBJECT_WRITE_OPERATION,
          resource: objectResource('app', child.classRef.objectId),
        }]),
      }),
      (error) => error?.name === 'AuthorityError',
    );
  });
});

test('NO-EXISTENCE-ORACLE: denied browsing of existing and missing classes is indistinguishable', async () => {
  await withImage(async (runtime) => {
    const {child} = await declareNativeClasses(runtime);
    const missing = objectRef('app', 'smalltalk/class/BrowseNeverDeclared');
    const denied = requireFor(runtime, []);

    for (const [label, ref] of [['existing', child.classRef], ['missing', missing]]) {
      await assert.rejects(
        authorizedDescribeSmalltalkClass({images: runtime.images, imageId: 'app', classRef: ref, require: denied}),
        (error) => error?.name === 'AuthorityError',
        `a denied ${label} class browse is AuthorityError, never not-found`,
      );
      await assert.rejects(
        authorizedDescribeSmalltalkMethod({
          images: runtime.images, imageId: 'app', classRef: ref, selector: 'childFirst', require: denied,
        }),
        (error) => error?.name === 'AuthorityError',
        `a denied ${label} method browse is AuthorityError, never not-found`,
      );
    }

    // A denied caller also cannot probe SELECTORS: an implemented and an unimplemented selector on
    // an existing class fail identically.
    for (const selector of ['childFirst', 'neverImplemented']) {
      await assert.rejects(
        authorizedDescribeSmalltalkMethod({
          images: runtime.images, imageId: 'app', classRef: child.classRef, selector, require: denied,
        }),
        (error) => error?.name === 'AuthorityError',
      );
    }

    // Existence is disclosed only to a caller who may read the thing: an AUTHORIZED browse of a
    // missing class, and of an unimplemented selector, says so. That is what makes the refusals
    // above authority ordering rather than a uniformly useless lane.
    await assert.rejects(
      authorizedDescribeSmalltalkClass({
        images: runtime.images, imageId: 'app', classRef: missing,
        require: requireFor(runtime, [readGrant('app', missing.objectId)]),
      }),
      (error) => error?.name === 'TypeError' && /behavior not found/.test(error.message),
    );
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images: runtime.images, imageId: 'app', classRef: child.classRef, selector: 'neverImplemented',
        require: requireFor(runtime, [
          readGrant('app', child.classRef.objectId),
          methodPositionGrant('app', child.classRef, 'neverImplemented'),
        ]),
      }),
      (error) => error?.name === 'TypeError' && /does not implement neverImplemented/.test(error.message),
    );
  });
});

test('malformed caller input is refused before anything is read, so it discloses nothing', async () => {
  await withImage(async (runtime) => {
    const {child} = await declareNativeClasses(runtime);
    const granted = requireFor(runtime, [readGrant('app', child.classRef.objectId)]);
    // A ref in another image is not this image's class, and saying so needs no read at all.
    await assert.rejects(
      authorizedDescribeSmalltalkClass({
        images: runtime.images, imageId: 'app', classRef: objectRef('other', child.classRef.objectId), require: granted,
      }),
      /classRef must be an unpinned object ref in app/,
    );
    // The require function is mandatory: there is no unauthorized browse entry point.
    await assert.rejects(
      authorizedDescribeSmalltalkClass({images: runtime.images, imageId: 'app', classRef: child.classRef}),
      /requires a require\(demand\) authority-check function/,
    );
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images: runtime.images, imageId: 'app', classRef: child.classRef, selector: 'childFirst',
      }),
      /requires a require\(demand\) authority-check function/,
    );
  });
});

// The Cuis-imported half of the seam. The manifest is the canonical semantic export format the
// import adapter consumes; no Cuis VM, provider or toolchain exists in this runtime.
const CUIS_MANIFEST = Object.freeze({
  format: CUIS_SEMANTIC_EXPORT_V2,
  packages: [{name: 'Fixture', requires: ['Cuis-Base']}],
  classes: [{
    identity: 'cuis-class/Fixture/BrowseImported',
    package: 'Fixture',
    name: 'BrowseImported',
    superclassName: 'Object',
    superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
    instanceVariables: ['baseValue'],
    classVariables: [],
  }],
  methods: [{
    identity: 'cuis-method/Fixture/BrowseImported/instance/baseValue',
    package: 'Fixture',
    class: 'cuis-class/Fixture/BrowseImported',
    side: 'instance',
    selector: 'baseValue',
    source: 'baseValue\n\t^ baseValue',
  }],
});

test('an imported-native class browses through the same seam, with no Cuis identity in the result', async () => {
  await withImage(async (runtime) => {
    const imported = await importCuisNativePackage({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app', manifest: CUIS_MANIFEST,
    });
    const {classRef} = imported.classes[0];
    // A hand-declared native class with the same declared shape and the same method, for a direct
    // comparison of the two descriptions.
    const declared = await ensureClassFromDeclaration({
      images: runtime.images, imageId: 'app', name: 'BrowseDeclared', instanceVariables: ['baseValue'],
    });
    await defineMethodsFromSource({
      images: runtime.images, compilation: runtime.compilation, imageId: 'app',
      classRef: declared.classRef, methods: [{selector: 'baseValue', source: '[ ^baseValue ]'}],
    });

    const describe = async (ref) => await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: 'app', classRef: ref,
      require: requireFor(runtime, [readGrant('app', ref.objectId)]),
    });
    const importedDescription = await describe(classRef);
    const declaredDescription = await describe(declared.classRef);

    // ONE public seam: not a Cuis-aware overload, not a second lane selected by origin. Everything
    // except the class's own name and refs is identical.
    assert.deepEqual(Object.keys(importedDescription).sort(), Object.keys(declaredDescription).sort());
    assert.deepEqual(
      {...importedDescription, class: null, classSide: null, name: null},
      {...declaredDescription, class: null, classSide: null, name: null},
    );
    assert.equal(importedDescription.name, 'BrowseImported');
    assert.equal(importedDescription.side, 'instance');
    assert.deepEqual(importedDescription.layout, {instanceVariables: ['baseValue'], indexed: 'none'});
    assert.deepEqual(importedDescription.selectors, ['baseValue']);
    // Cuis origin is not native identity and does not leak: no semantic identity, package name or
    // export format appears anywhere in the description.
    const text = JSON.stringify(importedDescription);
    for (const token of ['cuis', 'Cuis', 'Fixture', 'oop']) {
      assert.equal(text.includes(token), false, `imported class description must not carry ${token}: ${text}`);
    }
    assert.equal(importedDescription.provenance, null);
    assertNoStorageLayout(importedDescription, 'imported class description');

    // The same holds one level down: the imported method browses like any other native method.
    const [binding] = await methodBindings({images: runtime.images, imageId: 'app', classRef});
    const method = await authorizedDescribeSmalltalkMethod({
      images: runtime.images, imageId: 'app', classRef, selector: 'baseValue',
      require: requireFor(runtime, [
        readGrant('app', classRef.objectId),
        methodPositionGrant('app', classRef, 'baseValue'),
      ]),
    });
    assert.equal(method.selector, 'baseValue');
    assert.equal(method.side, 'instance');
    assert.deepEqual(method.method, binding.method);
    assert.equal(method.source, null, 'no durable native method source exists for an imported method either');
    assert.equal(method.provenance, null);
    assert.equal(JSON.stringify(method).includes('cuis'), false);
  });
});

test('the browsing seam has no Cuis, toolchain, foreign-runtime or Project module in its static closure', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const {modules, violations} = collectStaticModuleClosure({
    entry: 'src/language/smalltalk-browse.js',
    readSource: createNodeSourceReader(repo),
  });
  const paths = modules.map(({path}) => path);
  assert.ok(paths.includes('src/language/smalltalk-browse.js'));

  // No Cuis provider, adapter or toolchain can participate in a browse, and no Object Environment
  // concept (Perspective, Session, presentation, browser UI) enters Images to make one work.
  const forbidden = paths.filter((path) => /(cuis|toolchain|foreign-runtime|perspective|session|presentation|environment)/i.test(path));
  assert.deepEqual(forbidden, []);
  // Nor does browsing a native class drag in the Project subsystem: membership is not authority and
  // is not a browsing input.
  assert.deepEqual(paths.filter((path) => path.startsWith('src/project/')), []);
  assert.deepEqual(violations, [], 'the seam stays portable: no node:* import on the browsing lane');
});

test('retained native and Cuis-imported methods answer durable source through both browse seams and never leak stale source across revisions', async () => {
  await withImage(async (runtime) => {
    const declared = await ensureClassFromDeclaration({
      images: runtime.images, imageId: 'app', name: 'BrowseRetained', instanceVariables: ['baseValue'],
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: declared.classRef,
      retainSource: true,
      methods: [{selector: 'baseValue', source: '[ ^baseValue ]'}],
    });

    const grants = [
      readGrant('app', declared.classRef.objectId),
      methodPositionGrant('app', declared.classRef, 'baseValue'),
    ];
    const described = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'baseValue',
      require: requireFor(runtime, grants),
    });
    assert.equal(described.source, '[ ^baseValue ]');

    const forUpdate = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'baseValue',
      require: requireFor(runtime, grants),
    });
    assert.equal(forUpdate.descriptor.source, '[ ^baseValue ]');

    const sourceArtifact = await runtime.images.getCodeArtifact('app', `${described.method.objectId}:source`);
    const semanticArtifact = await runtime.images.getCodeArtifact('app', `${described.method.objectId}:semantic`);
    assert.equal(sourceArtifact.representation, SYMMETRIC_SMALLTALK_SOURCE_V0);
    assert.deepEqual(semanticArtifact.derivedFrom, [objectRef('app', `${described.method.objectId}:source`)]);

    // Denied method-position read never touches the durable source artifact.
    const seenArtifacts = [];
    const originalGetCodeArtifact = runtime.images.getCodeArtifact.bind(runtime.images);
    runtime.images.getCodeArtifact = async (imageId, artifactId) => {
      seenArtifacts.push(artifactId);
      return await originalGetCodeArtifact(imageId, artifactId);
    };
    await assert.rejects(
      async () => await authorizedDescribeSmalltalkMethod({
        images: runtime.images,
        imageId: 'app',
        classRef: declared.classRef,
        selector: 'baseValue',
        require: requireFor(runtime, [readGrant('app', declared.classRef.objectId)]),
      }),
      {name: 'AuthorityError'},
    );
    assert.deepEqual(seenArtifacts, []);
    runtime.images.getCodeArtifact = originalGetCodeArtifact;

    // Replacing with retainSource: true advances the revision and updates the durable source.
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: declared.classRef,
      retainSource: true,
      methods: [{selector: 'baseValue', source: '[ ^42 ]', expectedCurrent: described.method}],
    });
    const updated = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'baseValue',
      require: requireFor(runtime, grants),
    });
    assert.notDeepEqual(updated.method, described.method);
    assert.equal(updated.source, '[ ^42 ]');

    // Replacing WITHOUT retainSource creates a fresh unretained revision and resets source to null (no stale source).
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: declared.classRef,
      methods: [{selector: 'baseValue', source: '[ ^99 ]', expectedCurrent: updated.method}],
    });
    const unretained = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'baseValue',
      require: requireFor(runtime, grants),
    });
    assert.notDeepEqual(unretained.method, updated.method);
    assert.equal(unretained.source, null);

    // Imported Cuis package with retainSource: true also persists durable source on its imported methods.
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      manifest: CUIS_MANIFEST,
      retainSource: true,
    });
    const importedClassRef = imported.classes[0].classRef;
    const importedMethod = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: importedClassRef,
      selector: 'baseValue',
      require: requireFor(runtime, [
        readGrant('app', importedClassRef.objectId),
        methodPositionGrant('app', importedClassRef, 'baseValue'),
      ]),
    });
    assert.equal(importedMethod.source, '[\n^ baseValue.\nself\n]');
  });
});

test('a missing, cross-image, dangling or non-Metaclass behavior edge is reported as corrupt to an authorized caller and hidden behind AuthorityError for a denied caller', async () => {
  await withImage(async (runtime) => {
    const {base, child} = await declareNativeClasses(runtime);
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: child.metaclassRef,
      methods: [{selector: 'describe', source: '[ ^7 ]'}],
    });

    const originalClassRecord = await runtime.images.getObject('app', child.classRef.objectId);
    const originalMetaclassRecord = await runtime.images.getObject('app', child.metaclassRef.objectId);

    const rewriteBehaviorEdge = async (record, newBehavior) => {
      const current = await runtime.images.getObject('app', record.id);
      await runtime.images.putObject('app', {
        id: current.id,
        shape: current.shape,
        ...(newBehavior === null ? {} : {behavior: newBehavior}),
        slots: current.slots,
        metadata: current.metadata,
      }, {expectedVersion: current._version});
    };

    const classGrants = [
      readGrant('app', child.classRef.objectId),
      methodPositionGrant('app', child.classRef, 'childFirst'),
    ];
    const metaclassGrants = [
      readGrant('app', child.metaclassRef.objectId),
      methodPositionGrant('app', child.metaclassRef, 'describe'),
    ];
    const denied = requireFor(runtime, []);

    for (const [label, targetRecord, targetRef, selector, grants, corruptEdge, expectedPattern] of [
      [
        'missing behavior edge on class',
        originalClassRecord,
        child.classRef,
        'childFirst',
        classGrants,
        null,
        /behavior must be an unpinned ref in app/,
      ],
      [
        'cross-image behavior edge on class',
        originalClassRecord,
        child.classRef,
        'childFirst',
        classGrants,
        objectRef('other', child.metaclassRef.objectId),
        /behavior must be an unpinned ref in app/,
      ],
      [
        'dangling behavior edge on class',
        originalClassRecord,
        child.classRef,
        'childFirst',
        classGrants,
        objectRef('app', 'smalltalk/metaclass/Vanished'),
        /has a dangling behavior edge/,
      ],
      [
        'Metaclass with behavior edge corrupted to an instance-side class',
        originalMetaclassRecord,
        child.metaclassRef,
        'describe',
        metaclassGrants,
        base.classRef,
        /is not an instance of Metaclass/,
      ],
    ]) {
      await rewriteBehaviorEdge(targetRecord, corruptEdge);

      // 1. Denied caller still learns only AuthorityError (no corruption/existence oracle).
      await assert.rejects(
        authorizedDescribeSmalltalkClass({
          images: runtime.images, imageId: 'app', classRef: targetRef, require: denied,
        }),
        {name: 'AuthorityError'},
        `${label}: denied class browse must remain AuthorityError`,
      );
      await assert.rejects(
        authorizedDescribeSmalltalkMethod({
          images: runtime.images, imageId: 'app', classRef: targetRef, selector, require: denied,
        }),
        {name: 'AuthorityError'},
        `${label}: denied method browse must remain AuthorityError`,
      );

      // 2. Authorized caller receives a corruption error instead of normalizing to instance-side.
      const authorized = requireFor(runtime, grants);
      await assert.rejects(
        authorizedDescribeSmalltalkClass({
          images: runtime.images, imageId: 'app', classRef: targetRef, require: authorized,
        }),
        expectedPattern,
        `${label}: authorized class browse must report corruption`,
      );
      await assert.rejects(
        authorizedDescribeSmalltalkMethod({
          images: runtime.images, imageId: 'app', classRef: targetRef, selector, require: authorized,
        }),
        expectedPattern,
        `${label}: authorized method browse must report corruption`,
      );
      await assert.rejects(
        authorizedReadSmalltalkMethodForUpdate({
          images: runtime.images, imageId: 'app', classRef: targetRef, selector, require: authorized,
        }),
        expectedPattern,
        `${label}: authorized method-for-update read must report corruption`,
      );

      // Restore before next arm.
      await rewriteBehaviorEdge(targetRecord, targetRecord.behavior);
    }
  });
});

test('the no-storage-layout scan accepts caller-controlled names containing buckets/tally/oop/JSON while still rejecting every real storage or Cuis-identity leak', async () => {
  await withImage(async (runtime) => {
    const declared = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'JSONBucketTallyOop',
      instanceVariables: ['buckets', 'tally', 'oopValue'],
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: declared.classRef,
      retainSource: true,
      methods: [
        {selector: 'buckets', source: '[ ^buckets ]'},
        {selector: 'tally', source: '[ ^tally ]'},
        {selector: 'asJSONWithOop', source: '[ ^oopValue ]'},
      ],
    });

    const classDescription = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      require: requireFor(runtime, [readGrant('app', declared.classRef.objectId)]),
    });
    assertNoStorageLayout(classDescription, 'class with buckets/tally/oop/JSON names');

    const methodDescription = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'asJSONWithOop',
      require: requireFor(runtime, [
        readGrant('app', declared.classRef.objectId),
        methodPositionGrant('app', declared.classRef, 'asJSONWithOop'),
      ]),
    });
    assertNoStorageLayout(methodDescription, 'method with buckets/tally/oop/JSON names');
    // Also accepts an encoded method id whose base64url segment happens to contain "oop".
    assertNoStorageLayout({
      ...methodDescription,
      method: objectRef('app', `${declared.classRef.objectId}/method/oop_segment_test`),
    }, 'method ref with oop in encoded selector id');

    // Falsification: every real storage-layout or Cuis-identity leak still fails the scan.
    for (const [label, leaked] of [
      ['Behavior slot id', {...classDescription, leakedSlot: 'behavior-methods'}],
      ['MethodDictionary field buckets', {...classDescription, buckets: []}],
      ['MethodDictionary field tally', {...classDescription, tally: 3}],
      ['MethodDictionary object id', {...classDescription, classSide: objectRef('app', 'smalltalk/class/Foo/methods')}],
      ['backend _version', {...classDescription, _version: 1}],
      ['instance-Shape id', {...classDescription, layout: {...classDescription.layout, shape: 'instance-shape'}}],
      ['raw instance-slot id', {...classDescription, layout: {...classDescription.layout, instanceVariables: ['instance-slot:buckets']}}],
      ['Cuis semantic class identity', {...classDescription, class: objectRef('app', 'cuis-class/JSON/Json')}],
      ['Cuis semantic method identity', {...methodDescription, method: objectRef('app', 'cuis-method/JSON/Json/instance/readFrom:')}],
      ['Cuis provenance leak', {...classDescription, provenance: {package: 'JSON', oop: 42}}],
    ]) {
      assert.throws(
        () => assertNoStorageLayout(leaked, label),
        /must not expose/,
        `${label} must still fail the scan`,
      );
    }
  });
});

test('authorized class and method browsing each perform a single kernel read, and methodBlockRef probes single selectors with unchanged corruption checks', async () => {
  await withImage(async (runtime) => {
    const { child } = await declareNativeClasses(runtime);

    let kernelReads = 0;
    const countingImages = new Proxy(runtime.images, {
      get(target, key) {
        const value = target[key];
        if (key === 'getObject') {
          return (imageId, objectId) => {
            if (objectId === 'smalltalk-kernel/v1') kernelReads += 1;
            return value.call(target, imageId, objectId);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    kernelReads = 0;
    const classDesc = await authorizedDescribeSmalltalkClass({
      images: countingImages,
      imageId: 'app',
      classRef: child.classRef,
      require: requireFor(runtime, [readGrant('app', child.classRef.objectId)]),
    });
    assert.equal(kernelReads, 1, 'authorizedDescribeSmalltalkClass must read smalltalk-kernel/v1 once');
    assert.deepEqual(classDesc.selectors, ['childFirst', 'childSecond']);

    kernelReads = 0;
    const methodDesc = await authorizedDescribeSmalltalkMethod({
      images: countingImages,
      imageId: 'app',
      classRef: child.classRef,
      selector: 'childFirst',
      require: requireFor(runtime, [
        readGrant('app', child.classRef.objectId),
        methodPositionGrant('app', child.classRef, 'childFirst'),
      ]),
    });
    assert.equal(kernelReads, 1, 'authorizedDescribeSmalltalkMethod must read smalltalk-kernel/v1 once');
    assert.equal(methodDesc.selector, 'childFirst');
  });
});

test('retained native and Cuis-imported class/method provenance and category are durable, revision-bound, and never disclosed without authority', async () => {
  await withImage(async (runtime) => {
    const declared = await ensureClassFromDeclaration({
      images: runtime.images,
      imageId: 'app',
      name: 'ProvenancedCounter',
      instanceVariables: ['count'],
      provenance: {package: 'Core-Counters', category: 'Counters-Model'},
    });
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: declared.classRef,
      retainSource: true,
      methods: [
        {
          selector: 'count',
          source: '[ ^count ]',
          category: 'accessing',
          provenance: {package: 'Core-Counters'},
        },
      ],
    });

    const classGrants = [
      readGrant('app', declared.classRef.objectId),
      readGrant('app', declared.metaclassRef.objectId),
    ];
    const methodGrants = [
      ...classGrants,
      methodPositionGrant('app', declared.classRef, 'count'),
    ];

    const classDesc = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      require: requireFor(runtime, classGrants),
    });
    assert.deepEqual(classDesc.provenance, {
      package: 'Core-Counters',
      category: 'Counters-Model',
    });

    const metaclassDesc = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.metaclassRef,
      require: requireFor(runtime, classGrants),
    });
    assert.deepEqual(metaclassDesc.provenance, {
      package: 'Core-Counters',
      category: 'Counters-Model',
    });

    // Denied method-position browse (having only class object/read) discloses neither source nor provenance.
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images: runtime.images,
        imageId: 'app',
        classRef: declared.classRef,
        selector: 'count',
        require: requireFor(runtime, classGrants),
      }),
      {name: 'AuthorityError'},
    );

    const methodDesc = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'count',
      require: requireFor(runtime, methodGrants),
    });
    assert.equal(methodDesc.source, '[ ^count ]');
    assert.deepEqual(methodDesc.provenance, {
      package: 'Core-Counters',
      category: 'accessing',
    });

    // Replacing the method with a new category/provenance updates the durable provenance on the new revision.
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: declared.classRef,
      retainSource: true,
      methods: [
        {
          selector: 'count',
          source: '[ ^count + 1 ]',
          category: 'computing',
          provenance: {package: 'Core-Counters', file: 'ProvenancedCounter>>count'},
          expectedCurrent: methodDesc.method,
        },
      ],
    });
    const updatedMethodDesc = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'count',
      require: requireFor(runtime, methodGrants),
    });
    assert.notDeepEqual(updatedMethodDesc.descriptor.method, methodDesc.method);
    assert.deepEqual(updatedMethodDesc.descriptor.provenance, {
      package: 'Core-Counters',
      category: 'computing',
      file: 'ProvenancedCounter>>count',
    });

    // Replacing the method without category/provenance resets provenance to null (never stale).
    await reconcileMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      classRef: declared.classRef,
      methods: [
        {
          selector: 'count',
          source: '[ ^0 ]',
          expectedCurrent: updatedMethodDesc.descriptor.method,
        },
      ],
    });
    const clearedMethodDesc = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: declared.classRef,
      selector: 'count',
      require: requireFor(runtime, methodGrants),
    });
    assert.equal(clearedMethodDesc.provenance, null);
    assert.equal(clearedMethodDesc.source, null);

    // Cuis import with retainProvenance: true retains durable package and category provenance on classes and methods.
    const manifestWithCategories = {
      format: CUIS_SEMANTIC_EXPORT_V2,
      packages: [{name: 'ProvenancePkg', requires: []}],
      classes: [
        {
          identity: 'cuis-class/ProvenancePkg/ProvWidget',
          package: 'ProvenancePkg',
          name: 'ProvWidget',
          superclassName: 'Object',
          superclass: CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
          instanceVariables: ['label'],
          classVariables: [],
          category: 'ProvenancePkg-Widgets',
        },
      ],
      methods: [
        {
          identity: 'cuis-method/ProvenancePkg/ProvWidget/instance/label',
          package: 'ProvenancePkg',
          class: 'cuis-class/ProvenancePkg/ProvWidget',
          side: 'instance',
          selector: 'label',
          category: 'accessing',
          source: 'label\n\t^ label',
        },
        {
          identity: 'cuis-method/ProvenancePkg/ProvWidget/class/defaultLabel',
          package: 'ProvenancePkg',
          class: 'cuis-class/ProvenancePkg/ProvWidget',
          side: 'class',
          selector: 'defaultLabel',
          category: 'defaults',
          source: 'defaultLabel\n\t^ 42',
        },
      ],
    };
    const imported = await importCuisNativePackage({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'app',
      manifest: manifestWithCategories,
      retainSource: true,
      retainProvenance: true,
    });
    const widgetClassRef = imported.classes[0].classRef;
    const widgetMetaclassRef = imported.classes[0].metaclassRef;
    const widgetGrants = [
      readGrant('app', widgetClassRef.objectId),
      readGrant('app', widgetMetaclassRef.objectId),
      methodPositionGrant('app', widgetClassRef, 'label'),
      methodPositionGrant('app', widgetMetaclassRef, 'defaultLabel'),
    ];
    const browsedWidgetClass = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: widgetClassRef,
      require: requireFor(runtime, widgetGrants),
    });
    assert.deepEqual(browsedWidgetClass.provenance, {
      package: 'ProvenancePkg',
      category: 'ProvenancePkg-Widgets',
    });
    const browsedWidgetMethod = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: widgetClassRef,
      selector: 'label',
      require: requireFor(runtime, widgetGrants),
    });
    assert.deepEqual(browsedWidgetMethod.provenance, {
      package: 'ProvenancePkg',
      category: 'accessing',
    });
    assert.equal(browsedWidgetMethod.source, '[\n^ label.\nself\n]');
    const browsedWidgetClassMethod = await authorizedDescribeSmalltalkMethod({
      images: runtime.images,
      imageId: 'app',
      classRef: widgetMetaclassRef,
      selector: 'defaultLabel',
      require: requireFor(runtime, widgetGrants),
    });
    assert.deepEqual(browsedWidgetClassMethod.provenance, {
      package: 'ProvenancePkg',
      category: 'defaults',
    });
  });
});
