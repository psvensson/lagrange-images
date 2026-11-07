import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMAGE_SHAPE_MIGRATION_PLAN_V1,
  IMAGE_SHAPE_MIGRATION_RECEIPT_V1,
  SHAPE_INDEXED,
  buildShapeSlotMigrationPlan,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  evaluateCommonLispSource,
  evaluateSymmetricSmalltalkBlock,
  evolveSmalltalkClassShape,
  installCommonLispRuntime,
  installSymmetricSmalltalkStandardImage,
  integerValue,
  migrateImageObjectsToShape,
  migrateObjectRecordToShape,
  objectRef,
  planImageShapeMigration,
   publishSmalltalkClassGlobals,
  reconcileMethodsFromSource,
  textValue,
} from '../src/runtime.js';

test('generic shape migration plans and migrates objects between immutable Shapes while preserving identity and indexed elements', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const IMAGE_ID = 'shape-mig-generic';
  await runtime.images.createImage({id: IMAGE_ID, name: 'Generic Shape Migration'});

  const shapeV1 = await runtime.images.putShape(IMAGE_ID, {
    id: 'shape/record/v1',
    slots: [
      {id: 'slot-id', name: 'id'},
      {id: 'slot-legacy-label', name: 'legacyLabel'},
      {id: 'slot-obsolete', name: 'obsolete'},
    ],
    indexed: SHAPE_INDEXED.VALUES,
  });

  const shapeV2 = await runtime.images.putShape(IMAGE_ID, {
    id: 'shape/record/v2',
    slots: [
      {id: 'slot-id', name: 'id'},
      {id: 'slot-title', name: 'title'},
      {id: 'slot-version', name: 'version'},
    ],
    indexed: SHAPE_INDEXED.VALUES,
  });

  const obj1 = await runtime.images.putObject(IMAGE_ID, {
    id: 'rec/1',
    shape: objectRef(IMAGE_ID, shapeV1.id),
    slots: {
      'slot-id': integerValue(1n),
      'slot-legacy-label': textValue('first'),
      'slot-obsolete': integerValue(999n),
    },
    indexed: [integerValue(10n), integerValue(20n)],
  });

  const obj2 = await runtime.images.putObject(IMAGE_ID, {
    id: 'rec/2',
    shape: objectRef(IMAGE_ID, shapeV1.id),
    slots: {
      'slot-id': integerValue(2n),
      'slot-legacy-label': textValue('second'),
      'slot-obsolete': integerValue(888n),
    },
    indexed: [integerValue(30n)],
  });

  const slotPlan = buildShapeSlotMigrationPlan({
    fromShape: shapeV1,
    toShape: shapeV2,
    slotMapping: {title: 'legacyLabel'},
    defaultSlotValues: {version: integerValue(2n)},
  });
  assert.equal(slotPlan.fromShapeId, 'shape/record/v1');
  assert.equal(slotPlan.toShapeId, 'shape/record/v2');
  assert.equal(slotPlan.removedSlots.length, 1);
  assert.equal(slotPlan.removedSlots[0].name, 'obsolete');

  const previewRecord = migrateObjectRecordToShape(obj1, {
    fromShape: shapeV1,
    toShape: shapeV2,
    slotMapping: {title: 'legacyLabel'},
    defaultSlotValues: {version: integerValue(2n)},
  });
  assert.equal(previewRecord.id, 'rec/1');
  assert.deepEqual(previewRecord.shape, objectRef(IMAGE_ID, 'shape/record/v2'));
  assert.deepEqual(previewRecord.slots, {
    'slot-id': integerValue(1n),
    'slot-title': textValue('first'),
    'slot-version': integerValue(2n),
  });
  assert.deepEqual(previewRecord.indexed, [integerValue(10n), integerValue(20n)]);

  const plan = await planImageShapeMigration({
    images: runtime.images,
    imageId: IMAGE_ID,
    fromShapeId: shapeV1.id,
    toShapeId: shapeV2.id,
    slotMapping: {title: 'legacyLabel'},
    defaultSlotValues: {version: integerValue(2n)},
  });
  assert.equal(plan.format, IMAGE_SHAPE_MIGRATION_PLAN_V1);
  assert.deepEqual(plan.objectIds, ['rec/1', 'rec/2']);

  const dryReceipt = await migrateImageObjectsToShape({
    images: runtime.images,
    imageId: IMAGE_ID,
    fromShapeId: shapeV1.id,
    toShapeId: shapeV2.id,
    slotMapping: {title: 'legacyLabel'},
    defaultSlotValues: {version: integerValue(2n)},
    dryRun: true,
  });
  assert.equal(dryReceipt.format, IMAGE_SHAPE_MIGRATION_RECEIPT_V1);
  assert.equal(dryReceipt.dryRun, true);
  assert.equal((await runtime.images.getObject(IMAGE_ID, obj1.id)).shape.objectId, 'shape/record/v1');

  const receipt = await migrateImageObjectsToShape({
    images: runtime.images,
    imageId: IMAGE_ID,
    fromShapeId: shapeV1.id,
    toShapeId: shapeV2.id,
    slotMapping: {title: 'legacyLabel'},
    defaultSlotValues: {version: integerValue(2n)},
  });
  assert.equal(receipt.dryRun, false);
  assert.equal(receipt.migratedCount, 2);

  // Both old and new Shapes remain immutable in the image (ADR 0002)
  assert.equal((await runtime.images.getShape(IMAGE_ID, 'shape/record/v1')).slots.length, 3);
  assert.equal((await runtime.images.getShape(IMAGE_ID, 'shape/record/v2')).slots.length, 3);

  const migrated1 = await runtime.images.getObject(IMAGE_ID, obj1.id);
  const migrated2 = await runtime.images.getObject(IMAGE_ID, obj2.id);
  assert.equal(migrated1.shape.objectId, 'shape/record/v2');
  assert.deepEqual(migrated1.slots['slot-title'], textValue('first'));
  assert.deepEqual(migrated1.slots['slot-version'], integerValue(2n));
  assert.deepEqual(migrated2.slots['slot-title'], textValue('second'));
  assert.deepEqual(migrated2.indexed, [integerValue(30n)]);
});

