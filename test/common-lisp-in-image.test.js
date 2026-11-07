import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMON_LISP_ID,
  CONS_SHAPE_ID,
  LAGRANGE_CODE_V2,
  SYMMETRIC_SMALLTALK_ID,
  attachCommonLispMethod,
  commonLispListToArray,
  createRuntime,
  defineMethodsFromSource,
  ensureClassFromDeclaration,
  evaluateCommonLispSource,
  evaluateSymmetricSmalltalkBlock,
  installCommonLispProgram,
  installCommonLispRuntime,
  installCommonLispSystem,
  installCommonLispSystemFromArtifact,
  integerValue,
  objectRef,
  parseCommonLispDefsystem,
  publishSmalltalkClassGlobals,
  readCommonLispSource,
  readCommonLispSystemDefinition,
  symbolObjectId,
  textValue,
} from '../src/runtime.js';
import {exportGraphBundle, importGraphBundle} from '../src/graph/bundle.js';

async function withRuntime(fn) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'app', name: 'App'});
    await fn(runtime);
  } finally {
    await runtime.close();
  }
}

test('readCommonLispSource parses comments, radixes, strings, pipe-escaped symbols, quotes, quasiquotes and dotted pairs', () => {
  const forms = readCommonLispSource(`
    ; line comment
    #| nested #| block |# comment |#
    (defun |camelCase| (x :key)
      '(1 . 2)
      #'+
      \`(a ,x ,@(list #x10 #b101 #o7 "hi\\n")))
  `);
  assert.equal(forms.length, 1);
  const defun = forms[0];
  assert.equal(defun.kind, 'list');
  assert.equal(defun.elements[0].name, 'DEFUN');
  assert.equal(defun.elements[1].name, 'camelCase');
  assert.equal(defun.elements[1].spelling, 'camelCase');

  const dottedQuote = defun.elements[3];
  assert.equal(dottedQuote.elements[0].name, 'QUOTE');
  assert.equal(dottedQuote.elements[1].elements[0].value, '1');
  assert.equal(dottedQuote.elements[1].dottedTail.value, '2');

  assert.throws(() => readCommonLispSource('(1 . 2 3)'), /exactly one form after \./);
  assert.throws(() => readCommonLispSource('(. 1)'), /cannot begin with \./);
  assert.throws(() => readCommonLispSource('"unterminated'), /unterminated string/);

  // Phase 2 reader syntax: #(...) vector literals and #\... character literals
  const phase2Forms = readCommonLispSource('#(10 :x "ok") #\\A #\\Space #\\Newline #\\Tab');
  assert.equal(phase2Forms.length, 5);
  assert.equal(phase2Forms[0].kind, 'list');
  assert.equal(phase2Forms[0].elements[0].name, 'VECTOR');
  assert.equal(phase2Forms[1].elements[0].name, 'CODE-CHAR');
  assert.equal(phase2Forms[1].elements[1].value, '65');
  assert.equal(phase2Forms[2].elements[1].value, '32');
  assert.equal(phase2Forms[3].elements[1].value, '10');
  assert.equal(phase2Forms[4].elements[1].value, '9');
});

