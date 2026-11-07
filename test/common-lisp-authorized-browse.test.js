import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  COMMON_LISP_DEFINITION_DESCRIPTION_V1,
  COMMON_LISP_DEFINITION_KIND,
  COMMON_LISP_DEFINITION_READ_OPERATION,
  COMMON_LISP_DEFINITION_WRITE_OPERATION,
  COMMON_LISP_NAMESPACE_DESCRIPTION_V1,
  COMMON_LISP_NAMESPACE_ID,
  LagrangeBackend,
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  SMALLTALK_CLASS_DESCRIPTION_V1,
  authorizedDescribeCommonLispDefinition,
  authorizedDescribeCommonLispNamespace,
  authorizedDescribeSmalltalkClass,
  authorizedInstallCommonLispProgram,
  authorizedInstallCommonLispSystem,
  authorizedInstallCommonLispSystemFromArtifact,
  authorizedReplaceCommonLispDefinition,
  commonLispDefinitionResource,
  createRuntime,
  evaluateCommonLispSource,
  installCommonLispProgram,
  installCommonLispSystem,
  integerValue,
  objectRef,
  objectResource,
  textValue,
} from '../src/runtime.js';
import {exportGraphBundle, importGraphBundle} from '../src/graph/bundle.js';
import {createPortableRuntime} from '../src/portable-runtime.js';
import {collectStaticModuleClosure} from '../src/portable-artifact/module-closure.js';
import {createNodeSourceReader} from '../src/portable-artifact/node-source-reader.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const FORBIDDEN_STORAGE_TOKENS = [
  '_version',
  'global-binding',
  'common-lisp/function-binding/',
  'common-lisp/variable-binding/',
  'common-lisp/macro-binding/',
  'common-lisp/struct-binding/',
  'common-lisp/signature-binding/',
  '%MACRO:',
  '%STRUCT:',
  '%SIG:',
  '%MAKE-STRUCT-',
  'instance-shape',
  'behavior-methods',
];

function assertNoStorageLayout(description, label) {
  const raw = JSON.stringify(description);
  for (const token of FORBIDDEN_STORAGE_TOKENS) {
    assert.equal(raw.includes(token), false, `${label} must not expose ${token}: ${raw}`);
  }
}

function requireFor(runtime, grants) {
  const context = runtime.authority.issue({principal: 'inspector', grants});
  return (demand) => runtime.authority.require(context, demand);
}

const namespaceReadGrant = (imageId, namespaceId = COMMON_LISP_NAMESPACE_ID) => ({
  operation: OBJECT_READ_OPERATION,
  resource: objectResource(imageId, namespaceId),
});

const namespaceWriteGrant = (imageId, namespaceId = COMMON_LISP_NAMESPACE_ID) => ({
  operation: OBJECT_WRITE_OPERATION,
  resource: objectResource(imageId, namespaceId),
});

const definitionReadGrant = (imageId, kind, name, namespaceId = COMMON_LISP_NAMESPACE_ID) => ({
  operation: COMMON_LISP_DEFINITION_READ_OPERATION,
  resource: commonLispDefinitionResource(imageId, kind, name, {namespaceId}),
});

const definitionWriteGrant = (imageId, kind, name, namespaceId = COMMON_LISP_NAMESPACE_ID) => ({
  operation: COMMON_LISP_DEFINITION_WRITE_OPERATION,
  resource: commonLispDefinitionResource(imageId, kind, name, {namespaceId}),
});

