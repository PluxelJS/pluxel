# Host demos

- `PluginWithUI`：完整 Workbench extension、API、collection、stream、route 和 remote views。
- `PluginContributionFontDemo`：consumer-owned port placement + provider renderer，演示同一配置 UI 注入多个 dependents。
- `PluginHttpRoutesDemo`：常驻业务 HTTP + 可选说明文档。
- `PluginHttpWorkerDemo`：typed task + root shared worker pool + HMR/static artifact；Workbench 只负责展示说明。

所有管理资源通过 `ctx.workbench.mount(...)` 创建并绑定 owner effects。关闭 Workbench Plane 时 mount
返回 `undefined` 且不注册资源，HTTP 和插件核心逻辑仍然工作。
