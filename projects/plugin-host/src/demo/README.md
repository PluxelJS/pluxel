# Focused source references

默认应用演示统一由 `../showcase/ReportStudio.ts` 的一个 Plugin 提供，包含六种渲染引擎及真实 HTTP、Commands、Cache、Rates、Storage 与 Otel。下列文件只作为聚焦 API 示例和测试，不注册到默认应用目录；Bot Workspace 是独立产品。

- `PluginCompositionConfigDemo`：一个 Plugin 一次声明完整 object schema，并用嵌套字段组织内部模块配置。
- `PluginOptionalIntegrationDemo`：module-level `definePluginRef<T>()`、init-time `plugins.use(ref, setup)` 与 owner cleanup。
- `PluginEventsDemo`：producer-owned `EvtChannel`，consumer 通过 constructor required dependency 订阅。
- `PluginWithUI`：direct View API、Plugin-owned observer、tab、route 与 MF2 React Bridge。
- `PluginContributionFontDemo`：provider-owned Attachment + consumer-owned selection，演示 manager 被依赖插件放置和消费。
- `PluginHttpRoutesDemo`：常驻业务 HTTP；不为文档额外制造 Workbench 抽象。
- `PluginOutboundHttpDemo`：内建 Wretch、原生重试与 404 业务分支，以及独立 HTTP 路由的 DTO 投影。
- `PluginHttpWorkerDemo`：typed task + root shared worker pool + HMR/static artifact。

示例在所属 Plugin 的 `init()` 中调用一次 `this.ctx.service(WorkbenchRef)?.publish(definition, bindings)`。每次打开 View 都返回新的
`RpcTarget`。Renderer 使用 `createWorkbenchRenderer(Definition.entry)` 绑定页面，通过 scope 的 query/mutation 读取和修改状态。
需要直接操作 capability、进度或取消时，在同一页面内通过 `scope.useWorkbench()` 借用 RPC root。
