import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import './ensure-node-crypto.test-helper.js';
import {LagrangeBackend} from '../src/backend/index.js';
import {
  COMMON_LISP_ID,
  COMMON_LISP_SOURCE_V0,
  GRAPH_BUNDLE_V1,
  PROJECT_INSTALLATION_V1,
  SYMMETRIC_SMALLTALK_ID,
  addProjectMember,
  attachCommonLispMethod,
  captureCurrentGraphProjectRelease,
  commonLispListToArray,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  evaluateCommonLispSource,
  evaluateSymmetricSmalltalkBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  installManagedProjectRelease,
  integerValue,
  objectRef,
  publishSmalltalkClassGlobals,
  readManagedProjectInstallation,
  textValue,
} from '../src/runtime.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const CL_POLICY_ENGINE_SOURCE = `
  (defstruct policy-ctx
    (subject "anon")
    (tier 1)
    (risk-budget 100))

  (defstruct (audited-ctx (:include policy-ctx))
    (audit-count 0)
    (flags nil))

  (defmacro with-capped-score ((var expr &key (cap 500) (bonus 0 bonus-p)) &body body)
    (let ((raw-sym (gensym "RAW"))
          (adj-sym (gensym "ADJ")))
      \`(let* ((,raw-sym ,expr)
               (,adj-sym (+ ,raw-sym ,bonus ,(if bonus-p 10 0)))
               (,var (if (> ,adj-sym ,cap) ,cap ,adj-sym)))
          ,@body)))

  (defvar *rule-memo-table* (make-hash-table))

  (defun tier-weight (tier-index)
    (let ((weights #(10 25 50 100)))
      (if (and (>= tier-index 0) (< tier-index (length weights)))
          (aref weights tier-index)
          10)))

  (defun evaluate-policy-tree (ctx tree &optional (scale 1 scale-p) &key (bonus 0) (auditor nil))
    (let ((cleaned 0))
      (labels
        ((eval-node (node)
           (if (atom node)
               (if (integerp node) node 0)
               (let ((op (car node))
                     (args (cdr node)))
                 (case op
                   (:const
                    (car args))
                   (:tier-bonus
                    (let ((mult (car args))
                          (acc 0))
                      (dotimes (i (policy-ctx-tier ctx) (* acc mult))
                        (incf acc (tier-weight i)))))
                   (:guard-divide
                    (destructuring-bind (num denom fallback) args
                      (handler-bind
                        ((zero-divide (lambda (c) (use-value c fallback))))
                        (floor (eval-node num) (eval-node denom)))))
                   (:strict-budget
                    (destructuring-bind (cost fallback) args
                      (handler-case
                        (unwind-protect
                          (let ((cval (eval-node cost)))
                            (if (> cval (policy-ctx-risk-budget ctx))
                                (error "policy risk budget exceeded")
                                cval))
                          (incf cleaned 1)
                          (incf (audited-ctx-audit-count ctx) 1))
                        (error (c)
                          (when (string= (condition-message c) "policy risk budget exceeded")
                            fallback)))))
                   (:flag
                    (destructuring-bind (tag subnode) args
                      (let ((val (eval-node subnode))
                            (full-tag (concatenate 'string "flag:" tag)))
                        (when (char= (char full-tag 0) #\\f)
                          (push full-tag (audited-ctx-flags ctx)))
                        (when auditor
                          (send auditor :recordScore:tag: val full-tag))
                        val)))
                   (:sum
                    (let ((total 0))
                      (dolist (child args total)
                        (incf total (eval-node child)))))
                   (otherwise 0))))))
        (let* ((base-score (* (eval-node tree) (if scale-p scale 1)))
               (memo-key (policy-ctx-tier ctx)))
          (with-capped-score (final-score base-score :cap 1000 :bonus bonus)
            (setf (gethash memo-key *rule-memo-table*) final-score)
            (list final-score
                  (hash-table-count *rule-memo-table*)
                  (audited-ctx-audit-count ctx)
                  (length (audited-ctx-flags ctx))
                  cleaned))))))

  (defun build-standard-policy-rules ()
    '(:sum
       (:const 15)
       (:tier-bonus 2)
       (:guard-divide (:const 100) (:const 0) 35)
       (:strict-budget (:const 250) 20)
       (:flag "high-value" (:const 30))))

  (defun auditor-evaluate-bridge (self ctx scale bonus)
    (let ((rules (build-standard-policy-rules)))
      (evaluate-policy-tree ctx rules scale :bonus bonus :auditor self)))
`;

const CL_POLICY_RULES_SEXP_SOURCE = `
  (defun evaluate-custom-override (ctx auditor)
    (let ((custom-rules
            '(:sum
               (:const 40)
               (:guard-divide (:const 90) (:const 3) 0)
               (:strict-budget (:const 50) 5)
               (:flag "override" (:const 25)))))
      (evaluate-policy-tree ctx custom-rules 1 :bonus 5 :auditor auditor)))
`;

const ST_POLICY_AUDITOR_METHODS_SOURCE = JSON.stringify([
  {
    selector: 'initialize',
    source: '[ recordedTotal := 0. eventCount := 0. lastTag := \'none\'. ^self ]',
  },
  {
    selector: 'recordScore:tag:',
    source: '[ :score :tag | recordedTotal := recordedTotal + score. eventCount := eventCount + 1. lastTag := tag. ^self ]',
  },
  {
    selector: 'recordedTotal',
    source: '[ ^recordedTotal ]',
  },
  {
    selector: 'eventCount',
    source: '[ ^eventCount ]',
  },
  {
    selector: 'lastTag',
    source: '[ ^lastTag ]',
  },
  {
    selector: 'inspectAndEvaluateContext:scale:bonus:',
    source: `[ :ctx :scale :bonus |
      | summary |
      ctx tier: ((ctx tier) + 1).
      summary := self evaluateContext: ctx scale: scale bonus: bonus.
      (summary isCons)
        ifTrue: [ ^(summary car) + recordedTotal + eventCount + (ctx auditCount) ]
        ifFalse: [ ^0 ] ]`,
  },
]);

async function authorAndCapturePolicyProject(runtime, authorImageId = 'author-cl-policy') {
  await runtime.images.createImage({id: authorImageId, name: 'CL Policy Authoring Image'});

  const clEngineArtifact = await runtime.images.putCodeArtifact(authorImageId, {
    id: 'artifact/cl-policy-engine',
    languageId: COMMON_LISP_ID,
    representation: COMMON_LISP_SOURCE_V0,
    content: textValue(CL_POLICY_ENGINE_SOURCE),
  });

  const clRulesArtifact = await runtime.images.putCodeArtifact(authorImageId, {
    id: 'artifact/cl-policy-rules',
    languageId: COMMON_LISP_ID,
    representation: COMMON_LISP_SOURCE_V0,
    content: textValue(CL_POLICY_RULES_SEXP_SOURCE),
    derivedFrom: [objectRef(authorImageId, clEngineArtifact.id)],
  });

  const stAuditorArtifact = await runtime.images.putCodeArtifact(authorImageId, {
    id: 'artifact/st-policy-auditor',
    languageId: SYMMETRIC_SMALLTALK_ID,
    representation: 'symmetric-smalltalk/methods-json-v1',
    content: textValue(ST_POLICY_AUDITOR_METHODS_SOURCE),
    dependencies: [
      {artifact: objectRef(authorImageId, clEngineArtifact.id), role: 'runtime'},
      {artifact: objectRef(authorImageId, clRulesArtifact.id), role: 'runtime'},
    ],
  });

  const projectId = createProjectId();
  await createProject({
    images: runtime.images,
    imageId: authorImageId,
    projectId,
    name: 'CommonLispPolicyEngine',
  });

  const members = [
    {key: 'policy/cl-engine', role: 'source', target: objectRef(authorImageId, clEngineArtifact.id)},
    {key: 'policy/cl-rules', role: 'source', target: objectRef(authorImageId, clRulesArtifact.id)},
    {key: 'policy/st-auditor', role: 'source', target: objectRef(authorImageId, stAuditorArtifact.id)},
  ];
  for (const member of members) {
    await addProjectMember({
      images: runtime.images,
      imageId: authorImageId,
      projectId,
      ...member,
    });
  }

  const descriptor = {
    format: 'lagrange-project/v1',
    projectId,
    name: 'CommonLispPolicyEngine',
    namespace: null,
    members,
  };
  const profile = createDeploymentProfile({
    project: descriptor,
    profileId: 'production-polyglot',
    members: members.map(({key}) => key),
  });

  const captured = await captureCurrentGraphProjectRelease({
    images: runtime.images,
    projectImageId: authorImageId,
    projectId,
    profile,
  });

  return {
    projectId,
    authorImageId,
    sourceIds: {
      clEngineId: clEngineArtifact.id,
      clRulesId: clRulesArtifact.id,
      stAuditorId: stAuditorArtifact.id,
    },
    captured,
  };
}

async function installRecoveredPolicyApp({runtime, imageId, projectId, lane}) {
  const installation = await readManagedProjectInstallation({
    images: runtime.images,
    targetImageId: imageId,
    projectId,
  });
  assert.ok(installation, `managed installation for ${projectId} must exist in ${imageId}`);
  const byKey = new Map(installation.members.map((m) => [m.key, m]));

  const clEngineRecord = await runtime.images.getCodeArtifact(
    imageId,
    byKey.get('policy/cl-engine').target.objectId,
  );
  const clRulesRecord = await runtime.images.getCodeArtifact(
    imageId,
    byKey.get('policy/cl-rules').target.objectId,
  );
  const stAuditorRecord = await runtime.images.getCodeArtifact(
    imageId,
    byKey.get('policy/st-auditor').target.objectId,
  );

  // Provenance and cross-member dependency sharing preserved in the imported target graph:
  assert.deepEqual(
    clRulesRecord.derivedFrom,
    [objectRef(imageId, clEngineRecord.id)],
    'imported cl-rules derivedFrom points to the shared fresh target cl-engine artifact',
  );
  assert.deepEqual(
    stAuditorRecord.dependencies,
    [
      {artifact: objectRef(imageId, clEngineRecord.id), role: 'runtime'},
      {artifact: objectRef(imageId, clRulesRecord.id), role: 'runtime'},
    ],
    'imported st-auditor dependencies point to the shared fresh target Common Lisp artifacts',
  );

  await installCommonLispRuntime({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    lane,
  });

  await installCommonLispProgram({
    images: runtime.images,
    compilation: runtime.compilation,
    runtime,
    imageId,
    lane,
    source: clEngineRecord.content.value,
  });

  await installCommonLispProgram({
    images: runtime.images,
    compilation: runtime.compilation,
    runtime,
    imageId,
    lane,
    source: clRulesRecord.content.value,
  });

  const {classRef: auditorClassRef} = await ensureClassFromDeclaration({
    images: runtime.images,
    imageId,
    name: 'PolicyAuditor',
    instanceVariables: ['recordedTotal', 'eventCount', 'lastTag'],
  });
  const stMethods = JSON.parse(stAuditorRecord.content.value);
  await defineMethodsFromSource({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    classRef: auditorClassRef,
    lane,
    methods: stMethods,
  });
  await publishSmalltalkClassGlobals({
    images: runtime.images,
    imageId,
    names: ['PolicyAuditor'],
  });

  await attachCommonLispMethod({
    images: runtime.images,
    compilation: runtime.compilation,
    imageId,
    classRef: auditorClassRef,
    selector: 'evaluateContext:scale:bonus:',
    functionName: 'auditor-evaluate-bridge',
    passSelf: true,
    lane,
  });

  return {installation, auditorClassRef};
}

test('Real Common Lisp + Smalltalk application package: Project release capture, idempotent managed installation, cross-lane execution and durable LagrangeBackend restart', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'lagrange-cl-app-project-'));
  const sqlitePath = join(workDir, 'cl-policy-durable.sqlite');

  try {
    // -------------------------------------------------------------------------
    // Phase 1: Author and capture portable Project release in an authoring runtime
    // -------------------------------------------------------------------------
    const authorRuntime = await createRuntime({backend: {mode: 'mock'}});
    let capturedRelease;
    let capturedMaterial;
    let projectId;
    let sourceIds;
    try {
      const authored = await authorAndCapturePolicyProject(authorRuntime);
      capturedRelease = authored.captured.release;
      capturedMaterial = authored.captured.material;
      projectId = authored.projectId;
      sourceIds = authored.sourceIds;

      assert.equal(capturedMaterial.representation, GRAPH_BUNDLE_V1);
      assert.deepEqual(
        capturedMaterial.bundle.externals,
        {},
        'captured Common Lisp + Smalltalk Project release bundle is 100% closed',
      );
      assert.equal(
        Object.keys(capturedMaterial.bundle.records).length,
        3,
        'shared CodeArtifact dependencies are exported once in the multi-root bundle',
      );
    } finally {
      await authorRuntime.close();
    }

    // -------------------------------------------------------------------------
    // Phase 2: Install into target-neutral and target-wasm on a durable SQLite
    // LagrangeBackend, prove replay idempotence, and execute before restart
    // -------------------------------------------------------------------------
    const sqliteApp1 = createSqliteApplicationRuntime(sqlitePath);
    const runtime1 = await createRuntime({
      backend: {instance: new LagrangeBackend({runtime: sqliteApp1})},
    });

    const persistedFixturesByLane = {};

    try {
      for (const lane of ['neutral', 'wasm']) {
        const imageId = `target-${lane}`;
        await runtime1.images.createImage({id: imageId, name: `Policy Target (${lane})`});

        const installation = await installManagedProjectRelease({
          images: runtime1.images,
          targetImageId: imageId,
          release: capturedRelease,
          material: capturedMaterial,
        });
        assert.equal(installation.format, PROJECT_INSTALLATION_V1);
        assert.equal(installation.projectId, projectId);
        assert.equal(installation.releaseId, capturedRelease.releaseId);
        assert.equal(installation.targetImageId, imageId);

        // Fresh target identities: no target objectId equals authoring objectId or bundle localId
        for (const member of installation.members) {
          assert.equal(member.target.imageId, imageId);
          assert.notEqual(member.target.objectId, sourceIds.clEngineId);
          assert.notEqual(member.target.objectId, sourceIds.clRulesId);
          assert.notEqual(member.target.objectId, sourceIds.stAuditorId);
          assert.notEqual(member.target.objectId, capturedMaterial.bundle.roots[member.key]);
        }

        // Write-free idempotent replay of installManagedProjectRelease
        const recordsBeforeReplay = (await runtime1.images.listRecords(imageId)).length;
        const historyBeforeReplay = (await runtime1.images.history(imageId)).length;
        const replayed = await installManagedProjectRelease({
          images: runtime1.images,
          targetImageId: imageId,
          release: capturedRelease,
          material: capturedMaterial,
        });
        assert.deepEqual(replayed, installation);
        assert.equal((await runtime1.images.listRecords(imageId)).length, recordsBeforeReplay);
        assert.equal((await runtime1.images.history(imageId)).length, historyBeforeReplay);

        // Recover closure, compile & install Common Lisp + Smalltalk application in `lane`
        await installRecoveredPolicyApp({
          runtime: runtime1,
          imageId,
          projectId,
          lane,
        });

        // Allocate an AuditedCtx struct in Common Lisp and a PolicyAuditor in Smalltalk
        const ctxRef = await evaluateCommonLispSource({
          runtime: runtime1,
          imageId,
          lane,
          source: '(make-audited-ctx :subject "alice" :tier 1 :risk-budget 100)',
        });
        const auditorRef = await evaluateSymmetricSmalltalkBlock({
          runtime: runtime1,
          imageId,
          source: '[ PolicyAuditor new initialize ]',
        });

        // Execute from Smalltalk:
        // 1. Smalltalk increments `ctx tier:` from 1 -> 2 (mutating Common Lisp defstruct slot via Smalltalk accessor!)
        // 2. Smalltalk sends `self evaluateContext: ctx scale: 2 bonus: 15` -> Common Lisp `auditor-evaluate-bridge`
        // 3. Common Lisp evaluates the S-expression rule tree:
        //    - (:const 15) -> 15
        //    - (:tier-bonus 2) with tier=2 -> weights[0]+weights[1] = 10+25 = 35 * 2 = 70
        //    - (:guard-divide (:const 100) (:const 0) 35) -> ZeroDivide caught by handler-bind + use-value -> 35
        //    - (:strict-budget (:const 250) 20) -> 250 > 100 signals Error, unwind-protect increments cleaned & audit-count (1), handler-case returns 20
        //    - (:flag "high-value" (:const 30)) -> pushes "flag:high-value" to ctx.flags, sends `recordScore: 30 tag: 'flag:high-value'` to Smalltalk PolicyAuditor -> 30
        //    Sum = 15 + 70 + 35 + 20 + 30 = 170
        //    base-score = 170 * scale(2) = 340
        //    with-capped-score (:bonus 15, bonus-p true -> + 15 + 10 = +25) => final-score = 365
        //    Memoized under key tier=2 in *rule-memo-table* (hash-table-count = 1).
        //    Smalltalk receives Cons list (365 1 1 1 1) and returns:
        //    (summary car: 365) + (recordedTotal: 30) + (eventCount: 1) + (ctx auditCount: 1) = 397!
        const combinedScore = await evaluateSymmetricSmalltalkBlock({
          runtime: runtime1,
          imageId,
          arguments: [auditorRef, ctxRef],
          source: '[ :auditor :ctx | auditor inspectAndEvaluateContext: ctx scale: 2 bonus: 15 ]',
        });
        assert.deepEqual(
          combinedScore,
          integerValue(397n),
          `pre-restart polyglot evaluation matches in ${lane} lane`,
        );

        // Persist a durable root holding ctxRef and auditorRef so we can recover them after restart
        await runtime1.images.putShape(imageId, {
          id: 'policy/fixture-root-shape',
          slots: [
            {id: 'ctx', name: 'ctx'},
            {id: 'auditor', name: 'auditor'},
          ],
        });
        await runtime1.images.putObject(imageId, {
          id: 'policy/fixture-root',
          shape: objectRef(imageId, 'policy/fixture-root-shape'),
          slots: {
            ctx: ctxRef,
            auditor: auditorRef,
          },
        });
        persistedFixturesByLane[lane] = {imageId};
      }
    } finally {
      await runtime1.close();
    }

    // -------------------------------------------------------------------------
    // Phase 3: Reopen a fresh runtime over the same durable SQLite file WITH
    // ZERO RE-INSTALLATION OR RECOMPILATION, and prove both neutral and wasm
    // lanes execute from durable image state after restart.
    // -------------------------------------------------------------------------
    const sqliteApp2 = createSqliteApplicationRuntime(sqlitePath);
    const runtime2 = await createRuntime({
      backend: {instance: new LagrangeBackend({runtime: sqliteApp2})},
    });

    try {
      for (const lane of ['neutral', 'wasm']) {
        const {imageId} = persistedFixturesByLane[lane];

        // Verify managed installation metadata survived restart
        const recoveredInstall = await readManagedProjectInstallation({
          images: runtime2.images,
          targetImageId: imageId,
          projectId,
        });
        assert.ok(recoveredInstall, `managed installation survives restart in ${imageId}`);
        assert.equal(recoveredInstall.releaseId, capturedRelease.releaseId);

        const fixtureRoot = await runtime2.images.getObject(imageId, 'policy/fixture-root');
        const ctxRef = fixtureRoot.slots.ctx;
        const auditorRef = fixtureRoot.slots.auditor;

        // 1. Invoke the recovered cl-rules function `evaluate-custom-override` directly on the
        //    persisted ctx (tier is now 2, audit-count is 1, flags has 1 item) and auditor:
        //    - (:const 40) -> 40
        //    - (:guard-divide (:const 90) (:const 3) 0) -> 30
        //    - (:strict-budget (:const 50) 5) -> 50 <= 100 (no error!), unwind-protect still increments cleaned (1) & audit-count (1 -> 2) -> 50
        //    - (:flag "override" (:const 25)) -> pushes "flag:override" (flags length 1 -> 2), sends recordScore: 25 to auditor (recordedTotal 30 -> 55, eventCount 1 -> 2) -> 25
        //    Sum = 40 + 30 + 50 + 25 = 145
        //    with-capped-score (:bonus 5, bonus-p true -> + 5 + 10 = +15) => final-score = 160
        //    *rule-memo-table* updates key tier=2 -> 160 (hash-table-count remains 1).
        const overrideSummary = await evaluateCommonLispSource({
          runtime: runtime2,
          imageId,
          lane,
          captures: {
            ctx: {id: 'cap:ctx2', name: 'CTX', value: ctxRef},
            auditor: {id: 'cap:aud2', name: 'AUDITOR', value: auditorRef},
          },
          source: '(evaluate-custom-override ctx auditor)',
        });
        const summaryElements = await commonLispListToArray({
          images: runtime2.images,
          imageId,
          value: overrideSummary,
        });
        assert.deepEqual(
          summaryElements,
          [
            integerValue(160n),
            integerValue(1n),
            integerValue(2n),
            integerValue(2n),
            integerValue(1n),
          ],
          `post-restart Common Lisp evaluation and struct/hash-table state match in ${lane} lane`,
        );

        // 2. Execute Smalltalk -> Common Lisp bridge again after restart (mutating tier 2 -> 3,
        //    adding a second key tier=3 to *rule-memo-table*, and verifying Smalltalk state):
        //    With tier=3:
        //    - (:tier-bonus 2) -> (10 + 25 + 50) * 2 = 170
        //    - Sum = 15 + 170 + 35 + 20 + 30 = 270
        //    - scale=1 -> base-score = 270
        //    - bonus=0 (bonus-p true -> +10) -> final-score = 280
        //    - auditor recordedTotal becomes 55 + 30 = 85, eventCount becomes 2 + 1 = 3, ctx auditCount becomes 2 + 1 = 3
        //    - inspectAndEvaluateContext returns 280 + 85 + 3 + 3 = 371!
        const postRestartSmalltalkScore = await evaluateSymmetricSmalltalkBlock({
          runtime: runtime2,
          imageId,
          arguments: [auditorRef, ctxRef],
          source: '[ :auditor :ctx | auditor inspectAndEvaluateContext: ctx scale: 1 bonus: 0 ]',
        });
        assert.deepEqual(
          postRestartSmalltalkScore,
          integerValue(371n),
          `post-restart Smalltalk <-> Common Lisp method bridge matches in ${lane} lane`,
        );

        // Verify *rule-memo-table* now has 2 entries (tier 2 => 160, tier 3 => 280)
        const memoCheck = await evaluateCommonLispSource({
          runtime: runtime2,
          imageId,
          lane,
          source: '(list (hash-table-count *rule-memo-table*) (gethash 2 *rule-memo-table*) (gethash 3 *rule-memo-table*))',
        });
        assert.deepEqual(
          await commonLispListToArray({images: runtime2.images, imageId, value: memoCheck}),
          [integerValue(2n), integerValue(160n), integerValue(280n)],
          `durable *rule-memo-table* retains both pre- and post-restart entries in ${lane} lane`,
        );
      }
    } finally {
      await runtime2.close();
    }
  } finally {
    await rm(workDir, {recursive: true, force: true});
  }
});
