# Runtime Dynamic Split

状态：已实现的迁移说明。本文只描述 runtime common 与 runtime-dynamic route 的拆分结果；runtime-static route 的当前事实见 `RUNTIME.md` 与 `HMR.md`。

## 目标

这次迁移的目标是把 runtime common 和 loader route 分开：

```text
@pluxel/core
  <- @pluxel/runtime
       runtime common services / config / HTTP / web protocol / route-neutral API
  <- @pluxel/runtime-dynamic
       loader / scan / package / package-manager / workspace tools
       HMR mode / Vite runner / watch / loader replacement
```

runtime 不依赖 runtime-dynamic。`pnpm install` 只报告原有 core/test 循环，没有 runtime/runtime-dynamic 循环。

## 迁移内容

从 `@pluxel/runtime` 迁到 `@pluxel/runtime-dynamic` 的内容：

- `LoaderService`、`PluginRegistry`、module replacement、loader batch/control/status helpers。
- `ScanService` 和 workspace entry resolver/cache/snapshot。
- `PackageService` 和 install/remove/load/retry/state flows。
- 原 `market` API，改名为 `package-manager`，负责 package inventory、load issues、install/remove/reload/retry。
- `packageManager` route feature 的实现 handle：`PackageManagerHandle`。

留在 `@pluxel/runtime` 的内容：

- runtime service 注册、config persistence、HTTP/RPC server、web protocol。
- route-neutral plugin status/config/dependency/fork usecases。
- route capabilities 类型和 `RuntimeStateStore` 运行控制面状态。
- `RuntimeRpcApi.features()` / `RuntimeRpcApi.feature(name)` route feature lookup。

## 关键接口

`@pluxel/runtime/plugin-catalog` 是 runtime common 暴露 route-neutral catalog/status/source/capability 类型的出口。loader route 通过 `createLoaderRuntimeRoute()` 把 loader registry/runtime/control 映射成当前 `Context.runtimeRoute` 上的 capabilities。

`@pluxel/runtime/api` 是很薄的 route API 读取入口，只从当前 context 的 route capability 读取两类贡献：

- GraphQL resolver contribution。
- route feature handle contribution。

它不是可无限扩展的 route plugin 系统；它只是让 route 包把自己的控制面挂进 runtime 已有 server。当前 loader route capability 提供：

- package-manager GraphQL resolver。
- `packageManager` route feature handle。

## 为什么这样拆

loader route 的 scan/package/cache/module catalog 是动态插件生态的成本。runtime-static route 不继承这些成本，只提供 fixed catalog、definition diff 和 static HMR。

runtime common 仍然复用：

- config persistence 和 profile。
- plugin config/status/lifecycle usecases。
- HTTP/RPC transport。
- web protocol 和插件 UI protocols。
- vault/fs/logging/verification 等宿主服务。

这样 runtime-static route 未来只需要提供另一份 catalog/startup/hmr replacement 适配，不需要复制 runtime。

## 当前协议边界

对外协议边界：

- GraphQL 字段仍是 `packageInventory` / `packageLoadIssues`。
- RPC 入口是 `rpc.feature('packageManager')`，调用前可通过 `rpc.features()` 发现能力。
实现归属改变：这些入口只有在 loader route 注册后可用。dynamic HMR host 会显式 import `@pluxel/runtime-dynamic/register`；static route 不加载 loader/scan/package 注册。

## 清理结论

这次迁移没有重写 loader 核心逻辑，主要是物理迁移和入口重接：

- package-manager 已回到直接复用 `PackageService` / `normalizeSpecifier`，没有保留临时复制的 normalize 逻辑。
- runtime common 不再 import loader/package/scan/package-manager/workspace 实现。
- runtime-dynamic 只依赖 runtime 的窄公共入口：`internal`、`shared`、`plugin-catalog`、`api`、`protocol`。
- loader-specific tests 现在显式引用 runtime-dynamic 或显式注册 loader route。

剩余的抽象成本是 intentional：`plugin-catalog` 和 `api contributions`。前者是两条插件路线共享 runtime API 的必要契约；后者是避免 runtime common 反向依赖 loader-specific 控制面的最小接缝。
