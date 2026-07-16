# @pluxel/runtime-dev

该包提供 route-neutral 的 Workbench UI source compiler。插件作者声明
`workbench.entry(import.meta.url, path)` 并通过 `ctx.workbench.mount()` 挂载 module；static/dynamic host 通过 `workbenchUiSource` capability 把 source
declaration 绑定到 compiler。Workbench Plane 关闭时不创建 compiler 或 watcher。
compiler attachment 由本包统一安装并绑定到 Context effects；static/dynamic route 只提供 Vite server、
compiler config 和 enabled policy，不直接管理 compiler lifecycle。

内部边界见 `docs/PLUGIN_SYSTEM.md`；作者用法见 `user-docs/plugin-authoring.md`。
