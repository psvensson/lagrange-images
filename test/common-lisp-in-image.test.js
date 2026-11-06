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
  integerValue,
  objectRef,
  publishSmalltalkClassGlobals,
  readCommonLispSource,
  symbolObjectId,
  textValue,
} from '../src/runtime.js';

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

