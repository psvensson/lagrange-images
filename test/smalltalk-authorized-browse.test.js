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
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  importCuisNativePackage,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  methodBindings,
  objectRef,
  objectResource,
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
const FORBIDDEN_IN_DESCRIPTION = [
  '_version',
  'behavior-name', 'behavior-superclass', 'behavior-methods', 'behavior-instance-shape',
  'method-dictionary-tally', 'method-dictionary-shape', 'selector:', 'buckets', 'tally',
  'instance-shape', 'instance-slot', '/methods',
];

function assertNoStorageLayout(description, label) {
  const text = JSON.stringify(description);
  for (const token of FORBIDDEN_IN_DESCRIPTION) {
    assert.equal(text.includes(token), false, `${label} must not expose ${token}: ${text}`);
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
