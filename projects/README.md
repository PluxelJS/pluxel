# Pluxel Projects

`projects/` contains the maintainer applications and integration consumers that
currently evolve with this framework workspace.

| Project                                                    | Purpose                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`plugin-host`](plugin-host/README.md)                     | Native module delivery, Vite execution and HMR diagnostics.                  |
| `docs`                                                     | Documentation site built from the repository's `docs/` Markdown source.      |
| [`plugin-market`](plugin-market/README.md)                 | Plugin marketplace service and its Cloudflare Worker/D1 integration.         |
| [`typst-agent-workspace`](typst-agent-workspace/README.md) | Typst source editing, persistence and native-rendering integration consumer. |

## Cross-platform host examples

| To exercise a platform feature                                                                                   | Run this project                                     |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Enable built-in rules, edit their settings and reopen a browser extension with the saved choices                 | [WXT link cleaner](host-wxt/README.md)               |
| Load one published plugin package in Node, a Chromium Dedicated Worker and workerd, then edit the plugin in Vite | [Three-target build and HMR](host-targets/README.md) |
| Lend native Electron app information to a main-process plugin and display its result in a sandboxed window       | [Electron](host-electron/README.md)                  |
| Install a separate JS plugin and call Rust from a new QuickJS VM in the same process                             | [Rust / LLRT](host-llrt/README.md)                   |
| Install a separate JS file from an Android file picker and call the device locale service after reloading Hermes | [Expo / React Native](host-expo/README.md)           |

Electron, LLRT and Expo also run capability checks from the shared plugin package. [Shared checks](host-targets/plugins/src/probe.ts) · [Host entry points and storage](../docs/host/runtime-portability.md)

Scenario-based experiments, including the desktop launcher and report editor, live in [Pluxel Lab](https://github.com/PluxelJS/lab).

Independent applications consume a framework checkout through
[`pluxel source`](../docs/development/source-workspaces.md). For a new application,
generate the canonical standalone monorepo:

```sh
vp create @pluxel my-workspace
```
