import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import './ensure-node-crypto.test-helper.js';
import {
  COMMON_LISP_DEFINITION_READ_OPERATION,
  COMMON_LISP_ID,
  COMMON_LISP_NAMESPACE_ID,
  COMMON_LISP_SOURCE_V0,
  OBJECT_READ_OPERATION,
  SMALLTALK_METHOD_READ_OPERATION,
  addProjectMember,
  attachCommonLispMethod,
  authorizedDescribeCommonLispDefinition,
  authorizedDescribeCommonLispNamespace,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  captureCurrentGraphProjectRelease,
  commonLispDefinitionResource,
  commonLispListToArray,
  createDeploymentProfile,
  createProject,
  createProjectId,
  evaluateCommonLispSource,
  importCuisNativePackage,
  installCommonLispProgram,
  installCommonLispRuntime,
  installManagedProjectRelease,
  installSymmetricSmalltalkStandardImage,
  objectRef,
  objectResource,
  readManagedProjectInstallation,
  smalltalkMethodPositionResource,
  textValue,
} from '../src/runtime.js';
import {
  CUIS_LIFE_BLOB,
  FROZEN_STATES,
  GAMES_COMMIT,
  LIFE_METHOD_SCOPE,
  LIFE_SCOPE,
  assertProviderAbsence,
  composeFreshRuntime,
  readRecoveredClosure,
  resolveImportedClass,
} from './support/life-m5-witness.js';

const CL_LIFE_ANALYZER_SOURCE = `
  (defstruct life-generation-report
    (generation 0)
    (live-count 0)
    (neighbor-sum 0)
    (live-coords nil)
    (state-string ""))

  (defun make-life-point (r c)
    (send Point :x:y: r c))

  (defun sexp-pattern-to-smalltalk-array (rows-list)
    (let* ((row-count (length rows-list))
           (outer (send Array :new: row-count))
           (r-idx 1))
      (dolist (row rows-list outer)
        (let* ((col-count (length row))
               (inner (send Array :new: col-count))
               (c-idx 1))
          (dolist (cell row)
            (send inner :at:put: c-idx cell)
            (incf c-idx 1))
          (send outer :at:put: r-idx inner)
          (incf r-idx 1)))))

  (defun build-life-model-from-sexp (rows cols pattern-rows at-row at-col)
    (let ((model (send LifeModel :new))
          (st-pattern (sexp-pattern-to-smalltalk-array pattern-rows)))
      (send model :shape: (make-life-point rows cols))
      (send model :set:at: st-pattern (make-life-point at-row at-col))
      model))

  (defun life-model-state-string (model)
    (let* ((shape (send model :shape))
           (rows (send shape :x))
           (cols (send shape :y))
           (cells (send model :cells))
           (acc "|"))
      (dotimes (r0 rows acc)
        (let ((r (+ r0 1))
              (row-str ""))
          (dotimes (c0 cols)
            (let* ((c (+ c0 1))
                   (val (send cells :at: (make-life-point r c)))
                   (bit (if (= val 1) "1" "0")))
              (setq row-str (concatenate 'string row-str bit))))
          (setq acc (concatenate 'string acc row-str "|"))))))

  (defun live-neighbor-count (model cells pt)
    (let* ((env (send model :surrounding: pt))
           (n (send env :size))
           (acc 0))
      (dotimes (i n acc)
        (let ((npt (send env :at: (+ i 1))))
          (incf acc (send cells :at: npt))))))

  (defun analyze-life-model (model generation)
    (let* ((shape (send model :shape))
           (rows (send shape :x))
           (cols (send shape :y))
           (cells (send model :cells))
           (live-count 0)
           (neighbor-sum 0)
           (rev-coords nil))
      (dotimes (r0 rows)
        (let ((r (+ r0 1)))
          (dotimes (c0 cols)
            (let* ((c (+ c0 1))
                   (pt (make-life-point r c))
                   (val (send cells :at: pt)))
              (when (= val 1)
                (incf live-count 1)
                (incf neighbor-sum (live-neighbor-count model cells pt))
                (push (cons r c) rev-coords))))))
      (make-life-generation-report
        :generation generation
        :live-count live-count
        :neighbor-sum neighbor-sum
        :live-coords (reverse rev-coords)
        :state-string (life-model-state-string model))))

  (defun report-to-sexp (report)
    (list (life-generation-report-generation report)
          (life-generation-report-state-string report)
          (life-generation-report-live-count report)
          (life-generation-report-neighbor-sum report)
          (life-generation-report-live-coords report)))

  (defun life-model-step-and-analyze-bridge (self steps)
    (let ((rev-reports nil))
      (push (report-to-sexp (analyze-life-model self 0)) rev-reports)
      (dotimes (i steps (reverse rev-reports))
        (send self :nextState)
        (push (report-to-sexp (analyze-life-model self (+ i 1))) rev-reports))))
`;

