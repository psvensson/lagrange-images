// Common Lisp (SBCL) as an ordinary foreign runtime (bead lagrange-images-9p4): the language-
// neutrality falsifier. Everything generic is reused unchanged — durable source artifacts are
// ordinary code artifacts; the runtime DEFINITION is an ordinary code artifact whose dependencies
// are resolved by ForeignRuntimeDefinitionService; the definition's representation is bound to
// this provider id by the definition-binding registry; ForeignRuntimeService owns the lifecycle;
// the callable is foreign-runtime-callable-interface/v1 executed by the generic callable
// executor; the transport is the neutral stdio value bridge. This module owns ONLY what is Lisp-
// and SBCL-specific: the definition contract, materializing sources, generating the guest bridge,
// and how SBCL is started.
//
// Definition (`common-lisp/sbcl-runtime-definition-v1`), content = JSON:
//   {contract: 'common-lisp-runtime-definition/v0',
//    exports: [{service, operation, function: '<package>:<symbol>' | '<symbol>', arity}]}
// with dependencies role:`source` -> `common-lisp/source-v1` text artifacts (logicalPath *.lisp),
// loaded in dependency order. The exports table IS the allowlist: the guest bridge dispatches a
// CALL only to a declared (service, operation) by FUNCALLing the named function with exactly
// `arity` arguments. There is no reader-level eval of caller text, no ambient symbol lookup, no
// host callback. Values cross as integers, booleans and text (the spike's transport subset);
// anything else is refused by the guest as an ERR, never coerced.
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, extname, join, resolve} from 'node:path';
import {canonicalizeValue, isObjectRef} from '../value/index.js';
import {FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0} from './definition-service.js';
import {LineProcessRunner} from './line-process-runner.js';
import {
  StdioValueBridgeCallError,
  awaitBridgeReady,
  bridgeCall,
  bridgeQuit,
  createBridgeHandle,
  forceStopSession,
} from './stdio-value-bridge.js';

const COMMON_LISP_SBCL_PROVIDER_ID = 'common-lisp/sbcl';
const COMMON_LISP_SBCL_PROVIDER_V0 = 'common-lisp-sbcl-artifact-runtime/v0';
const COMMON_LISP_SOURCE_V1 = 'common-lisp/source-v1';
const COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1 = 'common-lisp/sbcl-runtime-definition-v1';
const COMMON_LISP_RUNTIME_DEFINITION_CONTRACT_V0 = 'common-lisp-runtime-definition/v0';
const COMMON_LISP_STDIO_BRIDGE_V1 = 'lagrange-common-lisp-stdio/v1';
const RUNTIME_LABEL = 'Common Lisp (SBCL)';
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SAFE_LISP_FUNCTION = /^(?:[A-Za-z][A-Za-z0-9*+\-/<>=!?._]*::?)?[A-Za-z][A-Za-z0-9*+\-/<>=!?._]*$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAB = '\t';

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function normalizeObjectRef(value, label) {
  const ref = canonicalizeValue(value);
  if (!isObjectRef(ref)) throw new TypeError(`${label} must be an unpinned object ref`);
  return ref;
}

class CommonLispCallError extends StdioValueBridgeCallError {
  constructor(code) {
    super(RUNTIME_LABEL, code);
    this.name = 'CommonLispCallError';
  }
}

// ---- the definition contract -----------------------------------------------------------------

function normalizeExport(entry, index) {
  const label = `Common Lisp runtime export ${index}`;
  exactKeys(entry, ['service', 'operation', 'function', 'arity'], label);
  const service = requiredText(entry.service, `${label} service`);
  const operation = requiredText(entry.operation, `${label} operation`);
  const fn = requiredText(entry.function, `${label} function`);
  if (!SAFE_NAME.test(service) || !SAFE_NAME.test(operation)) throw new TypeError(`${label} names contain unsafe characters`);
  if (!SAFE_LISP_FUNCTION.test(fn)) throw new TypeError(`${label} function must be a plain (optionally package-qualified) symbol name`);
  if (!Number.isInteger(entry.arity) || entry.arity < 0) throw new TypeError(`${label} arity must be a non-negative integer`);
  return Object.freeze({service, operation, function: fn, arity: entry.arity});
}

