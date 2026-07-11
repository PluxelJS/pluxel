# Plugin host demos

这些 demo 使用最终插件作者 API：

- `PluginWithUI`：`ui()` 纯声明与 `ctx.webManagement.use(web => web.ui.register(...))`。
- `PluginBuiltinShowcase`：`web.ui.builtin.doc(...)`。
- `PluginContributionFontDemo`：`web.ui.interaction.surface/offer(...)`。
- `PluginFeatureConfigDemo`：`@Plugin({ features: [...] })` + `features.use()`。
- `PluginFeatureDepsDemo`：constructor required dependency 与 `this.plugins.use()` optional integration。
- HTTP demos：常驻 `ctx.http`，不依赖 Web Management。

管理态使用 `web.state.collection()`；RPC/SSE 使用 `web.rpc` / `web.sse`。宿主关闭 Web Management 时相关 callback 不执行，HTTP 和插件核心逻辑仍运行。