async function decodeReportList(images, imageId, listVal) {
  const entryRefs = await commonLispListToArray({images, imageId, value: listVal});
  const reports = [];
  for (const entryRef of entryRefs) {
    const [genVal, stateVal, liveCountVal, neighborSumVal, coordsVal] =
      await commonLispListToArray({images, imageId, value: entryRef});
    const coordRefs = await commonLispListToArray({images, imageId, value: coordsVal});
    const coords = [];
    for (const ref of coordRefs) {
      const rec = await images.getObject(imageId, ref.objectId);
      coords.push([Number(rec.indexed[0].value), Number(rec.indexed[1].value)]);
    }
    reports.push({
      generation: Number(genVal.value),
      stateString: stateVal.value,
      liveCount: Number(liveCountVal.value),
      neighborSum: Number(neighborSumVal.value),
      coords,
    });
  }
  return reports;
}

test('Polyglot Common Lisp + native Cuis Life Project: S-expression construction, attached CL method on LifeModel, authorized browsing, and restart recovery with zero foreign providers', {timeout: 600_000}, async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/life-m5-release.json', import.meta.url), 'utf8'));
  assert.equal(fixture.recorded.upstream, `Cuis-Smalltalk/Games@${GAMES_COMMIT}`);
  assert.equal(fixture.recorded.packageBlob, CUIS_LIFE_BLOB);

  const directory = await mkdtemp(join(tmpdir(), 'lagrange-polyglot-life-cl-'));
  const filename = join(directory, 'image.sqlite');
  const AUTHOR = 'author-polyglot-life';
  const PROD = 'prod-polyglot-life';
  let polyglotProjectId = null;
  let capturedRelease = null;

  try {
    // 1. Authoring runtime: install the sealed Cuis Life release into an authoring image, add the
    // Common Lisp analyzer/driver CodeArtifact with explicit dependencies on the Cuis artifacts,
    // and capture a unified polyglot Project release.
    const runtimeA = await composeFreshRuntime(filename);
    try {
      await runtimeA.images.createImage({id: AUTHOR});
      await installManagedProjectRelease({
        images: runtimeA.images,
        targetImageId: AUTHOR,
        release: fixture.release,
        material: fixture.material,
      });
      const authorRecovered = await readRecoveredClosure(
        runtimeA.images,
        AUTHOR,
        fixture.release.projectId,
      );
      const authorByKey = new Map(
        authorRecovered.installation.members.map((m) => [m.key, m]),
      );
      const authorPackageRef = authorByKey.get('life/package').target;
      const authorExportRef = authorByKey.get('life/export').target;

      const clAnalyzerArtifact = await runtimeA.images.putCodeArtifact(AUTHOR, {
        id: 'artifact/cl-life-analyzer',
        languageId: COMMON_LISP_ID,
        representation: COMMON_LISP_SOURCE_V0,
        content: textValue(CL_LIFE_ANALYZER_SOURCE),
        dependencies: [
          {artifact: authorExportRef, role: 'domain-model'},
          {artifact: authorPackageRef, role: 'upstream-source'},
        ],
      });

      polyglotProjectId = createProjectId();
      await createProject({
        images: runtimeA.images,
        imageId: AUTHOR,
        projectId: polyglotProjectId,
        name: 'PolyglotCuisCommonLispLife',
      });
      const members = [
        {key: 'life/package', role: 'package', target: authorPackageRef},
        {key: 'life/export', role: 'semantic-export', target: authorExportRef},
        {key: 'life/cl-analyzer', role: 'source', target: objectRef(AUTHOR, clAnalyzerArtifact.id)},
      ];
      for (const member of members) {
        await addProjectMember({
          images: runtimeA.images,
          imageId: AUTHOR,
          projectId: polyglotProjectId,
          ...member,
        });
      }

      const descriptor = {
        format: 'lagrange-project/v1',
        projectId: polyglotProjectId,
        name: 'PolyglotCuisCommonLispLife',
        namespace: null,
        members,
      };
      const profile = createDeploymentProfile({
        project: descriptor,
        profileId: 'polyglot-life-wasm',
        members: members.map(({key}) => key),
      });
      capturedRelease = await captureCurrentGraphProjectRelease({
        images: runtimeA.images,
        projectImageId: AUTHOR,
        projectId: polyglotProjectId,
        profile,
      });

      // 2. Managed install of the unified polyglot release into fresh PROD image, native import of
      // Cuis Life + Common Lisp analyzer in the wasm lane, and bidirectional execution before restart.
      await runtimeA.images.createImage({id: PROD});
      const installed = await installManagedProjectRelease({
        images: runtimeA.images,
        targetImageId: PROD,
        release: capturedRelease.release,
        material: capturedRelease.material,
      });
      assert.equal(installed.releaseId, capturedRelease.release.releaseId);

      assertProviderAbsence(runtimeA, 'before polyglot native import');

      const prodInstallation = await readManagedProjectInstallation({
        images: runtimeA.images,
        targetImageId: PROD,
        projectId: polyglotProjectId,
      });
      const prodByKey = new Map(prodInstallation.members.map((m) => [m.key, m]));
      const prodExportRecord = await runtimeA.images.getCodeArtifact(
        PROD,
        prodByKey.get('life/export').target.objectId,
      );
      const prodPackageRecord = await runtimeA.images.getCodeArtifact(
        PROD,
        prodByKey.get('life/package').target.objectId,
      );
      const prodClRecord = await runtimeA.images.getCodeArtifact(
        PROD,
        prodByKey.get('life/cl-analyzer').target.objectId,
      );
      assert.deepEqual(prodClRecord.dependencies, [
        {artifact: objectRef(PROD, prodExportRecord.id), role: 'domain-model'},
        {artifact: objectRef(PROD, prodPackageRecord.id), role: 'upstream-source'},
      ]);

      await installSymmetricSmalltalkStandardImage({
        images: runtimeA.images,
        compilation: runtimeA.compilation,
        imageId: PROD,
        lane: 'wasm',
      });
      const importedLife = await importCuisNativePackage({
        images: runtimeA.images,
        compilation: runtimeA.compilation,
        imageId: PROD,
        manifest: JSON.parse(prodExportRecord.content.value),
        scope: {classes: [...LIFE_SCOPE], methods: [...LIFE_METHOD_SCOPE]},
      });
      const lifeModelClass = importedLife.classes.find(
        ({identity}) => identity === 'cuis-class/Life/LifeModel',
      ).classRef;

      await installCommonLispRuntime({
        images: runtimeA.images,
        compilation: runtimeA.compilation,
        imageId: PROD,
        lane: 'wasm',
      });
      await installCommonLispProgram({
        runtime: runtimeA,
        imageId: PROD,
        source: prodClRecord.content.value,
        lane: 'wasm',
        skipRuntimeEnsure: true,
      });

      // Attach a Common Lisp method directly onto the natively imported Cuis LifeModel class
      await attachCommonLispMethod({
        images: runtimeA.images,
        compilation: runtimeA.compilation,
        imageId: PROD,
        classRef: lifeModelClass,
        selector: 'stepAndAnalyze:',
        functionName: 'life-model-step-and-analyze-bridge',
        passSelf: true,
        lane: 'wasm',
      });

      // Construct a Cuis LifeModel in Common Lisp from an S-expression pattern and store it in a
      // durable Common Lisp special variable *active-blinker*, then invoke the polyglot method
      // (send *active-blinker* :stepAndAnalyze: 2).
      const stepEval = await evaluateCommonLispSource({
        runtime: runtimeA,
        imageId: PROD,
        lane: 'wasm',
        source: `
          (defparameter *active-blinker*
            (build-life-model-from-sexp 4 5 '((1 1 1)) 2 2))
          (send *active-blinker* :stepAndAnalyze: 2)
        `,
      });
      const reportsBefore = await decodeReportList(runtimeA.images, PROD, stepEval);
      assert.equal(reportsBefore.length, 3);
      assert.deepEqual(
        reportsBefore.map((r) => r.stateString),
        FROZEN_STATES,
        'Common Lisp analyzer + Cuis LifeModel>>nextState must produce exact FROZEN_STATES',
      );
      assert.deepEqual(
        reportsBefore.map((r) => [r.generation, r.liveCount, r.neighborSum]),
        [
          [0, 3, 4],
          [1, 3, 4],
          [2, 3, 4],
        ],
      );
      assert.deepEqual(reportsBefore[0].coords, [[2, 2], [2, 3], [2, 4]]);
      assert.deepEqual(reportsBefore[1].coords, [[1, 3], [2, 3], [3, 3]]);
      assert.deepEqual(reportsBefore[2].coords, [[2, 2], [2, 3], [2, 4]]);

      // Advance *active-blinker* one step to S1 (vertical blinker) before shutting down runtimeA
      const preShutdownState = await evaluateCommonLispSource({
        runtime: runtimeA,
        imageId: PROD,
        lane: 'wasm',
        source: `
          (send *active-blinker* :nextState)
          (life-model-state-string *active-blinker*)
        `,
      });
      assert.deepEqual(preShutdownState, textValue(FROZEN_STATES[1]));

      // Verify both authorized browsing seams (Smalltalk class/method browser on LifeModel +
      // Common Lisp namespace/definition browser on common-lisp/namespace/v1)
      const context = runtimeA.authority.issue({
        principal: 'principal:polyglot-inspector',
        grants: [
          {
            operation: OBJECT_READ_OPERATION,
            resource: objectResource(PROD, lifeModelClass.objectId),
          },
          {
            operation: OBJECT_READ_OPERATION,
            resource: objectResource(PROD, COMMON_LISP_NAMESPACE_ID),
          },
          {
            operation: SMALLTALK_METHOD_READ_OPERATION,
            resource: smalltalkMethodPositionResource(PROD, lifeModelClass, 'stepAndAnalyze:'),
          },
          {
            operation: COMMON_LISP_DEFINITION_READ_OPERATION,
            resource: commonLispDefinitionResource(PROD, 'struct', 'life-generation-report'),
          },
          {
            operation: COMMON_LISP_DEFINITION_READ_OPERATION,
            resource: commonLispDefinitionResource(PROD, 'variable', '*active-blinker*'),
          },
        ],
      });
      const require = (demand) => runtimeA.authority.require(context, demand);

      const lifeClassDesc = await authorizedDescribeSmalltalkClass({
        images: runtimeA.images,
        imageId: PROD,
        classRef: lifeModelClass,
        require,
      });
      assert.equal(lifeClassDesc.name, 'LifeModel');
      assert.ok(
        lifeClassDesc.selectors.includes('nextState')
        && lifeClassDesc.selectors.includes('stepAndAnalyze:'),
        'imported Cuis LifeModel class must list both native Cuis selectors and the attached Common Lisp selector',
      );
      const attachedMethodDesc = await authorizedDescribeSmalltalkMethod({
        images: runtimeA.images,
        imageId: PROD,
        classRef: lifeModelClass,
        selector: 'stepAndAnalyze:',
        require,
      });
      assert.equal(attachedMethodDesc.selector, 'stepAndAnalyze:');

      const clNsDesc = await authorizedDescribeCommonLispNamespace({
        images: runtimeA.images,
        imageId: PROD,
        require,
      });
      assert.ok(clNsDesc.functions.includes('BUILD-LIFE-MODEL-FROM-SEXP'));
      assert.ok(clNsDesc.structs.includes('LIFE-GENERATION-REPORT'));
      assert.ok(clNsDesc.variables.includes('*ACTIVE-BLINKER*'));

      const structDesc = await authorizedDescribeCommonLispDefinition({
        images: runtimeA.images,
        imageId: PROD,
        kind: 'struct',
        name: 'life-generation-report',
        require,
      });
      assert.equal(structDesc.className, 'LifeGenerationReport');
      assert.equal(structDesc.slots.length, 5);

      const blinkerVarDesc = await authorizedDescribeCommonLispDefinition({
        images: runtimeA.images,
        imageId: PROD,
        kind: 'variable',
        name: '*active-blinker*',
        require,
      });
      assert.equal(blinkerVarDesc.value.kind, 'ref');
    } finally {
      await runtimeA.close();
    }

    // 3. Real restart: fresh runtimeB over the same SQLite LagrangeBackend with zero providers.
    // Neither Cuis Life nor the Common Lisp program is re-imported or re-installed.
    const runtimeB = await composeFreshRuntime(filename);
    try {
      assertProviderAbsence(runtimeB, 'after restart');
      const recoveredInstall = await readManagedProjectInstallation({
        images: runtimeB.images,
        targetImageId: PROD,
        projectId: polyglotProjectId,
      });
      assert.equal(recoveredInstall.releaseId, capturedRelease.release.releaseId);

      const lifeModelAfterRestart = await resolveImportedClass(runtimeB.images, PROD, 'LifeModel');
      assert.equal(lifeModelAfterRestart.objectId, 'smalltalk/class/LifeModel');

      // The durable *active-blinker* Cuis LifeModel instance is still at S1 and transitions to S0
      // through the attached Common Lisp method stepAndAnalyze: after restart.
      const resumedEval = await evaluateCommonLispSource({
        runtime: runtimeB,
        imageId: PROD,
        lane: 'wasm',
        skipRuntimeEnsure: true,
        source: '(send *active-blinker* :stepAndAnalyze: 1)',
      });
      const reportsAfter = await decodeReportList(runtimeB.images, PROD, resumedEval);
      assert.equal(reportsAfter.length, 2);
      assert.deepEqual(
        reportsAfter.map((r) => r.stateString),
        [FROZEN_STATES[1], FROZEN_STATES[2]],
        'persisted Cuis LifeModel resumes from S1 and steps to S2 == S0 after restart',
      );
      assert.deepEqual(reportsAfter[0].coords, [[1, 3], [2, 3], [3, 3]]);
      assert.deepEqual(reportsAfter[1].coords, [[2, 2], [2, 3], [2, 4]]);
    } finally {
      await runtimeB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