async function withCommonLispImage(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app'});
    await installCommonLispProgram({
      runtime,
      imageId: 'app',
      lane: 'neutral',
      source: `
        (defparameter *risk-floor* 10)
        (defvar *audit-tag* "v1")

        (defmacro with-floor (val &body body)
          \`(let ((*risk-floor* ,val)) ,@body))

        (defstruct (base-tx (:conc-name tx-))
          id
          (amount 0))

        (defstruct (flagged-tx (:include base-tx) (:conc-name ftx-))
          (reason "none"))

        (defun score (base &optional (weight 2) &key (bonus 0))
          (+ (* base weight) bonus *risk-floor*))
      `,
    });
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

test('authorizedDescribeCommonLispNamespace lists sorted canonical functions, macros, structs, and variables without storage layout', async () => {
  await withCommonLispImage(async (runtime) => {
    const description = await authorizedDescribeCommonLispNamespace({
      images: runtime.images,
      imageId: 'app',
      require: requireFor(runtime, [namespaceReadGrant('app')]),
    });

    assert.equal(description.format, COMMON_LISP_NAMESPACE_DESCRIPTION_V1);
    assert.deepEqual(description.namespace, objectRef('app', COMMON_LISP_NAMESPACE_ID));
    assert.deepEqual(Object.keys(description).sort(), [
      'format',
      'functions',
      'macros',
      'namespace',
      'structs',
      'variables',
    ]);

    assert.ok(description.functions.includes('SCORE'));
    assert.ok(description.functions.includes('MAKE-BASE-TX'));
    assert.ok(description.functions.includes('MAKE-FLAGGED-TX'));
    assert.ok(description.functions.includes('MAPCAR'));
    assert.equal(
      description.functions.some((fn) => fn.startsWith('%')),
      false,
      'internal compiler helper functions must not appear in namespace function listings',
    );
    assert.deepEqual(
      description.functions,
      [...description.functions].sort((a, b) => a.localeCompare(b)),
      'functions are sorted canonically',
    );

    assert.deepEqual(description.macros, ['WITH-FLOOR']);
    assert.deepEqual(description.structs, ['BASE-TX', 'FLAGGED-TX']);
    assert.deepEqual(description.variables, ['*AUDIT-TAG*', '*RISK-FLOOR*']);

    assertNoStorageLayout(description, 'namespace description');
  });
});

test('authorizedDescribeCommonLispDefinition describes functions, macros, structs, and variables and follows revisions', async () => {
  await withCommonLispImage(async (runtime) => {
    const fnDesc = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
      name: 'score',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'score'),
      ]),
    });

    assert.equal(fnDesc.format, COMMON_LISP_DEFINITION_DESCRIPTION_V1);
    assert.equal(fnDesc.kind, 'function');
    assert.equal(fnDesc.name, 'SCORE');
    assert.equal(fnDesc.function.imageId, 'app');
    assert.equal(fnDesc.signature.requiredCount, 1);
    assert.equal(fnDesc.signature.optionalCount, 1);
    assert.equal(fnDesc.signature.hasRestOrKey, true);
    assert.ok(fnDesc.source.startsWith('(DEFUN SCORE '));
    assertNoStorageLayout(fnDesc, 'function description');

    // Redefining SCORE creates a new Block revision while the logical definition grant stays valid
    const grantBeforeRedefine = requireFor(runtime, [
      namespaceReadGrant('app'),
      definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'score'),
    ]);
    await evaluateCommonLispSource({
      runtime,
      imageId: 'app',
      source: '(defun score (base &optional (weight 3) &key (bonus 5)) (+ (* base weight) bonus))',
    });
    const fnDescAfter = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
      name: 'SCORE',
      require: grantBeforeRedefine,
    });
    assert.notEqual(
      fnDescAfter.function.objectId,
      fnDesc.function.objectId,
      'redefinition advances the bound Block revision',
    );
    assert.ok(fnDescAfter.source.includes('(WEIGHT 3)'));

    // Macro description
    const macroDesc = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.MACRO,
      name: 'with-floor',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.MACRO, 'with-floor'),
      ]),
    });
    assert.equal(macroDesc.format, COMMON_LISP_DEFINITION_DESCRIPTION_V1);
    assert.equal(macroDesc.kind, 'macro');
    assert.equal(macroDesc.name, 'WITH-FLOOR');
    assert.equal(macroDesc.lambdaList, '(VAL &BODY BODY)');
    assert.ok(macroDesc.source.startsWith('(DEFMACRO WITH-FLOOR (VAL &BODY BODY)'));
    assertNoStorageLayout(macroDesc, 'macro description');

    // Struct description + browsing its backing Smalltalk class locator
    const structDesc = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.STRUCT,
      name: 'flagged-tx',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.STRUCT, 'flagged-tx'),
      ]),
    });
    assert.equal(structDesc.format, COMMON_LISP_DEFINITION_DESCRIPTION_V1);
    assert.equal(structDesc.kind, 'struct');
    assert.equal(structDesc.name, 'FLAGGED-TX');
    assert.equal(structDesc.className, 'FlaggedTx');
    assert.equal(structDesc.include, 'BASE-TX');
    assert.equal(structDesc.concName, 'FTX-');
    assert.equal(structDesc.constructor, 'MAKE-FLAGGED-TX');
    assert.equal(structDesc.predicate, 'FLAGGED-TX-P');
    assert.equal(structDesc.copier, 'COPY-FLAGGED-TX');
    assert.deepEqual(structDesc.slots, ['ID', 'AMOUNT', 'REASON']);
    assert.deepEqual(structDesc.localSlots, ['REASON']);
    assertNoStorageLayout(structDesc, 'struct description');

    // The struct's `class` field is a standard Smalltalk Class locator browsable under its own grant
    const backingClassDesc = await authorizedDescribeSmalltalkClass({
      images: runtime.images,
      imageId: 'app',
      classRef: structDesc.class,
      require: requireFor(runtime, [
        {operation: OBJECT_READ_OPERATION, resource: objectResource('app', structDesc.class.objectId)},
      ]),
    });
    assert.equal(backingClassDesc.format, SMALLTALK_CLASS_DESCRIPTION_V1);
    assert.equal(backingClassDesc.name, 'FlaggedTx');
    assert.deepEqual(backingClassDesc.layout.instanceVariables, ['id', 'amount', 'reason']);

    // Variable description + runtime mutation reflection
    const varDesc = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.VARIABLE,
      name: '*risk-floor*',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.VARIABLE, '*risk-floor*'),
      ]),
    });
    assert.equal(varDesc.format, COMMON_LISP_DEFINITION_DESCRIPTION_V1);
    assert.equal(varDesc.kind, 'variable');
    assert.equal(varDesc.name, '*RISK-FLOOR*');
    assert.deepEqual(varDesc.value, integerValue(10));
    assertNoStorageLayout(varDesc, 'variable description');

    await evaluateCommonLispSource({
      runtime,
      imageId: 'app',
      source: '(defparameter *risk-floor* 42)',
    });
    const varDescUpdated = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.VARIABLE,
      name: '*RISK-FLOOR*',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.VARIABLE, '*risk-floor*'),
      ]),
    });
    assert.deepEqual(varDescUpdated.value, integerValue(42));
  });
});

