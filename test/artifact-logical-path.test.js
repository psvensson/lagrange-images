// A code artifact's logicalPath is semantic content, not provenance (Bead lagrange-images-9kg,
// ADR 0079).
//
// Before this, a Cuis image's fileName and a Rust source's path lived in `metadata`, which ADR
// 0074 defines as stripped, non-identity provenance — so a portable release round-trip silently
// dropped them and a captured Cuis image could no longer start. The fix promotes that one concern
// (the materialization-relative path) to a canonical CodeArtifact field the graph bundle carries
// and contentIdentity covers, while `metadata` stays exactly what ADR 0074 says it is.
//
// These proofs pin both halves: logicalPath IS identity-bearing and survives round-trip; metadata
// (provenance) still is NOT identity-bearing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import './ensure-node-crypto.test-helper.js';
import {
  CUIS_IMAGE_V1,
  RUST_SOURCE_V1,
  addProjectMember,
  bytesValue,
  captureCurrentGraphProjectRelease,
  createDeploymentProfile,
  createProject,
  createProjectId,
  createRuntime,
  objectRef,
  textValue,
} from '../src/runtime.js';
import {exportGraphBundle} from '../src/graph/bundle.js';
import {readProjectDescriptor} from '../src/project/working-state.js';
import {installManagedProjectRelease} from '../src/project/managed-installation.js';
import {readManagedProjectInstallation} from '../src/project/installation-state.js';
import {LagrangeBackend} from '../src/backend/lagrange-backend.js';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';

async function withRuntime(body) {
  const runtime = await createRuntime({backend: {mode: 'mock'}});
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}

test('the CodeArtifact owner validates logicalPath and round-trips it through storage', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    const stored = await runtime.images.putCodeArtifact('img', {
      id: 'src', representation: RUST_SOURCE_V1, content: textValue('fn main() {}\n'), logicalPath: 'src/main.rs',
    });
    assert.equal(stored.logicalPath, 'src/main.rs');
    assert.equal((await runtime.images.getCodeArtifact('img', 'src')).logicalPath, 'src/main.rs');

    // Absent is null, never a phantom empty string.
    const none = await runtime.images.putCodeArtifact('img', {
      id: 'plain', representation: 'wasm-binary/v1', content: bytesValue(new Uint8Array([0])),
    });
    assert.equal(none.logicalPath, null);

    // The owner refuses workspace-escaping and non-portable paths at put time.
    for (const bad of ['../escape.rs', '/abs/main.rs', 'a//b.rs', 'a\\b.rs', './x.rs']) {
      await assert.rejects(runtime.images.putCodeArtifact('img', {
        id: `bad-${bad}`, representation: RUST_SOURCE_V1, content: textValue('x'), logicalPath: bad,
      }), /logicalPath/);
    }
  });
});

test('A/B: identical bytes at different logicalPaths get different content identity', async () => {
  await withRuntime(async (runtime) => {
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putCodeArtifact('img', {
      id: 'a', representation: RUST_SOURCE_V1, content: textValue('fn main() {}\n'), logicalPath: 'src/main.rs',
    });
    await runtime.images.putCodeArtifact('img', {
      id: 'b', representation: RUST_SOURCE_V1, content: textValue('fn main() {}\n'), logicalPath: 'src/other.rs',
    });
    const a = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'a')}});
    const b = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'b')}});
    assert.notEqual(a.contentIdentity, b.contentIdentity, 'logicalPath is part of identity');

    // Same bytes AND same logicalPath in a fresh image -> identical identity (logicalPath is the
    // only thing that moved the hash above, not the artifact id or image).
    await runtime.images.createImage({id: 'img2'});
    await runtime.images.putCodeArtifact('img2', {
      id: 'c', representation: RUST_SOURCE_V1, content: textValue('fn main() {}\n'), logicalPath: 'src/main.rs',
    });
    const c = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img2', 'c')}});
    assert.equal(a.contentIdentity, c.contentIdentity, 'identity is content+logicalPath, not artifact/image id');
  });
});

