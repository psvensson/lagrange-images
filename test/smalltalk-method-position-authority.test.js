import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  SMALLTALK_METHOD_READ_OPERATION,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  authorizedReadSmalltalkMethodForUpdate,
  authorizedReplaceSmalltalkMethod,
  createRuntime,
  defineClass,
  defineMethodsFromSource,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  objectRef,
  objectResource,
  reconcileMethodsFromSource,
  smalltalkMethodPositionResource,
} from '../src/runtime.js';

const IMAGE_ID = 'authority/image.with:separators';
const CLASS_ID = 'smalltalk/class/AuthorityProbe';
const OTHER_CLASS_ID = 'smalltalk/class/AuthorityProbeOther';
const METACLASS_ID = 'smalltalk/metaclass/AuthorityProbe';

const classGrant = (imageId, classRef) => ({
  operation: OBJECT_READ_OPERATION,
  resource: objectResource(imageId, classRef.objectId),
});

const positionGrant = (imageId, classRef, selector) => ({
  operation: SMALLTALK_METHOD_READ_OPERATION,
  resource: smalltalkMethodPositionResource(imageId, classRef, selector),
});

const writeGrant = (imageId, classRef) => ({
  operation: OBJECT_WRITE_OPERATION,
  resource: objectResource(imageId, classRef.objectId),
});

function authorityRequire(runtime, grants, principal = 'method-position-probe') {
  const context = runtime.authority.issue({principal, grants});
  return {
    context,
    require: (demand) => runtime.authority.require(context, demand),
  };
}

// Central acceptance contexts must never smuggle a physical revision grant into the fixture. This
// helper deliberately accepts a grant list so the test can prove that adding such a grant is itself
// rejected, instead of merely observing that an honest list happens to pass.
function semanticReader(runtime, imageId, classRef, selector, grants = [
  classGrant(imageId, classRef),
  positionGrant(imageId, classRef, selector),
]) {
  const expected = [classGrant(imageId, classRef), positionGrant(imageId, classRef, selector)];
  assert.deepEqual(
    grants,
    expected,
    'semantic method-read authority must contain exactly class read plus logical-position read',
  );
  return {...authorityRequire(runtime, grants), grants};
}

async function fixture() {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: IMAGE_ID});
  await installSmalltalkKernel({images: runtime.images, imageId: IMAGE_ID});
  await installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: IMAGE_ID});
  const primary = await defineClass({images: runtime.images, imageId: IMAGE_ID, name: 'AuthorityProbe'});
  const secondary = await defineClass({images: runtime.images, imageId: IMAGE_ID, name: 'AuthorityProbeOther'});
  assert.equal(primary.classRef.objectId, CLASS_ID);
  assert.equal(primary.metaclassRef.objectId, METACLASS_ID);
  assert.equal(secondary.classRef.objectId, OTHER_CLASS_ID);

  const options = {images: runtime.images, compilation: runtime.compilation, imageId: IMAGE_ID, lane: 'neutral'};
  await defineMethodsFromSource({
    ...options,
    classRef: primary.classRef,
    methods: [{selector: 'foo', source: '[ ^ 1 ]'}, {selector: 'bar', source: '[ ^ 9 ]'}],
  });
  await defineMethodsFromSource({
    ...options,
    classRef: secondary.classRef,
    methods: [{selector: 'foo', source: '[ ^ 8 ]'}],
  });
  await defineMethodsFromSource({
    ...options,
    classRef: primary.metaclassRef,
    methods: [{selector: 'foo', source: '[ ^ 7 ]'}],
  });
  return {runtime, primary, secondary, options};
}

test('method-position resource naming is pure and injective for arbitrary semantic locator text', () => {
  const triples = [
    ['a/b', 'c', 'd'],
    ['a', 'b/c', 'd'],
    ['a', 'b', 'c/d'],
    ['a.b', 'c:d', 'e/f'],
    ['å/图', 'klass.名', 'foo:bar/β'],
  ];
  const resources = triples.map(([imageId, objectId, selector]) =>
    smalltalkMethodPositionResource(imageId, objectRef(imageId, objectId), selector));
  assert.equal(new Set(resources).size, resources.length, 'adversarial separators must never alias positions');
  assert.equal(
    smalltalkMethodPositionResource('a/b', objectRef('a/b', 'c'), 'd'),
    smalltalkMethodPositionResource('a/b', objectRef('a/b', 'c'), 'd'),
    'the same public semantic locator has one canonical resource',
  );
  assert.throws(
    () => smalltalkMethodPositionResource('one', objectRef('two', 'klass'), 'foo'),
    /must be an unpinned object ref in one/,
  );
});