test('authorization strictly precedes existence disclosure and isolates Lisp-2 function vs variable grants', async () => {
  await withCommonLispImage(async (runtime) => {
    // 1. Lisp-2 separation: a grant for function SCORE does not authorize variable SCORE
    const fnOnlyGrant = requireFor(runtime, [
      namespaceReadGrant('app'),
      definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'score'),
    ]);
    await assert.rejects(
      authorizedDescribeCommonLispDefinition({
        images: runtime.images,
        imageId: 'app',
        kind: COMMON_LISP_DEFINITION_KIND.VARIABLE,
        name: 'score',
        require: fnOnlyGrant,
      }),
      {name: 'AuthorityError'},
    );

    // 2. Namespace authority alone does not authorize any definition
    const nsOnlyGrant = requireFor(runtime, [namespaceReadGrant('app')]);
    await assert.rejects(
      authorizedDescribeCommonLispDefinition({
        images: runtime.images,
        imageId: 'app',
        kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
        name: 'score',
        require: nsOnlyGrant,
      }),
      {name: 'AuthorityError'},
    );

    // 3. Definition authority without namespace authority is refused before any backend read
    let backendReads = 0;
    const origGet = runtime.backend.get.bind(runtime.backend);
    runtime.backend.get = async (collection, key) => {
      backendReads += 1;
      return await origGet(collection, key);
    };
    try {
      const defOnlyGrant = requireFor(runtime, [
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'score'),
      ]);
      await assert.rejects(
        authorizedDescribeCommonLispDefinition({
          images: runtime.images,
          imageId: 'app',
          kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
          name: 'score',
          require: defOnlyGrant,
        }),
        {name: 'AuthorityError'},
      );
      assert.equal(backendReads, 0, 'denied definition browse must perform zero backend reads');

      // 4. Denied caller cannot distinguish existing SCORE from non-existent MISSING-FN (no existence oracle)
      let existingError = null;
      let missingError = null;
      try {
        await authorizedDescribeCommonLispDefinition({
          images: runtime.images,
          imageId: 'app',
          kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
          name: 'score',
          require: nsOnlyGrant,
        });
      } catch (err) {
        existingError = err;
      }
      try {
        await authorizedDescribeCommonLispDefinition({
          images: runtime.images,
          imageId: 'app',
          kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
          name: 'missing-fn',
          require: nsOnlyGrant,
        });
      } catch (err) {
        missingError = err;
      }
      assert.equal(existingError?.name, 'AuthorityError');
      assert.equal(missingError?.name, 'AuthorityError');
      assert.equal(backendReads, 0, 'no existence oracle: zero backend reads when definition grant is missing');
    } finally {
      runtime.backend.get = origGet;
    }

    // 5. Authorized caller requesting a missing definition receives a clear TypeError
    await assert.rejects(
      authorizedDescribeCommonLispDefinition({
        images: runtime.images,
        imageId: 'app',
        kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
        name: 'missing-fn',
        require: requireFor(runtime, [
          namespaceReadGrant('app'),
          definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'missing-fn'),
        ]),
      }),
      /does not define function MISSING-FN/,
    );
  });
});

