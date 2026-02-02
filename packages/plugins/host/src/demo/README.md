# Demo Plugins

`packages/plugins/host/src/demo` 放的是“演示/参考实现”插件：目标是让人（以及未来的 LLM）只靠读这些文件，就能写出同风格的高质量插件。

## 运行

- 启动 HMR 测试宿主：`pnpm --filter @pluxel/plugins-host hmr`
- Demo 入口由 `pluxel.hmr.jsonc` 的 `include` 负责（例如 `packages/plugins/host/src/demo/**/*.ts`），不再依赖自定义宿主脚本。
- Demo 默认假设 HMR 侧启用了 `configSourcePlugin`：因此 `configs.use(...)` / `features.use(...)` 可以不写装饰器，也能在启动前注册 schema/依赖信息。

## 清单（建议阅读顺序）

- `PluginEventsDemo.ts`：两种事件通信方式（EvtChannel + declare module 全局事件合同）。
- `PluginHonoGraphQLDemo.ts`：插件里使用 `ctx.honoService.modifyApp()` + `features.dep(GraphQLPlugin).useModule()`。
- `PluginBuiltinShowcase.ts`：尽量只用 builtin UI/config 的“大而全”样例（表单 meta、SSE state、内置文档块等）。
- `PluginFeatureConfigDemo.ts`：Feature 配置归因到父插件配置页（schema key 形如 `cache.config` / `cache.rules`，UI 会按 group 自动分组）。
- `PluginFeatureDepsDemo.ts`：FeatureHost 的“唯一推荐 API”（`use()` / `dep()` / BridgePlugin）。
- `PluginVaultDemo.ts`：插件里使用 `ctx.vault.open()` 做加密持久化（token/secret/batch/lock）。
- `PluginWithUI.ts` + `PluginWithUI/ui/*`：完整链路（UI + RPC + SSE + 持久化 state）。
- `PluginStandaloneFrameDemo.ts` + `PluginStandaloneFrameDemo/ui/*`：演示插件 routes 的 `frame: 'standalone'`（无 navbar/sidebar，但仍在同一 App/鉴权策略下运行）。
- `advanced/DemoBaseProviders.ts`：抽象基类 Token + 多实现（Provider 选择）。
- `advanced/DemoForks.ts`：ForkablePlugin（同插件多实例 / fork）。

## Demo 仅做类型检查

如果你只想检查 demo 相关的 TS 类型（不牵扯整个 workspace 的 build），用：

- `pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json`

## 非 demo（功能性示例）

- `packages/plugins/market/src/index.ts`：market UI（建议通过 workspace profile 的 `enabled` 启用）
