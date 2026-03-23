# Demo Plugins

`packages/plugins/host/src/demo` 是参考实现集合。目标是让人和 LLM 只靠读这些 demo，就能写出同风格的插件。

## 运行

- 启动开发宿主：`pnpm --filter @pluxel/plugins-host dev`
- demo 入口由 `packages/plugins/host/pluxel.hmr.jsonc` 的 `include` 负责
- 默认假设 HMR 侧启用了 `configSourcePlugin`

## 建议阅读顺序

- `PluginEventsDemo.ts`：事件通信
- `PluginBuiltinShowcase.ts`：宿主渲染 doc + signaldb action/state，无自定义 UI
- `PluginFeatureConfigDemo.ts`：Feature 配置归因
- `PluginFeatureDepsDemo.ts`：FeatureHost 推荐 API
- `PluginVaultDemo.ts`：加密持久化
- `PluginWithUI.ts` + `PluginWithUI/ui/*`：完整自定义前端链路
- `PluginHttpWorkerDemo.ts`：http + worker + fallback
- `advanced/DemoBaseProviders.ts`：抽象 token + 多实现
- `advanced/DemoForks.ts`：forkable plugin

## 前端推荐写法

- 插件主类里保留 `const pluginUi = ui('./ui/index.tsx')` + `pluginUi.bind(this.ctx)`；这是 authoring bridge，不是 runtime contract
- `@pluxel/hmr/plugin` 只用 named import：`import { ui, worker } from '@pluxel/hmr/plugin'`
- `pluxel build` 会把 `ui(...).bind(ctx)` 重写成 `ctx.ext.ui.packaged()`
- 插件 UI 浏览器侧统一从 `@pluxel/runtime/web/ui` 导入，并使用 `definePluginUIModule(...)`
- 前端命名空间推荐先写 `const fooUi = createPluginUiHelpers('MyPlugin')`
- `extensions` / `routes` 直接写稳定的裸对象结构
- `extensions[].id` 在单个 UI 模块内必须稳定且唯一
- `routes[].definition.path` 统一写相对子路径，如 `/dashboard`
- `setup()` 只做模块级副作用和清理

## `ctx.ext` 分层

- `ctx.ext.rpc.expose(...)`：自定义 UI 的 RPC
- `ctx.ext.sse.expose(...)`：自定义 UI 的 SSE
- `ctx.ext.signaldb.collection({ name })`：服务端 authoritative collection
- `ctx.ext.signaldb.bind(collection, selector)`：给宿主渲染 doc/helpers 绑定单条记录
- `ui(...).bind(ctx)`：作者侧 bridge，给 HMR / AST / build 用
- `ctx.ext.ui.packaged()`：runtime packaged remote 注册入口
- `ctx.ext.ui.doc(...)`：宿主渲染 doc 扩展
- `ctx.ext.ui.helpers(binding)`：宿主渲染 doc 的轻量 authoring helper

`doc` 现在只消费 `signaldb`：

- 展示读 state collection
- 交互写 action/state collection
- 不再直接依赖 RPC / SSE

## 类型检查

只检查 demo 相关 TS 类型：

- `pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json`

## 非 demo 示例

- `packages/plugins/market/src/index.ts`：market UI
