---
packages:
  '@pluxel/host': major
  '@pluxel/host-dev': major
  '@pluxel/host-dynamic': major
  '@pluxel/runtime': major
  '@pluxel/rolldown': major
  '@pluxel/create': major
  '@pluxel/cli': major
  '@pluxel/agent-tools': patch
---

## Compose applications around one Plugin Host

Introduce a Runtime-independent Host for catalog and lifecycle control, a shared development driver,
and optional dynamic file sources. Runtime applications use a plain default-exported object with
`plugins`, optional `sources`, `configure` and `prepare`; `satisfies RuntimeApplication` provides
TypeScript checking without a configuration marker helper. Dynamic source declarations perform no IO
until the Host opens their discovery session; source producers validate declared coverage before
creating resources.

## Unify development, builds and scaffolding

Use `runtime({ entry })` from `@pluxel/runtime/vite` for development and `application()` from
`@pluxel/rolldown/build` for production. Dynamic sources extend the same application declaration;
the official host and generated monorepo no longer have separate static/dynamic configurations.
Runtime-specific Workbench, Node artifacts and development console remain optional development
composition around the shared driver. Install `@pluxel/host-dev` as a development dependency when
using the Runtime Vite entry.

The CLI no longer maintains HMR discovery profiles or their TUI. Declare fixed plugins and optional
file/directory sources in the application itself; inspect a running application with `pluxel dev`.

## Restore official Workbench startup

Agent Tools projects its optional business fields and command variants into total portable Content
display values, so enabling Workbench no longer prevents the Plugin from starting.