test('Common Lisp browsing seam has a portable static module closure and survives createPortableRuntime and durable SQLite restart', async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const {modules, violations} = collectStaticModuleClosure({
    entry: 'src/language/common-lisp-browse.js',
    readSource: createNodeSourceReader(repo),
  });
  const paths = modules.map(({path}) => path);
  assert.ok(paths.includes('src/language/common-lisp-browse.js'));
  assert.ok(paths.includes('src/language/common-lisp-definition-resource.js'));
  const forbidden = paths.filter((path) =>
    /(cuis|toolchain|foreign-runtime|perspective|session|presentation|src\/project\/)/i.test(path));
  assert.deepEqual(forbidden, []);
  assert.deepEqual(violations, [], 'the seam stays portable: no node:* import on the browsing lane');

  const portable = await createPortableRuntime({backend: {mode: 'mock'}});
  try {
    await portable.images.createImage({id: 'portable-cl'});
    await installCommonLispProgram({
      runtime: portable,
      imageId: 'portable-cl',
      lane: 'neutral',
      source: '(defun portable-inc (x) (+ x 1))',
    });
    const portableNs = await authorizedDescribeCommonLispNamespace({
      images: portable.images,
      imageId: 'portable-cl',
      require: requireFor(portable, [namespaceReadGrant('portable-cl')]),
    });
    assert.ok(portableNs.functions.includes('PORTABLE-INC'));
  } finally {
    await portable.close();
  }

  const sqliteApp = createSqliteApplicationRuntime();
  await sqliteApp.start();
  try {
    const runtime1 = await createRuntime({
      backend: {
        instance: new LagrangeBackend({
          runtime: sqliteApp,
          ownsRuntime: false,
          namespace: 'cl-browse-durable',
        }),
      },
    });
    await runtime1.images.createImage({id: 'durable-cl'});
    await installCommonLispProgram({
      runtime: runtime1,
      imageId: 'durable-cl',
      lane: 'wasm',
      source: `
        (defstruct (point2d (:conc-name pt-)) (x 0) (y 0))
        (defun manhattan (p) (+ (pt-x p) (pt-y p)))
      `,
    });
    await runtime1.close();

    const runtime2 = await createRuntime({
      backend: {
        instance: new LagrangeBackend({
          runtime: sqliteApp,
          ownsRuntime: false,
          namespace: 'cl-browse-durable',
        }),
      },
    });
    try {
      const nsDesc = await authorizedDescribeCommonLispNamespace({
        images: runtime2.images,
        imageId: 'durable-cl',
        require: requireFor(runtime2, [namespaceReadGrant('durable-cl')]),
      });
      assert.ok(nsDesc.functions.includes('MANHATTAN'));
      assert.deepEqual(nsDesc.structs, ['POINT2D']);

      const fnDesc = await authorizedDescribeCommonLispDefinition({
        images: runtime2.images,
        imageId: 'durable-cl',
        kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
        name: 'manhattan',
        require: requireFor(runtime2, [
          namespaceReadGrant('durable-cl'),
          definitionReadGrant('durable-cl', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'manhattan'),
        ]),
      });
      assert.equal(fnDesc.name, 'MANHATTAN');
      assert.deepEqual(fnDesc.signature.parameters, ['P']);
    } finally {
      await runtime2.close();
    }
  } finally {
    await sqliteApp.stop();
  }
});