for (const lane of ['neutral', 'wasm']) {
  test(`in-image Common Lisp evaluates generalized booleans, arithmetic, predicates and control forms (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      const cl = await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      assert.equal(runtime.languages.get(COMMON_LISP_ID)?.id, COMMON_LISP_ID);

      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});

      // In Common Lisp, 0 and "" are truthy; only NIL / () is falsy!
      assert.deepEqual(await evalCL('(if 0 100 200)'), integerValue(100n));
      assert.deepEqual(await evalCL('(if "" 100 200)'), integerValue(100n));
      assert.deepEqual(await evalCL('(if nil 100 200)'), integerValue(200n));
      assert.deepEqual(await evalCL('(if () 100 200)'), integerValue(200n));

      // Predicates return T or NIL
      assert.deepEqual(await evalCL('(null nil)'), cl.t);
      assert.deepEqual(await evalCL('(null 0)'), cl.nil);
      assert.deepEqual(await evalCL('(and 1 2 3)'), integerValue(3n));
      assert.deepEqual(await evalCL('(and 1 nil 3)'), cl.nil);
      assert.deepEqual(await evalCL('(or nil 42 99)'), integerValue(42n));

      // Arithmetic & comparisons
      assert.deepEqual(await evalCL('(+ 10 (* 3 4) (- 20 5) (1+ 1) (1- 1))'), integerValue(39n));
      assert.deepEqual(await evalCL('(floor 17 5)'), integerValue(3n));
      assert.deepEqual(await evalCL('(mod 17 5)'), integerValue(2n));
      assert.deepEqual(
        await evalCL(`
          (cond
            ((< 10 5) :bad)
            ((= 7 7) (+ 40 2))
            (t 0))
        `),
        integerValue(42n),
      );

      // Type predicates work on all Value kinds including functions (lambda Blocks)
      assert.deepEqual(await evalCL('(consp (cons 1 2))'), cl.t);
      assert.deepEqual(await evalCL('(consp nil)'), cl.nil);
      assert.deepEqual(await evalCL('(consp (lambda (x) x))'), cl.nil);
      assert.deepEqual(await evalCL('(atom (lambda (x) x))'), cl.t);
      assert.deepEqual(await evalCL('(functionp (lambda (x) x))'), cl.t);
      assert.deepEqual(await evalCL('(functionp 42)'), cl.nil);
      assert.deepEqual(await evalCL('(symbolp \'foo)'), cl.t);
      assert.deepEqual(await evalCL('(symbolp nil)'), cl.t);
      assert.deepEqual(await evalCL('(integerp 42)'), cl.t);
      assert.deepEqual(await evalCL('(stringp "hello")'), cl.t);
      assert.deepEqual(await evalCL('(listp \'(1 2))'), cl.t);
      assert.deepEqual(await evalCL('(listp nil)'), cl.t);
    });
  });

  test(`in-image Common Lisp compiles lexical bindings, setq cells, escaping closures, flet and labels (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});

      // Parallel let vs sequential let*
      assert.deepEqual(
        await evalCL(`
          (let ((x 10))
            (let ((x 20) (y x))
              y))
        `),
        integerValue(10n),
      );
      assert.deepEqual(
        await evalCL(`
          (let* ((x 20) (y (+ x 5)))
            y)
        `),
        integerValue(25n),
      );

      // Mutable lexical cell shared across closures via setq
      assert.deepEqual(
        await evalCL(`
          (let ((acc 0))
            (let ((add (lambda (n) (setq acc (+ acc n)))))
              (funcall add 10)
              (funcall add 15)
              acc))
        `),
        integerValue(25n),
      );

      // Local recursive functions via labels and non-recursive via flet
      assert.deepEqual(
        await evalCL(`
          (flet ((square (x) (* x x)))
            (labels ((sum-squares (n)
                       (if (<= n 0)
                           0
                           (+ (square n) (sum-squares (- n 1))))))
              (sum-squares 4)))
        `),
        integerValue(30n),
      );

      // Escaping closure (snapshot capture) promoted to a durable Block in the image
      const closureRef = await evalCL(`
        (defun make-adder (offset)
          (let ((scale 2))
            (lambda (x) (+ offset (* scale x)))))
        (make-adder 100)
      `);
      const act = await runtime.invocations.invokeBlock(closureRef, [integerValue(7n)]);
      assert.deepEqual(await runtime.executor.execute(act), integerValue(114n));
    });
  });

  test(`in-image Common Lisp Cons lists, standard library, quasiquote and recursive defun work in ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});

      const listRef = await evalCL(`
        (defun fact (n)
          (if (<= n 1)
              1
              (* n (fact (- n 1)))))

        (defun even-num-p (n)
          (if (= n 0) t (odd-num-p (- n 1))))

        (defun odd-num-p (n)
          (if (= n 0) nil (even-num-p (- n 1))))

        (let* ((nums '(1 2 3 4 5))
               (evens (remove-if-not #'even-num-p nums))
               (facts (mapcar #'fact evens))
               (rev (reverse facts))
               (combined \`(0 ,@rev ,(reduce #'+ facts 0))))
          combined)
      `);

      const elements = await commonLispListToArray({
        images: runtime.images,
        imageId: 'app',
        value: listRef,
      });
      // evens = (2 4), facts = (2 24), rev = (24 2), sum = 26 -> (0 24 2 26)
      assert.deepEqual(elements, [
        integerValue(0n),
        integerValue(24n),
        integerValue(2n),
        integerValue(26n),
      ]);

      // assoc, member, nth, length, rplaca, rplacd
      assert.deepEqual(
        await evalCL(`
          (let ((alist '((:a . 10) (:b . 20) (:c . 30))))
            (+ (cdr (assoc :b alist))
               (length alist)
               (nth 2 '(100 200 300))))
        `),
        integerValue(323n),
      );
      assert.deepEqual(
        await evalCL(`
          (let ((cell (cons 1 2)))
            (rplaca cell 40)
            (rplacd cell 2)
            (+ (car cell) (cdr cell)))
        `),
        integerValue(42n),
      );
    });
  });

  test(`bidirectional Common Lisp <-> Symmetric Smalltalk interop in one image (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });

      // Define a Smalltalk Box class with slot `val`
      const {classRef: boxClassRef} = await ensureClassFromDeclaration({
        images: runtime.images,
        imageId: 'app',
        name: 'Box',
        instanceVariables: ['val'],
      });
      await defineMethodsFromSource({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
        classRef: boxClassRef,
        methods: [
          {selector: 'val', source: '[ ^val ]'},
          {selector: 'val:', source: '[ :v | val := v. ^self ]'},
        ],
      });
      await publishSmalltalkClassGlobals({images: runtime.images, imageId: 'app', names: ['Box']});

      // 1. Common Lisp allocating and sending messages to Smalltalk Box instances
      const clProgram = await installCommonLispProgram({
        images: runtime.images,
        compilation: runtime.compilation,
        runtime,
        imageId: 'app',
        lane,
        source: `
          (defun scale-box-and-cons (self factor)
            (let* ((current (send self :val))
                   (scaled (* current factor)))
              (send self :val: scaled)
              (cons current (cons scaled nil))))

          (defun sum-list (xs)
            (reduce #'+ xs 0))
        `,
      });
      assert.ok(clProgram.functions['SCALE-BOX-AND-CONS']);

      const clDirect = await evaluateCommonLispSource({
        runtime,
        imageId: 'app',
        lane,
        source: `
          (let ((b (send Box :new)))
            (send b :val: 21)
            (* 2 (send b :val)))
        `,
      });
      assert.deepEqual(clDirect, integerValue(42n));

      // 2. Attach the Common Lisp defun as a method on Smalltalk Box (`scaleAndCons:` with passSelf: true)
      await attachCommonLispMethod({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        classRef: boxClassRef,
        selector: 'scaleAndCons:',
        functionName: 'scale-box-and-cons',
        passSelf: true,
        lane,
      });
      await attachCommonLispMethod({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        classRef: boxClassRef,
        selector: 'sumList:',
        functionName: 'sum-list',
        passSelf: false,
        lane,
      });

      // 3. Smalltalk sends `scaleAndCons:` to a Box, receives a Common Lisp Cons list, inspects it via Cons>>car/cdr,
      //    and sends `sumList:` back to Common Lisp!
      const stResult = await evaluateSymmetricSmalltalkBlock({
        runtime,
        imageId: 'app',
        source: `
          [ | box list |
            box := Box new.
            box val: 15.
            list := box scaleAndCons: 3.
            (list isCons)
              ifTrue: [ (box sumList: list) + (box val) + (list car) + (list cdr car) ]
              ifFalse: [ 0 ] ]
        `,
      });
      // current = 15, scaled = 45 -> list = (15 45)
      // sumList: (15 45) = 60, box val = 45, list car = 15, list cdr car = 45 -> 60 + 45 + 15 + 45 = 165
      assert.deepEqual(stResult, integerValue(165n));

      // Verify semantic artifact representation is lagrange-code/v2
      const defunSemantic = clProgram.functions['SCALE-BOX-AND-CONS'].installed.semanticArtifact;
      assert.equal(defunSemantic.languageId, COMMON_LISP_ID);
      assert.equal(defunSemantic.representation, LAGRANGE_CODE_V2);
    });
  });

  test(`Common Lisp unwind-protect, handler-case, handler-bind with use-value resume, and cross-language conditions (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});

      // 1. handler-case catches ZeroDivide and Error, and unwind-protect runs cleanup on unwind
      assert.deepEqual(
        await evalCL(`
          (let ((cleaned 0))
            (let ((caught
                    (handler-case
                      (unwind-protect
                        (floor 10 0)
                        (setq cleaned (+ cleaned 100)))
                      (zero-divide (c) 7))))
              (+ cleaned caught)))
        `),
        integerValue(107n),
      );

      // 2. (error "custom failure") caught by handler-case with (condition-message c)
      assert.deepEqual(
        await evalCL(`
          (handler-case
            (progn
              (error "boom from common lisp")
              "unreachable")
            (error (c) (condition-message c)))
        `),
        textValue('boom from common lisp'),
      );

      // 3. handler-bind + (use-value c val) resumes at the signal site without unwinding!
      assert.deepEqual(
        await evalCL(`
          (handler-bind
            ((zero-divide (lambda (c) (use-value c 40))))
            (+ 2 (floor 10 0)))
        `),
        integerValue(42n),
      );

      // 4. ignore-errors returns NIL on error
      const clNil = objectRef('app', 'smalltalk/nil');
      assert.deepEqual(await evalCL('(ignore-errors (error "ignored"))'), clNil);

      // 5. Smalltalk `on:do:` catches an error signalled inside a Common Lisp function!
      await installCommonLispProgram({
        images: runtime.images,
        compilation: runtime.compilation,
        runtime,
        imageId: 'app',
        lane,
        source: `
          (defun cl-might-fail (x)
            (if (< x 0)
                (error "negative input to cl-might-fail")
                (* x 10)))
        `,
      });
      const {classRef: objectClassRef} = {classRef: objectRef('app', 'smalltalk/class/Object')};
      await attachCommonLispMethod({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        classRef: objectClassRef,
        selector: 'clMightFail:',
        functionName: 'cl-might-fail',
        lane,
      });

      const caughtInSmalltalk = await evaluateSymmetricSmalltalkBlock({
        runtime,
        imageId: 'app',
        source: '[ [ nil clMightFail: -5 ] on: Error do: [ :e | e messageText ] ]',
      });
      assert.deepEqual(caughtInSmalltalk, textValue('negative input to cl-might-fail'));
    });
  });

  test(`Phase 2: user defmacro, gensym, macroexpand, lambda-list (&optional/&rest/&body/&key), control macros and lexical block/return-from (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      const cl = await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});
      const toArray = (value) => commonLispListToArray({images: runtime.images, imageId: 'app', value});

      // 1. User-defined macros with nested destructuring, &optional, &key, &body, and gensym
      await evalCL(`
        (defmacro with-doubled ((var init &optional (bonus 0)) &body body)
          (let ((tmp (gensym "DBL")))
            \`(let* ((,tmp ,init)
                     (,var (+ (* ,tmp 2) ,bonus)))
                ,@body)))

        (defmacro scale-add (x &key (factor 10) (offset 0 offset-p))
          (if offset-p
              \`(+ (* ,x ,factor) ,offset 1000)
              \`(+ (* ,x ,factor) ,offset)))
      `);

      // Macros persist in common-lisp/namespace/v1 across subsequent evaluateCommonLispSource calls
      assert.deepEqual(
        await evalCL(`
          (let ((tmp 999))
            (with-doubled (x 15 3)
              (+ x tmp)))
        `),
        integerValue(1032n),
      );
      assert.deepEqual(await evalCL('(scale-add 4)'), integerValue(40n));
      assert.deepEqual(await evalCL('(scale-add 4 :factor 3 :offset 5)'), integerValue(1017n));

      // macroexpand-1 and macroexpand work inside Common Lisp code
      const exp1 = await evalCL('(macroexpand-1 \'(scale-add 4 :factor 3))');
      const exp1Arr = await toArray(exp1);
      assert.deepEqual(exp1Arr[0], objectRef('app', symbolObjectId('+')));

      // 2. Lambda-list &optional (with default & supplied-p), &rest, and &key on defun/lambda/flet
      await evalCL(`
        (defun compute-score (base &optional (mult 2 mult-p) &key (bonus 0 bonus-p))
          (+ (* base mult)
             (if mult-p 100 0)
             bonus
             (if bonus-p 1000 0)))

        (defun sum-rest (first &rest others)
          (reduce #'+ others first))
      `);
      assert.deepEqual(await evalCL('(compute-score 5)'), integerValue(10n));
      assert.deepEqual(await evalCL('(compute-score 5 3)'), integerValue(115n));
      assert.deepEqual(await evalCL('(compute-score 5 3 :bonus 7)'), integerValue(1122n));
      assert.deepEqual(await evalCL('(sum-rest 10 20 30 40)'), integerValue(100n));

      // 3. Standard control & iteration macros: prog2, dolist, dotimes, case, ecase, destructuring-bind
      assert.deepEqual(
        await evalCL(`
          (let ((side 0))
            (+ (prog2 (setq side 10) 25 (setq side (+ side 5)))
               side))
        `),
        integerValue(40n),
      );
      assert.deepEqual(
        await evalCL(`
          (let ((acc 0))
            (dolist (x '(2 4 6 8) (+ acc 1))
              (setq acc (+ acc x))))
        `),
        integerValue(21n),
      );
      assert.deepEqual(
        await evalCL(`
          (let ((acc 0))
            (dotimes (i 5 acc)
              (setq acc (+ acc (* i 2)))))
        `),
        integerValue(20n),
      );
      assert.deepEqual(
        await toArray(await evalCL(`
          (list
            (case :b
              (:a 10)
              ((:b :c) 20)
              (otherwise 30))
            (ecase 2
              (1 :one)
              ((2 3) :two-or-three)))
        `)),
        await toArray(await evalCL('\'(20 :two-or-three)')),
      );
      assert.deepEqual(
        await evalCL(`
          (destructuring-bind (a (b &optional (c 10)) &rest tail)
              '(1 (2) 3 4)
            (+ a b c (car tail) (cadr tail)))
        `),
        integerValue(20n),
      );

      // 4. Lexical block, return-from, return, implicit defun block, and cross-closure unwind-protect
      await evalCL(`
        (defun find-first-over (limit items)
          (dolist (x items :none)
            (when (> x limit)
              (return-from find-first-over x))))
      `);
      assert.deepEqual(await evalCL('(find-first-over 10 \'(3 7 15 20))'), integerValue(15n));
      assert.deepEqual(await evalCL('(find-first-over 50 \'(3 7 15 20))'), objectRef('app', symbolObjectId(':NONE')));

      // Early exit from dolist via (return ...) and cross-closure (return-from ...) running unwind-protect
      assert.deepEqual(
        await evalCL(`
          (let ((cleaned 0))
            (let ((res
                    (block outer
                      (unwind-protect
                        (mapcar (lambda (x)
                                  (when (= x 3)
                                    (return-from outer 77)))
                                '(1 2 3 4))
                        (setq cleaned (+ cleaned 100))))))
              (+ res cleaned)))
        `),
        integerValue(177n),
      );
      assert.deepEqual(
        await evalCL(`
          (dolist (x '(10 20 30) 0)
            (when (= x 20)
              (return 42)))
        `),
        integerValue(42n),
      );
      assert.equal(cl.imageId, 'app');
    });
  });

  test(`Phase 2: setf/incf/decf/push/pop, native defstruct with :include & Smalltalk interop, vectors, strings/chars and hash tables (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      const cl = await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});
      const toArray = (value) => commonLispListToArray({images: runtime.images, imageId: 'app', value});

      // 1. Generalized places: setf, incf, decf, push, pop on variables, conses, vectors, hash tables
      assert.deepEqual(
        await evalCL(`
          (let ((pair (cons 10 20))
                (items (list 1 2 3))
                (stack nil))
            (setf (car pair) 100
                  (cdr pair) 200
                  (nth 1 items) 50)
            (incf (car pair) 5)
            (decf (nth 1 items) 8)
            (push 9 stack)
            (push 8 stack)
            (let ((popped (pop stack)))
              (+ (car pair) (cdr pair) (cadr items) popped (car stack))))
        `),
        integerValue(364n),
      );

      // 2. Vectors (#(...), vector, make-array, aref, svref, vectorp, length, elt, subseq)
      assert.deepEqual(
        await toArray(await evalCL(`
          (let ((v1 #(10 20 30 40))
                (v2 (make-array 3 :initial-element 7))
                (v3 (make-array 4 :initial-contents '(1 2 3 4))))
            (setf (aref v1 2) 300)
            (incf (svref v2 1) 3)
            (let ((sub (subseq v1 1 3)))
              (list (vectorp v1)
                    (length v1)
                    (elt v1 2)
                    (aref v2 1)
                    (aref v3 3)
                    (length sub)
                    (aref sub 0)
                    (aref sub 1))))
        `)),
        await toArray(await evalCL('\'(t 4 300 10 4 2 20 300)')),
      );

      // 3. Characters (#\...) and strings (char, char-code, code-char, string=, char=, concatenate)
      assert.deepEqual(
        await toArray(await evalCL(`
          (let ((s (concatenate 'string "Lag" "range")))
            (list (characterp #\\L)
                  (char= (char s 0) #\\L)
                  (char-code (char s 3))
                  (string= s "Lagrange")
                  (length s)))
        `)),
        await toArray(await evalCL('\'(t t 114 t 8)')),
      );

      // 4. Hash tables (make-hash-table, gethash, setf gethash, remhash, maphash, hash-table-count, hash-table-p)
      assert.deepEqual(
        await toArray(await evalCL(`
          (let ((ht (make-hash-table)))
            (setf (gethash :alpha ht) 10
                  (gethash :beta ht) 20
                  (gethash :gamma ht) 30)
            (incf (gethash :beta ht) 5)
            (let ((removed (remhash :alpha ht))
                  (missing-after (gethash :alpha ht :gone))
                  (sum 0))
              (maphash (lambda (k v) (incf sum v)) ht)
              (list (hash-table-p ht)
                    removed
                    missing-after
                    (hash-table-count ht)
                    sum)))
        `)),
        await toArray(await evalCL('\'(t t :gone 2 55)')),
      );

      // 5. Native defstruct over Lagrange Shapes & Classes + :include inheritance + Smalltalk interop
      await evalCL(`
        (defstruct cl-point
          (x 0)
          (y 0))

        (defstruct (cl-point-3d (:include cl-point))
          (z 10))
      `);

      assert.deepEqual(
        await toArray(await evalCL(`
          (let* ((p2 (make-cl-point :x 3 :y 4))
                 (p3 (make-cl-point-3d :x 10 :y 20 :z 30))
                 (p3-copy (copy-cl-point-3d p3)))
            (setf (cl-point-x p3-copy) 99)
            (incf (cl-point-3d-z p3-copy) 1)
            (list (cl-point-p p2)
                  (cl-point-p p3)
                  (cl-point-3d-p p2)
                  (cl-point-3d-p p3)
                  (cl-point-x p3)
                  (cl-point-x p3-copy)
                  (cl-point-y p3-copy)
                  (cl-point-3d-z p3-copy)))
        `)),
        await toArray(await evalCL('\'(t t nil t 10 99 20 31)')),
      );

      // Bidirectional Smalltalk interoperability with Common Lisp defstruct!
      // A `defstruct cl-point-3d` compiles to Smalltalk class `ClPoint3d` (subclass of `ClPoint`)
      // with standard Smalltalk accessors `x`, `x:`, `y`, `y:`, `z`, `z:`.
      const stResult = await evaluateSymmetricSmalltalkBlock({
        runtime,
        imageId: 'app',
        source: '[ | p | p := ClPoint3d new. p x: 7. p y: 8. p z: 9. p ]',
      });
      assert.deepEqual(
        await evaluateCommonLispSource({
          runtime,
          imageId: 'app',
          lane,
          captures: {stPoint: {id: 'cl:cap:STPOINT', name: 'ST-POINT', value: stResult}},
          source: `
            (progn
              (incf (cl-point-x st-point) 10)
              (+ (cl-point-x st-point) (cl-point-y st-point) (cl-point-3d-z st-point)))
          `,
        }),
        integerValue(34n),
      );
      assert.equal(cl.imageId, 'app');
    });
  });

  test(`Phase 3: CLOS defclass (multiple inheritance, initargs, initforms, accessors), make-instance, slot-value, defgeneric/defmethod (:before/:after/:around, call-next-method, eql & built-in specializers) and Smalltalk interop (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});
      const toArray = (value) => commonLispListToArray({images: runtime.images, imageId: 'app', value});

      await evalCL(`
        (defclass shape ()
          ((color :initarg :color :initform 'black :accessor shape-color)))

        (defclass labeled ()
          ((label :initarg :label :initform "none" :reader labeled-text :writer set-labeled-text)))

        (defclass circle (shape labeled)
          ((radius :initarg :radius :initform 1 :accessor circle-radius)))

        (defclass rect (shape)
          ((width :initarg :w :initform 2 :accessor rect-w)
           (height :initarg :h :initform 3 :accessor rect-h)))
      `);

      // Instance creation (static & dynamic), slot-value (static & dynamic), readers/writers/accessors, reflection & typep
      assert.deepEqual(
        await toArray(await evalCL(`
          (let* ((c1 (make-instance 'circle :radius 5 :color 'red :label "C1"))
                 (dyn-cls 'circle)
                 (c2 (make-instance dyn-cls :radius 10))
                 (dyn-slot 'radius))
            (setf (shape-color c2) 'blue)
            (set-labeled-text "C2-tag" c2)
            (incf (circle-radius c1) 2)
            (setf (slot-value c2 dyn-slot) (+ (slot-value c2 'radius) 5))
            (list (circle-radius c1)
                  (shape-color c1)
                  (labeled-text c1)
                  (slot-value c2 dyn-slot)
                  (shape-color c2)
                  (labeled-text c2)
                  (type-of c1)
                  (class-name (class-of c1))
                  (typep c1 'circle)
                  (typep c1 'shape)
                  (typep c1 'labeled)
                  (typep c1 'rect)
                  (typep c1 'standard-object)
                  (let ((tp 'labeled)) (typep c1 tp))
                  (typep 42 'integer)
                  (typep 42 '(eql 42))
                  (typep 42 '(eql 99))))
        `)),
        await toArray(await evalCL(`'(7 red "C1" 15 blue "C2-tag" circle circle t t t nil t t t t nil)`)),
      );

      // Generic functions: single dispatch, inheritance, next-method-p, call-next-method (0 args & explicit args),
      // multi-dispatch, built-in & (eql ...) specializers, and :before / :after / :around method combination
      await evalCL(`
        (defgeneric describe-area (obj))
        (defmethod describe-area ((s shape))
          0)
        (defmethod describe-area ((c circle))
          (+ (* 3 (circle-radius c) (circle-radius c))
             (if (next-method-p) (call-next-method) -100)))
        (defmethod describe-area ((r rect))
          (* (rect-w r) (rect-h r)))

        (defgeneric scale-metric (obj factor))
        (defmethod scale-metric ((s shape) factor)
          (* factor 10))
        (defmethod scale-metric ((c circle) factor)
          (+ (circle-radius c) (call-next-method c (+ factor 1))))

        (defgeneric interact (a b))
        (defmethod interact ((a circle) (b circle)) 'circle-circle)
        (defmethod interact ((a circle) (b rect)) 'circle-rect)
        (defmethod interact ((a rect) (b circle)) 'rect-circle)
        (defmethod interact ((a shape) (b shape)) 'shape-shape)

        (defgeneric classify-val (x))
        (defmethod classify-val ((x (eql 0))) 'zero)
        (defmethod classify-val ((x (eql :magic))) 'magic-kw)
        (defmethod classify-val ((x integer)) 'int)
        (defmethod classify-val ((x string)) 'str)
        (defmethod classify-val ((x cons)) 'pair)
        (defmethod classify-val (x) 'other)

        (defparameter *trace-log* nil)
        (defgeneric traced-op (obj))
        (defmethod traced-op :around ((s shape))
          (setq *trace-log* (append *trace-log* (list 'around-shape-in)))
          (let ((res (call-next-method)))
            (setq *trace-log* (append *trace-log* (list 'around-shape-out)))
            res))
        (defmethod traced-op :around ((c circle))
          (setq *trace-log* (append *trace-log* (list 'around-circle-in)))
          (let ((res (call-next-method)))
            (setq *trace-log* (append *trace-log* (list 'around-circle-out)))
            (+ res 100)))
        (defmethod traced-op :before ((s shape))
          (setq *trace-log* (append *trace-log* (list 'before-shape))))
        (defmethod traced-op :before ((c circle))
          (setq *trace-log* (append *trace-log* (list 'before-circle))))
        (defmethod traced-op ((s shape))
          (setq *trace-log* (append *trace-log* (list 'primary-shape)))
          1)
        (defmethod traced-op ((c circle))
          (setq *trace-log* (append *trace-log* (list 'primary-circle)))
          (+ (circle-radius c) (call-next-method)))
        (defmethod traced-op :after ((s shape))
          (setq *trace-log* (append *trace-log* (list 'after-shape))))
        (defmethod traced-op :after ((c circle))
          (setq *trace-log* (append *trace-log* (list 'after-circle))))
      `);

      assert.deepEqual(
        await toArray(await evalCL(`
          (let ((c (make-instance 'circle :radius 4))
                (r (make-instance 'rect :w 5 :h 6))
                (s (make-instance 'shape)))
            (setq *trace-log* nil)
            (let ((traced-val (traced-op c)))
              (list (describe-area c)
                    (describe-area r)
                    (describe-area s)
                    (scale-metric c 2)
                    (interact c c)
                    (interact c r)
                    (interact r c)
                    (interact r r)
                    (classify-val 0)
                    (classify-val 42)
                    (classify-val :magic)
                    (classify-val "hi")
                    (classify-val '(1 2))
                    (classify-val c)
                    traced-val
                    (prin1-to-string *trace-log*))))
        `)),
        await toArray(await evalCL(`
          '(48 30 0 34
            circle-circle circle-rect rect-circle shape-shape
            zero int magic-kw str pair other
            105
            "(AROUND-CIRCLE-IN AROUND-SHAPE-IN BEFORE-CIRCLE BEFORE-SHAPE PRIMARY-CIRCLE PRIMARY-SHAPE AFTER-SHAPE AFTER-CIRCLE AROUND-SHAPE-OUT AROUND-CIRCLE-OUT)")
        `)),
      );

      // Bidirectional Smalltalk interop with CLOS class `Circle`
      const stCircle = await evaluateSymmetricSmalltalkBlock({
        runtime,
        imageId: 'app',
        source: '[ | c | c := Circle new. c radius: 6. c color: #green. c ]',
      });
      assert.deepEqual(
        await evaluateCommonLispSource({
          runtime,
          imageId: 'app',
          lane,
          captures: {stCircle: {id: 'cl:cap:STCIRCLE', name: 'ST-CIRCLE', value: stCircle}},
          source: '(list (describe-area st-circle) (shape-color st-circle) (type-of st-circle))',
        }).then(toArray),
        await toArray(await evalCL('\'(108 |green| circle)')),
      );
    });
  });

  test(`Phase 3: packages (defpackage/in-package/:use/:export), named restarts (restart-case/invoke-restart/find-restart), extended loop and format/streams (${lane} lane)`, async () => {
    await withRuntime(async (runtime) => {
      await installCommonLispRuntime({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'app',
        lane,
      });
      const evalCL = (source) => evaluateCommonLispSource({runtime, imageId: 'app', source, lane});
      const toArray = (value) => commonLispListToArray({images: runtime.images, imageId: 'app', value});

      // 1. Packages: defpackage, in-package, :use, :export, internal symbol isolation, pkg:sym vs pkg::sym
      await evalCL(`
        (defpackage :math-pkg
          (:use :cl)
          (:export #:square #:cube #:*scale*))
        (in-package :math-pkg)
        (defparameter *scale* 10)
        (defun secret-offset (x) (+ x 7))
        (defun square (x) (* x x))
        (defun cube (x) (* x (square x)))

        (defpackage :app-pkg
          (:use :cl :math-pkg)
          (:export #:compute))
        (in-package :app-pkg)
        (defun secret-offset (x) (* x 100))
        (defun compute (x)
          (+ (square x)
             (secret-offset x)
             (math-pkg::secret-offset x)
             *scale*))
        (in-package :cl-user)
      `);

      assert.deepEqual(
        await toArray(await evalCL(`
          (list (app-pkg:compute 3)
                (math-pkg:cube 4)
                (math-pkg::secret-offset 5))
        `)),
        [integerValue(329n), integerValue(64n), integerValue(12n)],
      );

      // Referring to unexported symbol via single colon `math-pkg:secret-offset` must throw SyntaxError
      await assert.rejects(
        () => evalCL('(math-pkg:secret-offset 5)'),
        /not exported from package MATH-PKG/,
      );

      // 2. Named restarts: restart-case, find-restart, invoke-restart, and handler decline
      assert.deepEqual(
        await toArray(await evalCL(`
          (defun risky-divide (a b)
            (restart-case
                (if (= b 0)
                    (error "division by zero")
                    (/ a b))
              (return-zero ()
                :report "Return 0"
                0)
              (use-divisor (new-b)
                :report "Use alternate divisor"
                (/ a new-b))))

          (list
            ;; Invoke use-divisor restart
            (handler-bind
                ((error (lambda (c)
                          (if (find-restart 'use-divisor)
                              (invoke-restart 'use-divisor 5)
                              0))))
              (risky-divide 100 0))
            ;; Inner handler declines (returns normally) when no 'nonexistent-restart is found,
            ;; outer handler catches and invokes 'return-zero
            (handler-bind
                ((error (lambda (c)
                          (invoke-restart 'return-zero))))
              (handler-bind
                  ((error (lambda (c)
                            (when (find-restart 'nonexistent-restart)
                              (invoke-restart 'nonexistent-restart)))))
                (risky-divide 50 0))))
        `)),
        [integerValue(20n), integerValue(0n)],
      );

      // 3. Extended LOOP macro
      assert.deepEqual(
        await toArray(await evalCL(`
          (mapcar #'prin1-to-string
            (list
              ;; numeric from/to, downto/by, below/sum
              (loop for i from 1 to 5 collect (* i i))
              (loop for i from 10 downto 2 by 3 collect i)
              (loop for i below 5 sum i)
              ;; in, on, across, maximize, minimize, count
              (loop for tail on '(10 20 30) collect (length tail))
              (loop for x across #(12 45 7 89 23) maximize x)
              (loop for x across #(12 45 7 89 23) minimize x)
              (loop for x in '(1 2 3 4 5 6) count (evenp x))
              ;; when/else/and with into accumulators + finally return
              (loop for x in '(1 2 3 4 5 6)
                    when (evenp x)
                      collect x into evens
                      and sum x into even-sum
                    else
                      collect x into odds
                    finally (return (list evens odds even-sum)))
              ;; = / then stepping with repeat
              (loop for a = 1 then b
                    and b = 1 then (+ a b)
                    repeat 6
                    collect a)
              ;; always, never, thereis
              (loop for x in '(2 4 6 8) always (evenp x))
              (loop for x in '(2 4 5 8) always (evenp x))
              (loop for x in '(1 3 5) never (evenp x))
              (loop for x in '(1 3 6 7) thereis (and (evenp x) (* x 10)))
              ;; with, initially, while, until, append
              (loop with base = 100
                    for x in '(1 2 3 4 5)
                    while (< x 4)
                    append (list x (+ base x)))))
        `)),
        [
          textValue('(1 4 9 16 25)'),
          textValue('(10 7 4)'),
          textValue('10'),
          textValue('(3 2 1)'),
          textValue('89'),
          textValue('7'),
          textValue('3'),
          textValue('((2 4 6) (1 3 5) 12)'),
          textValue('(1 1 2 4 8 16)'),
          textValue('T'),
          textValue('NIL'),
          textValue('T'),
          textValue('60'),
          textValue('(1 101 2 102 3 103)'),
        ],
      );

      // 4. Streams and FORMAT
      assert.deepEqual(
        await toArray(await evalCL(`
          (let ((s (make-string-output-stream)))
            (write-string "items: " s)
            (prin1 "hello" s)
            (write-char #\\Space s)
            (princ 42 s)
            (terpri s)
            (list
              (get-output-stream-string s)
              (get-output-stream-string s)
              (with-output-to-string (out)
                (format out "~A=~D (~S)" 'count 7 "ok"))
              (format nil "Hello ~A, ~S has ~D items~~!~%" "world" "box" 3)
              (princ-to-string '(1 "two" :three))
              (prin1-to-string '(1 "two" :three))))
        `)),
        [
          textValue('items: "hello" 42\n'),
          textValue(''),
          textValue('COUNT=7 ("ok")'),
          textValue('Hello world, "box" has 3 items~!\n'),
          textValue('(1 two THREE)'),
          textValue('(1 "two" :THREE)'),
        ],
      );
    });
  });

  test(`[${lane}] Common Lisp Phase 4: dynamic special-variable binding (let/let*, declare special, non-local unwind, defvar vs defparameter) and declarative .asd system importer`, async () => {
    await withRuntime(async (runtime) => {
      const evalCL = (source) =>
        evaluateCommonLispSource({
          runtime,
          imageId: 'app',
          source,
          lane,
        });
      const toArray = (value) => commonLispListToArray({images: runtime.images, imageId: 'app', value});

      // 1. Dynamic special-variable binding via let & let*, cross-function visibility, and non-local exit restoration
      await evalCL(`
        (defvar *multiplier* 2)
        (defparameter *offset* 5)
        (defun compute-dynamic (x)
          (+ (* x *multiplier*) *offset*))
        (defun bump-offset (delta)
          (setq *offset* (+ *offset* delta)))
      `);

      // defvar preserves existing value on re-evaluation, while defparameter overwrites it
      await evalCL(`
        (defvar *multiplier* 999)
        (defparameter *offset* 10)
      `);

      assert.deepEqual(
        await toArray(await evalCL(`
          (mapcar #'prin1-to-string
            (list
              ;; defvar preserved 2, defparameter updated to 10: 7*2 + 10 = 24
              (compute-dynamic 7)
              ;; dynamic let binding of *multiplier* and *offset* visible to called functions
              (let ((*multiplier* 10)
                    (*offset* 1))
                (let ((first (compute-dynamic 7)))
                  (bump-offset 4)
                  (list first (compute-dynamic 7))))
              ;; after let exits, *multiplier* and *offset* are restored to 2 and 10
              (compute-dynamic 7)
              ;; let* sequential dynamic binding: second init-form calls (compute-dynamic 3) seeing *multiplier* = 100
              (let* ((*multiplier* 100)
                     (*offset* (compute-dynamic 3)))
                (compute-dynamic 1))
              ;; after let* exits, restored to 2 and 10
              (list *multiplier* *offset*)))
        `)),
        [
          textValue('24'),
          textValue('(71 75)'),
          textValue('24'),
          textValue('410'),
          textValue('(2 10)'),
        ],
      );

      // Non-local exit via return-from and error/handler-case restores dynamic special bindings
      assert.deepEqual(
        await toArray(await evalCL(`
          (mapcar #'prin1-to-string
            (list
              (block escape
                (let ((*multiplier* 50)
                      (*offset* 500))
                  (when (> (compute-dynamic 2) 100)
                    (return-from escape (compute-dynamic 2)))
                  -1))
              ;; restored after return-from
              (list *multiplier* *offset*)
              (handler-case
                  (let ((*multiplier* 77)
                        (*offset* 88))
                    (error "boom"))
                (error (c)
                  ;; inside handler-case handler, the let around (error "boom") has already unwound!
                  (list *multiplier* *offset*)))
              ;; local (declare (special ...)) on a variable not previously declared with defvar
              (let ((local-dyn 42))
                (declare (special local-dyn))
                local-dyn)))
        `)),
        [
          textValue('600'),
          textValue('(2 10)'),
          textValue('(2 10)'),
          textValue('42'),
        ],
      );

      // 2. Declarative .asd / defsystem parser and multi-file system installer (with :depends-on systems and nested :module)
      const baseAsd = `
        (asdf:defsystem :cl-math-base
          :description "Base math utilities"
          :version "1.0.0"
          :serial t
          :components
          ((:file "packages")
           (:file "ops")))
      `;
      const appAsd = `
        (defsystem "cl-geometry-app"
          :description "Geometry system built on cl-math-base"
          :version "2.1.0"
          :depends-on (:cl-math-base)
          :components
          ((:file "pkg")
           (:module "shapes"
            :depends-on ("pkg")
            :serial t
            :components
            ((:file "base")
             (:file "metrics")))
           (:file "report" :depends-on ("shapes"))))
      `;

      const parsedApp = parseCommonLispDefsystem(appAsd);
      assert.equal(parsedApp.name, 'CL-GEOMETRY-APP');
      assert.equal(parsedApp.version, '2.1.0');
      assert.deepEqual(parsedApp.dependsOn, ['CL-MATH-BASE']);
      assert.deepEqual(parsedApp.loadOrder, ['pkg', 'shapes/base', 'shapes/metrics', 'report']);

      const installedSys = await installCommonLispSystem({
        runtime,
        imageId: 'app',
        asdSource: appAsd,
        lane,
        systems: {
          'cl-math-base': {
            asdSource: baseAsd,
            files: {
              'packages.lisp': `
                (defpackage :cl-math-base
                  (:use :cl)
                  (:export #:sq #:scale-factor #:*unit-scale*))
              `,
              'ops.lisp': `
                (in-package :cl-math-base)
                (defvar *unit-scale* 1)
                (defun sq (n) (* n n))
                (defun scale-factor (n) (* n *unit-scale*))
              `,
            },
          },
        },
        files: {
          'pkg.lisp': `
            (defpackage :cl-geometry-app
              (:use :cl :cl-math-base)
              (:export #:rect #:make-rect #:area #:describe-rect))
          `,
          'shapes/base.lisp': `
            (in-package :cl-geometry-app)
            (defclass rect ()
              ((w :initarg :w :reader rect-w)
               (h :initarg :h :reader rect-h)))
            (defun make-rect (w h)
              (make-instance 'rect :w w :h h))
          `,
          'shapes/metrics.lisp': `
            (in-package :cl-geometry-app)
            (defgeneric area (shape))
            (defmethod area ((r rect))
              (scale-factor (* (rect-w r) (rect-h r))))
          `,
          'report.lisp': `
            (in-package :cl-geometry-app)
            (defun describe-rect (w h scale)
              (let ((*unit-scale* scale))
                (let ((r (make-rect w h)))
                  (format nil "~Dx~D@~D=>~D" w h scale (area r)))))
          `,
        },
      });

      assert.deepEqual(installedSys.loadOrder, ['pkg', 'shapes/base', 'shapes/metrics', 'report']);
      assert.ok(installedSys.dependentSystems['CL-MATH-BASE']);
      assert.deepEqual(
        Object.keys(installedSys.componentArtifacts),
        ['pkg', 'shapes/base', 'shapes/metrics', 'report'],
      );
      const sysArtifactRecord = await runtime.images.getCodeArtifact('app', installedSys.artifact.objectId);
      assert.deepEqual(
        sysArtifactRecord.dependencies.map((d) => d.role),
        [
          'system:CL-MATH-BASE',
          'component:pkg',
          'component:shapes/base',
          'component:shapes/metrics',
          'component:report',
        ],
      );

      // Export the system CodeArtifact closure into a clean image and recover the entire multi-system .asd from the imported artifact alone
      await runtime.images.createImage({id: 'recovered-sys', name: 'Recovered System'});
      const {bundle} = await exportGraphBundle({
        images: runtime.images,
        roots: {geometrySys: installedSys.artifact},
      });
      const imported = await importGraphBundle({
        images: runtime.images,
        targetImageId: 'recovered-sys',
        bundle,
      });
      const recoveredSys = await installCommonLispSystemFromArtifact({
        runtime,
        imageId: 'recovered-sys',
        systemArtifact: imported.roots.geometrySys,
        lane,
      });
      assert.equal(recoveredSys.system.name, 'CL-GEOMETRY-APP');
      assert.deepEqual(recoveredSys.loadOrder, ['pkg', 'shapes/base', 'shapes/metrics', 'report']);
      assert.deepEqual(
        await evaluateCommonLispSource({
          runtime,
          imageId: 'recovered-sys',
          lane,
          source: '(cl-geometry-app:describe-rect 3 4 10)',
        }),
        textValue('3x4@10=>120'),
      );

      const sysMeta = await readCommonLispSystemDefinition({
        images: runtime.images,
        imageId: 'app',
        name: 'cl-geometry-app',
      });
      assert.equal(sysMeta.name, 'CL-GEOMETRY-APP');
      assert.equal(sysMeta.version, '2.1.0');
      assert.deepEqual(sysMeta.dependsOn, ['CL-MATH-BASE']);
      assert.deepEqual(sysMeta.loadOrder, ['pkg', 'shapes/base', 'shapes/metrics', 'report']);

      assert.deepEqual(
        await evalCL('(cl-geometry-app:describe-rect 3 4 10)'),
        textValue('3x4@10=>120'),
      );
      // Verify *unit-scale* was restored to 1 after describe-rect's dynamic let
      assert.deepEqual(
        await evalCL('(cl-geometry-app:area (cl-geometry-app:make-rect 3 4))'),
        integerValue(12n),
      );

      // Verify cycle detection and missing file/component errors
      assert.throws(
        () =>
          parseCommonLispDefsystem(`
            (defsystem :cyclic-sys
              :components
              ((:file "a" :depends-on ("b"))
               (:file "b" :depends-on ("a"))))
          `),
        /cyclic Common Lisp component dependency/i,
      );
      assert.throws(
        () =>
          parseCommonLispDefsystem(`
            (defsystem :missing-dep-sys
              :components
              ((:file "a" :depends-on ("no-such-file"))))
          `),
        /depends on unknown component NO-SUCH-FILE/i,
      );
      await assert.rejects(
        () =>
          installCommonLispSystem({
            runtime,
            imageId: 'app',
            asdSource: '(defsystem :incomplete-sys :components ((:file "missing")))',
            files: {},
            lane,
          }),
        /missing source file for component missing/i,
      );
    });
  });
}

test('installCommonLispRuntime is idempotent, supports live defun redefinition, and runs on portable-runtime', async () => {
  const portable = await import('../src/portable-runtime.js');
  const runtime = await portable.createPortableRuntime({backend: {mode: 'mock'}});
  try {
    await runtime.images.createImage({id: 'portable-cl', name: 'Portable CL'});
    await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'portable-cl',
    });

    await installCommonLispProgram({
      images: runtime.images,
      compilation: runtime.compilation,
      runtime,
      imageId: 'portable-cl',
      source: `
        (defun compute (x) (+ x 10))
        (defun caller (x) (* 2 (compute x)))
      `,
    });
    assert.deepEqual(
      await evaluateCommonLispSource({
        runtime,
        imageId: 'portable-cl',
        source: '(caller 5)',
      }),
      integerValue(30n),
    );

    // Re-running installCommonLispRuntime converges and preserves user definitions
    await installCommonLispRuntime({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'portable-cl',
    });
    assert.deepEqual(
      await evaluateCommonLispSource({
        runtime,
        imageId: 'portable-cl',
        source: '(caller 5)',
      }),
      integerValue(30n),
    );

    // Redefining compute updates its GlobalBinding; caller observes the new definition without recompiling caller
    await installCommonLispProgram({
      images: runtime.images,
      compilation: runtime.compilation,
      runtime,
      imageId: 'portable-cl',
      source: '(defun compute (x) (+ x 100))',
    });
    assert.deepEqual(
      await evaluateCommonLispSource({
        runtime,
        imageId: 'portable-cl',
        source: '(caller 5)',
      }),
      integerValue(210n),
    );
  } finally {
    await runtime.close();
  }
});

