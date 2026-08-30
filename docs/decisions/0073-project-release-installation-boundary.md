# ADR 0073: Project release and installation boundary

Status: accepted — first semantic contract implemented in `src/project/model.js`; durable Project-object storage, bundle materialization and Git sync remain follow-up work

## Problem

The roadmap has deliberately kept Project semantics in Lagrange Images while moving Project UX to
Lagrange Object Environment. That ownership split is sound, but it leaves an important semantic gap:
what does it mean to deploy a Project, or part of one, **as** a new Image or **into** an existing
Image? The same gap blocks a precise answer for upgrades, Project export/import and live Git
projection.

A tempting answer is to blur Project and Image:

```text
Project ~= miniature Image ~= checkout ~= deployable unit
```

That would be wrong. An Image is a persistent live world with identity, state, execution and history.
A Project is semantic organization *inside and across* that world. Git is an external projection.
Deployment needs an immutable boundary between a changing Project and a target Image, not another
name for either endpoint.

This ADR also has to respect current substrate limits rather than designing against imaginary
features:

- ADR 0061 already decides that a Project may designate a namespace, but namespace nesting is
  visibility, **not Project containment**, and neither structure implies authority.
- ADR 0071 defines an Image frontier as a per-image history revision and states that a cross-image
  Project position is a **map `{imageId -> revision}`**, with no Project-level sequencing decision yet.
  Historical/as-of reads are not implemented.
- Generic graph export/import is still a roadmap item. There is no lossless portable graph bundle
  today.
- Record deletion/tombstone semantics are explicitly unresolved. An upgrade cannot honestly promise
  to delete an obsolete installed member.
- Project objects/relationships themselves remain planned ordinary image objects/refs. The current
  indexed mutation lane cannot yet express every future relationship edit, and this ADR must not
  invent a hidden JSON Project store to work around that.

The goal is therefore the smallest durable semantic boundary that later storage, bundle, installer
and Git work can consume without changing identity again.

## Fresh-review corrections to the initial proposal

The initial Image / Project / Release / Installation distinction survives review, with four important
corrections.

### 1. Release identity and source provenance are separate

A release assembled from equivalent Project content in two different development Images should have
the same semantic release identity. Source ObjectRefs and source frontier maps therefore **must not**
participate in release identity. They are provenance.

This follows the repository-wide rule `dependency != provenance`: release dependencies describe what
the release requires; provenance describes where this particular release materialization came from.

### 2. Project frontier is a map, never one number

ADR 0071 has already decided this. A source-provenance position is:

```text
{
  imageA: revisionA,
  imageB: revisionB,
  ...
}
```

There is no atomic cross-image capture primitive yet. V1 records the map as provenance but does not
claim that Lagrange can derive it atomically or read every member as-of that position. A future
Project commit/sequencing primitive may supply that guarantee without changing this manifest shape.

### 3. V1 deployment selection is explicit, not inferred

A `DeploymentProfile` is an explicit set of stable Project member keys. V1 does **not** infer
selection from roles, graph reachability, namespaces, ObjectRefs or language/package dependency
rules. Project relationship semantics are not implemented yet, so there is no evidence for one
universal closure rule.

A later profile producer may compute a closure from richer Project relationships, but the release
boundary still receives an explicit member set.

### 4. Upgrade detach is not delete

If member `X` existed in release R1 and is absent from R2, the v1 reconciliation action is `detach`:
the installation stops managing `X`. It does **not** delete the target object. Deletion/tombstone/GC
semantics are a separate unresolved graph concern (ADR 0071).

## Decision

### 1. Image, Project, release manifest and installation are distinct concepts

```text
Image
  persistent mutable live world

Project
  semantic organization of image-visible material
  has a portable semantic projectId
  members have stable Project-local keys

ProjectReleaseManifest
  immutable/content-addressed deployment intent for an explicit Project subset
  contains no source Image refs/frontiers

ProjectInstallation
  target-Image-specific record of which release is installed
  maps Project member keys -> concrete target ObjectRefs
```

A future **ProjectRelease** in the full transport sense is:

```text
ProjectReleaseManifest + portable member material/bundle
```

Only the manifest/identity half is implemented here because generic lossless graph export/import does
not yet exist.

### 2. Deploying "as an Image" means creating an Image and installing a release

No conversion exists from Project identity to Image identity.

```text
Project working state
      |
      v
release/profile
      |
      v
ProjectRelease
      |
      +---- install into existing Image
      |
      `---- create/fork suitable base Image -> install into it
