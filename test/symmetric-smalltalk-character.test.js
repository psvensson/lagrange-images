import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  SMALLTALK_END_OF_SOURCE_CHARACTER,
  CHARACTER_BINDING_ID,
  CHARACTER_CODE_POINT_SLOT,
  CHARACTER_SHAPE_ID,
  CompilationService,
  VALUE_KIND,
  booleanValue,
  compileSymmetricSmalltalkBlock,
  createDefaultCodeCompilerRegistry,
  createDefaultCompilationGroupCompilerRegistry,
  createRuntime,
  defineMethodsFromSource,
  installSmalltalkCharacterProtocol,
  installSmalltalkControlFlow,
  installSmalltalkEqualityProtocol,
  installSmalltalkInstanceVariableProtocol,
  installSmalltalkKernel,
  installSmalltalkIntegerProtocol,
  installSymmetricSmalltalkBlock,
  installSymmetricSmalltalkStandardImage,
  installWasmBlockTree,
  integerValue,
  objectRef,
  parseSymmetricSmalltalk,
  tokenizeSymmetricSmalltalk,
} from '../src/runtime.js';
import {faultingImages, forkableRuntime} from './support/recovery-harness.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

async function seed(runtime, imageId, {lane = 'neutral'} = {}) {
  await runtime.images.createImage({id: imageId});
  return await installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId, lane,
  });
}

async function evaluate(runtime, imageId, id, source, args = []) {
  const installed = await installSymmetricSmalltalkBlock({
    images: runtime.images, imageId, id, source,
  });
  const activation = await runtime.invocations.invokeBlock(
    objectRef(imageId, installed.block.id), args,
  );
  return await runtime.executor.execute(activation);
}

test('the tokenizer applies the pinned one-code-point Character literal rule', () => {
  const tokens = tokenizeSymmetricSmalltalk(`$<$<isAscii $  $$ $' $" $n $λ $😀`);
  assert.deepEqual(
    tokens.slice(0, -1).map(({type, value}) => [type, value]),
    [
      ['character', '<'],
      ['character', '<'],
      ['identifier', 'isAscii'],
      ['character', ' '],
      ['character', '$'],
      ['character', "'"],
      ['character', '"'],
      ['character', 'n'],
      ['character', 'λ'],
      ['character', '😀'],
    ],
  );
  const supplementary = tokens.at(-2);
  assert.equal(supplementary.end - supplementary.start, 3, 'dollar plus one supplementary code point');

  const lineFeed = tokenizeSymmetricSmalltalk('$\n')[0];
  assert.deepEqual({type: lineFeed.type, value: lineFeed.value}, {type: 'character', value: '\n'});
  const atEnd = tokenizeSymmetricSmalltalk('$')[0];
  assert.deepEqual(
    {type: atEnd.type, value: atEnd.value, start: atEnd.start, end: atEnd.end},
    {type: 'character', value: SMALLTALK_END_OF_SOURCE_CHARACTER, start: 0, end: 1},
  );
  assert.equal(atEnd.value.codePointAt(0), 26, 'the pinned Cuis scanner end marker');
  assert.throws(
    () => tokenizeSymmetricSmalltalk(`$\ud800`),
    /character literal must contain a Unicode scalar value/,
  );
});

test('dollars in strings and comments are never Character syntax', () => {
  assert.deepEqual(
    tokenizeSymmetricSmalltalk(`"$< ignored" '$<' $<`).map(({type, value}) => [type, value]),
    [['string', '$<'], ['character', '<'], ['eof', '']],
  );
});

test('the parser preserves Character as an explicit syntax form', () => {
  assert.deepEqual(
    parseSymmetricSmalltalk('[ ^ $< ]'),
    {
      kind: 'block',
      parameters: [],
      body: {kind: 'return', value: {kind: 'character', value: '<'}, start: 2},
      start: 0,
      end: 8,
    },
  );
});

test('semantic lowering names only the image-local Character interner and a code point', () => {
  const {syntax, program} = compileSymmetricSmalltalkBlock('[ $λ ]');
  assert.deepEqual(syntax.body, {kind: 'character', value: 'λ'});
  assert.deepEqual(program.body, {
    op: 'send',
    languageId: 'symmetric-smalltalk',
    receiver: {op: 'binding', id: CHARACTER_BINDING_ID},
    message: {kind: 'text', value: 'value:'},
    arguments: [{op: 'literal', value: integerValue(955)}],
  });
  assert.equal(JSON.stringify(program).includes('"kind":"ref"'), false, 'no image ref in semantic code');
  assert.equal('CHARACTER' in VALUE_KIND, false, 'the generic Value model is unchanged');
  assert.throws(
    () => compileSymmetricSmalltalkBlock('[ $< ]', {captures: {$character: 'fixture-binding'}}),
    /capture name \$character is reserved for the character intrinsic/,
  );
  assert.throws(
    () => compileSymmetricSmalltalkBlock('[ $< ]', {captures: {fixture: CHARACTER_BINDING_ID}}),
    /capture binding id smalltalk\/intrinsic\/character is reserved for the character intrinsic/,
  );
});