test('authorizedDescribeCommonLispDefinition describes CLOS classes and generic functions and browses package namespaces', async () => {
  await withCommonLispImage(async (runtime) => {
    await installCommonLispProgram({
      runtime,
      imageId: 'app',
      lane: 'neutral',
      source: `
        (defclass account ()
          ((balance :initarg :balance :initform 0 :accessor account-balance)))

        (defclass savings-account (account)
          ((rate :initarg :rate :initform 5 :reader savings-rate)))

        (defgeneric compute-interest (acct years))
        (defmethod compute-interest ((a account) years) 0)
        (defmethod compute-interest ((a savings-account) years)
          (* (account-balance a) (savings-rate a) years))

        (defpackage :bank-pkg
          (:use :cl)
          (:export #:open-acct))
        (in-package :bank-pkg)
        (defun open-acct (b) b)
        (in-package :cl-user)
      `,
    });

    const clsDesc = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.CLASS,
      name: 'savings-account',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.CLASS, 'savings-account'),
      ]),
    });
    assert.equal(clsDesc.format, COMMON_LISP_DEFINITION_DESCRIPTION_V1);
    assert.equal(clsDesc.kind, 'class');
    assert.equal(clsDesc.name, 'SAVINGS-ACCOUNT');
    assert.equal(clsDesc.className, 'SavingsAccount');
    assert.deepEqual(clsDesc.superclasses, ['ACCOUNT']);
    assert.deepEqual(clsDesc.cpl, ['SAVINGS-ACCOUNT', 'ACCOUNT']);
    assert.deepEqual(clsDesc.slots, ['BALANCE', 'RATE']);
    assert.deepEqual(clsDesc.localSlots, ['RATE']);
    assertNoStorageLayout(clsDesc, 'CLOS class description');

    const genDesc = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.GENERIC,
      name: 'compute-interest',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.GENERIC, 'compute-interest'),
      ]),
    });
    assert.equal(genDesc.format, COMMON_LISP_DEFINITION_DESCRIPTION_V1);
    assert.equal(genDesc.kind, 'generic');
    assert.equal(genDesc.name, 'COMPUTE-INTEREST');
    assert.deepEqual(genDesc.parameters, ['ACCT', 'YEARS']);
    assert.equal(genDesc.methods.length, 2);
    assert.deepEqual(genDesc.methods[0].specializers, ['ACCOUNT', 'T']);
    assert.deepEqual(genDesc.methods[1].specializers, ['SAVINGS-ACCOUNT', 'T']);
    assertNoStorageLayout(genDesc, 'CLOS generic function description');

    // Package namespace browsing
    const pkgNsId = 'common-lisp/package-namespace/QkFOSy1QS0c';
    const pkgNsDesc = await authorizedDescribeCommonLispNamespace({
      images: runtime.images,
      imageId: 'app',
      namespaceId: pkgNsId,
      require: requireFor(runtime, [namespaceReadGrant('app', pkgNsId)]),
    });
    assert.equal(pkgNsDesc.format, COMMON_LISP_NAMESPACE_DESCRIPTION_V1);
    assert.deepEqual(pkgNsDesc.functions, ['OPEN-ACCT']);
    assertNoStorageLayout(pkgNsDesc, 'package namespace description');
  });
});