test('provenance-only metadata differences still collide (ADR 0074 preserved)', async () => {
  await withRuntime(async (runtime) => {
    // Two artifacts identical in content and logicalPath, differing ONLY in metadata. Metadata is
    // still stripped provenance, so they must hash the same — the invariant graph-bundle.test.js
    // pins for objects, held here for a code artifact that also carries a logicalPath.
    await runtime.images.createImage({id: 'img'});
    await runtime.images.putCodeArtifact('img', {
      id: 'm1', representation: RUST_SOURCE_V1, content: textValue('fn main() {}\n'),
      logicalPath: 'src/main.rs', metadata: {note: 'one'},
    });
    await runtime.images.createImage({id: 'img2'});
    await runtime.images.putCodeArtifact('img2', {
      id: 'm2', representation: RUST_SOURCE_V1, content: textValue('fn main() {}\n'),
      logicalPath: 'src/main.rs', metadata: {note: 'two', extra: 'provenance'},
    });
    const first = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img', 'm1')}});
    const second = await exportGraphBundle({images: runtime.images, roots: {root: objectRef('img2', 'm2')}});
    assert.equal(first.contentIdentity, second.contentIdentity, 'metadata is provenance, not identity');
  });
});

// The exact defect that blocked lagrange-images-gxa, proven fixed at this layer: a logicalPath-
// bearing artifact survives capture and managed install into a fresh image with its logicalPath
// intact. Proven for both a Cuis image (fileName) and a Rust source (path).
async function roundTrip(t, {representation, content, logicalPath, memberKey}) {
  const directory = await mkdtemp(join(tmpdir(), 'lagrange-logical-path-'));
  const filename = join(directory, 'image.sqlite');
  const projectId = createProjectId();
  try {
    const backendA = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    const runtimeA = await createRuntime({backend: {instance: backendA}});
    let release; let material;
    try {
      await runtimeA.images.createImage({id: 'src'});
      const artifact = await runtimeA.images.putCodeArtifact('src', {
        id: 'artifact', languageId: 'smalltalk', representation, content, logicalPath,
      });
      await createProject({images: runtimeA.images, imageId: 'src', projectId, name: 'P'});
      await addProjectMember({
        images: runtimeA.images, imageId: 'src', projectId,
        key: memberKey, role: 'artifact', target: objectRef('src', artifact.id),
      });
      const descriptor = await readProjectDescriptor({images: runtimeA.images, imageId: 'src', projectId});
      const profile = createDeploymentProfile({project: descriptor, profileId: 'deploy', members: [memberKey]});
      ({release, material} = await captureCurrentGraphProjectRelease({
        images: runtimeA.images, projectImageId: 'src', projectId, profile,
      }));
      await runtimeA.images.createImage({id: 'dst'});
      await installManagedProjectRelease({images: runtimeA.images, targetImageId: 'dst', release, material});
    } finally {
      await runtimeA.close();
    }

    const backendB = new LagrangeBackend({runtime: createSqliteApplicationRuntime(filename)});
    const runtimeB = await createRuntime({backend: {instance: backendB}});
    try {
      const installation = await readManagedProjectInstallation({
        images: runtimeB.images, targetImageId: 'dst', projectId,
      });
      const target = installation.members[0].target;
      const installed = await runtimeB.images.getCodeArtifact(target.imageId, target.objectId);
      assert.equal(installed.logicalPath, logicalPath, `${t}: logicalPath must survive capture/install`);
      assert.equal(installed.representation, representation);
    } finally {
      await runtimeB.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('a Cuis image logicalPath (fileName) survives capture/install round-trip', async () => {
  await roundTrip('cuis', {
    representation: CUIS_IMAGE_V1, content: bytesValue(Buffer.from('fake-cuis-image')),
    logicalPath: 'Mixed.image', memberKey: 'cuis/image',
  });
});

test('a Rust source logicalPath (path) survives capture/install round-trip', async () => {
  await roundTrip('rust', {
    representation: RUST_SOURCE_V1, content: textValue('fn main() {}\n'),
    logicalPath: 'src/main.rs', memberKey: 'rust/source',
  });
});