test('one real semantic authority context supports first read, successful reread and stale reread', async () => {
  const {runtime, primary, options} = await fixture();
  try {
    const classRef = primary.classRef;
    const reader = semanticReader(runtime, IMAGE_ID, classRef, 'foo');
    assert.deepEqual(reader.grants, [classGrant(IMAGE_ID, classRef), positionGrant(IMAGE_ID, classRef, 'foo')]);

    // A — class browsing reveals only the selector name. The same pre-nameable context then reveals
    // the physical revision for the first time through the semantic method seam.
    const classDescription = await authorizedDescribeSmalltalkClass({
      images: runtime.images, imageId: IMAGE_ID, classRef, require: reader.require,
    });
    assert.ok(classDescription.selectors.includes('foo'));
    const describedA = await authorizedDescribeSmalltalkMethod({
      images: runtime.images, imageId: IMAGE_ID, classRef, selector: 'foo', require: reader.require,
    });
    const readA = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images, imageId: IMAGE_ID, classRef, selector: 'foo', require: reader.require,
    });
    assert.deepEqual(readA.descriptor, describedA);
    const a = readA.descriptor.method;
    assert.equal(
      reader.grants.some((grant) => grant.operation === OBJECT_READ_OPERATION
        && grant.resource === objectResource(IMAGE_ID, a.objectId)),
      false,
      'Block A was not known or granted before first read',
    );
    assert.throws(
      () => semanticReader(runtime, IMAGE_ID, classRef, 'foo', [
        ...reader.grants,
        {operation: OBJECT_READ_OPERATION, resource: objectResource(IMAGE_ID, a.objectId)},
      ]),
      /must contain exactly/,
      'the acceptance rejects a hidden physical-revision grant',
    );

    // A method-position grant is not generic object authority for the Block it reveals.
    assert.throws(
      () => runtime.authority.require(reader.context, {
        operation: OBJECT_READ_OPERATION,
        resource: objectResource(IMAGE_ID, a.objectId),
      }),
      (error) => error?.name === 'AuthorityError',
    );

    // B — public replacement preserves its minimal receipt. The SAME read context discovers B;
    // neither B's identity nor a B-specific grant existed beforehand.
    const writer = authorityRequire(runtime, [writeGrant(IMAGE_ID, classRef)], 'method-writer');
    const receipt = await authorizedReplaceSmalltalkMethod({
      ...options,
      classRef,
      selector: 'foo',
      source: '[ ^ 2 ]',
      expectedVersionToken: readA.versionToken,
      require: writer.require,
    });
    assert.deepEqual(receipt, {replaced: true});
    assert.deepEqual(Object.keys(receipt), ['replaced']);
    const readB = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images, imageId: IMAGE_ID, classRef, selector: 'foo', require: reader.require,
    });
    const b = readB.descriptor.method;
    assert.notDeepEqual(b, a);
    assert.equal(reader.grants.some((grant) => grant.resource === objectResource(IMAGE_ID, b.objectId)), false);
    assert.throws(
      () => semanticReader(runtime, IMAGE_ID, classRef, 'foo', [
        ...reader.grants,
        {operation: OBJECT_READ_OPERATION, resource: objectResource(IMAGE_ID, b.objectId)},
      ]),
      /must contain exactly/,
      'the acceptance rejects a future-revision B grant',
    );

    // C — another trusted owner advances B to C. The public writer's B token is stale, and the same
    // unchanged semantic reader discovers C without any predicted revision id.
    await reconcileMethodsFromSource({
      ...options,
      classRef,
      methods: [{selector: 'foo', source: '[ ^ 3 ]', expectedCurrent: b}],
    });
    const stale = await authorizedReplaceSmalltalkMethod({
      ...options,
      classRef,
      selector: 'foo',
      source: '[ ^ 4 ]',
      expectedVersionToken: readB.versionToken,
      require: writer.require,
    }).then(() => null, (error) => error);
    assert.equal(stale?.name, 'SmalltalkStaleMethodPositionError');
    const readC = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images, imageId: IMAGE_ID, classRef, selector: 'foo', require: reader.require,
    });
    const c = readC.descriptor.method;
    assert.notDeepEqual(c, b);
    assert.equal(reader.grants.some((grant) => grant.resource === objectResource(IMAGE_ID, c.objectId)), false);
    assert.throws(
      () => semanticReader(runtime, IMAGE_ID, classRef, 'foo', [
        ...reader.grants,
        {operation: OBJECT_READ_OPERATION, resource: objectResource(IMAGE_ID, c.objectId)},
      ]),
      /must contain exactly/,
      'the acceptance rejects a future-revision C grant',
    );
    assert.deepEqual(reader.grants, [classGrant(IMAGE_ID, classRef), positionGrant(IMAGE_ID, classRef, 'foo')]);
  } finally {
    await runtime.close();
  }
});

