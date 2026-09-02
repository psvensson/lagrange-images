# ADR 0073: Project release and installation boundary

Status: accepted — first semantic contracts implemented in `src/project/model.js`; durable Project storage, materialization/deployment and Git sync remain follow-up work

## Problem

Project semantics belong in Lagrange Images because headless agents, tooling, deployment and
import/export need them independently of the Object Environment. The current ownership split is
sound, but it did not yet answer a concrete lifecycle question:

```text
What does it mean to deploy a Project, or part of one, as a new Image or into an existing Image?
```

The same missing boundary affects upgrades, native Project export/import and live Git projection.

A tempting answer is to collapse the concepts:

```text
Project ~= miniature Image ~= checkout ~= deployable unit
```

That is rejected. An Image is a persistent live world with identity, mutable state, execution and
history. A Project is semantic organization of image-visible material. Git is an external
projection. Deployment needs an immutable boundary between a changing Project and a target Image;
it is not another name for either endpoint.

This decision must also fit what exists today:

- ADR 0061: namespace parenting is visibility, not Project containment, and implies no authority.
- ADR 0071: an Image frontier is a per-image history position; a cross-image Project position is a
  **map `{imageId -> revision}`**, not one scalar. Historical/as-of reads and a Project-level
  sequencing primitive do not yet exist.
- Generic lossless graph export/import is still a roadmap item.
- Deletion/tombstone semantics are unresolved, so an upgrade cannot honestly promise to delete an
  obsolete target object.
- Durable Project objects/relationships are still planned ordinary image objects/refs. This ADR must
  not invent a hidden JSON Project store merely because that service is not built yet.

The goal is the smallest stable semantic boundary that later Project storage, bundle, installer and
Git work can consume without changing identity again.

## Fresh-review corrections to the initial proposal

### Release identity is separate from source provenance

Equivalent deployable content assembled from different development Images should have the same
release identity. Source ObjectRefs and source frontier maps therefore do not enter `releaseId`.
They are provenance. This follows the repository-wide `dependency != provenance` rule.

### Cross-image frontier is a map, never one number

V1 can record `{imageId -> revision}` provenance but cannot claim that Lagrange captured it atomically
or can reread every member as-of it. Future frontier-aware reads or Project sequencing may strengthen
the producer without changing the release format.

### DeploymentProfile v1 is explicit selection

V1 profiles select stable Project member keys. They do not infer role filters, namespace containment,
graph reachability, package dependencies or a universal closure rule before Project relationships
exist. Richer policy may later *produce* this explicit selection.

### Detach is not delete

When an installed member disappears from the desired release, v1 emits `detach`: the installation
stops managing the existing target. Target cleanup awaits explicit deletion/tombstone/GC semantics.

### Installation must preserve Project role

`role` is part of release semantics. A target installation therefore records it beside the material
identity. Otherwise an upgrade could silently `retain` identical bytes whose Project meaning changed
(for example `test` -> `runtime-component`). V1 treats role change as a reconciliation change.

## Decision

### Image, working Project, release manifest and installation are distinct

```text
Image
  persistent mutable live world

Project
  semantic organization of image-visible material
  portable semantic projectId
  stable Project-local member keys

ProjectReleaseManifest
  immutable/content-addressed deployment intent for an explicit Project subset
  no source Image refs/frontiers

ProjectInstallation
  target-Image-specific state for one installed release
  Project member key -> concrete target ObjectRef
```

A future fully transportable `ProjectRelease` is conceptually:

```text
ProjectReleaseManifest + portable member material/bundle
```

Only the manifest/identity half is implemented now because lossless graph bundle/export-import is not.

### Deploying "as an Image" is composition, not conversion

```text
working Project
    -> select profile
    -> make release
    -> either install into an existing Image
       or create/fork a suitable base Image and install into it
```

Image clone/fork remains a separate operation that derives another live world according to the Image
copy contract. A Project never becomes an Image by identity conversion.

### Project identity and member identity are semantic

`projectId` is opaque stable text generated once and preserved across export/import/installations. It
is not an ObjectRef, Project name, namespace path, Git path or remote. The helper currently generates
`project:<uuid>`; consumers must treat the text as opaque.

Each direct working Project member is:

```text
{ key, role, target }
```

