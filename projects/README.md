# Pluxel Projects

`projects/` contains the maintainer applications and integration consumers that
currently evolve with this framework workspace.

| Project                                                    | Purpose                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`plugin-host`](plugin-host/README.md)                     | Native module delivery, Vite execution and HMR diagnostics.                  |
| `docs`                                                     | Documentation site built from the repository's `docs/` Markdown source.      |
| [`plugin-market`](plugin-market/README.md)                 | Plugin marketplace service and its Cloudflare Worker/D1 integration.         |
| [`typst-agent-workspace`](typst-agent-workspace/README.md) | Typst source editing, persistence and native-rendering integration consumer. |

Execution-environment experiments live in [Pluxel Lab](https://github.com/PluxelJS/lab),
with their own lockfile, CI and validation records. The former `embedded-launcher`
and `report-template-studio` projects are now
[QuickJS native](https://github.com/PluxelJS/lab/tree/main/experiments/quickjs-native)
and [Electron studio](https://github.com/PluxelJS/lab/tree/main/experiments/electron-studio).
Framework unit and compatibility fixtures remain with their owning packages.

Independent applications consume a framework checkout through
[`pluxel source`](../docs/development/source-workspaces.md). For a new application,
generate the canonical standalone monorepo:

```sh
pnpm create @pluxel my-workspace
```
