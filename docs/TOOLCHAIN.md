# Toolchain

Toolchain 包括 build、Vite 分层、lint、test 和发布约束。它的职责是尽早暴露作者错误，并把 authoring 语义降成 runtime 可消费的产物。

## Build

`@pluxel/rolldown` 是公开的 Pluxel toolchain 包。它不定义插件 authoring API，也不定义 runtime 业务 API；它收敛 build、Rolldown/Vite plugin、workspace helper 和 build-critical lint，负责构建期改写、元数据注入和开发期子编译工具。

关键插件：

- `lintGuardPlugin()`：执行 build-critical lint，违规直接失败。
- `configSourcePlugin()`：提取 `@Config(...)` / `configs.use(...)` 的 schema source 和 layout metadata。
- `runtimeUiBridgePlugin()`：把 `ui(...).bind(ctx)` 改写成 `ctx.ext.ui.remote.packaged()`。

最终产物不应残留 loader-hmr/source authoring 语义。

## Vite 分层

当前 Vite 使用有三类消费者：

- components/workbench client。
- runtime web asset build。
- route HMR / plugin UI remote build。

route-specific HMR 提交流程归各 runtime route；route-neutral Rolldown/Vite/MF/Paraglide helper 归 `@pluxel/rolldown`。`@pluxel/runtime-dynamic/hmr` 负责 loader HMR 的 Vite runner/watch/module replacement；`@pluxel/runtime-static` 负责 static definition import/catalog diff。`@pluxel/runtime/plugin` 提供 route-neutral 的 `ui(...)` / `worker(...)` authoring bridge，插件 UI remote build helper 由 `@pluxel/rolldown/vite/plugin-ui` 共享。

规则：

- 环境相关 Vite plugin 必须限定作用域。
- Runtime HMR 接收标准 Vite `InlineConfig`；文档警告高风险字段，但不额外发明一套插件/alias options。
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
- `@pluxel/runtime-static`
- `@pluxel/rolldown`
- `@pluxel/cli`
- `@pluxel/test`

其他 workspace 包默认 internal/private，除非显式提升。

## 实现入口

- `packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`
- `packages/rolldown/src/rolldown/plugins/runtimeUiBridgePlugin.ts`
- `packages/rolldown/src/cli/index.ts`
- `packages/cli/src/build.ts`
- `packages/cli/src/hmr/**`
- `packages/runtime-dynamic/src/hmr/engine/config.ts`
- `packages/rolldown/src/vite/plugin-ui.ts`
- `oxlint.build.config.ts`
- `oxlint.config.ts`
- `packages/rolldown/src/workspace/oxlint/plugin.ts`
- `packages/test/README.md`
- `packages/test/LLM_TESTING_GUIDE.md`
