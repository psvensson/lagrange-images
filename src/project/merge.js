import {OBJECT_READ_OPERATION, objectResource} from '../authority/object-resource.js';
import {reconstructImageRecordsAtFrontier} from '../graph/diff.js';
import {mergeImageFrontiers} from '../graph/merge.js';
import {isObjectRef, objectRef} from '../value/index.js';
import {normalizeProjectDescriptor, normalizeProjectReleaseManifest} from './model.js';
import {PROJECT_SHAPE_ID, projectObjectId, readProjectDescriptor} from './working-state.js';

const PROJECT_DESCRIPTOR_MERGE_V1 = 'lagrange-project-descriptor-merge/v1';
const PROJECT_RELEASE_MERGE_V1 = 'lagrange-project-release-merge/v1';
const PROJECT_NONE_ID = 'lagrange-project/none/v1';

const PROJECT_MERGE_CONFLICT_KINDS = Object.freeze({
  PROJECT_ID_MISMATCH: 'project-id-mismatch',
  NAME_CONFLICT: 'name-conflict',
  NAMESPACE_CONFLICT: 'namespace-conflict',
  MEMBER_ADD_ADD_CONFLICT: 'member-add-add-conflict',
  MEMBER_DELETE_MODIFY_CONFLICT: 'member-delete-modify-conflict',
  MEMBER_MODIFY_CONFLICT: 'member-modify-conflict',
  PROFILE_CONFLICT: 'profile-conflict',
  DEPENDENCY_VERSION_CONFLICT: 'dependency-version-conflict',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-negative non-empty string`);
  }
  return value;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameRef(a, b, {ignoreImageId = false} = {}) {
  if (a === null && b === null) return true;
  if (!isObjectRef(a) || !isObjectRef(b)) return false;
  if (ignoreImageId) return a.objectId === b.objectId;
  return a.imageId === b.imageId && a.objectId === b.objectId;
}

function rehomeRef(ref, targetImageId) {
  if (!ref || !isObjectRef(ref) || !targetImageId) return ref;
  return objectRef(targetImageId, ref.objectId);
}

function rehomeMember(member, targetImageId) {
  if (!member || !targetImageId) return member;
  return Object.freeze({
    key: member.key,
    role: member.role,
    target: rehomeRef(member.target, targetImageId),
  });
}

function membersEqual(a, b, {ignoreImageId = false} = {}) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.role === b.role && sameRef(a.target, b.target, {ignoreImageId});
}

function mergeProjectDescriptors(
  baseProject,
  leftProject,
  rightProject,
  {targetImageId = null, ignoreImageId = false, resolutions = {}} = {},
) {
  const base = normalizeProjectDescriptor(baseProject);
  const left = normalizeProjectDescriptor(leftProject);
  const right = normalizeProjectDescriptor(rightProject);

  const conflicts = [];
  const nameResolution = resolutions?.name;
  const namespaceResolution = resolutions?.namespace;
  const memberResolutions = resolutions?.members ?? {};

  if (base.projectId !== left.projectId || base.projectId !== right.projectId) {
    conflicts.push(
      Object.freeze({
        conflictKind: PROJECT_MERGE_CONFLICT_KINDS.PROJECT_ID_MISMATCH,
        base: base.projectId,
        left: left.projectId,
        right: right.projectId,
      }),
    );
  }

  // 1. Three-way merge Project name
  let mergedName = base.name;
  if (left.name === base.name) {
    mergedName = right.name;
  } else if (right.name === base.name || left.name === right.name) {
    mergedName = left.name;
  } else if (nameResolution === 'left') {
    mergedName = left.name;
  } else if (nameResolution === 'right') {
    mergedName = right.name;
  } else if (typeof nameResolution === 'string' && nameResolution.length > 0) {
    mergedName = nameResolution;
  } else {
    conflicts.push(
      Object.freeze({
        conflictKind: PROJECT_MERGE_CONFLICT_KINDS.NAME_CONFLICT,
        base: base.name,
        left: left.name,
        right: right.name,
      }),
    );
  }

  // 2. Three-way merge Project namespace
  let mergedNamespace = rehomeRef(base.namespace, targetImageId);
  const leftNsUnchanged = sameRef(left.namespace, base.namespace, {ignoreImageId});
  const rightNsUnchanged = sameRef(right.namespace, base.namespace, {ignoreImageId});
  const leftNsEqualsRight = sameRef(left.namespace, right.namespace, {ignoreImageId});
  if (leftNsUnchanged) {
    mergedNamespace = rehomeRef(right.namespace, targetImageId);
  } else if (rightNsUnchanged || leftNsEqualsRight) {
    mergedNamespace = rehomeRef(left.namespace, targetImageId);
  } else if (namespaceResolution === 'left') {
    mergedNamespace = rehomeRef(left.namespace, targetImageId);
  } else if (namespaceResolution === 'right') {
    mergedNamespace = rehomeRef(right.namespace, targetImageId);
  } else {
    conflicts.push(
      Object.freeze({
        conflictKind: PROJECT_MERGE_CONFLICT_KINDS.NAMESPACE_CONFLICT,
        base: base.namespace,
        left: left.namespace,
        right: right.namespace,
      }),
    );
  }

  // 3. Three-way merge Project members by member.key
  const baseByKey = new Map(base.members.map((m) => [m.key, m]));
  const leftByKey = new Map(left.members.map((m) => [m.key, m]));
  const rightByKey = new Map(right.members.map((m) => [m.key, m]));
  const allKeys = [
    ...new Set([...baseByKey.keys(), ...leftByKey.keys(), ...rightByKey.keys()]),
  ].sort(compareText);

  const mergedMembers = [];
  const memberChanges = [];

  for (const key of allKeys) {
    const bMem = baseByKey.get(key) ?? null;
    const lMem = leftByKey.get(key) ?? null;
    const rMem = rightByKey.get(key) ?? null;
    const resolution = Object.hasOwn(memberResolutions, key) ? memberResolutions[key] : undefined;

    if (!bMem) {
      if (lMem && !rMem) {
        const m = rehomeMember(lMem, targetImageId);
        mergedMembers.push(m);
        memberChanges.push(Object.freeze({key, action: 'added-left', member: m}));
        continue;
      }
      if (!lMem && rMem) {
        const m = rehomeMember(rMem, targetImageId);
        mergedMembers.push(m);
        memberChanges.push(Object.freeze({key, action: 'added-right', member: m}));
        continue;
      }
      if (lMem && rMem) {
        if (membersEqual(lMem, rMem, {ignoreImageId})) {
          const m = rehomeMember(lMem, targetImageId);
          mergedMembers.push(m);
          memberChanges.push(Object.freeze({key, action: 'added-both', member: m}));
          continue;
        }
        if (resolution === 'left') {
          const m = rehomeMember(lMem, targetImageId);
          mergedMembers.push(m);
          memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: m}));
        } else if (resolution === 'right') {
          const m = rehomeMember(rMem, targetImageId);
          mergedMembers.push(m);
          memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: m}));
        } else {
          conflicts.push(
            Object.freeze({
              conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_ADD_ADD_CONFLICT,
              key,
              base: null,
              left: lMem,
              right: rMem,
            }),
          );
        }
      }
      continue;
    }

    if (!lMem && !rMem) {
      memberChanges.push(Object.freeze({key, action: 'removed-both', member: null}));
      continue;
    }

    if (!lMem && rMem) {
      if (membersEqual(rMem, bMem, {ignoreImageId})) {
        memberChanges.push(Object.freeze({key, action: 'removed-left', member: null}));
        continue;
      }
      if (resolution === 'left') {
        memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: null}));
      } else if (resolution === 'right') {
        const m = rehomeMember(rMem, targetImageId);
        mergedMembers.push(m);
        memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: m}));
      } else {
        conflicts.push(
          Object.freeze({
            conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_DELETE_MODIFY_CONFLICT,
            key,
            deletedSide: 'left',
            modifiedSide: 'right',
            base: bMem,
            left: null,
            right: rMem,
          }),
        );
        mergedMembers.push(rehomeMember(bMem, targetImageId));
      }
      continue;
    }

    if (lMem && !rMem) {
      if (membersEqual(lMem, bMem, {ignoreImageId})) {
        memberChanges.push(Object.freeze({key, action: 'removed-right', member: null}));
        continue;
      }
      if (resolution === 'right') {
        memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: null}));
      } else if (resolution === 'left') {
        const m = rehomeMember(lMem, targetImageId);
        mergedMembers.push(m);
        memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: m}));
      } else {
        conflicts.push(
          Object.freeze({
            conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_DELETE_MODIFY_CONFLICT,
            key,
            deletedSide: 'right',
            modifiedSide: 'left',
            base: bMem,
            left: lMem,
            right: null,
          }),
        );
        mergedMembers.push(rehomeMember(bMem, targetImageId));
      }
      continue;
    }

    // Present in base, left, and right
    const lUnchanged = membersEqual(lMem, bMem, {ignoreImageId});
    const rUnchanged = membersEqual(rMem, bMem, {ignoreImageId});
    const lrEqual = membersEqual(lMem, rMem, {ignoreImageId});

    if (lUnchanged && rUnchanged) {
      mergedMembers.push(rehomeMember(bMem, targetImageId));
      continue;
    }
    if (lUnchanged) {
      const m = rehomeMember(rMem, targetImageId);
      mergedMembers.push(m);
      memberChanges.push(Object.freeze({key, action: 'modified-right', member: m}));
      continue;
    }
    if (rUnchanged) {
      const m = rehomeMember(lMem, targetImageId);
      mergedMembers.push(m);
      memberChanges.push(Object.freeze({key, action: 'modified-left', member: m}));
      continue;
    }
    if (lrEqual) {
      const m = rehomeMember(lMem, targetImageId);
      mergedMembers.push(m);
      memberChanges.push(Object.freeze({key, action: 'modified-both-identical', member: m}));
      continue;
    }

    // Both modified: check if one side changed role and the other changed target
    const lRoleUnchanged = lMem.role === bMem.role;
    const rRoleUnchanged = rMem.role === bMem.role;
    const lrRoleSame = lMem.role === rMem.role;
    const roleConflict = !lRoleUnchanged && !rRoleUnchanged && !lrRoleSame;

    const lTargetUnchanged = sameRef(lMem.target, bMem.target, {ignoreImageId});
    const rTargetUnchanged = sameRef(rMem.target, bMem.target, {ignoreImageId});
    const lrTargetSame = sameRef(lMem.target, rMem.target, {ignoreImageId});
    const targetConflict = !lTargetUnchanged && !rTargetUnchanged && !lrTargetSame;

    if (!roleConflict && !targetConflict) {
      const mergedRole = lRoleUnchanged ? rMem.role : lMem.role;
      const mergedTarget = lTargetUnchanged ? rMem.target : lMem.target;
      const m = rehomeMember({key, role: mergedRole, target: mergedTarget}, targetImageId);
      mergedMembers.push(m);
      memberChanges.push(Object.freeze({key, action: 'merged-member', member: m}));
      continue;
    }

    if (resolution === 'left') {
      const m = rehomeMember(lMem, targetImageId);
      mergedMembers.push(m);
      memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: m}));
    } else if (resolution === 'right') {
      const m = rehomeMember(rMem, targetImageId);
      mergedMembers.push(m);
      memberChanges.push(Object.freeze({key, action: 'resolved-conflict', member: m}));
    } else {
      conflicts.push(
        Object.freeze({
          conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_MODIFY_CONFLICT,
          key,
          base: bMem,
          left: lMem,
          right: rMem,
          roleConflict,
          targetConflict,
        }),
      );
      mergedMembers.push(rehomeMember(bMem, targetImageId));
    }
  }

  const mergedDescriptor = normalizeProjectDescriptor({
    format: 'lagrange-project/v1',
    projectId: base.projectId,
    name: mergedName,
    namespace: mergedNamespace,
    members: mergedMembers,
  });

  return Object.freeze({
    format: PROJECT_DESCRIPTOR_MERGE_V1,
    projectId: base.projectId,
    clean: conflicts.length === 0,
    mergedDescriptor,
    memberChanges: Object.freeze(memberChanges),
    conflicts: Object.freeze(conflicts),
  });
}

function releaseMembersEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.role === b.role &&
    a.representation === b.representation &&
    a.contentIdentity === b.contentIdentity
  );
}

function mergeProjectReleases(baseRelease, leftRelease, rightRelease) {
  const base = normalizeProjectReleaseManifest(baseRelease);
  const left = normalizeProjectReleaseManifest(leftRelease);
  const right = normalizeProjectReleaseManifest(rightRelease);

  const conflicts = [];

  if (base.projectId !== left.projectId || base.projectId !== right.projectId) {
    conflicts.push(
      Object.freeze({
        conflictKind: PROJECT_MERGE_CONFLICT_KINDS.PROJECT_ID_MISMATCH,
        base: base.projectId,
        left: left.projectId,
        right: right.projectId,
      }),
    );
  }

  let mergedProfileId = base.profileId;
  if (left.profileId === base.profileId) {
    mergedProfileId = right.profileId;
  } else if (right.profileId === base.profileId || left.profileId === right.profileId) {
    mergedProfileId = left.profileId;
  } else {
    conflicts.push(
      Object.freeze({
        conflictKind: PROJECT_MERGE_CONFLICT_KINDS.PROFILE_CONFLICT,
        base: base.profileId,
        left: left.profileId,
        right: right.profileId,
      }),
    );
  }

  const baseByKey = new Map(base.members.map((m) => [m.key, m]));
  const leftByKey = new Map(left.members.map((m) => [m.key, m]));
  const rightByKey = new Map(right.members.map((m) => [m.key, m]));
  const allKeys = [
    ...new Set([...baseByKey.keys(), ...leftByKey.keys(), ...rightByKey.keys()]),
  ].sort(compareText);

  const mergedMembers = [];
  const memberChanges = [];

  for (const key of allKeys) {
    const bMem = baseByKey.get(key) ?? null;
    const lMem = leftByKey.get(key) ?? null;
    const rMem = rightByKey.get(key) ?? null;

    if (!bMem) {
      if (lMem && !rMem) {
        mergedMembers.push(lMem);
        memberChanges.push(Object.freeze({key, action: 'added-left', member: lMem}));
      } else if (!lMem && rMem) {
        mergedMembers.push(rMem);
        memberChanges.push(Object.freeze({key, action: 'added-right', member: rMem}));
      } else if (lMem && rMem) {
        if (releaseMembersEqual(lMem, rMem)) {
          mergedMembers.push(lMem);
          memberChanges.push(Object.freeze({key, action: 'added-both', member: lMem}));
        } else {
          conflicts.push(
            Object.freeze({
              conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_ADD_ADD_CONFLICT,
              key,
              base: null,
              left: lMem,
              right: rMem,
            }),
          );
        }
      }
      continue;
    }

    if (!lMem && !rMem) {
      memberChanges.push(Object.freeze({key, action: 'removed-both', member: null}));
      continue;
    }
    if (!lMem && rMem) {
      if (releaseMembersEqual(rMem, bMem)) {
        memberChanges.push(Object.freeze({key, action: 'removed-left', member: null}));
      } else {
        conflicts.push(
          Object.freeze({
            conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_DELETE_MODIFY_CONFLICT,
            key,
            deletedSide: 'left',
            modifiedSide: 'right',
            base: bMem,
            left: null,
            right: rMem,
          }),
        );
        mergedMembers.push(bMem);
      }
      continue;
    }
    if (lMem && !rMem) {
      if (releaseMembersEqual(lMem, bMem)) {
        memberChanges.push(Object.freeze({key, action: 'removed-right', member: null}));
      } else {
        conflicts.push(
          Object.freeze({
            conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_DELETE_MODIFY_CONFLICT,
            key,
            deletedSide: 'right',
            modifiedSide: 'left',
            base: bMem,
            left: lMem,
            right: null,
          }),
        );
        mergedMembers.push(bMem);
      }
      continue;
    }

    const lUnchanged = releaseMembersEqual(lMem, bMem);
    const rUnchanged = releaseMembersEqual(rMem, bMem);
    const lrEqual = releaseMembersEqual(lMem, rMem);

    if (lUnchanged && rUnchanged) {
      mergedMembers.push(bMem);
    } else if (lUnchanged) {
      mergedMembers.push(rMem);
      memberChanges.push(Object.freeze({key, action: 'modified-right', member: rMem}));
    } else if (rUnchanged) {
      mergedMembers.push(lMem);
      memberChanges.push(Object.freeze({key, action: 'modified-left', member: lMem}));
    } else if (lrEqual) {
      mergedMembers.push(lMem);
      memberChanges.push(Object.freeze({key, action: 'modified-both-identical', member: lMem}));
    } else {
      conflicts.push(
        Object.freeze({
          conflictKind: PROJECT_MERGE_CONFLICT_KINDS.MEMBER_MODIFY_CONFLICT,
          key,
          base: bMem,
          left: lMem,
          right: rMem,
        }),
      );
      mergedMembers.push(bMem);
    }
  }

  // Merge dependencies by projectId
  const baseDeps = new Map(base.dependencies.map((d) => [d.projectId, d]));
  const leftDeps = new Map(left.dependencies.map((d) => [d.projectId, d]));
  const rightDeps = new Map(right.dependencies.map((d) => [d.projectId, d]));
  const allDepProjects = [
    ...new Set([...baseDeps.keys(), ...leftDeps.keys(), ...rightDeps.keys()]),
  ].sort(compareText);

  const mergedDependencies = [];
  const dependencyChanges = [];

  for (const depProjectId of allDepProjects) {
    const bDep = baseDeps.get(depProjectId) ?? null;
    const lDep = leftDeps.get(depProjectId) ?? null;
    const rDep = rightDeps.get(depProjectId) ?? null;

    if (!bDep) {
      if (lDep && !rDep) {
        mergedDependencies.push(lDep);
        dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'added-left', dependency: lDep}));
      } else if (!lDep && rDep) {
        mergedDependencies.push(rDep);
        dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'added-right', dependency: rDep}));
      } else if (lDep && rDep) {
        if (lDep.releaseId === rDep.releaseId) {
          mergedDependencies.push(lDep);
          dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'added-both', dependency: lDep}));
        } else {
          conflicts.push(
            Object.freeze({
              conflictKind: PROJECT_MERGE_CONFLICT_KINDS.DEPENDENCY_VERSION_CONFLICT,
              projectId: depProjectId,
              base: null,
              left: lDep,
              right: rDep,
            }),
          );
        }
      }
      continue;
    }

    if (!lDep && !rDep) {
      dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'removed-both', dependency: null}));
      continue;
    }
    if (!lDep && rDep) {
      if (rDep.releaseId === bDep.releaseId) {
        dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'removed-left', dependency: null}));
      } else {
        conflicts.push(
          Object.freeze({
            conflictKind: PROJECT_MERGE_CONFLICT_KINDS.DEPENDENCY_VERSION_CONFLICT,
            projectId: depProjectId,
            base: bDep,
            left: null,
            right: rDep,
          }),
        );
        mergedDependencies.push(bDep);
      }
      continue;
    }
    if (lDep && !rDep) {
      if (lDep.releaseId === bDep.releaseId) {
        dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'removed-right', dependency: null}));
      } else {
        conflicts.push(
          Object.freeze({
            conflictKind: PROJECT_MERGE_CONFLICT_KINDS.DEPENDENCY_VERSION_CONFLICT,
            projectId: depProjectId,
            base: bDep,
            left: lDep,
            right: null,
          }),
        );
        mergedDependencies.push(bDep);
      }
      continue;
    }

    if (lDep.releaseId === bDep.releaseId && rDep.releaseId === bDep.releaseId) {
      mergedDependencies.push(bDep);
    } else if (lDep.releaseId === bDep.releaseId) {
      mergedDependencies.push(rDep);
      dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'modified-right', dependency: rDep}));
    } else if (rDep.releaseId === bDep.releaseId || lDep.releaseId === rDep.releaseId) {
      mergedDependencies.push(lDep);
      dependencyChanges.push(Object.freeze({projectId: depProjectId, action: 'modified-left', dependency: lDep}));
    } else {
      conflicts.push(
        Object.freeze({
          conflictKind: PROJECT_MERGE_CONFLICT_KINDS.DEPENDENCY_VERSION_CONFLICT,
          projectId: depProjectId,
          base: bDep,
          left: lDep,
          right: rDep,
        }),
      );
      mergedDependencies.push(bDep);
    }
  }

  return Object.freeze({
    format: PROJECT_RELEASE_MERGE_V1,
    projectId: base.projectId,
    mergedProfileId,
    clean: conflicts.length === 0,
    mergedMembers: Object.freeze(mergedMembers),
    mergedDependencies: Object.freeze(mergedDependencies),
    memberChanges: Object.freeze(memberChanges),
    dependencyChanges: Object.freeze(dependencyChanges),
    conflicts: Object.freeze(conflicts),
  });
}

function assembleProjectDescriptorFromRecords(records, projectId) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const idRef = projectObjectId(projectId);
  const project = byId.get(idRef);
  if (
    !project ||
    project.kind !== 'object' ||
    !isObjectRef(project.shape) ||
    project.shape.objectId !== PROJECT_SHAPE_ID ||
    project.slots?.['project-id']?.value !== projectId
  ) {
    throw new TypeError(`durable Project not found at requested frontier: ${idRef}`);
  }
  const memberRefs = Array.isArray(project.indexed) ? project.indexed : [];
  const members = [];
  for (const ref of memberRefs) {
    const member = byId.get(ref.objectId);
    if (!member) {
      throw new TypeError(`durable Project member not found at requested frontier: ${ref.objectId}`);
    }
    members.push({
      key: member.slots['project-member-key'].value,
      role: member.slots['project-member-role'].value,
      target: member.slots['project-member-target'],
    });
  }
  const namespace = project.slots['project-namespace'];
  return normalizeProjectDescriptor({
    format: 'lagrange-project/v1',
    projectId: project.slots['project-id'].value,
    name: project.slots['project-name'].value,
    namespace: isObjectRef(namespace) && namespace.objectId !== PROJECT_NONE_ID ? namespace : null,
    members,
  });
}

async function mergeProjectAtFrontiers({
  images,
  imageId,
  projectId,
  baseFrontier,
  leftFrontier,
  rightFrontier,
  resolutions = {},
} = {}) {
  requiredText(imageId, 'imageId');
  requiredText(projectId, 'projectId');
  const [baseRecords, leftRecords, rightRecords] = await Promise.all([
    reconstructImageRecordsAtFrontier({images, imageId, frontier: baseFrontier}),
    reconstructImageRecordsAtFrontier({images, imageId, frontier: leftFrontier}),
    reconstructImageRecordsAtFrontier({images, imageId, frontier: rightFrontier}),
  ]);
  const baseDescriptor = assembleProjectDescriptorFromRecords(baseRecords, projectId);
  const leftDescriptor = assembleProjectDescriptorFromRecords(leftRecords, projectId);
  const rightDescriptor = assembleProjectDescriptorFromRecords(rightRecords, projectId);

  const projectMerge = mergeProjectDescriptors(baseDescriptor, leftDescriptor, rightDescriptor, {
    targetImageId: imageId,
    resolutions: resolutions?.project ?? {},
  });
  const frontierMerge = await mergeImageFrontiers({
    images,
    imageId,
    baseFrontier,
    leftFrontier,
    rightFrontier,
    resolutions: resolutions?.records ?? {},
  });

  return Object.freeze({
    projectMerge,
    frontierMerge,
  });
}

async function authorizedMergeProjects({
  images,
  baseImageId,
  baseProjectId,
  leftImageId = baseImageId,
  leftProjectId = baseProjectId,
  rightImageId = baseImageId,
  rightProjectId = baseProjectId,
  targetImageId = baseImageId,
  resolutions = {},
  require,
} = {}) {
  requiredText(baseImageId, 'baseImageId');
  requiredText(baseProjectId, 'baseProjectId');
  requiredText(leftImageId, 'leftImageId');
  requiredText(leftProjectId, 'leftProjectId');
  requiredText(rightImageId, 'rightImageId');
  requiredText(rightProjectId, 'rightProjectId');
  if (typeof require !== 'function') {
    throw new TypeError('authorizedMergeProjects requires a require(demand) authority-check function');
  }

  const rawResources = [
    objectResource(baseImageId, projectObjectId(baseProjectId)),
    objectResource(leftImageId, projectObjectId(leftProjectId)),
    objectResource(rightImageId, projectObjectId(rightProjectId)),
  ];
  const uniqueByKey = new Map();
  for (const res of rawResources) {
    uniqueByKey.set(`${res.imageId}\u0000${res.objectId}`, res);
  }
  const orderedResources = [...uniqueByKey.values()].sort(
    (a, b) => compareText(a.imageId, b.imageId) || compareText(a.objectId, b.objectId),
  );
  for (const resource of orderedResources) {
    require({operation: OBJECT_READ_OPERATION, resource});
  }

  const [baseDescriptor, leftDescriptor, rightDescriptor] = await Promise.all([
    readProjectDescriptor({images, imageId: baseImageId, projectId: baseProjectId}),
    readProjectDescriptor({images, imageId: leftImageId, projectId: leftProjectId}),
    readProjectDescriptor({images, imageId: rightImageId, projectId: rightProjectId}),
  ]);

  const crossImage = baseImageId !== leftImageId || baseImageId !== rightImageId;
  return mergeProjectDescriptors(baseDescriptor, leftDescriptor, rightDescriptor, {
    targetImageId,
    ignoreImageId: crossImage,
    resolutions,
  });
}

export {
  PROJECT_DESCRIPTOR_MERGE_V1,
  PROJECT_MERGE_CONFLICT_KINDS,
  PROJECT_RELEASE_MERGE_V1,
  authorizedMergeProjects,
  mergeProjectAtFrontiers,
  mergeProjectDescriptors,
  mergeProjectReleases,
};