test('method-position authority is exact across selector, class, side and image', async () => {
  const {runtime, primary, secondary} = await fixture();
  try {
    const position = positionGrant(IMAGE_ID, primary.classRef, 'foo');
    const denied = [
      {
        label: 'another selector',
        imageId: IMAGE_ID,
        classRef: primary.classRef,
        selector: 'bar',
        grants: [classGrant(IMAGE_ID, primary.classRef), position],
      },
      {
        label: 'another class',
        imageId: IMAGE_ID,
        classRef: secondary.classRef,
        selector: 'foo',
        grants: [classGrant(IMAGE_ID, secondary.classRef), position],
      },
      {
        label: 'class side',
        imageId: IMAGE_ID,
        classRef: primary.metaclassRef,
        selector: 'foo',
        grants: [classGrant(IMAGE_ID, primary.metaclassRef), position],
      },
      {
        label: 'another image',
        imageId: 'another/image',
        classRef: objectRef('another/image', primary.classRef.objectId),
        selector: 'foo',
        grants: [
          classGrant('another/image', objectRef('another/image', primary.classRef.objectId)),
          position,
        ],
      },
    ];
    for (const entry of denied) {
      const {require} = authorityRequire(runtime, entry.grants, entry.label);
      await assert.rejects(
        authorizedDescribeSmalltalkMethod({
          images: runtime.images,
          imageId: entry.imageId,
          classRef: entry.classRef,
          selector: entry.selector,
          require,
        }),
        (error) => error?.name === 'AuthorityError',
        entry.label,
      );
    }

    const positionOnly = authorityRequire(runtime, [position], 'position-only');
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images: runtime.images,
        imageId: IMAGE_ID,
        classRef: primary.classRef,
        selector: 'foo',
        require: positionOnly.require,
      }),
      (error) => error?.name === 'AuthorityError',
      'method position authority is not transitive class authority',
    );
  } finally {
    await runtime.close();
  }
});

test('position authorization precedes every graph read and a valid token conveys zero authority', async () => {
  const {runtime, primary} = await fixture();
  try {
    const classOnly = authorityRequire(runtime, [classGrant(IMAGE_ID, primary.classRef)], 'class-only');
    let reads = 0;
    const images = new Proxy(runtime.images, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== 'function') return value;
        return (...args) => {
          reads += 1;
          return value.apply(target, args);
        };
      },
    });
    await assert.rejects(
      authorizedDescribeSmalltalkMethod({
        images,
        imageId: IMAGE_ID,
        classRef: primary.classRef,
        selector: 'foo',
        require: classOnly.require,
      }),
      (error) => error?.name === 'AuthorityError',
    );
    assert.equal(reads, 0, 'no kernel, Behavior, MethodDictionary or Block read precedes position authority');

    const authorized = semanticReader(runtime, IMAGE_ID, primary.classRef, 'foo');
    const {versionToken} = await authorizedReadSmalltalkMethodForUpdate({
      images: runtime.images,
      imageId: IMAGE_ID,
      classRef: primary.classRef,
      selector: 'foo',
      require: authorized.require,
    });
    assert.equal(typeof versionToken, 'string');
    await assert.rejects(
      authorizedReadSmalltalkMethodForUpdate({
        images: runtime.images,
        imageId: IMAGE_ID,
        classRef: primary.classRef,
        selector: 'foo',
        require: classOnly.require,
      }),
      (error) => error?.name === 'AuthorityError',
      'holding a valid current token in caller data grants no reread authority',
    );
  } finally {
    await runtime.close();
  }
});
