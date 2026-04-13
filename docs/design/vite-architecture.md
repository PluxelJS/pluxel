# Vite Architecture

## Goal

把 Pluxel 里的 Vite 配置拆成三个边界清晰的 consumer：

- `components workbench client`
- `runtime web asset build`
- `hmr dev host`

同时把真正共享的策略只维护一份，避免：

- 同一组 `dedupe / optimizeDeps / chunk groups` 在多个配置里发散
- 语义型插件误跑到浏览器 consumer
- dev host 和浏览器构建职责混杂

## Current Layers

### 1. Components Workbench Client

文件：

- `packages/components/vite.config.ts`
- `packages/components/vite/plugins.ts`

职责：

- Workbench 浏览器端构建
- React + TanStack Router 文件路由生成
- 浏览器产物分包与预构建优化

它不负责：

- plugin source 语义注入
- SSR runner 转译
- HMR host 路由装配

### 2. Runtime Web Asset Build

文件：

- `packages/runtime/vite.config.ts`
- `packages/runtime/vite/plugins.ts`

职责：

- 构建 runtime 自带的浏览器 UI 资产
- 生成 `public/.vite/manifest.json`
- 提供给 `HttpService` 静态托管

它不负责：

- HMR dev host 启动
- plugin source 语义提取
- server runner 编译行为

### 3. HMR Dev Host

文件：

- `packages/hmr/src/dev/hmr/config.ts`

职责：

- dev server 组装
- runner / http / internal api 挂载
- SSR 环境专用源码语义插件注册

这里才是：

- `configSourcePlugin()`
- `importTypeFixerPlugin()`

的正确挂载点。

## Environment-Scoped Plugin Rule

所有“只该跑在 server consumer”的插件都必须显式包装。

共享入口：

- `packages/runtime/src/services/runtime/shared/vite-environment.ts`

统一 helper：

- `serverOnlyVitePlugin(name, plugin)`
- `browserOnlyVitePlugin(name, plugin)`

规则：

- `configSourcePlugin`、`importTypeFixerPlugin` 这类源码语义插件只能通过 `serverOnlyVitePlugin(...)` 注册
- 浏览器 consumer 不允许直接注册这类插件
- 新增环境插件时，不允许散落手写 `environment.name === 'ssr'` 判断

## Shared UI Build Policy

浏览器 UI 构建共享策略统一放在：

- `packages/workspace/src/vite.ts`

当前集中内容：

- `PLUXEL_UI_DEDUPE_PACKAGES`
- `PLUXEL_UI_OPTIMIZE_DEPS_INCLUDE`
- `PLUXEL_TABLER_ICONS_ESM_ENTRY_SPECIFIER`
- `createPluxelUiChunkGroups()`
- `fixRolldownUndefinedExportsPlugin()`

这意味着：

- `components` 和 `runtime web` 共用同一套浏览器依赖去重
- 共用同一套生产 chunk 分组策略
- 共用同一份 `server_browser_exports` 修补插件

但它们仍然保持独立配置文件，因为：

- 路由插件只属于 `components`
- runtime alias / publicDir / manifest 只属于 `runtime`

## Runtime HTML Shell

runtime UI 的 dev/static HTML 壳统一放在：

- `packages/runtime/src/server/html.ts`

由：

- `packages/runtime/src/server/dev.tsx`
- `packages/runtime/src/server/static.ts`

共同复用，避免同一份 `<html>` 壳在 dev/build 两处继续分叉。

## Practical Rules

新增 Vite 设置时先判断属于哪一层：

- 浏览器 UI 构建共性：
  放到 `packages/workspace/src/vite.ts`
- 只影响某个包的 build：
  放到该包 `vite.config.ts`
- 只影响某个包的插件装配：
  放到该包 `vite/plugins.ts`
- 只影响 dev host / SSR runner：
  放到 `packages/hmr/src/dev/hmr/config.ts`

新增 Vite 插件时再判断环境：

- server consumer only:
  `serverOnlyVitePlugin(...)`
- browser consumer only:
  `browserOnlyVitePlugin(...)`
- 双端都需要：
  直接注册，但必须确认不会引入语义污染或无效开销