test('direct provider-free native source answers canonical Characters distinct from Text and Integer', async () => {
  await withRuntime(async (runtime) => {
    const image = await seed(runtime, 'character');
    const literal = await evaluate(runtime, 'character', 'literal', '[ $< ]');
    const indexed = await evaluate(runtime, 'character', 'indexed', "[ '<' at: 1 ]");
    assert.deepEqual(literal, indexed, 'literal and Text indexing answer the same image identity');
    assert.deepEqual(await evaluate(runtime, 'character', 'equal', "[ $< = ('<' at: 1) ]"), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, 'character', 'identical', "[ $< == ('<' at: 1) ]"), booleanValue(true));
    assert.deepEqual(await evaluate(runtime, 'character', 'not-text', "[ $< = '<' ]"), booleanValue(false));
    assert.deepEqual(await evaluate(runtime, 'character', 'not-integer', '[ $< = 60 ]'), booleanValue(false));

    const record = await runtime.images.getObject('character', literal.objectId);
    assert.equal(record.shape.objectId, CHARACTER_SHAPE_ID);
    assert.deepEqual(record.behavior, image.classes.Character);
    assert.deepEqual(record.slots[CHARACTER_CODE_POINT_SLOT], integerValue(60));
  });
});

test('non-ASCII and supplementary literals share canonical identity with Text indexing', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'unicode-character');
    assert.deepEqual(
      await evaluate(runtime, 'unicode-character', 'lambda', "[ $λ == ('λ' at: 1) ]"),
      booleanValue(true),
    );
    assert.deepEqual(
      await evaluate(runtime, 'unicode-character', 'supplementary', "[ $😀 == ('😀' at: 1) ]"),
      booleanValue(true),
    );
    await assert.rejects(
      evaluate(runtime, 'unicode-character', 'supplementary-bound', "[ '😀' at: 2 ]"),
      /outside the 1\.\.1 range/,
    );
  });
});

