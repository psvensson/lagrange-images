import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import * as portable from '../src/portable-runtime.js';
import {installSmalltalkKernel, findSmalltalkKernel} from '../src/language/smalltalk-kernel.js';
import {defineClass} from '../src/language/smalltalk-class-builder.js';
import {installCallableInterfaceV2} from '../src/callable/interface-v2-artifacts.js';
import {installImageCreationBinding} from '../src/callable/image-creation-binding.js';
import {installImageMutationBinding} from '../src/callable/image-mutation-binding.js';
import {installImageObjectReadBinding} from '../src/callable/image-object-read-binding.js';
import {installImageObservationBinding} from '../src/callable/image-observation-binding.js';
import {packCompositeValue, unpackCompositeValue} from '../src/callable/composite-codec.js';
import {normalizeTypeDeclarations} from '../src/callable/type-grammar.js';
import {objectRef, referencesOfValue, textValue} from '../src/value/scalars.js';
import {objectResource, parseObjectResource} from '../src/authority/object-resource.js';
import {objectVersionToken} from '../src/object/version-token.js';
import {
  addProjectMember,
  authorizedReadProject,
  authorizedReadProjectDescriptor,
  authorizedRenameProject,
  createProject,
  projectObjectId,
} from '../src/project/working-state.js';
import {collectStaticModuleClosure} from '../src/portable-artifact/module-closure.js';
import {createNodeSourceReader} from '../src/portable-artifact/node-source-reader.js';

// Public portable Object Environment composition seam (Bead 6sv).
//
// Each export is the identical function its semantic module owns. The portable
// root selects a bounded public surface; it neither wraps nor reimplements one.
const owned = Object.freeze({
  installSmalltalkKernel,
  findSmalltalkKernel,
  defineClass,
  installCallableInterfaceV2,
  installImageCreationBinding,
  installImageMutationBinding,
  installImageObjectReadBinding,
  installImageObservationBinding,
  objectRef,
  textValue,
  referencesOfValue,
  objectResource,
  parseObjectResource,
  objectVersionToken,
  packCompositeValue,
  unpackCompositeValue,
  normalizeTypeDeclarations,
  authorizedReadProject,
  authorizedReadProjectDescriptor,
  authorizedRenameProject,
  createProject,
  addProjectMember,
  projectObjectId,
});

test('portable-runtime exposes the exact Object Environment composition owner bindings', () => {
  for (const [name, owner] of Object.entries(owned)) {
    assert.equal(typeof portable[name], 'function', `required public export ${name}`);
    assert.equal(portable[name], owner, `${name} must be a re-export, never a wrapper`);
  }
});

test('the bounded public seam does not broaden the portable static closure', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '..');
  const {modules, violations} = collectStaticModuleClosure({
    entry: 'src/portable-runtime.js',
    readSource: createNodeSourceReader(repo),
  });

  const paths = modules.map(({path}) => path);
  const projectPaths = paths.filter((path) => path.startsWith('src/project/'));

  // 109 after the two reviewed Project owner modules (#184); 110 after the wasm-module contract
  // owner (src/wasm/module-contract.js, ygi) — the ONE decoder/describer of the compiled-module
  // representation, reached from the compilation registry and the WASM producers already in the
  // closure. It imports only value/object/code/support modules (no node:*).
  assert.equal(modules.length, 110, 'the reviewed owner modules: two Project owners + the wasm-module contract owner');
  assert.ok(paths.includes('src/wasm/module-contract.js'));
  assert.deepEqual(projectPaths, [
    'src/project/model.js',
    'src/project/working-state.js',
  ], 'the bounded seam must not pull the broader Project barrel or release/deployment graph into the artifact');
  assert.deepEqual(violations, [], 'the portable closure remains closed and Node-free');
});