function parseDefinitionContent(content) {
  if (content?.kind !== 'text') throw new TypeError(`${COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1} content must be a text Value`);
  let decoded;
  try {
    decoded = JSON.parse(content.value);
  } catch (error) {
    throw new TypeError(`${COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1} content must be valid JSON`, {cause: error});
  }
  exactKeys(decoded, ['contract', 'exports'], 'Common Lisp runtime definition');
  if (decoded.contract !== COMMON_LISP_RUNTIME_DEFINITION_CONTRACT_V0) {
    throw new TypeError(`Common Lisp runtime definition contract must be ${COMMON_LISP_RUNTIME_DEFINITION_CONTRACT_V0}`);
  }
  if (!Array.isArray(decoded.exports) || decoded.exports.length === 0) {
    throw new TypeError('Common Lisp runtime definition must declare at least one export');
  }
  const seen = new Set();
  const exports = decoded.exports.map(normalizeExport);
  for (const {service, operation} of exports) {
    const key = `${service}/${operation}`;
    if (seen.has(key)) throw new TypeError(`Common Lisp runtime definition exports ${key} twice`);
    seen.add(key);
  }
  return Object.freeze({contract: decoded.contract, exports: Object.freeze(exports)});
}

// The canonical definition content: written by whoever authors a definition, so that the
// representation has one encoder as well as one decoder.
function createCommonLispRuntimeDefinitionContent({exports = []} = {}) {
  const normalized = parseDefinitionContent({kind: 'text', value: JSON.stringify({contract: COMMON_LISP_RUNTIME_DEFINITION_CONTRACT_V0, exports})});
  return JSON.stringify({
    contract: normalized.contract,
    exports: normalized.exports.map((e) => ({service: e.service, operation: e.operation, function: e.function, arity: e.arity})),
  });
}

function normalizeNode(node, label) {
  exactKeys(node, ['artifact', 'ref'], label);
  const ref = normalizeObjectRef(node.ref, `${label} ref`);
  const artifact = node.artifact;
  if (!artifact || typeof artifact !== 'object' || artifact.kind !== 'code-artifact') throw new TypeError(`${label} artifact must be a code-artifact snapshot`);
  if (artifact.imageId !== ref.imageId || artifact.id !== ref.objectId) throw new TypeError(`${label} artifact identity must match its ref`);
  return Object.freeze({ref, artifact});
}

// Validate the generic definition envelope (resolved by ForeignRuntimeDefinitionService) against
// this provider's contract: one definition root, N source dependencies, nothing else.
function validateCommonLispRuntimeDefinition(spec) {
  exactKeys(spec, ['runtimeDefinition'], 'Common Lisp runtime spec');
  const definition = spec.runtimeDefinition;
  exactKeys(definition, ['artifacts', 'protocol', 'root'], 'foreign runtime definition envelope');
  if (definition.protocol !== FOREIGN_RUNTIME_DEFINITION_PROTOCOL_V0) {
    throw new TypeError(`unsupported foreign runtime definition protocol: ${definition.protocol}`);
  }
  const root = normalizeNode(definition.root, 'foreign runtime definition root');
  if (root.artifact.representation !== COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1) {
    throw new TypeError(`Common Lisp runtime definition must be ${COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1}`);
  }
  const contract = parseDefinitionContent(root.artifact.content);
  const byKey = new Map();
  for (const [index, node] of (definition.artifacts ?? []).entries()) {
    const normalized = normalizeNode(node, `foreign runtime definition artifact ${index}`);
    byKey.set(`${normalized.ref.imageId} ${normalized.ref.objectId}`, normalized);
  }
  const sources = [];
  const fileNames = new Set();
  for (const dependency of root.artifact.dependencies ?? []) {
    if (dependency.role !== 'source') throw new TypeError(`unsupported Common Lisp runtime dependency role: ${dependency.role}`);
    const ref = normalizeObjectRef(dependency.artifact, 'Common Lisp source dependency');
    const node = byKey.get(`${ref.imageId} ${ref.objectId}`);
    if (!node) throw new TypeError(`Common Lisp source ${ref.imageId}/${ref.objectId} is not present in the resolved definition`);
    const {artifact} = node;
    if (artifact.representation !== COMMON_LISP_SOURCE_V1) throw new TypeError(`Common Lisp source must be ${COMMON_LISP_SOURCE_V1}`);
    if (artifact.content?.kind !== 'text') throw new TypeError(`Common Lisp source ${artifact.id} content must be a text Value`);
    const fileName = requiredText(artifact.logicalPath, `Common Lisp source ${artifact.id} logicalPath`);
    if (basename(fileName) !== fileName || !SAFE_FILE.test(fileName) || extname(fileName) !== '.lisp') {
      throw new TypeError(`Common Lisp source ${artifact.id} logicalPath must be a safe .lisp basename`);
    }
    if (fileNames.has(fileName)) throw new TypeError(`duplicate Common Lisp source filename: ${fileName}`);
    fileNames.add(fileName);
    sources.push(Object.freeze({ref, artifact, fileName}));
  }
  if (sources.length === 0) throw new TypeError('Common Lisp runtime definition requires at least one source dependency');
  return Object.freeze({protocol: definition.protocol, definitionRef: root.ref, contract, sources: Object.freeze(sources)});
}

