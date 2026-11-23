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

The examples run the same compiled `Provider`, `Consumer` and `HostCapabilities` plugins. The application owns the Host and installs any native service. The platform plugin borrows that service with `ctx.service(...)`. [Shared plugin source](host-targets/plugins/src/index.ts) · [Shared checks](host-targets/plugins/src/probe.ts)

| Project                                                | What runs there                                                                   | Platform-specific check                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Node, browser and Cloudflare](host-targets/README.md) | One plugin tarball in Node, a Chromium Dedicated Worker and workerd               | Exercise each transport, check Worker storage limits and reload the plugin graph during development |
| [LLRT](host-llrt/README.md)                            | A Rust executable embeds QuickJS via LLRT and drives its event loop               | Install a separately built JS plugin, call Rust and reload fresh VMs in the same process            |
| [Electron](host-electron/README.md)                    | The Electron main process runs the Node Host and displays its receipt in a window | Read the native application name and version through a desktop service                              |
| [Expo / React Native](host-expo/README.md)             | A React Native app runs the embedded Host in Hermes                               | Install a separate JS file in an Android release, reload Hermes and read Expo language tags         |

Use Node and Vite in the three-target project to edit the shared plugins with HMR. Use the LLRT and Expo projects to exercise installation, offline startup and removal on the target engine. Start with the target README when copying an app. Change a common assertion in `host-targets/plugins/src/probe.ts` once, rebuild the shared package, then rerun each target. Change a native adapter or its plugin in the target directory. The Expo project has its own lockfile for the Expo SDK, React and React Native, and links the same local framework and plugin builds. [Host runtime requirements](../docs/host/runtime-portability.md)

For a standalone copy, use the framework packages and the shared plugin tarball from the same release or checkout. If the checkout contains unpublished changes, pack those local builds as well. For Electron or LLRT, use the checkout’s `packageManager` version and resolve the app’s `catalog:` dependencies to the versions in the workspace. The LLRT build uses esbuild’s platform package. In a fresh pnpm workspace, set `allowBuilds.esbuild: false` to use it with the same install policy as this checkout. [Toolchain](../package.json) · [Dependency versions and install policy](../pnpm-workspace.yaml)

Scenario-based experiments, including the desktop launcher and report editor, live in [Pluxel Lab](https://github.com/PluxelJS/lab).

Independent applications consume a framework checkout through
[`pluxel source`](../docs/development/source-workspaces.md). For a new application,
generate the canonical standalone monorepo:

```sh
vp create @pluxel my-workspace
```
