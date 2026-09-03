import {VersionConflictError} from '../backend/backend-contract.js';
import {prepareGraphBundleImport} from '../graph/bundle.js';
import {validateProjectReleaseMaterialForRelease} from './graph-release-materialization.js';
import {
  ensureInstallationShapes,
  installationHeadObjectId,
  materializeInstallationRecords,
  readManagedProjectInstallation,
} from './installation-state.js';
import {createProjectInstallation, normalizeProjectReleaseManifest} from './model.js';

// Managed Project installation coordinator (ADR 0076 Decisions 2, 4–9, 11 and
// 13). This is the ONE owner of lifecycle sequencing only. Graph translation,
// descriptor semantics, durable-state translation and atomic publication remain
// delegated to their existing owners.

class ManagedProjectInstallationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ManagedProjectInstallationError';
    Object.assign(this, details);
  }
}

class ManagedProjectInstallationConflictError extends ManagedProjectInstallationError {
  constructor({targetImageId, projectId, currentReleaseId, desiredReleaseId}) {
    super(
      `managed Project ${projectId} in Image ${targetImageId} is at release ${currentReleaseId}; `
      + `desired release ${desiredReleaseId} requires upgrade`,
      {targetImageId, projectId, currentReleaseId, desiredReleaseId},
    );
    this.name = 'ManagedProjectInstallationConflictError';
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManagedProjectInstallationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireImages(images) {
  const methods = ['getRecord', 'putShape', 'createRecords'];
  if (!images || typeof images !== 'object' || methods.some((method) => typeof images[method] !== 'function')) {
    throw new ManagedProjectInstallationError(`images must provide ${methods.join(', ')}`);
  }
  return images;
}

function decideExisting(existing, desiredRelease) {
  if (existing.releaseId === desiredRelease.releaseId) return existing;
  throw new ManagedProjectInstallationConflictError({
    targetImageId: existing.targetImageId,
    projectId: desiredRelease.projectId,
    currentReleaseId: existing.releaseId,
    desiredReleaseId: desiredRelease.releaseId,
  });
}

async function installManagedProjectRelease({images, targetImageId, release, material, crypto} = {}) {
  requireImages(images);
  requiredText(targetImageId, 'targetImageId');

  // Complete semantic preflight before any target-side write. The existing
  // owners isolate and freeze both inputs, so caller mutation cannot race the
  // later preparation/publication window.
  const normalizedRelease = normalizeProjectReleaseManifest(release);
  const validatedMaterial = validateProjectReleaseMaterialForRelease({
    release: normalizedRelease,
    material,
    crypto,
  });

  // The deterministic head is the sole installation witness. Existing state
  // short-circuits before Shape bootstrap, id minting or publication.
  const existing = await readManagedProjectInstallation({
    images,
    targetImageId,
    projectId: normalizedRelease.projectId,
  });
  if (existing) return decideExisting(existing, normalizedRelease);

  // Shapes are harmless schema, never installation state. Their owner handles
  // concurrent bootstrap and fixed-definition divergence.
  await ensureInstallationShapes({images, targetImageId});

  // One shared graph owner prepares fresh ids/refs without durable effect.
  const plan = await prepareGraphBundleImport({
    images,
    targetImageId,
    bundle: validatedMaterial.bundle,
    expectedContentIdentity: validatedMaterial.contentIdentity,
    crypto,
  });
  const installation = createProjectInstallation({
    release: normalizedRelease,
    targetImageId,
    targets: plan.roots,
  });
  const installationRecords = materializeInstallationRecords({installation, crypto});

  // The sole installation effect: graph + members + snapshot + deterministic
  // head are insert-only candidates in ONE createRecords transaction. Only a
  // conflict on that exact head key is an install race; every other collision or
  // failure propagates unchanged and the batch owner guarantees zero partials.
  try {
    await images.createRecords(targetImageId, [...plan.recordInputs, ...installationRecords]);
  } catch (error) {
    const headId = installationHeadObjectId(normalizedRelease.projectId);
    if (!(error instanceof VersionConflictError) || error.key !== headId) throw error;
    const winner = await readManagedProjectInstallation({
      images,
      targetImageId,
      projectId: normalizedRelease.projectId,
    });
    if (!winner) {
      throw new ManagedProjectInstallationError(
        `managed Project head ${headId} conflicted but no committed installation can be read`,
        {cause: error, targetImageId, projectId: normalizedRelease.projectId},
      );
    }
    return decideExisting(winner, normalizedRelease);
  }

  return installation;
}

export {
  ManagedProjectInstallationConflictError,
  ManagedProjectInstallationError,
  installManagedProjectRelease,
};
