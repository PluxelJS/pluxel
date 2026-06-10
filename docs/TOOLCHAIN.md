# Toolchain

Toolchain 包括 build、Vite 分层、lint、test 和发布约束。它的职责是尽早暴露作者错误，并把 authoring 语义降成 runtime 可消费的产物。

## Build

`@pluxel/build` 是内部构建辅助包。它不定义 authoring API，也不定义 runtime API，只负责构建期改写和元数据注入。

关键插件：

- `lintGuardPlugin()`：执行 build-critical lint，违规直接失败。
- `configSourcePlugin()`：提取 `@Config(...)` / `configs.use(...)` 的 schema source 和 layout metadata。
- `runtimeDynamicUiBridgePlugin()`：把 `ui(...).bind(ctx)` 改写成 `ctx.ext.ui.remote.packaged()`。

最终产物不应残留 loader-hmr/source authoring 语义。

## Vite 分层

当前 Vite 使用有三类消费者：

- components/workbench client。
- runtime web asset build。
- HMR host。

HMR host 归入 `@pluxel/runtime-dynamic` HMR mode；Vite 分层原则不变。

规则：

- 环境相关 Vite plugin 必须限定作用域。
- runtime HTML shell 和 HMR host 不混成一层。
- shared UI build policy 要和插件 UI remote build 保持一致。

## Lint

Lint 分 repo lint 和 build lint：

- repo lint：仓库范围的质量规则。
- build lint：构建/HMR/测试链路必须守住的 correctness 规则。

构建期不再偷偷修源码。能 autofix 的仅限明确机械、安全、不改变语义的规则；语义问题直接 fail。

## Test

测试选择最低真实 host：

- core lifecycle/config/effects/logger：core test host。
- runtime services、loader、config persistence、HTTP/control-plane：runtime test host。
- HMR batching、Vite runner、watch：HMR support，尽量接真实 runtime host。

避免为了方便而 mock 掉 loader/config/registry 后再验证生命周期行为。

## 发布和依赖

公开发布意图：

- `@pluxel/core`
- `@pluxel/runtime`
- `@pluxel/runtime-dynamic`
- `@pluxel/cli`
- `@pluxel/test`

其他 workspace 包默认 internal/private，除非显式提升。

## 实现入口

- `packages/build/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/build/src/rolldown/plugins/runtimeDynamicUiBridgePlugin.ts`
- `packages/build/src/cli.ts`
- `packages/cli/src/build.ts`
- `packages/cli/src/hmr/**`
- `packages/runtime-dynamic/src/hmr/engine/config.ts`
- `packages/runtime-dynamic/src/hmr/plugin-build.ts`
- `oxlint.build.config.ts`
- `oxlint.config.ts`
- `packages/workspace/src/oxlint/plugin.ts`
- `packages/test/README.md`
- `packages/test/LLM_TESTING_GUIDE.md`