test('evolveSmalltalkClassShape evolves a Smalltalk class and its subclasses to new immutable Shapes and migrates existing instances', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const IMAGE_ID = 'shape-mig-st';
  await runtime.images.createImage({id: IMAGE_ID, name: 'Smalltalk Shape Evolution'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: IMAGE_ID,
  });

  const vecClass = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'Vec2',
    instanceVariables: ['x', 'y', 'tempTrash'],
  });
  const coloredVecClass = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId: IMAGE_ID,
    name: 'ColoredVec',
    superclassRef: vecClass.classRef,
    instanceVariables: ['hue'],
  });
  await publishSmalltalkClassGlobals({
    images: runtime.images,
    imageId: IMAGE_ID,
    names: ['Vec2', 'ColoredVec'],
  });

  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: IMAGE_ID,
    classRef: vecClass.classRef,
    methods: [
      {selector: 'x:y:', source: '[ :nx :ny | x := nx. y := ny. tempTrash := 999. ^self ]'},
      {selector: 'xVal', source: '[ ^x ]'},
    ],
  });
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: IMAGE_ID,
    classRef: coloredVecClass.classRef,
    methods: [
      {selector: 'hue:', source: '[ :h | hue := h. ^self ]'},
      {selector: 'hue', source: '[ ^hue ]'},
    ],
  });

  const v1Ref = await evaluateSymmetricSmalltalkBlock({
    runtime,
    imageId: IMAGE_ID,
    source: '[ (Vec2 new) x: 10 y: 20 ]',
  });
  const cv1Ref = await evaluateSymmetricSmalltalkBlock({
    runtime,
    imageId: IMAGE_ID,
    source: '[ ((ColoredVec new) x: 30 y: 40) hue: 7 ]',
  });

  const originalVecShapeId = (await runtime.images.getObject(IMAGE_ID, v1Ref.objectId)).shape.objectId;

  // Evolve Vec2: rename `x` -> `px` (with preserveRenamedSlotIds: true), keep `y`, drop `tempTrash`, add `z` (default 5)
  const evolved = await evolveSmalltalkClassShape({
    images: runtime.images,
    imageId: IMAGE_ID,
    classRef: vecClass.classRef,
    instanceVariables: ['px', 'y', 'z'],
    slotMapping: {px: 'x'},
    defaultSlotValues: {z: integerValue(5n)},
    preserveRenamedSlotIds: true,
    cascadeSubclasses: true,
  });

  assert.notEqual(evolved.instanceShapeRef.objectId, originalVecShapeId);
  assert.equal(evolved.migrationReceipt.migratedCount, 1);
  assert.equal(evolved.subclassResults.length, 1);
  assert.equal(evolved.subclassResults[0].migrationReceipt.migratedCount, 1);

  // Even BEFORE recompiling `xVal`, because `preserveRenamedSlotIds: true` kept `x`'s slot id for `px`,
  // existing compiled method `xVal` still reads the preserved slot on both `v1Ref` and `cv1Ref`!
  const xBeforeRecompile = await runtime.executor.execute(
    await runtime.invocations.sendMessage({
      receiver: v1Ref,
      message: textValue('xVal'),
      arguments: [],
      languageId: 'symmetric-smalltalk',
    }),
  );
  assert.deepEqual(xBeforeRecompile, integerValue(10n));

  // Reconcile methods on Vec2 to use the new `px` and `z` instance variables
  await reconcileMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: IMAGE_ID,
    classRef: vecClass.classRef,
    methods: [
      {selector: 'sumComponents', source: '[ ^px + y + z ]'},
      {selector: 'z', source: '[ ^z ]'},
    ],
  });

  // Pre-existing Vec2 instance (10 + 20 + 5 = 35) and ColoredVec subclass instance (30 + 40 + 5 = 75, hue = 7)
  const v1Sum = await runtime.executor.execute(
    await runtime.invocations.sendMessage({
      receiver: v1Ref,
      message: textValue('sumComponents'),
      arguments: [],
      languageId: 'symmetric-smalltalk',
    }),
  );
  assert.deepEqual(v1Sum, integerValue(35n));

  const cv1Sum = await runtime.executor.execute(
    await runtime.invocations.sendMessage({
      receiver: cv1Ref,
      message: textValue('sumComponents'),
      arguments: [],
      languageId: 'symmetric-smalltalk',
    }),
  );
  const cv1Hue = await runtime.executor.execute(
    await runtime.invocations.sendMessage({
      receiver: cv1Ref,
      message: textValue('hue'),
      arguments: [],
      languageId: 'symmetric-smalltalk',
    }),
  );
  assert.deepEqual(cv1Sum, integerValue(75n));
  assert.deepEqual(cv1Hue, integerValue(7n));
});

