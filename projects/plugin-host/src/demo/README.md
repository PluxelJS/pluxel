# Host demos

- `PluginCompositionConfigDemo`：一个 Plugin 一次声明完整 object schema，并用嵌套字段组织内部模块配置。
- `PluginOptionalIntegrationDemo`：module-level `definePluginRef<T>()`、init-time `plugins.use(ref, setup)` 与 owner cleanup。
- `PluginEventsDemo`：producer-owned `EvtChannel`，consumer 通过 constructor required dependency 订阅。
- `PluginWithUI`：完整 Workbench extension、API、collection、stream、route 和 remote views。
- `PluginContributionFontDemo`：consumer-owned port placement + provider renderer，演示同一配置 UI 注入多个 dependents。
- `PluginHttpRoutesDemo`：常驻业务 HTTP + 可选说明文档。
- `PluginHttpWorkerDemo`：typed task + root shared worker pool + HMR/static artifact；Workbench 只负责展示说明。

所有管理资源通过 `ctx.workbench.mount(...)` 创建并绑定 owner effects。关闭 Workbench Plane 时 mount
返回 `undefined` 且不注册资源，HTTP 和插件核心逻辑仍然工作。
