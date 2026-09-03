// One durable mixed-language Project (Bead lagrange-images-gxa).
//
// Everything this file uses already has an owner: Project working state, the stable-current
// capture coordinator, the graph-bundle closure, the managed installation, the callable
// interface/binding owners, Symmetric Smalltalk, the Cuis runtime-definition provider and the
// WASM Component runtime. What none of them proved together is that ONE durable Project can name
// a native Smalltalk entry, a Cuis runtime relationship and a real Rust-derived Component as
// ordinary members — organization, not authority — and that the whole thing survives capture,
// managed installation, a real backend restart, and execution in a fresh runtime assembled ONLY
// from the declared artifact graph.
//
// The ownership rule under test (docs/ownership.md, "durable Project membership -> heterogeneous
// language member targets"): membership is `{key, role, target}` and nothing more. If making this
// pass had required a Project module to branch on a member's representation, that rule — not the
// test — would have been wrong.
//
// The Rust member is the committed real-Rust normalize Component (fixtures/normalize-component).
// The Cuis lane runs the artifact-backed provider against a fake stdio session here; the live-VM
// variant belongs to the integration lane beside test/two-lane-callable-real.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import './ensure-node-crypto.test-helper.js';
import {
  CUIS_IMAGE_V1,
  CUIS_PACKAGE_V1,
  CUIS_RUNTIME_DEFINITION_CONTRACT_V0,
  CUIS_RUNTIME_DEFINITION_V1,
  CUIS_STDIO_BRIDGE_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  WASM_COMPONENT_V1,
  addProjectMember,
  bytesValue,
  captureCurrentGraphProjectRelease,
  createArtifactBackedOpenSmalltalkCuisProvider,
  createDeploymentProfile,
  createJcoComponentRuntime,
  createProject,
  createRuntime,
  installCallableInterface,
  installForeignRuntimeBinding,
  installSymmetricSmalltalkBlock,
  installWasmComponentBinding,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {readProjectDescriptor} from '../src/project/working-state.js';
import {installManagedProjectRelease} from '../src/project/managed-installation.js';
import {readManagedProjectInstallation} from '../src/project/installation-state.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

const COMPONENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..',
  'fixtures', 'normalize-component', 'normalize.component.wasm',
);

const PROJECT_ID = 'project:mixed-app';
const STUDIO = 'studio';
const PROD = 'prod';

function normalizeSpec(text) {
  return text.toLowerCase().replace(/[\t\n\v\f\r ]+/g, ' ').trim();
}

// The same fake stdio bridge the fast two-lane proof uses: text/normalize over the real
// percent-encoded wire tokens, so the artifact-backed provider's whole materialization and
// framing path runs for real — only the Smalltalk VM process is absent.
class FakeCuisSession {
  constructor() {
    this.lines = [`READY\t${CUIS_STDIO_BRIDGE_V1}`];
    this.writes = [];
  }

