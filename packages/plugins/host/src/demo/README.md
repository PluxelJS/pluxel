# Demo Plugins

`packages/plugins/host/src/demo` 不是能力堆栈清单，而是一套可复制的参考实现。目标只有两个：

- 让人第一次读就能知道“标准 Pluxel 插件该从哪里起手”
- 让 LLM 能按同一套分层和命名继续扩展示例

整条前端链路见 `docs/architecture/frontend.md`。

## 运行

- 开发宿主：`pnpm --filter @pluxel/plugins-host dev`
- demo 入口由 `packages/plugins/host/pluxel.hmr.jsonc` 的 `include` 控制
- 默认假设 HMR 侧启用了 `configSourcePlugin`

## 建议阅读顺序

先读这 4 个，它们覆盖了最常见的标准用法：

1. `PluginFeatureConfigDemo.ts`
   最小配置写法。看 `configs.use(...)`、`features.use(...)` 和 feature 配置如何归因到父插件。
2. `PluginBuiltinShowcase.ts`
   不写自定义前端时的标准 builtin 路径。看 `signaldb.doc().form()`、`action()`、`doc(...)`。
3. `PluginFeatureDepsDemo.ts` + `PluginFeatureDeps.shared.ts`
   标准依赖写法。看 `features.use(...)`、`features.dep(...)`、局部 `EvtChannel`、bridge plugin，以及推荐的跨文件拆分。
4. `PluginWithUI.ts` + `PluginWithUI/ui/*`
   最小自定义 UI 路径。看 `ui(...).bind(this.ctx)`、RPC、SSE、SignalDB 与浏览器侧 `plugin.use()`。

在这之后按需再看：

- `PluginEventsDemo.ts`
  只补充声明式全局事件总线；局部事件优先看 `PluginFeatureDepsDemo.ts`。
- `PluginContributionFontDemo.ts`
  推荐的 cross-plugin interaction：consumer 拥有 config/surface，provider 拥有资源与 session UI。
- `PluginHttpWorkerDemo.ts`
  HTTP 路由和 HMR worker fallback。
- `PluginVaultDemo.ts`
  插件级加密持久化。

最后再看 advanced：

- `advanced/DemoBaseProviders.ts`
  抽象基类 provider。
- `advanced/DemoForks.ts`
  forkable plugin。

## 标准拆分建议

这套 demo 现在默认按下面的拆分思路组织：

- 插件入口文件只保留 plugin/feature 装配与生命周期
- schema、共享类型、纯运行时 helper 分拆到相邻文件
- 自定义 UI 独立放到 `PluginName/ui/*`
- 只有会被宿主直接加载的插件类保留在 demo 主文件里

推荐直接照着 `PluginFeatureDepsDemo.ts` 和 `PluginFeatureDeps.shared.ts` 复制：

- `PluginFeatureDeps.shared.ts`
  放共享 type、可复用 feature、纯 helper
- `PluginFeatureDepsDemo.ts`
  只保留插件类、依赖关系和生命周期

`PluginBuiltinShowcase.shared.ts` 和 `PluginWithUI/ui/*` 也分别演示了“共享 schema/格式化逻辑”和“浏览器侧模块独立”的拆法。

## 服务端作者约定

- `configs.use(schema)` 读到的是 schema 归一化后的值；默认值放进 Valibot，不要在插件里再做 `?? fallback`
- `this.ctx.ext.signaldb.collection({ name }).doc(selector).form(...)` 默认同步当前选中的 doc；不想同步时再显式改用 `formUnsynced(...)` 或 `formFrom(...)`
- `@pluxel/hmr/plugin` 只用 named import：`import { ui, worker } from '@pluxel/hmr/plugin'`
- 自定义 UI 插件主类保留 `const pluginUi = ui('./ui/index.tsx')` + `pluginUi.bind(this.ctx)`
- 生命周期清理统一绑到 `this.ctx.effects`

## 浏览器侧作者约定

- 浏览器侧统一从 `@pluxel/runtime/web/ui` 导入
- UI 模块统一用 `definePluginUIModule(...)`
- `const plugin = pluginUi('MyPlugin')`
- 默认入口用 `plugin.use()`；`plugin.useGlobal()` 只留给全局扩展点
- 常见能力统一从 `const app = plugin.use()` 取得：`rpc`、`sse`、`db`、`locale`、`notify`
- 固定单文档优先 `app.db.useDocById(...)`
- 列表优先 `collection().useList(...)`
- 只有复杂派生查询才用 `useLiveQuery(...)`

## 最小组合

不写自定义 UI：

- `signaldb.collection().doc(...)`
- `docHandle.form(...)` / `docHandle.action(...)`
- `ctx.ext.ui.builtin.doc(...)`

写自定义 UI：

- 服务端：`pluginUi.bind(this.ctx)` + `ctx.ext.rpc.expose(...)` + `ctx.ext.sse.expose(...)`
- 浏览器侧：`const plugin = pluginUi('MyPlugin')` + `const app = plugin.use()` + `app.db.useDocById(...)`

## 类型检查

- `pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json`

## 非目标

- 这里不追求“每种能力都给一个等权 demo”
- `plugins-host` 只保留最小但完整的推荐样例，不维护一组彼此重叠的变体