```

Image clone/fork remains a different operation: it derives another live world, including whatever
state/history the clone contract preserves. Project deployment installs selected release material.

### 3. Project identity is semantic and portable; member identity is Project-local

`projectId` is an opaque non-empty semantic identity generated once and preserved across
export/import/installations. It is **not** an ObjectRef, Project name, namespace path or Git remote.
The first helper generates `project:<uuid>`, but the contract only requires opaque stable text.

Each direct Project member has:

```text
{ key, role, target }
```

- `key` — stable identity within this Project lineage; opaque text, **not a filesystem path**.
- `role` — language/tool policy text (`source`, `test`, `component`, `note`, etc.); the generic layer
  does not enumerate roles.
- `target` — current unpinned ObjectRef. It may point into another Image.

The same target may participate in several Projects or under several deliberate Project meanings.
A Project member key names the Project relationship, not the target object's global identity.

V1 membership is deliberately minimal. Typed Project-to-Project/member relationships remain roadmap
work and must not be guessed merely to make deployment profiles convenient.

### 4. A Project may span Images

Project membership may contain refs from several Images. This is consistent with the existing graph
and with ADR 0071's cross-image frontier analysis.

A designated namespace remains separate organization (ADR 0061). It is not automatically a release
member, dependency closure or deployment namespace. If deployable namespace/binding material is
needed, a concrete release producer must materialize it explicitly as release members.

### 5. DeploymentProfile v1 is an explicit key set

A profile is:

```text
{
  format: 'lagrange-project-deployment-profile/v1',
  projectId,
  profileId,
  members: [memberKey, ...]
}
```

Member keys are unique and canonicalized in lexical code-unit order. A profile must select existing
members of the named Project.

No v1 semantics for:

- role predicates
- implicit traversal of refs
- automatic package/runtime dependency closure
- "everything reachable"
- namespace containment

Those may become *profile-production policies* later. They do not change the explicit release
boundary.

### 6. ProjectReleaseManifest v1 is canonical and content-addressed

The manifest contains only portable deployment identity/intent:

```text
{
  format: 'lagrange-project-release-manifest/v1',
  projectId,
  profileId,
  releaseId: 'sha256:<canonical-manifest-body>',
  members: [
    {
      key,
      role,
      representation,
      contentIdentity
    }, ...
  ],
  dependencies: [
    { projectId, releaseId }, ...
  ]
}
```

`representation` and `contentIdentity` are supplied by the representation/materialization owner.
The generic Project layer does not pretend it can serialize every ordinary object graph today.
`contentIdentity` must denote immutable material according to that representation's contract; the
Project layer freezes *which identity was selected*, not the truth of an arbitrary external hash.

Members and dependencies are canonically ordered. `releaseId` is SHA-256 over the canonical body
(`projectId`, `profileId`, selected member material identities and release dependencies). Reordering
inputs, changing the Project display name or assembling the same semantic material from different
source Image refs does not change the release id. Changing selected material does.

A release must not directly depend on another release of the same Project in v1. Upgrade lineage is
represented by installations/reconciliation, not by making R2 depend on R1.

### 7. Release provenance is a separate record

Source provenance is:

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

The frontier map is canonicalized by Image id and revisions are canonical decimal strings. It must
cover at least every Image directly named by a selected member source. Extra frontiers are allowed
because a representation-specific materialization may depend on declared/transitive material beyond
its direct member root.

This record is **evidence/provenance**, not release identity and not a historical-read API. V1 does
not claim the source map was atomically captured. A producer is responsible for ensuring the
`contentIdentity` it emits corresponds to what it actually read. Future frontier-aware reads or a
Project commit primitive can strengthen that producer without changing release identity.

### 8. ProjectInstallation is target-specific state

After a materializer has created/resolved the selected members in target Image `T`, an installation
records:

```text
{
  format: 'lagrange-project-installation/v1',
  projectId,
  releaseId,
  targetImageId: T,
  members: [
    {
      key,
      representation,
      contentIdentity,
      target: ObjectRef(T, ...)
    }, ...
  ]
}
```

Every target ref must belong to the installation target Image. The installation maps portable
Project member identity onto target-local object identity. It is **not** a copy of the Project and
does not turn target ObjectRefs into Project identity.

Durable storage of the installation record as ordinary image objects remains follow-up work; this
ADR fixes its semantic shape first.

### 9. Upgrade is reconciliation from installed base to desired release

The implemented v1 planner is pure/effect-free:

```text
(current ProjectInstallation, next ProjectReleaseManifest)
       -> reconciliation actions
```

For each stable member key:

- absent -> present: `install`
- same representation + contentIdentity: `retain`
- present with changed material: `replace`
- present -> absent: `detach`

The planner does **not** mutate an Image, authorize anything, run migrations or decide a
representation-specific materialization strategy. It also cannot detect local drift merely from the
installation record: a future executor must compare the target's current managed state using the
representation-specific contract before replacing it.

This separation is intentional. A later deployment reconciler can be durable/idempotent and may use
a final installation-record switch as the visible commit point, but it must be designed against real
materializers and migration pressure.

### 10. Managed definitions and live state remain different deployment concerns

The generic release manifest does not claim that every Project member should be copied/replaced.
Typical future materializers may distinguish:

```text
immutable code/component/artifact   -> release-managed
configuration default               -> seed / explicit policy
persistent domain object            -> preserve live target state
schema evolution                    -> explicit migration
notes/tests                          -> excluded by runtime profile unless selected
```

Those policies belong to concrete Project relationships/profile production/materializers. Do not add
an enum to the generic Project model without a real deployment consumer proving the common cases.

### 11. Native export and Git projection sit above the same identities

The long-term layering is:

```text
Project / ProjectReleaseManifest
        |
        +-- lossless Project bundle / generic graph export-import   (future)
        |
        `-- Git/file projection                                     (future)
```