  async writeLine(line) {
    this.writes.push(line);
    const fields = line.split('\t');
    if (fields[0] === 'QUIT') {
      this.lines.push('BYE');
      return;
    }
    const [, id, service, operation, ...args] = fields;
    if (service !== 'text' || operation !== 'normalize') {
      this.lines.push(`ERR\t${id}\tunsupported`);
      return;
    }
    const decodePercent = (token) => {
      const encoded = token.slice(2);
      const bytes = [];
      for (let i = 0; i < encoded.length; i++) {
        if (encoded[i] === '%') {
          bytes.push(parseInt(encoded.substring(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(encoded.charCodeAt(i));
        }
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    };
    const encodePercent = (str) => Array.from(new TextEncoder().encode(str), (b) =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
      || b === 0x2D || b === 0x2E || b === 0x5F || b === 0x7E
        ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    this.lines.push(`OK\t${id}\te:${encodePercent(normalizeSpec(decodePercent(args[0])))}`);
  }

  async nextLine() {
    if (this.lines.length === 0) throw new Error('fake Cuis session has no queued output');
    return this.lines.shift();
  }

  async waitForExit() { return {code: 0, signal: null, stderr: ''}; }
  kill() {}
  stderrText() { return ''; }
}

class FakeCuisRunner {
  constructor() { this.sessions = []; }
  async start() {
    const session = new FakeCuisSession();
    this.sessions.push(session);
    return session;
  }
}

// A full runtime over a restartable backend. Everything here is composition-root wiring —
// providers, definition binding, component runtime — never durable state.
async function composeRuntime(filename, cuisRunner, workspaceRoot) {
  const backend = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
  return await createRuntime({
    backend: {instance: backend},
    componentRuntime: createJcoComponentRuntime(),
    foreignRuntimeProviders: [[
      OPENSMALLTALK_CUIS_PROVIDER_ID,
      createArtifactBackedOpenSmalltalkCuisProvider({
        vmPath: '/vm',
        vmIdentity: 'vm/test',
        runner: cuisRunner,
        workspaceRoot,
      }),
    ]],
    foreignRuntimeDefinitionBindings: [[CUIS_RUNTIME_DEFINITION_V1, OPENSMALLTALK_CUIS_PROVIDER_ID]],
  });
}

// Author the whole mixed-language application in `studio` and return the durable Project.
async function authorMixedProject(runtime) {
  const images = runtime.images;
  await images.createImage({id: STUDIO});

  // One explicit interface. Both language lanes are held to it; nothing else names a callable.
  const callableInterface = await installCallableInterface({
    images,
    imageId: STUDIO,
    interfaceId: 'normalize-interface',
    functionName: 'normalize',
    parameters: ['string'],
    result: 'string',
  });
  const interfaceRef = objectRef(STUDIO, callableInterface.id);

  // Rust member: the committed real-Rust Component behind the interface.
  const component = await images.putCodeArtifact(STUDIO, {
    id: 'normalize-component',
    representation: WASM_COMPONENT_V1,
    content: bytesValue(await readFile(COMPONENT_PATH)),
    languageId: 'rust',
  });
  const componentLane = await installWasmComponentBinding({
    images,
    callableInterface: interfaceRef,
    component: objectRef(STUDIO, component.id),
    bindingId: 'normalize-component-binding',
    blockId: 'normalize-component-block',
  });

  // Cuis member: a startable runtime definition with image + package relationships, bound to the
  // same interface through the foreign-runtime lane.
  const cuisImage = await images.putCodeArtifact(STUDIO, {
    id: 'cuis-image',
    representation: CUIS_IMAGE_V1,
    content: bytesValue(Buffer.from('fake-cuis-image')),
    languageId: 'smalltalk',
    logicalPath: 'Mixed.image',
  });
  const cuisPackage = await images.putCodeArtifact(STUDIO, {
    id: 'cuis-package',
    representation: CUIS_PACKAGE_V1,
    content: textValue("'From Cuis'!\n!classDefinition: #LagrangeMixedProof!"),
    languageId: 'smalltalk',
    logicalPath: 'LagrangeMixedProof.pck.st',
  });
  const cuisDefinition = await images.putCodeArtifact(STUDIO, {
    id: 'cuis-definition',
    representation: CUIS_RUNTIME_DEFINITION_V1,
    content: textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0),
    languageId: 'smalltalk',
    dependencies: [
      {role: 'image', artifact: objectRef(STUDIO, cuisImage.id)},
      {role: 'package', artifact: objectRef(STUDIO, cuisPackage.id)},
    ],
  });
  const cuisLane = await installForeignRuntimeBinding({
    images,
    callableInterface: interfaceRef,
    runtimeDefinition: objectRef(STUDIO, cuisDefinition.id),
    target: {service: 'text', operation: 'normalize'},
    bindingId: 'normalize-cuis-binding',
    blockId: 'normalize-cuis-block',
  });

  // Native Symmetric Smalltalk entry: pipe the Rust lane's answer through the Cuis lane. The
  // composition is deliberately ordered so the proof can see BOTH lanes ran (the Cuis session
  // must receive already-normalized text, which only the Component produces).
  const environment = await images.putLexicalEnvironment(STUDIO, {
    id: 'mixed-environment',
    bindings: {
      'mixed:cuis': {name: 'cuis', value: objectRef(STUDIO, cuisLane.block.id)},
      'mixed:rust': {name: 'rust', value: objectRef(STUDIO, componentLane.block.id)},
    },
  });
  const entry = await installSymmetricSmalltalkBlock({
    images,
    compilation: runtime.compilation,
    imageId: STUDIO,
    id: 'mixed-entry',
    source: '[ :t | cuis value: (rust value: t) ]',
    captures: {cuis: 'mixed:cuis', rust: 'mixed:rust'},
    environment: objectRef(STUDIO, environment.id),
  });

  // The durable Project: pure organization over the artifacts above.
  await createProject({images, imageId: STUDIO, projectId: PROJECT_ID, name: 'Mixed App'});
  const members = [
    ['app/entry', 'entrypoint', objectRef(STUDIO, entry.block.id)],
    ['app/interface', 'interface', interfaceRef],
    ['rust/normalize', 'callable', objectRef(STUDIO, componentLane.block.id)],
    ['cuis/normalize', 'callable', objectRef(STUDIO, cuisLane.block.id)],
    ['cuis/runtime', 'runtime-definition', objectRef(STUDIO, cuisDefinition.id)],
    ['cuis/package', 'package', objectRef(STUDIO, cuisPackage.id)],
  ];
  for (const [key, role, target] of members) {
    await addProjectMember({images, imageId: STUDIO, projectId: PROJECT_ID, key, role, target});
  }
  return {memberKeys: members.map(([key]) => key)};
}

async function invokeText(runtime, blockRef, text) {
  const activation = await runtime.invocations.invokeBlock(blockRef, [textValue(text)]);
  return await runtime.executor.execute(activation);
}

test('one durable Project carries Smalltalk, Cuis and Rust Component members through capture, managed install, restart and fresh-runtime execution', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-mixed-project-'));
  const filename = join(directory, 'image.sqlite');
  const INPUT = '  HÄLLO   Wörld  ';
  const EXPECTED = normalizeSpec(INPUT);
  let release;
  let material;
  let provenance;
  let memberKeys;

  try {
    // --- Author, prove locally, capture, install, and shut the runtime down completely.
    const authorRunner = new FakeCuisRunner();
    const runtimeA = await composeRuntime(filename, authorRunner, directory);
    try {
      ({memberKeys} = await authorMixedProject(runtimeA));

      // The application works where it was authored (both lanes, through the entry).
      const authored = await invokeText(runtimeA, objectRef(STUDIO, 'mixed-entry'), INPUT);
      assert.deepEqual(authored, textValue(EXPECTED));
      assert.equal(authorRunner.sessions.length, 1);

      const descriptor = await readProjectDescriptor({images: runtimeA.images, imageId: STUDIO, projectId: PROJECT_ID});
      assert.deepEqual(descriptor.members.map(({key}) => key), [...memberKeys].sort());

      const profile = createDeploymentProfile({project: descriptor, profileId: 'full', members: memberKeys});
      ({release, material, provenance} = await captureCurrentGraphProjectRelease({
        images: runtimeA.images, projectImageId: STUDIO, projectId: PROJECT_ID, profile,
      }));
      assert.equal(release.projectId, PROJECT_ID);
      assert.deepEqual(release.members.map(({key}) => key), [...memberKeys].sort());
      assert.deepEqual(Object.keys(provenance.sourceFrontiers), [STUDIO]);

      await runtimeA.images.createImage({id: PROD});
      const installed = await installManagedProjectRelease({
        images: runtimeA.images, targetImageId: PROD, release, material,
      });
      assert.equal(installed.releaseId, release.releaseId);
    } finally {
      await runtimeA.close();
    }

    // --- Restart: a genuinely fresh runtime over the same durable store. Nothing survives from
    // the authoring process except the sqlite file; providers and the component runtime are
    // composition wiring, configured before any member is known.
    const freshRunner = new FakeCuisRunner();
    const runtimeB = await composeRuntime(filename, freshRunner, directory);
    try {
      // Recovery: the durable installation state alone names every member and its target.
      const installation = await readManagedProjectInstallation({
        images: runtimeB.images, targetImageId: PROD, projectId: PROJECT_ID,
      });
      assert.ok(installation, 'managed installation must be recoverable after restart');
      assert.equal(installation.releaseId, release.releaseId);
      assert.deepEqual(installation.members.map(({key}) => key), [...memberKeys].sort());
      // Identity guard: an installation member carries stable artifact/semantic identity and a
      // target ref — never a runtime handle, session id, provider id or foreign heap identity.
      for (const member of installation.members) {
        assert.deepEqual(Object.keys(member).sort(), ['contentIdentity', 'key', 'representation', 'role', 'target']);
        assert.equal(member.target.imageId, PROD);
      }

      // Execute the entry resolved ONLY through the installation descriptor.
      const byKey = new Map(installation.members.map((member) => [member.key, member]));
      const entryTarget = byKey.get('app/entry').target;
      const result = await invokeText(runtimeB, entryTarget, INPUT);
      assert.deepEqual(result, textValue(EXPECTED));

      // Both language lanes really ran in the fresh runtime: a Cuis session was started from the
      // imported runtime definition, and the text it received was ALREADY normalized — only the
      // Rust Component produces that.
      assert.equal(freshRunner.sessions.length, 1);
      const call = freshRunner.sessions[0].writes.find((line) => line.includes('\ttext\tnormalize\t'));
      assert.ok(call, 'the fresh Cuis session must have served the normalize call');
      assert.match(call, /e:h%C3%A4llo%20w%C3%B6rld$/);

      // The imported graph is a faithful copy, not a reference back into the studio image.
      assert.equal(byKey.get('rust/normalize').target.imageId, PROD);
      const entryRecord = await runtimeB.images.getBlock(PROD, entryTarget.objectId);
      assert.equal(entryRecord.environment.imageId, PROD);

      // Same release, replayed: recovery, not duplication (the managed contract's second outcome).
      const replay = await installManagedProjectRelease({
        images: runtimeB.images, targetImageId: PROD, release, material,
      });
      assert.deepEqual(replay, installation);
    } finally {
      await runtimeB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// Falsifier: the declared artifact relationships are load-bearing. A runtime definition whose
// image dependency was never declared installs fine (organization does not validate language
// semantics) but cannot start — the fresh runtime refuses at the provider's own contract, rather
// than quietly reaching for anything outside the declared graph.
test('a Project member missing a declared runtime dependency fails in the fresh runtime, not silently', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-mixed-project-broken-'));
  const filename = join(directory, 'image.sqlite');
  let release;
  let material;

  try {
    const runtimeA = await composeRuntime(filename, new FakeCuisRunner(), directory);
    try {
      const images = runtimeA.images;
      await images.createImage({id: STUDIO});
      const cuisDefinition = await images.putCodeArtifact(STUDIO, {
        id: 'broken-definition',
        representation: CUIS_RUNTIME_DEFINITION_V1,
        content: textValue(CUIS_RUNTIME_DEFINITION_CONTRACT_V0),
        languageId: 'smalltalk',
        // No image dependency: the startable relationship is deliberately not declared.
        dependencies: [],
      });
      const callableInterface = await installCallableInterface({
        images,
        imageId: STUDIO,
        interfaceId: 'broken-interface',
        functionName: 'normalize',
        parameters: ['string'],
        result: 'string',
      });
      const lane = await installForeignRuntimeBinding({
        images,
        callableInterface: objectRef(STUDIO, callableInterface.id),
        runtimeDefinition: objectRef(STUDIO, cuisDefinition.id),
        target: {service: 'text', operation: 'normalize'},
        bindingId: 'broken-binding',
        blockId: 'broken-block',
      });
      await createProject({images, imageId: STUDIO, projectId: PROJECT_ID, name: 'Broken'});
      await addProjectMember({
        images, imageId: STUDIO, projectId: PROJECT_ID,
        key: 'cuis/normalize', role: 'callable', target: objectRef(STUDIO, lane.block.id),
      });
      const descriptor = await readProjectDescriptor({images, imageId: STUDIO, projectId: PROJECT_ID});
      const profile = createDeploymentProfile({project: descriptor, profileId: 'full', members: ['cuis/normalize']});
      ({release, material} = await captureCurrentGraphProjectRelease({
        images, projectImageId: STUDIO, projectId: PROJECT_ID, profile,
      }));
      await images.createImage({id: PROD});
      await installManagedProjectRelease({images, targetImageId: PROD, release, material});
    } finally {
      await runtimeA.close();
    }

    const runtimeB = await composeRuntime(filename, new FakeCuisRunner(), directory);
    try {
      const installation = await readManagedProjectInstallation({
        images: runtimeB.images, targetImageId: PROD, projectId: PROJECT_ID,
      });
      const target = installation.members[0].target;
      await assert.rejects(
        invokeText(runtimeB, target, 'anything'),
        /image/i,
      );
    } finally {
      await runtimeB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
