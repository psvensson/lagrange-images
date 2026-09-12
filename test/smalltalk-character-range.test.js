import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, objectRef,
} from '../src/runtime.js';

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Character ranges allocate Arrays of canonical inclusive elements`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'range'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'range', lane,
      });
      let sequence = 0;
      const evaluate = async source => {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'range', id: `range-${sequence++}`, source,
        });
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('range', block.id), []));
      };
      assert.deepEqual(await evaluate(`[ | result index valid |
        result := $0 to: $9. index := 0. valid := true.
        '0123456789' do: [:each | index := index + 1. valid := valid and: [(result at: index) == each]].
        (result class == Array) and: [(result size = 10) and: [valid]] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | first second |
        first := $A to: $B. second := $A to: $B.
        (first == second) not and: [(first at: 1) == (second at: 1)] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | singleton empty |
        singleton := $A to: $A. empty := $B to: $A.
        (singleton size = 1) and: [((singleton at: 1) == $A) and: [empty size = 0]] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | letters |
        letters := $λ to: $ν.
        (letters size = 3) and: [((letters at: 1) == $λ) and: [
          ((letters at: 2) == $μ) and: [(letters at: 3) == $ν]]] ]`), booleanValue(true));
      // Pinned Cuis also refuses wider descending bounds through negative result allocation.
      await assert.rejects(evaluate('[ $C to: $A ]'), /size must be non-negative/);
      await assert.rejects(evaluate('[ $9 to: $0 ]'), /size must be non-negative/);
    } finally { await runtime.close(); }
  });
}
