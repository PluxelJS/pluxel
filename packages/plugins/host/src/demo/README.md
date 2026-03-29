# Demo Plugins

`packages/plugins/host/src/demo` 是参考实现集合。目标是让人和 LLM 只靠读这些 demo，就能写出同风格的插件。整条前端链路见 `docs/architecture/frontend.md`。

## 运行

- 开发宿主：`pnpm --filter @pluxel/plugins-host dev`
- demo 入口由 `packages/plugins/host/pluxel.hmr.jsonc` 的 `include` 控制
- 默认假设 HMR 侧启用了 `configSourcePlugin`

## 按用途看 Demo

- 只用宿主渲染控件，不写自定义 UI：
  `PluginBuiltinShowcase.ts`
- 自定义 UI + SignalDB + RPC + SSE：
  `PluginWithUI.ts` + `PluginWithUI/ui/*`
- 插件间事件通信：
  `PluginEventsDemo.ts`
- 插件 / Feature 配置：
  `PluginFeatureConfigDemo.ts`
- provider 提供 target 插件页面前端与资源选择器：
  `PluginContributionFontDemo.ts`
- Feature 依赖和桥接：
  `PluginFeatureDepsDemo.ts`
- HTTP 路由 + worker fallback：
  `PluginHttpWorkerDemo.ts`
- 加密持久化：
  `PluginVaultDemo.ts`
- 抽象基类 provider：
  `advanced/DemoBaseProviders.ts`
- Forkable plugin：
  `advanced/DemoForks.ts`

## 前端入口

- `configs.use(schema)` 读到的是 schema 归一化后的值；默认值放进 Valibot（如 `v.optional(..., default)`），不要在插件里再写 `this.foo ?? fallback` 这种二次兜底。
- `this.ctx.ext.signaldb.collection({ name }).doc(selector).form(...)` 默认会同步当前选中的 SignalDB 文档；如果明确不想同步，用 `formUnsynced(...)`；如果要改同步源，用 `formFrom(...)`。
- 插件主类里保留 `const pluginUi = ui('./ui/index.tsx')` + `pluginUi.bind(this.ctx)`。
- `@pluxel/hmr/plugin` 只用 named import：`import { ui, worker } from '@pluxel/hmr/plugin'`
- build 会把这条 UI 声明重写成 `ctx.ext.ui.remote.packaged()`

## 浏览器侧入口

- 浏览器侧统一从 `@pluxel/runtime/web/ui` 导入
- 服务端声明 interaction contract 时，从 `@pluxel/runtime/web/extensions` 导入 `defineInteractionContract`
- UI 模块统一用 `definePluginUIModule(...)`
- `const plugin = pluginUi('MyPlugin')`
- `plugin.use()` 是默认入口；`plugin.useGlobal()` 只给 header/global status bar 这种全局扩展点
- `const app = plugin.use()` 后，常用宿主能力都从 `app` 上拿：`pluginName/pathname/colorScheme/locale/notify/confirm/rpc/sse/transport/db`
- SignalDB 响应性统一走官方链路：`@signaldb/maverickjs` + `@signaldb/react`
- 固定单文档优先用 `app.db.useDocById('collection', id)` / `app.db.collection('collection').useDocById(id)`
- 列表/排序优先用 `app.db.collection('name').useList({ where, sort, limit, skip })`
- 计数优先用 `app.db.useCount()` / `app.db.collection('name').useCount()`
- 只有复杂派生查询才用 `app.db.useLiveQuery(...)`
- `locale` 是宿主唯一 locale 服务；负责 locale 状态与日期/数字格式化
- 如果插件要做正式 i18n，统一用 `@inlang/paraglide-js`
- 当前 HMR / `buildPluginUiRemote()` 会在检测到包根有 `project.inlang` 时自动注入 Paraglide Vite 插件；默认约定是 `messages/` -> `src/paraglide/`
- `extensions` / `routes` 直接写稳定的裸对象结构
- `extensions[].id` 在单个 UI 模块内必须稳定且唯一
- `routes[].definition.path` 写相对子路径，如 `/dashboard`
- `setup({ pluginName, locale })` 只做模块级副作用和清理；如果接 Paraglide，就在这里桥接宿主 locale

最小自定义 UI 组合通常就是：

- 服务端：`pluginUi.bind(this.ctx)` + `this.ctx.ext.rpc.expose(...)` + `this.ctx.ext.sse.expose(...)`
- 浏览器侧：`const plugin = pluginUi('MyPlugin')` + `const app = plugin.use()` + `app.db.useDocById()`

## `ctx.ext`

- `this.ctx.ext.rpc.expose(...)`
  自定义 UI 的 RPC
- `this.ctx.ext.sse.expose(...)`
  自定义 UI 的 SSE
- `this.ctx.ext.signaldb.collection({ name })`
  服务端 authoritative collection
  `collection.doc(selector)` 给单文档场景生成 `get/field/path/snapshot/form/action`
- `pluginUi.bind(this.ctx)`
  UI 声明绑定入口
- `this.ctx.ext.ui.remote.packaged()`
  编译后的 UI remote 注册入口
- `this.ctx.ext.ui.builtin.doc(...)`
  宿主渲染 doc 扩展
- `this.ctx.ext.ui.interaction.surface(...)`
  consumer-owned interaction surface
- `this.ctx.ext.ui.interaction.offer(...)`
  provider-owned interaction offer
- `this.ctx.http.plugin.routes(...)`
  插件级 HTTP 路由挂载
- `workerDecl.bind(this.ctx, options)`
  HMR worker 绑定入口
- `this.ctx.vault.open(...)`
  插件级加密持久化
- `this.ctx.root.fs.*`
  root FS 入口
- `this.ctx.loader.api`
  loader API（如 snapshot/builtin tooling）

## doc 约束

宿主渲染 doc 只消费 `signaldb`：

- 展示读 state collection
- `form`
  宿主 AutoForm，默认同步当前 doc，再把提交写入 `write`
- `action`
  宿主按钮，点击后执行 `write`；常见用法是写入 action collection
- 副作用由插件后端 watch collection 后处理

`PluginBuiltinShowcase.ts` 演示了 `doc(schemaMap).card(...)`、`docHandle.form(...)` 和 `docHandle.action(...)` 这三种最小 builtin 组合。

`PluginContributionFontDemo.ts` 演示 consumer 先声明 `ctx.ext.ui.interaction.surface(...)`，provider 再通过 `ctx.ext.ui.interaction.offer(...)` 暴露兼容 contract 的交互能力，宿主解析出 session 后加载 provider 的 `fontPickerSession` UI，并把最终结果写回 consumer 配置。

可以把当前推荐交互形式理解成：

- consumer 拥有 config/schema/surface
- provider 拥有资源集合与 session 前端
- host 拥有匹配、会话同步、commit 与诊断

更准确地说：

- 这份 demo 演示的是唯一推荐的 cross-plugin interaction 路径
- provider 负责完整前端，consumer 只负责 surface 和 config ownership
- `doc(...)` 只是插件自己的 builtin UI，不参与这条 interaction 语义

宿主侧现在也会把这条链路的诊断暴露出来：

- 扩展路由页 banner 会显示 active / waiting / rejected interaction 摘要
- 插件详情页会显示 surface / offer / session / incoming / outgoing 的状态卡片

## 类型检查

- `pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json`

## 非 demo 示例

- `packages/plugins/market/src/index.ts`
  market UI
