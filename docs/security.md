# Security boundary

An image contains program state. It should not contain the authority to administer the cluster that happens to store it.

## Keep these separate

Cluster/service configuration belongs outside images:

- Lagrange node and cluster credentials
- TLS keys and trust roots
- external identity provider configuration
- SSO / OIDC setup
- operator/admin policy
- placement and resource policy
- secrets used to reach external systems

Images may contain *references* to named resources or capabilities, but not the master credentials that mint them.

## Principals

The service should eventually accept principals from both:

- external SSO/OIDC providers
- a locally provided identity system, for example Keycloak

The image layer should see a normalized principal/capability model rather than know which IdP authenticated somebody.

## Capabilities

Object access and distributed execution fit naturally with capabilities:

```text
principal -> image capability -> object/project capability -> allowed operations
```

A reference crossing an image or service boundary should not automatically carry every right held by the sender. Rights should be narrow, delegable where intended, and revocable at an authority layer.

This is especially important if remote message syntax becomes pleasantly similar to local sends. Convenience must not erase the authority boundary.

## History

History and source objects can contain sensitive material. Authorization must apply to history, snapshots, debugger state and exports as well as current object state.

## Mock warning

The current HTTP scaffold has **no authentication**. It is a local development surface only. Do not expose it on an untrusted network.
