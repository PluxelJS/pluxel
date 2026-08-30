# Host demos

- `PluginCompositionConfigDemo`：一个 Plugin 一次声明完整 object schema，并用嵌套字段组织内部模块配置。
- `PluginOptionalIntegrationDemo`：module-level `definePluginRef<T>()`、init-time `plugins.use(ref, setup)` 与 owner cleanup。
- `PluginEventsDemo`：producer-owned `EvtChannel`，consumer 通过 constructor required dependency 订阅。
- `PluginWithUI`：direct View API、Plugin-owned observer、tab、route 与 MF2 React Bridge。
- `PluginContributionFontDemo`：provider-owned Attachment + consumer-owned selection，演示 manager 被依赖插件放置和消费。
- `PluginHttpRoutesDemo`：常驻业务 HTTP；不为文档额外制造 Workbench 抽象。
- `PluginHttpWorkerDemo`：typed task + root shared worker pool + HMR/static artifact。

Workbench 插件每代至多调用一次 `ctx.workbench.publish(definition, bindings)`。每次打开 View 都返回新的
`RpcTarget`，renderer 通过 exact descriptor 调用 `useWorkbench()`；状态读取和订阅仍由插件 API 自己定义。