- `key`: stable Project-local member identity; opaque text, not a filesystem path.
- `role`: language/tool policy text. The generic Project layer does not enumerate roles.
- `target`: current unpinned ObjectRef; it may point into another Image.

Member identity is the Project relationship, not the target object's global identity. Objects may
participate in several Projects. V1 deliberately does not invent richer relationship kinds yet.

### A Project may span Images

Direct member refs may name several Images. A Project's designated namespace remains independent
organization: it is not automatically membership, deployment closure or authority. If a deployment
needs namespace/binding material, a concrete producer must include it explicitly.

### DeploymentProfile/v1 is an explicit member-key set

```text
{
  format: 'lagrange-project-deployment-profile/v1',
  projectId,
  profileId,
  members: [memberKey, ...]
}
```

Keys are unique, canonicalized by host-independent code-unit ordering, and must exist in the named
Project. V1 has no implicit traversal or role/package/namespace closure semantics.

### ProjectReleaseManifest/v1 is canonical and content-addressed

```text
{
  format: 'lagrange-project-release-manifest/v1',
  projectId,
  profileId,
  releaseId: 'sha256:<canonical-body>',
  members: [
    { key, role, representation, contentIdentity }, ...
  ],
  dependencies: [
    { projectId, releaseId }, ...
  ]
}
```

`representation` and `contentIdentity` come from the materialization/representation owner. The
Project layer does not pretend it can serialize every ordinary object graph today. A
`contentIdentity` must denote immutable material according to that representation's contract; this
layer freezes which identity was selected, not the truth of an arbitrary external digest.

Members and dependencies are canonicalized using host-independent code-unit ordering. `releaseId` is
SHA-256 over canonical `projectId`, `profileId`, selected member semantics/material identities and
release dependencies. Project display name, working ObjectRefs, source Images and source frontiers do
not enter the hash. Changing a member role or material identity does.

A release cannot directly depend on another release of the same Project in v1. Upgrade lineage is
installation/reconciliation state, not a release dependency on its predecessor.

### Release provenance is separate data

```text
{
  format: 'lagrange-project-release-provenance/v1',
  projectId,
  releaseId,
  sourceFrontiers: {
    imageId: revision,
    ...
  },
  memberSources: [
    { key, source: ObjectRef }, ...
  ]
}
```

Revisions are canonical decimal strings and Image ids are canonicalized by code-unit order. The map
must cover every Image directly named by a selected member source; extra frontiers are permitted for
representation-specific transitive material.

This is evidence/provenance, not release identity and not an as-of read API. V1 does not claim atomic
cross-image capture. The producer remains responsible for matching each emitted `contentIdentity` to
what it actually read.

### ProjectInstallation/v1 is target-specific mapping state

After a materializer creates or resolves selected members in target Image `T`, the installation is:

```text
{
  format: 'lagrange-project-installation/v1',
  projectId,
  releaseId,
  targetImageId: T,
  members: [
    {
      key,
      role,
      representation,
      contentIdentity,
      target: ObjectRef(T, ...)
    }, ...
  ]
}
```

Every target ref belongs to `T`. The record maps portable Project member identity onto target-local
object identity. Target refs never become Project identity. Durable storage of this descriptor as
ordinary image objects was follow-up work and is now decided: ADR 0076 (stable head + immutable
snapshot + member records, committed atomically with the imported graph).

### Upgrade v1 is pure reconciliation planning

```text
(current ProjectInstallation, next ProjectReleaseManifest)
      -> reconciliation plan
```

Per stable member key:

- absent -> present: `install`
- same `role + representation + contentIdentity`: `retain`
- present with changed role or material: `replace`
- present -> absent: `detach`

The planner is effect-free. It does not mutate an Image, authorize operations, copy material, run
migrations or choose a representation-specific materializer. It also cannot detect local target
drift from the installation record alone. A future executor must compare the current managed target
through the representation-specific contract before replacing it.

A later deployment reconciler may be durable/idempotent and may use an installation-record switch as
a visible commit point, but that must be designed against real materializers and migration pressure.

### Managed definitions and live state remain different concerns

The generic manifest does not claim every selected thing should be copied/replaced identically.
Future producers/materializers may distinguish, for example:

