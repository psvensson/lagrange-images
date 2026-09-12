import assert from 'node:assert/strict';
import {addProjectMember, resolveGlobal, textValue} from '../../src/runtime.js';
import {
  M4_LOCATOR, M4_XML, openRuntime, send, mutate,
  reacquireDocument, inspectDocument, recoverApplication,
} from './yaxo-m4-acceptance.js';

// These are deliberately wrong recovery flows, separate from the positive A/B acceptance.
// Each fresh runtime starts from the store/Project locator. Old refs are comparison values only,
// except F1, whose purpose is to prove that handing the old root to recovery is rejected.
export async function runM4Falsifiers(filename, expected) {
  const unreadable = new Proxy({}, {get() {throw new Error('runtime accessed before locator validation');}});
  await assert.rejects(recoverApplication(unreadable, expected.document), {code: 'ERR_ASSERTION'});

  // The successful acceptance left 'se'. Reset through YAXO, after independent Project discovery,
  // so the negative cases start with the same 'sv' precondition as positive recovery.
  const reset = await openRuntime(filename);
  try {
    const document = await reacquireDocument(reset.runtime, {...M4_LOCATOR});
    const graph = await inspectDocument(reset.runtime, document);
    assert.deepEqual(graph.refs, expected);
    assert.deepEqual(graph.lang, textValue('se'));
    await mutate(reset.runtime, graph.refs.root, 'sv');
  } finally { await reset.runtime.close(); }

  // F5: a perfectly readable XMLElement is the wrong application root. The same shape guard used
  // by positive recovery must reject it before the post-restart mutation.
  const wrongRoot = await openRuntime(filename);
  try {
    const runtime = wrongRoot.runtime;
    const document = await reacquireDocument(runtime, {...M4_LOCATOR});
    const graph = await inspectDocument(runtime, document);
    const member = {images: runtime.images, imageId: M4_LOCATOR.imageId, projectId: M4_LOCATOR.projectId, key: M4_LOCATOR.memberKey, role: 'application-root'};
    await addProjectMember({...member, target: graph.refs.root});
    try {
      await assert.rejects(recoverApplication(runtime, {...M4_LOCATOR}), error =>
        error.code === 'ERR_ASSERTION' && error.actual === 'XMLElement' && error.expected === 'XMLDocument');
    } finally {
      await addProjectMember({...member, target: document});
    }
  } finally { await wrongRoot.runtime.close(); }

  // F6: keep every durable record readable and all query behavior working, but disable execution
  // of the recovered mutation's actual code artifact at the executor boundary. The second YAXO
  // mutation must be attempted and must fail. No installer or data reconstruction can mask it.
  const dataOnly = await openRuntime(filename);
  try {
    const runtime = dataOnly.runtime;
    const document = await reacquireDocument(runtime, {...M4_LOCATOR});
    const before = await inspectDocument(runtime, document);
    const activation = await runtime.invocations.sendMessage({
      languageId: 'symmetric-smalltalk', receiver: before.refs.root,
      message: textValue('attributeAt:put:'), arguments: [textValue('lang'), textValue('se')],
    });
    const mutationCode = activation.code;
    assert.ok(await runtime.images.getCodeArtifact(mutationCode.imageId, mutationCode.objectId));
    const originalGet = runtime.codeExecutors.get;
    let attempts = 0;
    runtime.codeExecutors.get = function(representation) {
      const executor = originalGet.call(this, representation);
      return {execute(input, context) {
        if (input.code.imageId === mutationCode.imageId && input.code.id === mutationCode.objectId) {
          attempts++;
          const error = new Error('M4 executable recovery disabled');
          error.code = 'M4_EXECUTABLE_RECOVERY_DISABLED';
          throw error;
        }
        return executor.execute(input, context);
      }};
    };
    try {
      await assert.rejects(recoverApplication(runtime, {...M4_LOCATOR}), {code: 'M4_EXECUTABLE_RECOVERY_DISABLED'});
      assert.equal(attempts, 1, 'the recovered YAXO mutation reached its executable');
      const after = await inspectDocument(runtime, document);
      assert.deepEqual(after.refs, before.refs);
      assert.deepEqual(after.lang, textValue('sv'), 'records and query behavior survived without the failed write');
    } finally { runtime.codeExecutors.get = originalGet; }
  } finally { await dataOnly.runtime.close(); }

  // F2: deliberately reparse in another runtime using the already durable parser class. Restore
  // the same attribute value through YAXO so only identity, not different contents, rejects it.
  const reparse = await openRuntime(filename);
  try {
    const runtime = reparse.runtime;
    const original = await inspectDocument(runtime, await reacquireDocument(runtime, {...M4_LOCATOR}));
    const parserBinding = await resolveGlobal({images: runtime.images, imageId: M4_LOCATOR.imageId, name: 'XMLDOMParser'});
    const parser = await send(runtime, parserBinding, 'value');
    const stream = await send(runtime, textValue(M4_XML), 'readStream');
    const rebuiltDocument = await send(runtime, parser, 'parseDocumentFrom:', [stream]);
    const rebuilt = await inspectDocument(runtime, rebuiltDocument);
    await mutate(runtime, rebuilt.refs.root, 'sv');
    const sameContents = await inspectDocument(runtime, rebuiltDocument);
    assert.deepEqual(sameContents.lang, original.lang);
    assert.throws(() => assert.deepEqual(sameContents.refs, expected), {code: 'ERR_ASSERTION'});
    for (const key of ['document', 'root', 'child', 'text']) {
      assert.notDeepEqual(sameContents.refs[key], expected[key], `${key} was reconstructed, not recovered`);
    }
    assert.deepEqual((await inspectDocument(runtime, await reacquireDocument(runtime, {...M4_LOCATOR}))).refs, expected);
  } finally { await reparse.runtime.close(); }
}
