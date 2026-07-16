# @pluxel/runtime-dev

该包提供 route-neutral 的 Workbench UI source compiler。插件作者声明
`workbench.entry(import.meta.url, path)` 并通过 `ctx.workbench.mount()` 挂载 module；static/dynamic host 把
source compiler 直接绑定到 root Workbench artifact service。Workbench Plane 关闭时不创建 compiler 或 watcher。
compiler attachment 由本包统一安装并绑定到 Context effects；static/dynamic route 只提供 Vite server、
compiler config 和 enabled policy，不直接管理 compiler lifecycle。每个 runtime root 最多安装一个 compiler，
它直接绑定该 root 的 Workbench artifact service，不创建通用 Context capability adapter。

内部边界见 `docs/PLUGIN_SYSTEM.md`；作者用法见 `user-docs/plugin-authoring.md`。
