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

## References and interfaces are not authority

A ref identifies an object or artifact. A callable interface describes how code may be invoked. Neither grants permission to use it.

```text
object ref != capability
implementation ref != capability
callable interface != capability
```

This matters for both image-native and foreign execution. A future capability-aware dispatcher/runtime must check authority independently of the durable ref/interface graph.

The first foreign-WASM ABI, `wasm-scalar-call/v0`, has zero WebAssembly imports. That is deliberately a zero-host-capability surface: it cannot acquire WASI, filesystem, network, callbacks or `ctx.call` through this contract. Any richer host surface requires a new explicit ABI plus capability policy.

## Capabilities

Object access and distributed execution fit naturally with capabilities:

```text
principal -> image capability -> object/project/callable capability -> allowed operations
```

A reference crossing an image or service boundary should not automatically carry every right held by the sender. Rights should be narrow, delegable where intended, and revocable at an authority layer.

This is especially important if remote message/call syntax becomes pleasantly similar to local invocation. Convenience must not erase the authority boundary.

## History

History and source objects can contain sensitive material. Authorization must apply to history, snapshots, debugger state and exports as well as current object state.

## Mock warning

The current HTTP scaffold has **no authentication**. It is a local development surface only. Do not expose it on an untrusted network.
