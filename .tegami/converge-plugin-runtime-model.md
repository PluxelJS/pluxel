---
packages:
  '@pluxel/context':
    type: major
  '@pluxel/core':
    type: major
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/test':
    type: major
  '@pluxel/wretch':
    type: patch
  valibot-form:
    type: major
---

## Converge Plugin definitions, nodes, and generations

Replace constructor-shaped forks with concrete definition records, explicit default/fork node
addresses, and isolated lifecycle generations. Forkability is now an immutable concrete definition
fact declared with `@Plugin({ forkable: true })`; `ForkablePlugin`, synthetic subclasses, metadata
cloning, `provideBase`, and constructor-based fork APIs are removed.

Make static and dynamic hosts share one catalog plus RuntimeState reconciler, apply definition-wide
replacement atomically, and preserve explicit provider and dependency policy as durable desired state.
Generated metadata now uses a versioned toolchain-only ABI, while the default package entries expose
only the supported Plugin author surface.

Remove the legacy reflection metadata bootstrap from Core; Plugin dependency injection now consumes
only lowered declaration facts and no longer installs a global `Reflect` polyfill. Remove the
`@pluxel/rolldown` root and `./workspace` umbrella exports; tooling consumers must import the explicit
capability subpath they use.

Publish `@pluxel/context` as a host-neutral immutable Context kernel with explicit root, scope, and
owner-view capabilities, strict lazy construction, inferred host projections, and constrained
pre-root overrides. The kernel has no prepare, dispose, IO, Plugin, or Runtime lifecycle contract;
Core maps scopes to Plugin generations and caller ownership, while Runtime performs its own explicit
service preparation before Plugin startup. Core consumes the package as a workspace development
dependency and completely inlines its JavaScript and declarations, so published Core artifacts have
no production dependency on `@pluxel/context`.

Remove global service registration, Context service decorators, mutable `Context.config`, legacy
mutable Runtime Context overrides, and compatibility aliases. Static, dynamic, and test hosts capture resolved immutable
inputs before root creation; standalone hosts may compose their own shape, but Plugins cannot add to or mutate the Runtime
Context.

Separate the runtime management plane from the optional Workbench extension plane. Publish one
framework-neutral browser contract/client for management snapshots and mutations, make the official
Workbench consume that same path, and keep its not-yet-standardized View-host session transport behind
an explicit internal entry and physical module boundary. Management connection options no longer carry
SSE/session fields or the legacy `adminAccess.enabled` shape. Level 1 discovery reports only whether
Workbench is enabled; renderer, catalog and session facts remain outside the Management protocol until
the View-host ABI is standardized. Remove the internal GraphQL endpoint,
GQLens code-generation stack, workspace submodule, generated clients, and duplicated GraphQL read
model.
Headless hosts can explicitly enable management without creating layout, artifact, grant, remote-view,
or UI routing state; omitting both planes has zero management/Workbench backend cost.
`management.pluginGroups` remains the host-owned Plugin classification contract. Management access
is determined by physical-peer recovery and the unique committed, running authentication provider;
there is no `management.access` configuration. Workbench configuration only owns its UI plane, while
the neutral catalog layout service and persistence namespace belong to management.

Project unsupported config field structures as explicit read-only presentation nodes and remove the
fallback renderer that accepted unknown structures without an honest editing contract.

Update test hosts to return typed node-address handles and retain type inference without inventing a
runtime handle identity. Existing tests and host integrations must address fork nodes directly.

Unify graph-affecting browser control results around one address-only apply report. Fork creation and
dependency selection now commit atomically, while explicit fork removal rejects inbound references,
retains disabled intent after metadata failures, and never purges plugin business persistence.
Dependency inspection and override mutation identify constructor requirements by stable definition
address rather than parameter position.

Make config mutation authority transactional: validate once, stage one immutable normalized tree,
flush persistence, then confirm its revision before Core can apply it. Schema output must be a
portable plain object/array tree. Config queries still return defaults; mutation results return the
persisted value and apply report without duplicating defaults.

Make the Redis and S3 abstract bases ordinary capability tokens, with fork support declared only by
the concrete official providers. This removes inherited fork authority and lets every alternate
provider decide independently whether multiple governed nodes are safe.

Close cached Cache and Rates handles synchronously with both the caller and provider generation so
withdrawn handles retain their package-specific stopped-error contracts instead of leaking a generic
stale-facade failure.

Pin Wretch clients and managed-settings handles to their caller and provider generations so cached
clients fail with the documented stopped-client contract after either owner is withdrawn.
