# Demo Plugins

`packages/plugins/host/src/demo` 是参考实现集合。目标是让人和 LLM 只靠读这些 demo，就能写出同风格的插件。整条前端链路见 `docs/FRONTEND_ARCHITECTURE.md`。

## 运行

- 开发宿主：`pnpm --filter @pluxel/plugins-host dev`
- demo 入口由 `packages/plugins/host/pluxel.hmr.jsonc` 的 `include` 控制
- 默认假设 HMR 侧启用了 `configSourcePlugin`

## 建议阅读顺序

- `PluginEventsDemo.ts`
  事件通信
- `PluginBuiltinShowcase.ts`
  宿主渲染 doc + signaldb state/action，无自定义 UI
- `PluginFeatureConfigDemo.ts`
  Feature 配置归因
- `PluginFeatureDepsDemo.ts`
  FeatureHost API
- `PluginVaultDemo.ts`
  加密持久化
- `PluginWithUI.ts` + `PluginWithUI/ui/*`
  完整自定义前端链路
- `PluginHttpWorkerDemo.ts`
  http + worker + fallback
- `advanced/DemoBaseProviders.ts`
  抽象 token + 多实现
- `advanced/DemoForks.ts`
  forkable plugin

## 前端入口

- `configs.use(schema)` 读到的是 schema 归一化后的值；默认值放进 Valibot（如 `v.optional(..., default)`），不要在插件里再写 `this.foo ?? fallback` 这种二次兜底。
- `this.ctx.ext.signaldb.collection({ name }).doc(selector).form(...)` 默认会同步当前选中的 SignalDB 文档；只有明确不想同步时才传 `state: false`。
- 插件主类里保留 `const pluginUi = ui('./ui/index.tsx')` + `pluginUi.bind(this.ctx)`。
- `@pluxel/hmr/plugin` 只用 named import：`import { ui, worker } from '@pluxel/hmr/plugin'`
- build 会把这条 UI 声明重写成 `ctx.ext.ui.packaged()`

## 浏览器侧入口

- 浏览器侧统一从 `@pluxel/runtime/web/ui` 导入
- UI 模块统一用 `definePluginUIModule(...)`
- `const fooUi = createPluginUi('MyPlugin')`
- `fooUi` 常用入口：`use()` / `useCollection()` / `useDoc()` / `useSignalDbQuery()`
- `use()` 默认取当前 extension context，也可显式写 `use('global')` / `use('plugin')`
- `use()` 返回 `context/transport/rpc/sse/notify/confirm/locale`
- SignalDB 响应性统一走官方链路：`@signaldb/maverickjs` + `@signaldb/react`
- 读固定单文档用 `useDoc()`；列表/排序/过滤/聚合/派生值统一用 `useSignalDbQuery(...)`
- `locale` 是宿主唯一 locale 服务；负责 locale 状态与日期/数字格式化
- 如果插件要做正式 i18n，统一用 `@inlang/paraglide-js`
- 当前 HMR / `buildPluginUiRemote()` 会在检测到包根有 `project.inlang` 时自动注入 Paraglide Vite 插件；默认约定是 `messages/` -> `src/paraglide/`
- `extensions` / `routes` 直接写稳定的裸对象结构
- `extensions[].id` 在单个 UI 模块内必须稳定且唯一
- `routes[].definition.path` 写相对子路径，如 `/dashboard`
- `setup({ pluginName, locale })` 只做模块级副作用和清理；如果接 Paraglide，就在这里桥接宿主 locale

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
- `this.ctx.ext.ui.packaged()`
  编译后的 UI remote 注册入口
- `this.ctx.ext.ui.doc(...)`
  宿主渲染 doc 扩展
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
- 交互写 state 或 action collection
- 副作用由插件后端 watch collection 后处理

## 类型检查

- `pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json`

## 非 demo 示例

- `packages/plugins/market/src/index.ts`
  market UI
