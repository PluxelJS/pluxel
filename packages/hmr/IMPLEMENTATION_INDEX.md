# @pluxel/hmr — Implementation Index

目标：快速定位 dev host、Vite wiring、plugin authoring bridge 和插件 UI 编译链。

前端整条链路说明见：

- [`docs/architecture/frontend.md`](../../docs/architecture/frontend.md)

如果你是为了追“为什么 `ui(...).bind(ctx)` 最终会变成 packaged remote”，优先按下面顺序看：

1. `packages/hmr/src/plugin.ts`
2. `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`
3. `packages/build/src/rolldown/plugins/hmrUiBridgePlugin.ts`
4. `packages/hmr/src/plugin-build.ts`

## Package Exports

- `packages/hmr/package.json`
- `packages/hmr/src/index.ts`
- `packages/hmr/src/host.ts`
- `packages/hmr/src/plugin.ts`
- `packages/hmr/src/plugin-build.ts`
- `packages/hmr/src/snapshot.ts`

## Standard Entry

- `packages/hmr/src/host.ts`
  `createHmrHostFromConfig` / `startHmrHostFromConfig`
- `packages/hmr/src/dev/attach-runtime.ts`
  把 HMR 能力 attach 到已有 runtime `Context`

## HMR Service

- `packages/hmr/src/dev/hmr/HMRService.ts`
  Vite dev server、runner、watch pipeline
- `packages/hmr/src/dev/hmr/config.ts`
  HMR Vite config、bridge modules、dedupe、optimizeDeps
- `packages/hmr/src/dev/hmr/*`
  runner / pipeline / runtime shims / workspace resolver

## Plugin Authoring Bridge

- `packages/hmr/src/plugin.ts`
  `ui(...)` / `worker(...)`
- `packages/hmr/src/paraglide.ts`
  解析 Paraglide 固定约定并生成 Vite plugin 注入
- `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`
  消费 `ui(...).bind(ctx)`，编译插件 UI 源码，提交 compiled module
- `packages/hmr/src/plugin-build.ts`
  用 `@module-federation/vite` 构建插件 UI remote，并复用 Paraglide 集成

这是 HMR 与 MF2 对接的关键链路：

- `plugin.ts`
  作者侧 bridge 入口
- `ExtensionCompilerService`
  dev 期消费 bridge、watch 源码、提交 compiled module
- `plugin-build.ts`
  build 期把插件 UI 产出为稳定 MF2 remote

这里的职责不要混：

- `plugin.ts`
  只定义作者侧 bridge 形状
- `ExtensionCompilerService`
  只处理 dev 期源码消费与 compiled module 提交
- `plugin-build.ts`
  只处理 remote 构建

真正的 runtime 注册发生在 `@pluxel/runtime` 的 `ExtensionService`，不在这里。

## Diagnose / Snapshot

- `packages/hmr/src/diagnose/config.ts`
  HMR config 读写
- `packages/hmr/src/diagnose/diagnose.ts`
  workspace diagnose
- `packages/hmr/src/snapshot.ts`
  `HmrWorkspaceSnapshot`

## Tests

- `packages/hmr/tests/plugin/plugin-api.test.ts`
  `ui(...)` / `worker(...)` bridge 行为
- `packages/hmr/tests/plugin/paraglide-integration.test.ts`
  Paraglide 固定路径约定与 build/dev 注入
- `packages/hmr/tests/host/host-runtime-bridges.test.ts`
  host attach/runtime bridge
- `packages/hmr/tests/hmr/client-optimize-deps.test.ts`
  dev client optimizeDeps 约束
