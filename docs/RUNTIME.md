# Runtime

`@pluxel/runtime` 是共同宿主层。它不应该只被理解成“动态插件生态”，而是承载宿主能力的 runtime：当前 runtime-dynamic 路线和 runtime-static 路线都复用这里的服务、协议和状态投影。

当前 `@pluxel/runtime` 与 `@pluxel/runtime-dynamic` 的拆分细节见 `RUNTIME_DYNAMIC_SPLIT.md`。

## 设计边界

runtime 拥有：

- runtime services 注册和宿主能力
- durable/ephemeral/readonly runtime persistence backend
- profile-aware config path
- route-neutral plugin catalog 契约
- 插件状态 read model
- Elysia HTTP routes、fetch mount 和 GraphQL HTTP capability
- optional web-management bundle：RPC、SSE、runtime web UI、management panel、`ctx.ext`
- optional vault bundle：`ctx.vault` 和 host-side vault bootstrap/admin
- plugin interaction contracts
- plugin UI runtime protocols
- browser host APIs、web config、workbench surfaces

loader/package/scan/package-manager/workspace tools 属于 `@pluxel/runtime-dynamic`，不是 runtime common 的内置能力。

runtime 不拥有：

- core 生命周期算法
- Vite runner/watch/moduleGraph
- HMR source semantics
- 构建期源码改写

route 实现可以改变 module/catalog 状态，但插件真正 start/stop 仍由 core commit 完成；runtime common 只承接 route-neutral 状态投影和控制面。

## 当前插件加载路线：loader route

当前实现是 loader-based：

```text
module id
-> exported plugin ctors
-> plugin name
-> runtime state enabled bit
-> core registry draft
-> core commit
```

这是当前已实现路线。它适合 workspace scan、package install、动态启停和 HMR 模块替换。它比企业 fixed catalog 的最低需求更重，重在：

- 要维护 module id 到 plugin ctor 的映射。
- 要支持 scan/package/cache/status 同步。
- 要处理模块替换、缺失依赖、enabled-but-stopped 等运行时状态。
- 要把动态目录的不确定性解释给 control-plane 和 workbench。

## 固定插件路线：runtime-static route

runtime-static route 是当前已实现的第二条 runtime 路线。它消费 `defineStaticRuntimeConfig({ plugins: [...] })` 产出的 fixed catalog，不做 workspace scan、package install、dynamic module registry 或 loader batch。static HMR 由 `@pluxel/runtime-static/vite` route 内部拥有：Vite SSR import 重新得到 definition 后，static route 按 plugin name diff catalog，再对受影响且 enabled 的插件提交 core lifecycle 计划。

两条路线的隔离方式是：

```text
runtime common host layer
  -> runtime-dynamic route  scan/package/dynamic module/HMR replaceModule
  -> runtime-static route   known catalog/definition diff/static HMR
```

两条路线不复制 core 生命周期，也不复制 runtime 的配置、web config、plugin UI protocols。共同逻辑留在 runtime common host layer；差异只放在 catalog resolution、startup policy 和 route-specific management 能力。

## Runtime 服务入口

- `packages/runtime/src/index.ts`：默认 plugin authoring/runtime common entry，只注册 static/common services。
- `packages/runtime/src/runtime/register/static.ts`：static production 默认服务注册。
- `packages/runtime/src/runtime/register/full.ts`：dynamic/dev common 注册入口，不包含 vault 或 web-management optional boundary。
- `packages/runtime/src/services/vault.ts`：显式 vault service boundary。
- `packages/runtime/src/services/web-management.ts`：显式 web-management service boundary。
- `packages/runtime/src/api/contributions.ts`：从当前 `Context.runtimeRoute.api` 读取 GraphQL resolver 和 route feature handle。
- `packages/runtime/src/plugin-catalog.ts`：route-neutral plugin catalog/status/source/capability 类型出口。
- `packages/runtime/src/runtime/capabilities.ts`：runtime common 使用的窄 route capabilities；缺少必需 capability 时会明确报错。
- `packages/runtime/src/services/persistence/PersistenceService.ts`：窄 runtime persistence service，config/state/plugin-data/logger/vault 通过 namespace 复用 backend。
  common runtime 不内置 Node fs backend；未显式提供 backend 时使用 memory backend，dynamic route 通过 workspace fs adapter 注入 durable backend。
