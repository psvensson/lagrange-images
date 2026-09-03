// Shared helpers for the two mixed-language Project proofs (Bead lagrange-images-gxa):
// test/mixed-language-project.test.js (fast, faked VM) and
// test/mixed-language-project-real.test.js (live OpenSmalltalkVM). Only the genuinely identical
// pieces live here — the normalization contract both language lanes are held to, and the ordinary
// Block invocation. The two files author deliberately different graphs (the faked one carries a
// package as a member to prove package membership; the real one carries a bootable image +
// changes + sources), so their authoring flows stay separate on purpose.
import {textValue} from '../../src/runtime.js';

// The one normalization spec both the Rust Component and the Cuis lane must satisfy. It is
// idempotent, which is what lets the entry Block pipe one lane's output through the other and still
// get a stable expected value.
function normalizeSpec(text) {
  return text.toLowerCase().replace(/[\t\n\v\f\r ]+/g, ' ').trim();
}

async function invokeText(runtime, blockRef, text) {
  const activation = await runtime.invocations.invokeBlock(blockRef, [textValue(text)]);
  return await runtime.executor.execute(activation);
}

export {invokeText, normalizeSpec};