// ---- the guest bridge --------------------------------------------------------------------------

function lispString(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The generated guest program: load the declared sources, announce readiness, then serve CALLs
// strictly through the exports table. Integers, booleans and text cross; the guest answers ERR for
// anything it cannot represent or that is not declared. Every host-visible line is flushed.
function bridgeSource({sources, exports}) {
  const loads = sources.map(({fileName}) => `(load ${lispString(fileName)})`).join('\n');
  // Function names are carried as strings and resolved at CALL time (after the sources are
  // loaded) through FIND-SYMBOL in the named package (COMMON-LISP-USER by default): no reader
  // evaluation of any text, and an undefined or unexported symbol is an ERR, never a crash.
  const table = exports.map((e) => {
    const [packageName, symbolName] = e.function.includes(':')
      ? [e.function.slice(0, e.function.indexOf(':')), e.function.slice(e.function.lastIndexOf(':') + 1)]
      : ['COMMON-LISP-USER', e.function];
    return `(list ${lispString(e.service)} ${lispString(e.operation)} ${lispString(packageName.toUpperCase())} ${lispString(symbolName.toUpperCase())} ${e.arity})`;
  }).join('\n    ');
  return [
    `;;; Generated by lagrange-images (${COMMON_LISP_STDIO_BRIDGE_V1}). Do not edit.`,
    '(defpackage :lagrange-bridge (:use :common-lisp))',
    '(in-package :lagrange-bridge)',
    '',
    '(defun split-tab (line)',
    '  (loop with start = 0',
    '        for pos = (position #\\Tab line :start start)',
    '        collect (subseq line start pos)',
    '        while pos',
    '        do (setf start (1+ pos))))',
    '',
    '(defun hex-digit (n) (char "0123456789ABCDEF" n))',
    '',
    '(defun percent-encode (text)',
    '  (with-output-to-string (out)',
    '    (loop for byte across (sb-ext:string-to-octets text :external-format :utf-8)',
    '          do (if (or (<= 48 byte 57) (<= 65 byte 90) (<= 97 byte 122) (member byte (quote (45 46 95 126))))',
    '                 (write-char (code-char byte) out)',
    '                 (progn (write-char #\\% out)',
    '                        (write-char (hex-digit (ash byte -4)) out)',
    '                        (write-char (hex-digit (logand byte 15)) out))))))',
    '',
    '(defun percent-decode (encoded)',
    '  (let ((bytes (make-array 0 :element-type (quote (unsigned-byte 8)) :adjustable t :fill-pointer 0))',
    '        (i 0) (n (length encoded)))',
    '    (loop while (< i n)',
    '          do (let ((c (char encoded i)))',
    '               (if (and (char= c #\\%) (< (+ i 2) n))',
    '                   (progn (vector-push-extend (parse-integer encoded :start (+ i 1) :end (+ i 3) :radix 16) bytes)',
    '                          (incf i 3))',
    '                   (progn (vector-push-extend (char-code c) bytes) (incf i)))))',
    '    (sb-ext:octets-to-string bytes :external-format :utf-8)))',
    '',
    '(defun decode-value (token)',
    '  (cond ((and (>= (length token) 2) (string= (subseq token 0 2) "i:")) (parse-integer token :start 2))',
    '        ((string= token "b:1") t)',
    '        ((string= token "b:0") nil)',
    '        ((and (>= (length token) 2) (string= (subseq token 0 2) "e:")) (percent-decode (subseq token 2)))',
    '        (t (error "unsupported-value"))))',
    '',
    '(defun encode-value (value)',
    '  (cond ((integerp value) (format nil "i:~d" value))',
    '        ((eq value t) "b:1")',
    '        ((null value) "b:0")',
    '        ((stringp value) (format nil "e:~a" (percent-encode value)))',
    '        (t (error "unsupported-result"))))',
    '',
    '(defparameter *exports*',
    '  (list',
    `    ${table}))`,
    '',
    '(defun find-export (service operation)',
    '  (find-if (lambda (e) (and (string= (first e) service) (string= (second e) operation))) *exports*))',
    '',
    '(defun export-function (export)',
    '  (let* ((package (find-package (third export)))',
    '         (symbol (and package (find-symbol (fourth export) package))))',
    '    (if (and symbol (fboundp symbol)) (fdefinition symbol) (error "undefined-function"))))',
    '',
    '(defun answer (line)',
    '  (write-string line) (terpri) (finish-output))',
    '',
    '(defun serve-call (fields)',
    '  (destructuring-bind (id service operation &rest args) fields',
    '    (handler-case',
    '        (let ((export (find-export service operation)))',
    '          (cond ((null export) (answer (format nil "ERR~a~a~anot-exported" #\\Tab id #\\Tab)))',
    '                ((/= (length args) (fifth export)) (answer (format nil "ERR~a~a~aarity" #\\Tab id #\\Tab)))',
    '                (t (answer (format nil "OK~a~a~a~a" #\\Tab id #\\Tab',
    '                                   (encode-value (apply (export-function export) (mapcar (function decode-value) args))))))))',
    '      (error (condition)',
    '        (answer (format nil "ERR~a~a~a~a" #\\Tab id #\\Tab (percent-encode (princ-to-string condition))))))))',
    '',
    '(defun serve ()',
    `  (answer (format nil "READY~a~a" #\\Tab ${lispString(COMMON_LISP_STDIO_BRIDGE_V1)}))`,
    '  (loop for line = (read-line *standard-input* nil)',
    '        while line',
    '        do (let ((fields (split-tab line)))',
    '             (cond ((string= (first fields) "QUIT") (answer "BYE") (return))',
    '                   ((string= (first fields) "CALL") (serve-call (rest fields)))',
    '                   (t nil)))))',
    '',
    '(in-package :common-lisp-user)',
    loads,
    '(lagrange-bridge::serve)',
    '',
  ].join('\n');
}

// ---- the provider ------------------------------------------------------------------------------

function createArtifactBackedCommonLispSbclProvider({
  sbclPath,
  sbclIdentity,
  runner = new LineProcessRunner(),
  workspaceRoot = tmpdir(),
  startupTimeoutMs = 30_000,
  callTimeoutMs = 10_000,
  stopTimeoutMs = 5_000,
} = {}) {
  const executable = resolve(requiredText(sbclPath, 'SBCL path'));
  const stableIdentity = requiredText(sbclIdentity, 'SBCL identity');
  if (!runner || typeof runner.start !== 'function') throw new TypeError('SBCL runner must implement start(request)');
  const root = resolve(requiredText(workspaceRoot, 'SBCL workspaceRoot'));
  positiveInteger(startupTimeoutMs, 'SBCL startupTimeoutMs');
  positiveInteger(callTimeoutMs, 'SBCL callTimeoutMs');
  positiveInteger(stopTimeoutMs, 'SBCL stopTimeoutMs');
  const identity = `${COMMON_LISP_SBCL_PROVIDER_V0}/${createHash('sha256').update(stableIdentity).digest('hex')}`;

  return Object.freeze({
    identity,
    sbclIdentity: stableIdentity,
    async start(request) {
      const graph = validateCommonLispRuntimeDefinition(request.spec);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-common-lisp-runtime-'));
      let session = null;
      try {
        for (const source of graph.sources) {
          await writeFile(join(workspace, source.fileName), source.artifact.content.value, 'utf8');
        }
        const bridgePath = join(workspace, 'lagrange-bridge.lisp');
        await writeFile(bridgePath, bridgeSource({sources: graph.sources, exports: graph.contract.exports}), 'utf8');
        session = await runner.start({
          command: executable,
          args: ['--noinform', '--non-interactive', '--no-userinit', '--no-sysinit', '--disable-debugger', '--load', bridgePath],
          cwd: workspace,
          environment: {},
        });
        await awaitBridgeReady(session, COMMON_LISP_STDIO_BRIDGE_V1, {timeoutMs: startupTimeoutMs, runtimeLabel: RUNTIME_LABEL});
        return Object.freeze({
          handle: createBridgeHandle(session, {workspace, exports: graph.contract.exports}),
          metadata: Object.freeze({
            runtime: 'SBCL',
            bridgeProtocol: COMMON_LISP_STDIO_BRIDGE_V1,
            sbclIdentity: stableIdentity,
            definitionProtocol: graph.protocol,
            definition: graph.definitionRef,
            sources: graph.sources.map(({ref, fileName}) => Object.freeze({artifact: ref, fileName})),
            exports: graph.contract.exports.map(({service, operation, arity}) => Object.freeze({service, operation, arity})),
          }),
        });
      } catch (error) {
        const stderrText = session ? session.stderrText() : '';
        if (session) await forceStopSession(session, stopTimeoutMs);
        await rm(workspace, {recursive: true, force: true});
        const detail = stderrText.trim().length > 0 ? `; stderr: ${stderrText.trim().slice(0, 500)}` : '';
        throw new TypeError(`${error.message}${detail}`, {cause: error});
      }
    },
    async call(handle, request) {
      exactKeys(request.interface, ['operation', 'service'], 'Common Lisp interface');
      const service = requiredText(request.interface.service, 'Common Lisp interface service');
      const operation = requiredText(request.interface.operation, 'Common Lisp interface operation');
      const exported = handle.exports.find((e) => e.service === service && e.operation === operation);
      if (!exported) throw new TypeError(`Common Lisp interface not exported by its runtime definition: ${service}/${operation}`);
      if (request.arguments.length !== exported.arity) {
        throw new TypeError(`Common Lisp ${service}/${operation} expects ${exported.arity} arguments`);
      }
      try {
        return await bridgeCall(handle, {service, operation, arguments: request.arguments, timeoutMs: callTimeoutMs, runtimeLabel: RUNTIME_LABEL});
      } catch (error) {
        if (error instanceof StdioValueBridgeCallError && !(error instanceof CommonLispCallError)) throw new CommonLispCallError(error.code);
        throw error;
      }
    },
    async stop(handle) {
      await bridgeQuit(handle, {timeoutMs: stopTimeoutMs, runtimeLabel: RUNTIME_LABEL});
      await rm(handle.workspace, {recursive: true, force: true});
    },
  });
}

export {
  COMMON_LISP_RUNTIME_DEFINITION_CONTRACT_V0,
  COMMON_LISP_SBCL_PROVIDER_ID,
  COMMON_LISP_SBCL_PROVIDER_V0,
  COMMON_LISP_SBCL_RUNTIME_DEFINITION_V1,
  COMMON_LISP_SOURCE_V1,
  COMMON_LISP_STDIO_BRIDGE_V1,
  CommonLispCallError,
  TAB as COMMON_LISP_BRIDGE_FIELD_SEPARATOR,
  bridgeSource as createCommonLispStdioBridgeSource,
  createArtifactBackedCommonLispSbclProvider,
  createCommonLispRuntimeDefinitionContent,
  validateCommonLispRuntimeDefinition,
};
