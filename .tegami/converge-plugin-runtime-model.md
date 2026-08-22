---
packages:
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

Update test hosts to return typed node-address handles and retain type inference without inventing a
runtime handle identity. Existing tests and host integrations must address fork nodes directly.

Unify graph-affecting browser control results around one address-only apply report. Fork creation and
dependency selection now commit atomically, while explicit fork removal rejects inbound references,
retains disabled intent after metadata failures, and never purges plugin business persistence.

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