test('Common Lisp defstruct and CLOS defclass redefinition evolve immutable Shapes and migrate existing instances in-image', async () => {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  const IMAGE_ID = 'shape-mig-cl';
  await runtime.images.createImage({id: IMAGE_ID, name: 'Common Lisp Shape Evolution'});
  await installSymmetricSmalltalkStandardImage({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: IMAGE_ID,
  });
  await installCommonLispRuntime({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId: IMAGE_ID,
  });

  // 1. Define initial DEFSTRUCT `probe` and bind an instance `*p1*`
  const p1Ref = await evaluateCommonLispSource({
    runtime,
    imageId: IMAGE_ID,
    source: `
      (defstruct probe
        id
        (reading 40)
        obsolete-flag)
      (defparameter *p1* (make-probe :id 101 :reading 42 :obsolete-flag 999))
      *p1*
    `,
  });
  const p1BeforeShape = (await runtime.images.getObject(IMAGE_ID, p1Ref.objectId)).shape.objectId;

  // Redefine DEFSTRUCT `probe`: drop `obsolete-flag`, add `(scale 3)`, reorder slots
  const structAfterVal = await evaluateCommonLispSource({
    runtime,
    imageId: IMAGE_ID,
    source: `
      (defstruct probe
        (reading 40)
        (scale 3)
        id)
      (+ (probe-id *p1*) (* (probe-reading *p1*) (probe-scale *p1*)))
    `,
  });
  // 101 + (42 * 3) = 227
  assert.deepEqual(structAfterVal, integerValue(227n));
  const p1AfterShape = (await runtime.images.getObject(IMAGE_ID, p1Ref.objectId)).shape.objectId;
  assert.notEqual(p1AfterShape, p1BeforeShape, 'redefined defstruct migrates *p1* to a new immutable Shape');

  // 2. Define initial CLOS DEFCLASS `account-node` and bind an instance `*acc1*`
  const acc1Ref = await evaluateCommonLispSource({
    runtime,
    imageId: IMAGE_ID,
    source: `
      (defclass account-node ()
        ((owner-id :initarg :owner-id :accessor account-owner-id)
         (balance :initarg :balance :initform 0 :accessor account-balance)
         (legacy-tag :initarg :legacy-tag :initform 77 :accessor account-legacy-tag)))
      (defparameter *acc1* (make-instance 'account-node :owner-id 7 :balance 500))
      *acc1*
    `,
  });
  const acc1BeforeShape = (await runtime.images.getObject(IMAGE_ID, acc1Ref.objectId)).shape.objectId;

  // Redefine CLOS DEFCLASS `account-node`: remove `legacy-tag`, add `(bonus :initarg :bonus :initform 25 :accessor account-bonus)`
  const closAfterVal = await evaluateCommonLispSource({
    runtime,
    imageId: IMAGE_ID,
    source: `
      (defclass account-node ()
        ((balance :initarg :balance :initform 0 :accessor account-balance)
         (bonus :initarg :bonus :initform 25 :accessor account-bonus)
         (owner-id :initarg :owner-id :accessor account-owner-id)))
      (defgeneric compute-total (node))
      (defmethod compute-total ((node account-node))
        (+ (account-owner-id node) (account-balance node) (account-bonus node)))
      (compute-total *acc1*)
    `,
  });
  // 7 + 500 + 25 = 532
  assert.deepEqual(closAfterVal, integerValue(532n));
  const acc1AfterShape = (await runtime.images.getObject(IMAGE_ID, acc1Ref.objectId)).shape.objectId;
  assert.notEqual(acc1AfterShape, acc1BeforeShape, 'redefined CLOS defclass migrates *acc1* to a new immutable Shape');
});