```text
immutable code/component/artifact -> release-managed
configuration default             -> seed / explicit policy
persistent domain object          -> preserve target live state
schema evolution                  -> explicit migration
notes/tests                        -> selected only when the profile wants them
```

Do not add a generic enum for those cases until real deployment consumers prove a common contract.

### Native export and Git projection sit above the same identities

```text
Project / ProjectReleaseManifest
       |
       +-- lossless Project bundle / generic graph export-import   (future)
       |
       `-- Git/file projection                                     (future)
```

A native bundle is the lossless Lagrange transport that can eventually make a release self-contained.
Git is an interoperable projection, not Image storage and not the native release format.

Git projection should keep an explicit `memberKey <-> path` mapping, so moving a file does not change
Project member identity. Live sync should later use a common-base anchor, conceptually:

```text
{
  projectId,
  projectFrontierMap,
  gitCommit
}
```

and reconcile Image-side and Git-side changes from that base. External file changes become candidate
semantic Project changes, not direct writes to arbitrary image records. GitHub/GitLab/Codeberg
adapters and credentials sit above generic Git projection semantics; credentials never become
Project data.

### None of these structures confer authority

```text
Project membership != authority
DeploymentProfile   != authority
release manifest    != authority
installation        != authority
Git projection      != authority
```

Release/export reads require read authority. Installation/upgrade requires explicit target create,
write and edge authority. Migrations need their own execution rights. Project structure never widens
authority transitively.

## Implemented in this slice

`src/project/model.js` provides pure contracts for:

- `createProjectDescriptor` / `normalizeProjectDescriptor`
- `createDeploymentProfile` / `selectProjectMembers`
- canonical content-addressed `createProjectReleaseManifest`
- separate `createProjectReleaseProvenance`
- `createProjectInstallation`
- effect-free `planProjectUpgrade`

The module is exported as `lagrange-images/project` and from the main runtime barrel. Tests prove:

- cross-Image working membership and unique stable member keys
- explicit profile subset selection
- canonical release identity independent of source refs/order/display name
- release/provenance separation and cross-Image frontier maps
- target-local installation mappings
- `install/retain/replace/detach` upgrade planning
- member role survives installation and role-only change is not silently retained

These descriptors are **not** a shadow durable Project store. The authoritative working Project model
still belongs in ordinary image objects/refs when that service is implemented. This module fixes the
semantic contracts those objects/services must satisfy.

## Deferred by evidence

- durable Project object/member/relationship Shapes and mutation service
- Project-level sequencing/commit semantics across multiple Image frontier axes
- revision-aware capture at a historical frontier
- generic lossless graph bundle/export-import
- representation-specific member materializers/installers
- durable/idempotent deployment reconciler and recovery protocol
- migration contracts and local-drift/conflict semantics
- target cleanup/deletion/GC after `detach`
- Git/file projection format and stable path mapping
- live bidirectional Git sync and provider adapters
- Project branch/diff/merge/conflict objects

## Consequences

The Image/Project deployment boundary is now explicit without overclaiming execution support. A
Project can eventually be released and installed into zero, one or many Images while target Images
keep their own object identity and live state. Partial deployment has an explicit reproducible
selection. Equivalent content from different development Images shares release identity while source
provenance remains available. Upgrade has a stable reconciliation base without pretending that a pure
planner can copy, authorize or migrate anything. Git can later synchronize against the same semantic
identities without becoming the platform ontology.

## Guardrails

```text
Image != Project.
Image fork/clone != Project deployment.
Deploy-as-Image = create/fork suitable base Image + install release.
projectId is portable semantic identity, never ObjectRef/name/namespace/path/Git remote.
member key is Project-local semantic identity, never a filesystem path.
namespace visibility != Project membership != deployment closure != authority.
DeploymentProfile/v1 is explicit member-key selection; no inferred universal closure.
release identity != release provenance; source refs/frontiers never enter releaseId.
ProjectReleaseManifest/v1 is deployment intent, not yet a self-contained graph bundle.
Project frontier provenance is {imageId -> revision}; v1 records but cannot atomically capture/read it.
ProjectInstallation maps member keys -> target-local refs and preserves member role.
upgrade is effect-free install/retain/replace/detach; detach != delete.
Project/release/installation/Git projection confer no authority.
Git/file is projection, never canonical Image/Project storage.
```
