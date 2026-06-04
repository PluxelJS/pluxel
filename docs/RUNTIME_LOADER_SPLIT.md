# Runtime Loader Split

状态：已实现的迁移说明。本文只描述当前 runtime-loader split，不描述未来 static suite route 的完整设计；未来路线仍见 `proposals/runtime-routes.md`。

## 目标

这次迁移的目标是把 runtime common 和 loader route 分开：

```text
@pluxel/core
  <- @pluxel/runtime
       runtime common services / config / ops / HTTP / web protocol / route-neutral API
  <- @pluxel/runtime-loader
       loader / scan / package / package-manager / workspace tools
  <- @pluxel/hmr
       dev server / Vite runner / watch / HMR submit
```

runtime 不依赖 runtime-loader。`pnpm install` 只报告原有 core/test 循环，没有 runtime/runtime-loader 循环。

## 迁移内容

从 `@pluxel/runtime` 迁到 `@pluxel/runtime-loader` 的内容：

- `LoaderService`、`PluginRegistry`、module replacement、loader batch/control/status helpers。
- `ScanService` 和 workspace entry resolver/cache/snapshot。
- `PackageService` 和 install/remove/load/retry/state flows。
- 原 `market` API，改名为 `package-manager`，负责 package inventory、load issues、install/remove/reload/retry。
- `rpc.package()` 的实现 handle，改名为 `PackageManagerHandle`。
- `workspace.resolveEntry` / `workspace.listEntries` MCP dev tools。

留在 `@pluxel/runtime` 的内容：

- runtime service 注册、config persistence、ops、HTTP/RPC/MCP server、web protocol。
- route-neutral plugin status/config/dependency/fork usecases。
- `RuntimePluginCatalogService` 契约和共享 extra keys。
- `RuntimeRpcApi.package()` 协议入口，但实际 handle 由 route contribution 注册。

## 关键接口

`@pluxel/runtime/plugin-catalog` 是 runtime common 读取插件目录的 route-neutral 契约。loader route 通过 `LoaderPluginCatalogService` 覆盖这个契约，把 loader registry/runtime/control 映射给 runtime API。

`@pluxel/runtime/api` 是很薄的 contribution registry，只提供三类注册点：

- GraphQL resolver contribution。
- RPC handle contribution。
- MCP tools contribution。

它不是可无限扩展的 route plugin 系统；它只是让 route 包把自己的控制面挂进 runtime 已有 server。当前 loader route 注册：

- package-manager GraphQL resolver。
- `rpc.package()` handle。
- workspace MCP tools。

## 为什么这样拆

loader route 的 scan/package/cache/module catalog 是动态插件生态的成本。static suite route 未来不应该继承这些成本。

runtime common 仍然复用：

- config persistence 和 profile。
- plugin config/status/lifecycle ops。
- HTTP/RPC/MCP transport。
- web protocol 和插件 UI protocols。
- vault/fs/logging/verification 等宿主服务。

这样 static suite 未来只需要提供另一份 catalog/startup/HMR submit 适配，不需要复制 runtime。

## 当前兼容边界

对外协议保持不变：

- GraphQL 字段仍是 `packageInventory` / `packageLoadIssues`。
- RPC 入口仍是 `rpc.package()`。
- MCP tool 名仍是 `workspace.resolveEntry` / `workspace.listEntries`。

实现归属改变：这些入口只有在 loader route 注册后可用。HMR 和 frozen bootstrap 会显式 import `@pluxel/runtime-loader/register`。

## 清理结论

这次迁移没有重写 loader 核心逻辑，主要是物理迁移和入口重接：

- package-manager 已回到直接复用 `PackageService` / `normalizeSpecifier`，没有保留临时复制的 normalize 逻辑。
- runtime common 不再 import loader/package/scan/package-manager/workspace 实现。
- runtime-loader 只依赖 runtime 的窄公共入口：`internal`、`shared`、`plugin-catalog`、`api`、`protocol`。
- loader-specific tests 现在显式引用 runtime-loader 或显式注册 loader route。

剩余的抽象成本是 intentional：`plugin-catalog` 和 `api contributions`。前者是两条插件路线共享 runtime API 的必要契约；后者是避免 runtime common 反向依赖 loader-specific 控制面的最小接缝。
