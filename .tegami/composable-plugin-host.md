---
packages:
  '@pluxel/host': major
  '@pluxel/host-dev': major
  '@pluxel/rolldown': major
  '@pluxel/create': major
  '@pluxel/cli': major
  '@pluxel/agent-tools': patch
  '@pluxel/services': major
---

## Compose applications around one Plugin Host

Host owns catalog and lifecycle control, with a shared development driver and optional dynamic file
sources. Applications default-export `defineHostApplication(startup => ({ ... }))`, declaring
`plugins`, optional `sources`, `services` and `prepare`. Dynamic declarations perform no IO until the
Host opens their discovery session; producers validate declared coverage before creating resources.

## Unify development, builds and scaffolding

Use `vitePreset({ entry })` from `@pluxel/services/vite` and `buildPreset()` from
`@pluxel/services/build` for the official service composition. Custom compositions use
`host({ entry })` from `@pluxel/host-dev/vite` and `pluxel()` from `@pluxel/rolldown`.
Both use the same Host application declaration, including dynamic sources. Workbench and Node artifact
attachments are installed only for selected services; the development console is explicitly enabled.

The CLI no longer maintains HMR discovery profiles or their TUI. Declare fixed plugins and optional
file/directory sources in the application itself; inspect a running application with `pluxel dev`.

## Restore official Workbench startup

Agent Tools projects its optional business fields and command variants into total portable Content
display values, so enabling Workbench no longer prevents the Plugin from starting.
