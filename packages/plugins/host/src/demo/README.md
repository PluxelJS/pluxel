# Demo Plugins

`packages/plugins/host/src/demo` 是参考实现集合。目标是让人和 LLM 只靠读这些 demo，就能写出同风格的插件。

如果你是为了理解整条前端架构，不要只读 demo，同时看：

- `docs/FRONTEND_ARCHITECTURE.md`

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
  FeatureHost 推荐 API
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

如果你是按场景读，而不是按文件名读，推荐这样跳：

- 想看“只用宿主控件，不写自定义 UI”
  先读 `PluginBuiltinShowcase.ts`
- 想看“完整自定义 UI + SignalDB + RPC/SSE”
  先读 `PluginWithUI.ts` + `PluginWithUI/ui/*`
- 想看“Feature/依赖关系”
  先读 `PluginFeatureDepsDemo.ts` / `PluginFeatureConfigDemo.ts`

## 前端推荐写法

- 插件主类里保留 `const pluginUi = ui('./ui/index.tsx')` + `pluginUi.bind(this.ctx)`
- `@pluxel/hmr/plugin` 只用 named import：`import { ui, worker } from '@pluxel/hmr/plugin'`
- build 会把 `ui(...).bind(ctx)` 重写成 `ctx.ext.ui.packaged()`
- 浏览器侧统一从 `@pluxel/runtime/web/ui` 导入
- UI 模块统一用 `definePluginUIModule(...)`
- 推荐先写 `const fooUi = createPluginUi('MyPlugin')`
- `fooUi` 当前只推荐记 4 个入口：`use()` / `useCollection()` / `useDoc()` / `useSignalDbQuery()`
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

这里最容易误解的一点是：

- `ui(...).bind(ctx)` 是 authoring bridge，给 HMR / AST rewrite / build 用
- `ctx.ext.ui.packaged()` 才是 runtime 最终注册语义

demo 保留 `bind(ctx)` 写法，是为了让开发期和构建期都能识别同一个声明点，而不是让 runtime 去理解源码入口。

## `ctx.ext`

- `ctx.ext.rpc.expose(...)`
  自定义 UI 的 RPC
- `ctx.ext.sse.expose(...)`
  自定义 UI 的 SSE
- `ctx.ext.signaldb.collection({ name })`
  服务端 authoritative collection
- `ui(...).bind(ctx)`
  作者侧 bridge，供 HMR / AST / build 识别
- `ctx.ext.ui.packaged()`
  runtime packaged remote 注册入口
- `ctx.ext.ui.doc(...)`
  宿主渲染 doc 扩展
- `ctx.ext.ui.state(collection, selector)`
  doc/builtin 场景的状态 helper，统一生成 `get/field/path/snapshot/form/action`

## doc 约束

宿主渲染 doc 只消费 `signaldb`：

- 展示读 state collection
- 交互写 state 或 action collection
- 副作用由插件后端 watch collection 后处理

因此 demo 里的设计意图也很固定：

- doc/builtin demo
  展示“受控宿主交互层”
- custom UI demo
  展示“完整 remote + browser contract”

## 类型检查

- `pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json`

## 非 demo 示例

- `packages/plugins/market/src/index.ts`
  market UI