for (const lane of ['neutral', 'wasm']) {
  test(`Character codePoint exposes its existing canonical scalar in the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      await seed(runtime, `character-code-point-${lane}`, {lane});
      for (const [glyph, scalar] of [['A', 65], ['λ', 955], ['😀', 128512]]) {
        assert.deepEqual(
          await evaluate(
            runtime,
            `character-code-point-${lane}`,
            `code-point-${scalar}-${lane}`,
            `[ $${glyph} codePoint ]`,
          ),
          integerValue(scalar),
          `U+${scalar.toString(16).toUpperCase()} exposes the scalar already stored by Character`,
        );
      }
    });
  });

  test(`Character isSeparator is exactly the pinned seven-member relation in the ${lane} lane`, async () => {
    await withRuntime(async (runtime) => {
      const imageId = `character-separator-${lane}`;
      await seed(runtime, imageId, {lane});
      const positives = [32, 9, 10, 13, 12, 160, 8203];
      const negatives = [0, 11, 27, 65, 133, 8194, 8204, 128512];
      for (const [expected, scalars] of [[true, positives], [false, negatives]]) {
        for (const scalar of scalars) {
          const glyph = String.fromCodePoint(scalar);
          assert.deepEqual(
            await evaluate(
              runtime,
              imageId,
              `separator-${scalar}-${lane}`,
              `[ $${glyph} isSeparator ]`,
            ),
            booleanValue(expected),
            `U+${scalar.toString(16).toUpperCase().padStart(4, '0')} separator classification`,
          );
        }
      }
    });
  });
}

test('direct class-scoped source [ ^ $< ] compiles and executes with no Cuis material', async () => {
  await withRuntime(async (runtime) => {
    const image = await seed(runtime, 'method-character');
    await defineMethodsFromSource({
      images: runtime.images,
      compilation: runtime.compilation,
      imageId: 'method-character',
      lane: 'wasm',
      classRef: image.kernel.objectClass,
      methods: [{selector: 'literalLessThan', source: '[ ^ $< ]'}],
    });
    assert.deepEqual(
      await evaluate(runtime, 'method-character', 'call-method', '[ 1 literalLessThan == $< ]'),
      booleanValue(true),
    );
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
    assert.deepEqual(runtime.toolchainProviders.list(), []);
  });
});

test('Character literals and Text production agree across neutral and WASM execution', async () => {
  await withRuntime(async (runtime) => {
    await seed(runtime, 'character-lanes', {lane: 'wasm'});
    const source = "[ $😀 = ('😀' at: 1) ]";
    const neutral = await evaluate(runtime, 'character-lanes', 'character-neutral', source);
    const installed = await installSymmetricSmalltalkBlock({
      images: runtime.images, imageId: 'character-lanes', id: 'character-wasm', source,
    });
    const tree = await installWasmBlockTree({
      images: runtime.images,
      compilation: runtime.compilation,
      semanticRef: objectRef('character-lanes', installed.semanticArtifact.id),
      id: 'character-wasm:tree',
      environment: installed.block.environment,
    });
    const wasm = await runtime.executor.execute(
      await runtime.invocations.invokeBlock(objectRef('character-lanes', tree.block.id), []),
    );
    assert.deepEqual(neutral, booleanValue(true));
    assert.deepEqual(wasm, neutral);
  });
});

test('the Cuis adapter owns no Character syntax or representation', async () => {
  const source = await readFile(new URL('../src/language/cuis-native-import.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"]character['"]/, 'the adapter must not branch on the Character token');
  assert.equal(source.includes("type === 'character'"), false);
  assert.equal(source.includes("case 'character'"), false);
  assert.equal(source.includes('character-intern'), false);
  assert.equal(source.includes('$<'), false);
});

test('separator classification does not widen Array or bypass ordinary Character protocol', async () => {
  const [characterSource, indexedSource, adapterSource, primitiveSource] = await Promise.all([
    readFile(new URL('../src/language/smalltalk-character.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/language/smalltalk-indexed.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/language/cuis-native-import.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/language/smalltalk-primitives-character.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(indexedSource, /statePointsTo:/, 'xxm.13 adds no generic Array membership');
  assert.doesNotMatch(adapterSource, /isSeparator|codePoint/, 'the Cuis adapter owns no Character protocol');
  assert.doesNotMatch(primitiveSource, /IS_SEPARATOR|isSeparator/, 'classification is not a primitive');
  assert.match(characterSource, /scalar := self codePoint/, 'classification composes through codePoint');
  assert.doesNotMatch(characterSource, /RegExp|\\s|trim\(|unicode.*white/i, 'no host Unicode classifier');
});

const compilationFor = (images) => new CompilationService({
  images,
  compilers: createDefaultCodeCompilerRegistry(),
  groupCompilers: createDefaultCompilationGroupCompilerRegistry(),
});

for (const lane of ['neutral', 'wasm']) {
  test(`exhaustive-recovery: every write publishing the ${lane} Character personality`, async () => {
    const base = await forkableRuntime(async (runtime) => {
      await runtime.images.createImage({id: 'character-recovery'});
      await installSmalltalkKernel({images: runtime.images, imageId: 'character-recovery'});
      await installSmalltalkEqualityProtocol({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'character-recovery',
        lane,
      });
      await installSmalltalkControlFlow({
        images: runtime.images,
        compilation: runtime.compilation,
        imageId: 'character-recovery',
        lane,
      });
      await installSmalltalkIntegerProtocol({
        images: runtime.images, compilation: runtime.compilation, imageId: 'character-recovery', lane,
      });
      await installSmalltalkInstanceVariableProtocol({
        images: runtime.images,
        imageId: 'character-recovery',
      });
    });
    try {
      const total = await base.withFork(async (runtime) => {
        const wrapped = faultingImages(runtime.images, {});
        await installSmalltalkCharacterProtocol({
          images: wrapped.images,
          compilation: compilationFor(wrapped.images),
          imageId: 'character-recovery',
          lane,
        });
        return wrapped.writeCount();
      });
      assert.ok(total > 8, `expected Character records, primitives and Text method writes, saw ${total}`);

      for (let failAt = 1; failAt <= total; failAt += 1) {
        for (const commitThenThrow of [false, true]) {
          await base.withFork(async (runtime) => {
            const wrapped = faultingImages(runtime.images, {failAt, commitThenThrow});
            await assert.rejects(
              installSmalltalkCharacterProtocol({
                images: wrapped.images,
                compilation: compilationFor(wrapped.images),
                imageId: 'character-recovery',
                lane,
              }),
              /injected/,
            );

            await installSmalltalkCharacterProtocol({
              images: runtime.images,
              compilation: runtime.compilation,
              imageId: 'character-recovery',
              lane,
            });
            assert.deepEqual(
              await evaluate(
                runtime,
                'character-recovery',
                `recovered-character-${lane}-${failAt}-${commitThenThrow}`,
                "[ :characterClass | ((characterClass codePoint: 955) == $λ) and: [ ('λ😀' size = 2) and: [ ($λ == ('λ' at: 1)) and: [ ($λ codePoint = 955) and: [ ($λ asciiValue == nil) and: [ ($: asciiValue = 58) and: [ ($0 isDigit) and: [ ($λ isDigit not) and: [$\u200b isSeparator] ] ] ] ] ] ] ] ]",
                [objectRef('character-recovery', 'smalltalk/class/Character')],
              ),
              booleanValue(true),
              'recovery preserves Character identity, its owned scalar and classification',
            );
          });
        }
      }
    } finally {
      await base.close();
    }
  });
}
