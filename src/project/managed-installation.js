import {OBJECT_WRITE_OPERATION, objectResource} from '../authority/object-resource.js';
import {VersionConflictError} from '../backend/backend-contract.js';
import {
  exportGraphBundleWithSourceMap,
  extractSubBundleFromBundle,
  prepareGraphBundleImport,
} from '../graph/bundle.js';
import {objectRef, textValue} from '../value/index.js';
import {validateProjectReleaseMaterialForRelease} from './graph-release-materialization.js';
import {
  PROJECT_INSTALLATION_HEAD_SHAPE_ID,
  ensureInstallationShapes,
  installationHeadObjectId,
  listManagedProjectInstallations,
  materializeInstallationRecords,
  materializeInstallationSnapshotRecords,
  readManagedProjectInstallation,
  readManagedProjectInstallationState,
} from './installation-state.js';
import {
  createProjectInstallation,
  normalizeProjectReleaseManifest,
  planProjectUpgrade,
} from './model.js';

const PROJECT_INSTALLATION_PROVENANCE_V1 = 'lagrange-project-installation-provenance/v1';

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

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

async function discoverReusableSubgraphBindings({
  images,
  desiredRelease,
  desiredBundle,
  candidateMembers = [],
  crypto,
} = {}) {
  const preboundLocalRefs = {};
  const reusedMemberKeys = [];
  const reusedInstallationMap = new Map();
  if (!Array.isArray(candidateMembers) || candidateMembers.length === 0) {
    return {preboundLocalRefs, reusedMemberKeys, reusedInstallations: []};
  }

  // Index candidate installed members by both (key) and (subBundle contentIdentity).
  const candidateExportsByKey = new Map();
  const candidateExportsByIdentity = new Map();
  for (const cand of candidateMembers) {
    // eslint-disable-next-line no-await-in-loop
    const exported = await exportGraphBundleWithSourceMap({
      images,
      roots: {root: cand.target},
      referencePolicy: {classify: () => 'internal'},
      crypto,
    });
    const entry = {
      ...exported,
      sourceProjectId: cand.sourceProjectId ?? null,
      sourceReleaseId: cand.sourceReleaseId ?? null,
    };
    if (!candidateExportsByKey.has(cand.key)) {
      candidateExportsByKey.set(cand.key, entry);
    }
    if (!candidateExportsByIdentity.has(exported.contentIdentity)) {
      candidateExportsByIdentity.set(exported.contentIdentity, entry);
    }
  }

  for (const member of desiredRelease.members) {
    const rootLocalId = desiredBundle.roots[member.key];
    // eslint-disable-next-line no-await-in-loop
    const desiredSub = await extractSubBundleFromBundle({
      bundle: desiredBundle,
      rootLocalId,
      rootKey: 'root',
      crypto,
    });

    // Prefer same-key candidate if its sub-bundle contentIdentity matches; otherwise fall back to any candidate with matching sub-bundle contentIdentity.
    const sameKeyCand = candidateExportsByKey.get(member.key);
    const matchingExport =
      sameKeyCand && sameKeyCand.contentIdentity === desiredSub.contentIdentity
        ? sameKeyCand
        : candidateExportsByIdentity.get(desiredSub.contentIdentity) ?? null;

    if (matchingExport) {
      reusedMemberKeys.push(member.key);
      if (matchingExport.sourceProjectId && matchingExport.sourceReleaseId) {
        const instKey = `${matchingExport.sourceProjectId}:${matchingExport.sourceReleaseId}`;
        reusedInstallationMap.set(instKey, {
          projectId: matchingExport.sourceProjectId,
          releaseId: matchingExport.sourceReleaseId,
        });
      }
      for (const [subLocalId, bundleLocalId] of Object.entries(desiredSub.subLocalToBundleLocal)) {
        if (!Object.hasOwn(preboundLocalRefs, bundleLocalId)) {
          preboundLocalRefs[bundleLocalId] = matchingExport.localToSourceRef[subLocalId];
        }
      }
    }
  }

  const reusedInstallations = [...reusedInstallationMap.values()].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
  );
  return {preboundLocalRefs, reusedMemberKeys, reusedInstallations};
}

