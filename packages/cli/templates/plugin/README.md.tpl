# {{packageName}}

{{description}}

Before changing plugin code or package/build configuration, consult the documentation matching the
installed Pluxel version. Run `vp exec pluxel docs` for the canonical upstream documentation entry;
keep this package README focused on its own contract instead of copying framework documentation.

## Install

```sh
vp add {{packageName}} @pluxel/core
```

Import the root named Plugin export into a static catalog or expose the same package root through a
dynamic catalog/source producer. Both routes use the same lowered definition address;
class/display name is not identity.

```ts
import { {{className}}Plugin } from '{{packageName}}'

export const plugins = [{{className}}Plugin]
```

Coding agents: read [AGENTS.md](./AGENTS.md), then use the
[pluxel-development skill](.agents/skills/pluxel-development/SKILL.md), available after workspace setup.
The skill routes development, service diagnostics and live operations to the relevant tools and documentation.

## Develop

Prepare the global Vite+ CLI, Node.js 24+ and hk as described in the
[workspace guide](https://github.com/PluxelJS/pluxel/blob/main/docs/development/workspace-toolchain.md).
This plugin follows the same `vp` commands as Pluxel application starters. Vite+ reads
`packageManager` to select and install the pinned package manager; `mise.toml` offers
optional pinned tool installation.

```sh
vp install
vp run setup
# Once the project is a Git repository:
vp run hooks:install
vp run verify
```

`verify` checks Oxfmt, Oxlint with the Pluxel rule plugin, unused lint suppressions, types, tests, and
the production plugin build. Core is a peer dependency; build and test tooling stays in
development dependencies. `pnpm-workspace.yaml` owns their shared compatible ranges through the
catalog and explicitly allows the esbuild install script required by the toolchain.

This standalone plugin has no development service. For live operations, use the consuming application’s `pluxel.dev` configuration with `vp exec pluxel dev status/run --root <app-project>` and use `--profile <name>` to override its default (or to resolve several profiles without a default). Use `--instance <id>` when several live instances match that profile; the console does not require Pitchfork. The development skill explains when to use the application console instead of isolated plugin tests, and how to pause and apply HMR batches while editing a running consumer.