A native bundle is the lossless Lagrange transport needed to make a release self-contained. Git is
not that format and does not become Image storage.

Git projection should map stable Project member keys to paths through explicit projection metadata.
A path rename must not create a new Project member identity merely because a file moved.

Live Git synchronization should later use a sync anchor such as:

```text
{
  projectId,
  projectFrontierMap,
  gitCommit
}
```

and reconcile both sides from that common base. External file changes become candidate semantic
Project changes, not direct writes to an Image record. Provider-specific GitHub/GitLab/Codeberg APIs
sit above generic Git projection/sync semantics; credentials remain host/control-plane state, never
Project data.

### 12. Project/release/installation confer no authority

The existing invariant remains strict:

```text
Project membership != authority
DeploymentProfile   != authority
release manifest    != authority
installation        != authority
Git projection      != authority
```

Reading source material for release/export requires read authority. Installing/upgrading requires the
appropriate create/write/edge authority on the target. Migrations require their own execution
rights. Nothing in Project structure recursively widens authority.

## Implemented in this slice

`src/project/model.js` provides pure, host-independent contracts for:

- `createProjectDescriptor` / `normalizeProjectDescriptor`
- `createDeploymentProfile` / `selectProjectMembers`
- canonical content-addressed `createProjectReleaseManifest`
- separate `createProjectReleaseProvenance`
- `createProjectInstallation`
- effect-free `planProjectUpgrade`

The model is exported from the package (`lagrange-images/project` and the main runtime barrel).
Tests prove cross-Image membership, explicit subset selection, canonical release identity independent
of source refs/order/name, provenance separation/frontier maps, target-local installation mapping and
`install/retain/replace/detach` upgrade planning.

These descriptors are **not a shadow durable Project store**. The authoritative durable Project model
still belongs in ordinary Image objects/refs when implemented. This module fixes the semantic
contracts those objects/services must satisfy.

## Deferred by evidence, not by omission

- durable Project object/member/relationship Shapes and mutation service
- Project-level sequencing/commit semantics across several Image frontier axes
- revision-aware capture of release material at a historical frontier
- generic lossless graph bundle/export-import format
- representation-specific member materializers/installers
- durable/idempotent deployment reconciler and recovery protocol
- migration contracts and local-drift/conflict semantics
- target cleanup/deletion/GC after `detach`
- Git/file projection format and path mapping
- live bidirectional Git synchronization and provider adapters
- Project branch/diff/merge/conflict objects

Each has a stable boundary to attach to now; none is falsely claimed by this first slice.

## Consequences

- Project and Image no longer need to blur for deployment. A Project can be released and installed
  into zero, one or many Images while each target keeps its own object identity and live state.
- Deploying a Project "as an Image" is composition (`create/fork base Image -> install release`), not
  type conversion.
- Partial deployment is explicit and reproducible through stable member keys and a profile.
- Equivalent release content built from different development Images receives the same release id;
  source provenance remains available without contaminating semantic identity.
- Upgrade has a stable three-way-shaped base (`installed release`, `target mapping`, `desired
  release`) without pretending the pure planner can perform or authorize the effects.
- The absence of deletion semantics is reflected honestly as `detach`, leaving later GC/deletion work
  free to choose the right model.
- Git can later become a live interoperable projection without becoming the canonical ontology.

## Guardrails

```text
Image != Project. Image is the live world; Project is semantic organization.
Image fork/clone != Project deployment. Deploy-as-Image = create/fork base Image + install release.
projectId is semantic portable identity, never ObjectRef/name/namespace/path/Git remote.
member key is stable Project-local identity, never filesystem path; target ObjectRef is current
  working identity and may be cross-Image.
namespace visibility != Project membership != deployment closure != authority.
DeploymentProfile/v1 is an explicit member-key set. No inferred reachability/role/package closure.
release identity != release provenance. Source refs/frontiers never enter releaseId.
ProjectReleaseManifest/v1 is content-addressed semantic intent, NOT yet a self-contained graph bundle.
Project frontier provenance is {imageId -> revision}, never one scalar. V1 records but does not
  atomically capture/read that map.
ProjectInstallation maps member keys -> target-local refs; target refs never become Project identity.
upgrade planning is effect-free install/retain/replace/detach. detach != delete.
release/install/project membership confer no authority.
Git/file is a projection; never canonical Image/Project storage.
```