async function installManagedProjectRelease({
  images,
  targetImageId,
  release,
  material,
  reuseExistingInstallations = false,
  provenance = null,
  crypto,
} = {}) {
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

  let preboundLocalRefs = {};
  let reusedMemberKeys = [];
  let reusedInstallations = [];
  if (reuseExistingInstallations && typeof images.listObjects === 'function') {
    const otherInstallations = await listManagedProjectInstallations({images, targetImageId});
    const candidateMembers = otherInstallations.flatMap((inst) =>
      inst.members.map((m) => ({
        ...m,
        sourceProjectId: inst.projectId,
        sourceReleaseId: inst.releaseId,
      })),
    );
    const discovered = await discoverReusableSubgraphBindings({
      images,
      desiredRelease: normalizedRelease,
      desiredBundle: validatedMaterial.bundle,
      candidateMembers,
      crypto,
    });
    preboundLocalRefs = discovered.preboundLocalRefs;
    reusedMemberKeys = discovered.reusedMemberKeys;
    reusedInstallations = discovered.reusedInstallations;
  }

  // One shared graph owner prepares fresh ids/refs without durable effect.
  const plan = await prepareGraphBundleImport({
    images,
    targetImageId,
    bundle: validatedMaterial.bundle,
    expectedContentIdentity: validatedMaterial.contentIdentity,
    preboundLocalRefs,
    crypto,
  });
  const installation = createProjectInstallation({
    release: normalizedRelease,
    targetImageId,
    targets: plan.roots,
  });
  const totalBundleRecords = Object.keys(validatedMaterial.bundle.records).length;
  const installationProvenance =
    provenance !== null || reuseExistingInstallations
      ? deepFreeze({
          format: PROJECT_INSTALLATION_PROVENANCE_V1,
          operation: 'install',
          projectId: normalizedRelease.projectId,
          targetImageId,
          fromReleaseId: null,
          toReleaseId: normalizedRelease.releaseId,
          sourceReleaseProvenance: provenance ? structuredClone(provenance) : null,
          reusedMemberKeys: [...reusedMemberKeys].sort(),
          replacedMemberKeys: [],
          installedMemberKeys: normalizedRelease.members
            .map((m) => m.key)
            .filter((k) => !reusedMemberKeys.includes(k)),
          importedMemberKeys: normalizedRelease.members
            .map((m) => m.key)
            .filter((k) => !reusedMemberKeys.includes(k))
            .sort(),
          detachedMemberKeys: [],
          reusedInstallations,
          reusedRecordCount: totalBundleRecords - plan.recordInputs.length,
          createdRecordCount: plan.recordInputs.length,
        })
      : null;
  const installationRecords = materializeInstallationRecords({
    installation,
    provenance: installationProvenance,
    crypto,
  });

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

async function upgradeManagedProjectRelease({
  images,
  targetImageId,
  release,
  material,
  expectedReleaseId = null,
  reuseUnchangedMembers = true,
  reuseAcrossInstallations = false,
  provenance = null,
  crypto,
} = {}) {
  requireImages(images);
  if (typeof images.putObject !== 'function') {
    throw new ManagedProjectInstallationError('images must provide putObject for upgradeManagedProjectRelease');
  }
  requiredText(targetImageId, 'targetImageId');
  if (expectedReleaseId !== null && expectedReleaseId !== undefined) {
    requiredText(expectedReleaseId, 'expectedReleaseId');
  }

  const normalizedRelease = normalizeProjectReleaseManifest(release);
  const validatedMaterial = validateProjectReleaseMaterialForRelease({
    release: normalizedRelease,
    material,
    crypto,
  });

  const existingState = await readManagedProjectInstallationState({
    images,
    targetImageId,
    projectId: normalizedRelease.projectId,
  });
  if (!existingState) {
    throw new ManagedProjectInstallationError(
      `cannot upgrade absent managed Project ${normalizedRelease.projectId} in Image ${targetImageId}`,
      {targetImageId, projectId: normalizedRelease.projectId},
    );
  }

  if (
    expectedReleaseId !== null
    && expectedReleaseId !== undefined
    && existingState.installation.releaseId !== expectedReleaseId
  ) {
    throw new ManagedProjectInstallationConflictError({
      targetImageId,
      projectId: normalizedRelease.projectId,
      currentReleaseId: existingState.installation.releaseId,
      desiredReleaseId: expectedReleaseId,
    });
  }

  const reconciliation = planProjectUpgrade({
    installation: existingState.installation,
    nextRelease: normalizedRelease,
  });

  if (existingState.installation.releaseId === normalizedRelease.releaseId) {
    const memberKeys = existingState.installation.members.map((m) => m.key);
    return deepFreeze({
      installation: existingState.installation,
      reconciliation,
      upgraded: false,
      previousReleaseId: existingState.installation.releaseId,
      reusedMemberKeys: memberKeys,
      replacedMemberKeys: [],
      installedMemberKeys: [],
      importedMemberKeys: [],
      detachedMemberKeys: [],
      reusedRecordCount: Object.keys(validatedMaterial.bundle.records).length,
      createdRecordCount: 0,
      provenance: existingState.provenance,
    });
  }

  await ensureInstallationShapes({images, targetImageId});

  let preboundLocalRefs = {};
  let reusedMemberKeys = [];
  let reusedInstallations = [];
  if (reuseUnchangedMembers) {
    const candidateMembers = existingState.installation.members.map((m) => ({
      ...m,
      sourceProjectId: existingState.installation.projectId,
      sourceReleaseId: existingState.installation.releaseId,
    }));
    if (reuseAcrossInstallations && typeof images.listObjects === 'function') {
      const allInstallations = await listManagedProjectInstallations({images, targetImageId});
      for (const inst of allInstallations) {
        if (inst.projectId !== normalizedRelease.projectId) {
          for (const m of inst.members) {
            candidateMembers.push({
              ...m,
              sourceProjectId: inst.projectId,
              sourceReleaseId: inst.releaseId,
            });
          }
        }
      }
    }
    const discovered = await discoverReusableSubgraphBindings({
      images,
      desiredRelease: normalizedRelease,
      desiredBundle: validatedMaterial.bundle,
      candidateMembers,
      crypto,
    });
    preboundLocalRefs = discovered.preboundLocalRefs;
    reusedMemberKeys = discovered.reusedMemberKeys;
    reusedInstallations = discovered.reusedInstallations;
  }

  const plan = await prepareGraphBundleImport({
    images,
    targetImageId,
    bundle: validatedMaterial.bundle,
    expectedContentIdentity: validatedMaterial.contentIdentity,
    preboundLocalRefs,
    crypto,
  });

  const installation = createProjectInstallation({
    release: normalizedRelease,
    targetImageId,
    targets: plan.roots,
  });

  const totalBundleRecords = Object.keys(validatedMaterial.bundle.records).length;
  const reusedSet = new Set(reusedMemberKeys);
  const replacedMemberKeys = reconciliation.actions
    .filter((a) => (a.kind === 'replace' || a.kind === 'retain') && !reusedSet.has(a.key))
    .map((a) => a.key);
  const installedMemberKeys = reconciliation.actions
    .filter((a) => a.kind === 'install' && !reusedSet.has(a.key))
    .map((a) => a.key);
  const importedMemberKeys = [...replacedMemberKeys, ...installedMemberKeys].sort();
  const detachedMemberKeys = reconciliation.actions
    .filter((a) => a.kind === 'detach')
    .map((a) => a.key);
  const reusedRecordCount = totalBundleRecords - plan.recordInputs.length;
  const createdRecordCount = plan.recordInputs.length;

  const installationProvenance = deepFreeze({
    format: PROJECT_INSTALLATION_PROVENANCE_V1,
    operation: 'upgrade',
    projectId: normalizedRelease.projectId,
    targetImageId,
    previousReleaseId: existingState.installation.releaseId,
    fromReleaseId: existingState.installation.releaseId,
    toReleaseId: normalizedRelease.releaseId,
    sourceReleaseProvenance: provenance ? structuredClone(provenance) : null,
    reusedMemberKeys: [...reusedMemberKeys].sort(),
    replacedMemberKeys,
    installedMemberKeys,
    importedMemberKeys,
    detachedMemberKeys,
    reusedInstallations,
    reusedRecordCount,
    createdRecordCount,
  });

  const {memberRecords, snapshot, snapshotRef} = materializeInstallationSnapshotRecords({
    installation,
    provenance: installationProvenance,
    crypto,
  });

  // 1. Atomically publish any new graph records + the new installation member and snapshot records.
  // Until the deterministic head is updated below, these records are unreachable from the head.
  await images.createRecords(targetImageId, [...plan.recordInputs, ...memberRecords, snapshot]);

  // 2. Atomically advance the deterministic head via CAS at expectedVersion: existingState.headVersion.
  try {
    await images.putObject(
      targetImageId,
      {
        id: existingState.headId,
        shape: objectRef(targetImageId, PROJECT_INSTALLATION_HEAD_SHAPE_ID),
        behavior: null,
        slots: {
          'installation-project-id': textValue(normalizedRelease.projectId),
          'installation-snapshot': snapshotRef,
        },
      },
      {expectedVersion: existingState.headVersion},
    );
  } catch (error) {
    if (!(error instanceof VersionConflictError)) throw error;
    const winner = await readManagedProjectInstallationState({
      images,
      targetImageId,
      projectId: normalizedRelease.projectId,
    });
    if (winner && winner.installation.releaseId === normalizedRelease.releaseId) {
      return deepFreeze({
        installation: winner.installation,
        reconciliation,
        upgraded: false,
        previousReleaseId: existingState.installation.releaseId,
        reusedMemberKeys,
        replacedMemberKeys,
        installedMemberKeys,
        importedMemberKeys,
        detachedMemberKeys,
        reusedRecordCount,
        createdRecordCount,
        provenance: winner.provenance,
      });
    }
    throw new ManagedProjectInstallationConflictError({
      targetImageId,
      projectId: normalizedRelease.projectId,
      currentReleaseId: winner?.installation?.releaseId ?? existingState.installation.releaseId,
      desiredReleaseId: normalizedRelease.releaseId,
    });
  }

  return deepFreeze({
    installation,
    reconciliation,
    upgraded: true,
    previousReleaseId: existingState.installation.releaseId,
    reusedMemberKeys: [...reusedMemberKeys].sort(),
    replacedMemberKeys,
    installedMemberKeys,
    importedMemberKeys,
    detachedMemberKeys,
    reusedRecordCount,
    createdRecordCount,
    provenance: installationProvenance,
  });
}

async function authorizedUpgradeManagedProjectRelease({
  authority,
  authorityContext,
  images,
  targetImageId,
  release,
  material,
  expectedReleaseId = null,
  reuseUnchangedMembers = true,
  reuseAcrossInstallations = false,
  provenance = null,
  require,
  crypto,
} = {}) {
  requireImages(images);
  if (typeof images.putObject !== 'function') {
    throw new ManagedProjectInstallationError('images must provide putObject for authorizedUpgradeManagedProjectRelease');
  }
  requiredText(targetImageId, 'targetImageId');
  const normalizedRelease = normalizeProjectReleaseManifest(release);
  validateProjectReleaseMaterialForRelease({
    release: normalizedRelease,
    material,
    crypto,
  });

  const headResource = objectResource(targetImageId, installationHeadObjectId(normalizedRelease.projectId));
  if (typeof require === 'function') {
    if (require.length >= 2) {
      require(OBJECT_WRITE_OPERATION, headResource);
    } else {
      require({operation: OBJECT_WRITE_OPERATION, resource: headResource});
    }
  } else if (authority && typeof authority.require === 'function') {
    authority.require(authorityContext, {
      operation: OBJECT_WRITE_OPERATION,
      resource: headResource,
    });
  } else {
    throw new TypeError(
      'authorizedUpgradeManagedProjectRelease requires either a require function or {authority, authorityContext}',
    );
  }

  return await upgradeManagedProjectRelease({
    images,
    targetImageId,
    release: normalizedRelease,
    material,
    expectedReleaseId,
    reuseUnchangedMembers,
    reuseAcrossInstallations,
    provenance,
    crypto,
  });
}

export {
  ManagedProjectInstallationConflictError,
  ManagedProjectInstallationError,
  PROJECT_INSTALLATION_PROVENANCE_V1,
  authorizedUpgradeManagedProjectRelease,
  installManagedProjectRelease,
  upgradeManagedProjectRelease,
};