- `packages/runtime/src/services/RuntimeStateStore.ts`：运行控制面状态持久化，包括 enabled、forks、base providers、依赖覆盖、builtin/plugin groups。
- `packages/runtime-static/src/index.ts`：static production direct launcher，导出 `defineStaticRuntimeConfig(...)` 和 `createStaticRuntime(config)`；factory 返回前已完成 startup，直接使用 `runtime.fetch`。
- `packages/runtime-static/src/vite.ts`：static Vite launcher，负责 SSR 加载同一份 runtime config、按需接入 web-management/dev UI bridge 和 HMR。
- `packages/runtime-dynamic/src/register.ts`：loader route services 注册副作用，并通过 `@pluxel/runtime/services/web-management` 显式接入 dynamic 开发管理面；不默认启用 vault。
- `packages/runtime-dynamic/src/index.ts`：dynamic dev/HMR direct launcher，导出 `defineDynamicRuntimeConfig(...)` 和 `createDynamicDevRuntime(config)`；`createDynamicRuntime(config)` 仅作为兼容别名保留。
- `packages/runtime-dynamic/src/vite.ts`：dynamic Vite launcher，负责 SSR 加载同一份 runtime config 和 loader HMR。
- `packages/runtime-dynamic/src/services.ts`：loader route services public surface。
- `packages/runtime-dynamic/src/loader/LoaderService.ts`：loader service 和 public loader API。
- `packages/runtime-dynamic/src/catalog/LoaderRuntimeRoute.ts`：把 loader registry/runtime/control 组装成 runtime route capabilities。
- `packages/runtime-dynamic/src/loader/PluginRegistry.ts`：loader declaration/status state。
- `packages/runtime-dynamic/src/loader/module-replacer.ts`：HMR/module replacement 接入 loader。
- `packages/runtime-dynamic/src/loader/support.ts`：loader batch/status/control helpers。
- `packages/runtime-dynamic/src/scan/ScanService.ts`：workspace/plugin entry 扫描。
- `packages/runtime-dynamic/src/package/PackageService.ts`：dynamic package facade，负责 ready/config/policy。
- `packages/runtime-dynamic/src/package/mutation.ts`：package install/remove/reinstall flows。
- `packages/runtime-dynamic/src/package/load-runtime.ts`：package load/retry/runtime cache flows。
- `packages/runtime-dynamic/src/package/inventory.ts`：package inventory/load issue read model。
- `packages/runtime-dynamic/src/api/features/package-manager/**`：loader-specific package inventory/load issues GraphQL 查询。
- `packages/runtime-dynamic/src/api/http/rpc/PackageManagerHandle.ts`：`packageManager` route feature 的 package install/remove/reload/retry 操作。
- `packages/runtime/src/services/ConfigService.ts`：runtime 配置持久化。
- `packages/runtime/src/api/usecases/**`：route-neutral plugin status/config/dependency/fork usecases。
- `packages/runtime/src/api/**`：route-neutral HTTP、RPC、feature APIs；loader package 通过当前 route feature 挂载 loader-specific 控制面。
- `packages/runtime/src/web/**`：browser/runtime web clients 和协议。

## 控制面原则

runtime 内部控制面使用明确的 usecase + RPC method。当前不提供 MCP transport；未来如果接入，也应复用这些 usecase 函数，而不是在内核里保留半套 carrier。

安全管理面继续走专用 security client，不并入 plugin control-plane RPC。

## 和 core/HMR 的关系

依赖方向是：

```text
core <- runtime common <- runtime-dynamic <- cli
```

runtime 依赖 core 来提交生命周期。loader route 依赖 runtime common 的配置、catalog 契约和宿主服务，并提供 scan/package/dynamic module 能力。loader HMR mode 是 dynamic Vite route 的内部 runtime wiring，并显式注册 loader route。runtime 不应该 import `@pluxel/runtime-dynamic/hmr`；loader HMR 不应该重新定义 runtime 协议。
