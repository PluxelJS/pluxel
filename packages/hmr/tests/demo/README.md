# Demo Plugins

`packages/hmr/tests/demo` 放的是“演示/参考实现”插件：目标是让人（以及未来的 LLM）只靠读这些文件，就能写出同风格的高质量插件。

## 运行

- 启动 HMR 测试宿主：`pnpm --filter @pluxel/hmr hmr`
- 这些 demo 会通过 `packages/hmr/tests/start.ts` 的 `hmrService.dir` 自动被扫描/加载。

## 清单（建议阅读顺序）

- `PluginEventsChannel.ts`：插件 A 暴露 `EvtChannel`，插件 B 注入 A 并订阅。
- `PluginEventsDeclared.ts`：`declare module '@pluxel/hmr'` 声明全局事件合同，然后用 `ctx.emit/on` 通信。
- `PluginHonoGraphQLDemo.ts`：插件里使用 `ctx.honoService.modifyApp()` + `ctx.graphql.useModule()`。
- `PluginWithUI.ts` + `PluginWithUI/ui/*`：完整链路（UI + RPC + SSE + 持久化 state）。
- `PluginBuiltinShowcase.ts`：偏保守不注册新组件的 Config/UI Builtins 展示（表单 meta、SSE state、内置文档块等）。
- `advanced/DemoBaseProviders.ts`：抽象基类 Token + 多实现（Provider 选择）。
- `advanced/DemoForks.ts`：ForkablePlugin（同插件多实例 / fork）。

## Demo 仅做类型检查

如果你只想检查 demo 相关的 TS 类型（不牵扯整个 workspace 的 build），用：

- `pnpm exec tsc -p packages/hmr/tests/demo/tsconfig.json`

## 非 demo（功能性示例）

- `packages/hmr/tests/ui-demos/MarketUI.ts`：market UI（默认不在 `tests/start.ts` 扫描列表中）
