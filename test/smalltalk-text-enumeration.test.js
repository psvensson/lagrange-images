import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, integerValue, objectRef, textValue,
} from '../src/runtime.js';

// The pinned Cuis oracle on dph enumerates Unicode Characters in order, ignores callback
// answers, returns its receiver, and invokes no callback for empty text.
for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Text do: enumerates canonical scalar Characters`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'text-enumeration'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'text-enumeration', lane,
      });
      let sequence = 0;
      const evaluate = async source => {
        const {block} = await installSymmetricSmalltalkBlock({
          images: runtime.images, imageId: 'text-enumeration', id: `text-do-${sequence++}`, source,
        });
        return runtime.executor.execute(await runtime.invocations.invokeBlock(objectRef('text-enumeration', block.id), []));
      };
      assert.deepEqual(await evaluate(`[ | text chars answer |
        text := 'Aλ𝄞A'. chars := OrderedCollection new.
        answer := text do: [:each | chars add: each. 999].
        (answer == text) and: [(text size = 4) and: [(chars size = 4) and: [
          ((chars at: 1) == $A) and: [((chars at: 2) == $λ) and: [
            ((chars at: 3) == $𝄞) and: [(chars at: 4) == $A] ] ] ] ] ] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | calls answer |
        calls := 0. answer := '' do: [:each | calls := calls + 1].
        (calls = 0) and: [(answer = '') and: ['' size = 0]] ]`), booleanValue(true));
      assert.deepEqual(await evaluate(`[ | seen |
        seen := OrderedCollection new.
        ['AB' do: [:each | seen add: each. (EmptyCollection new) signal]]
          on: EmptyCollection do: [:error | nil].
        (seen size = 1) and: [seen first == $A] ]`), booleanValue(true));
      const size = async value => runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('text-enumeration', 'smalltalk/primitive/text-size'), [value],
      ));
      assert.deepEqual(await size(textValue('Aλ𝄞A')), integerValue(4));
      await assert.rejects(size(integerValue(4)), /receiver must be a Text Value/);
      await assert.rejects(size(textValue('\ud800')), /lone surrogate/);
    } finally { await runtime.close(); }
  });
}
