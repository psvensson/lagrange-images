import test from 'node:test';
import assert from 'node:assert/strict';
import {
  booleanValue, createRuntime, installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage, objectRef, textValue,
} from '../src/runtime.js';

// All true entries measured from pinned Cuis Character>>isLetter over the initializer's 0..255 domain.
const PINNED_LETTERS = new Set(`65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 97 98 99 100 101 102 103 104 105 106 107 108 109 110 111 112 113 114 115 116 117 118 119 120 121 122 170 181 186 192 193 194 195 196 197 198 199 200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 216 217 218 219 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 248 249 250 251 252 253 254 255`.split(' ').map(Number));

for (const lane of ['neutral', 'wasm']) {
  test(`native ${lane} Character isLetter matches every Latin-1 entry and refuses wider classification`, async () => {
    const runtime = await createRuntime({backend: {mode: 'mock'}});
    try {
      await runtime.images.createImage({id: 'letter'});
      await installSymmetricSmalltalkStandardImage({
        images: runtime.images, compilation: runtime.compilation, imageId: 'letter', lane,
      });
      const {block} = await installSymmetricSmalltalkBlock({
        images: runtime.images, imageId: 'letter', id: 'classify', source: '[ :text | (text at: 1) isLetter ]',
      });
      const classify = async scalar => runtime.executor.execute(await runtime.invocations.invokeBlock(
        objectRef('letter', block.id), [textValue(String.fromCodePoint(scalar))],
      ));
      for (let scalar = 0; scalar < 256; scalar++) {
        assert.deepEqual(await classify(scalar), booleanValue(PINNED_LETTERS.has(scalar)), `scalar ${scalar}`);
      }
      // Cuis supports these; native coverage is explicitly partial, never a fabricated false.
      for (const scalar of [256, 955, 19968, 128512]) {
        await assert.rejects(classify(scalar), {name: 'SmalltalkMessageNotUnderstoodError', selector: 'isLetterOutsideLatin1'});
      }
    } finally { await runtime.close(); }
  });
}