test('authorizedInstallCommonLispProgram, authorizedInstallCommonLispSystem, and authorizedReplaceCommonLispDefinition enforce write authority before existence and isolate Lisp-2 write grants', async () => {
  await withCommonLispImage(async (runtime) => {
    // 1. Denied program install performs zero backend reads (no existence oracle)
    let backendReads = 0;
    const origGet = runtime.backend.get.bind(runtime.backend);
    runtime.backend.get = async (collection, key) => {
      backendReads += 1;
      return await origGet(collection, key);
    };
    try {
      await assert.rejects(
        authorizedInstallCommonLispProgram({
          runtime,
          imageId: 'app',
          source: '(defun unauthorized-fn (x) x)',
          require: requireFor(runtime, [namespaceReadGrant('app')]),
        }),
        {name: 'AuthorityError'},
      );
      assert.equal(backendReads, 0, 'denied program install must perform zero backend reads');

      // 2. Denied definition replacement cannot distinguish existing SCORE from missing NO-SUCH-FN
      const nsWriteOnly = requireFor(runtime, [namespaceWriteGrant('app')]);
      await assert.rejects(
        authorizedReplaceCommonLispDefinition({
          runtime,
          imageId: 'app',
          kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
          name: 'score',
          source: '(defun score (base) base)',
          require: nsWriteOnly,
        }),
        {name: 'AuthorityError'},
      );
      await assert.rejects(
        authorizedReplaceCommonLispDefinition({
          runtime,
          imageId: 'app',
          kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
          name: 'no-such-fn',
          source: '(defun no-such-fn (base) base)',
          require: nsWriteOnly,
        }),
        {name: 'AuthorityError'},
      );
      assert.equal(backendReads, 0, 'denied definition replacement must perform zero backend reads');

      // 3. Lisp-2 write isolation: variable write grant for *RISK-FLOOR* cannot replace function *RISK-FLOOR* (and vice versa)
      const fnScoreWriteGrant = requireFor(runtime, [
        namespaceWriteGrant('app'),
        definitionWriteGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, '*risk-floor*'),
      ]);
      await assert.rejects(
        authorizedReplaceCommonLispDefinition({
          runtime,
          imageId: 'app',
          kind: COMMON_LISP_DEFINITION_KIND.VARIABLE,
          name: '*risk-floor*',
          source: '(defparameter *risk-floor* 999)',
          require: fnScoreWriteGrant,
        }),
        {name: 'AuthorityError'},
      );
      assert.equal(backendReads, 0, 'Lisp-2 mismatched write grant must perform zero backend reads');
    } finally {
      runtime.backend.get = origGet;
    }

    // 4. Authorized program install succeeds and returns a storage-layout-free receipt
    const installReceipt = await authorizedInstallCommonLispProgram({
      runtime,
      imageId: 'app',
      source: `
        (defparameter *bonus-scale* 3)
        (defun apply-bonus (x) (* x *bonus-scale*))
      `,
      require: requireFor(runtime, [namespaceWriteGrant('app')]),
    });
    assert.equal(installReceipt.installed, true);
    assert.deepEqual(installReceipt.functions, ['APPLY-BONUS']);
    assert.deepEqual(installReceipt.variables, ['*BONUS-SCALE*']);
    assertNoStorageLayout(installReceipt, 'install receipt');

    // 5. Authorized replacement of an existing function and variable updates live execution
    const replaceFnReceipt = await authorizedReplaceCommonLispDefinition({
      runtime,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
      name: 'apply-bonus',
      source: '(defun apply-bonus (x) (+ (* x *bonus-scale*) 100))',
      require: requireFor(runtime, [
        namespaceWriteGrant('app'),
        definitionWriteGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'apply-bonus'),
      ]),
    });
    assert.deepEqual(replaceFnReceipt, {
      replaced: true,
      namespace: objectRef('app', COMMON_LISP_NAMESPACE_ID),
      kind: 'function',
      name: 'APPLY-BONUS',
    });
    assertNoStorageLayout(replaceFnReceipt, 'replace receipt');

    assert.deepEqual(
      await evaluateCommonLispSource({
        runtime,
        imageId: 'app',
        source: '(apply-bonus 5)',
      }),
      integerValue(115n),
    );

    // Authorized replacement of a missing definition fails cleanly with TypeError
    await assert.rejects(
      authorizedReplaceCommonLispDefinition({
        runtime,
        imageId: 'app',
        kind: COMMON_LISP_DEFINITION_KIND.FUNCTION,
        name: 'missing-target',
        source: '(defun missing-target (x) x)',
        require: requireFor(runtime, [
          namespaceWriteGrant('app'),
          definitionWriteGrant('app', COMMON_LISP_DEFINITION_KIND.FUNCTION, 'missing-target'),
        ]),
      }),
      /does not define function MISSING-TARGET/,
    );

    // 6. Authorized system install and authorized system definition browse
    const sysReceipt = await authorizedInstallCommonLispSystem({
      runtime,
      imageId: 'app',
      asdSource: `
        (defsystem :mini-ledger
          :description "Mini ledger system"
          :version "0.4.0"
          :serial t
          :components
          ((:file "entry")
           (:file "summary")))
      `,
      files: {
        'entry.lisp': '(defun make-entry (amt) (+ amt 1))',
        'summary.lisp': '(defun summarize-entry (amt) (format nil "total=~D" (make-entry amt)))',
      },
      require: requireFor(runtime, [
        namespaceWriteGrant('app'),
        definitionWriteGrant('app', COMMON_LISP_DEFINITION_KIND.SYSTEM, 'mini-ledger'),
      ]),
    });
    assert.equal(sysReceipt.installed, true);
    assert.equal(sysReceipt.system, 'MINI-LEDGER');
    assert.equal(sysReceipt.version, '0.4.0');
    assert.deepEqual(sysReceipt.loadOrder, ['entry', 'summary']);
    assertNoStorageLayout(sysReceipt, 'system install receipt');

    const sysDesc = await authorizedDescribeCommonLispDefinition({
      images: runtime.images,
      imageId: 'app',
      kind: COMMON_LISP_DEFINITION_KIND.SYSTEM,
      name: 'mini-ledger',
      require: requireFor(runtime, [
        namespaceReadGrant('app'),
        definitionReadGrant('app', COMMON_LISP_DEFINITION_KIND.SYSTEM, 'mini-ledger'),
      ]),
    });
    assert.equal(sysDesc.format, COMMON_LISP_DEFINITION_DESCRIPTION_V1);
    assert.equal(sysDesc.kind, 'system');
    assert.equal(sysDesc.name, 'MINI-LEDGER');
    assert.equal(sysDesc.version, '0.4.0');
    assert.deepEqual(sysDesc.loadOrder, ['entry', 'summary']);
    assertNoStorageLayout(sysDesc, 'system definition description');

    assert.deepEqual(
      await evaluateCommonLispSource({
        runtime,
        imageId: 'app',
        source: '(summarize-entry 41)',
      }),
      textValue('total=42'),
    );

    // 7. authorizedInstallCommonLispSystemFromArtifact enforces authority before existence and recovers from imported bundle
    const exportedSystem = await installCommonLispSystem({
      runtime,
      imageId: 'app',
      asdSource: `
        (defsystem :portable-ledger
          :description "Portable ledger system"
          :version "1.0.0"
          :serial t
          :components
          ((:file "calc")
           (:file "fmt")))
      `,
      files: {
        'calc.lisp': '(defun ledger-calc (n) (* n 10))',
        'fmt.lisp': '(defun ledger-fmt (n) (format nil "val=~D" (ledger-calc n)))',
      },
    });
    await runtime.images.createImage({id: 'target-cl'});
    const {bundle} = await exportGraphBundle({
      images: runtime.images,
      roots: {ledger: exportedSystem.artifact},
    });
    const imported = await importGraphBundle({
      images: runtime.images,
      targetImageId: 'target-cl',
      bundle,
    });
    const targetSysRef = imported.roots.ledger;
    const targetSysRecord = await runtime.images.getCodeArtifact('target-cl', targetSysRef.objectId);

    // Denied caller without object/read on systemArtifact performs zero backend reads
    let artifactReads = 0;
    const origGetTarget = runtime.backend.get.bind(runtime.backend);
    runtime.backend.get = async (collection, key) => {
      artifactReads += 1;
      return await origGetTarget(collection, key);
    };
    try {
      await assert.rejects(
        authorizedInstallCommonLispSystemFromArtifact({
          runtime,
          imageId: 'target-cl',
          systemArtifact: targetSysRef,
          require: requireFor(runtime, [namespaceWriteGrant('target-cl')]),
        }),
        {name: 'AuthorityError'},
      );
      assert.equal(artifactReads, 0, 'missing object/read on systemArtifact must perform zero backend reads');
    } finally {
      runtime.backend.get = origGetTarget;
    }

    const artifactGrants = [
      namespaceWriteGrant('target-cl'),
      {operation: OBJECT_READ_OPERATION, resource: objectResource('target-cl', targetSysRef.objectId)},
      ...targetSysRecord.dependencies.map((d) => ({
        operation: OBJECT_READ_OPERATION,
        resource: objectResource('target-cl', d.artifact.objectId),
      })),
      definitionWriteGrant('target-cl', COMMON_LISP_DEFINITION_KIND.SYSTEM, 'portable-ledger'),
    ];
    const fromArtifactReceipt = await authorizedInstallCommonLispSystemFromArtifact({
      runtime,
      imageId: 'target-cl',
      systemArtifact: targetSysRef,
      require: requireFor(runtime, artifactGrants),
    });
    assert.equal(fromArtifactReceipt.installed, true);
    assert.equal(fromArtifactReceipt.system, 'PORTABLE-LEDGER');
    assert.equal(fromArtifactReceipt.version, '1.0.0');
    assert.deepEqual(fromArtifactReceipt.loadOrder, ['calc', 'fmt']);
    assertNoStorageLayout(fromArtifactReceipt, 'system artifact install receipt');

    assert.deepEqual(
      await evaluateCommonLispSource({
        runtime,
        imageId: 'target-cl',
        source: '(ledger-fmt 7)',
      }),
      textValue('val=70'),
    );
  });
});
