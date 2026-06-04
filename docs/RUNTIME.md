# Runtime

`@pluxel/runtime` 是共同宿主层。它不应该只被理解成“动态插件生态”，而是承载宿主能力的 runtime：动态 loader 路线和未来 fixed catalog/static suite 路线都应该复用这里的服务、协议和状态投影。

当前 `@pluxel/runtime` 与 `@pluxel/runtime-loader` 的拆分细节见 `RUNTIME_LOADER_SPLIT.md`。

## 设计边界

runtime 拥有：

- runtime services 注册和宿主能力
- file/memory/readonly 配置持久化
- profile-aware config path
- route-neutral plugin catalog 契约
- 插件状态 read model
- HTTP/control-plane routes
- ops catalog 和 invocation boundary
- MCP/RPC/SSE/runtime web APIs
- plugin interaction services
- plugin UI runtime protocols
- browser host APIs、web config、workbench surfaces

loader/package/scan/package-manager/workspace tools 属于 `@pluxel/runtime-loader`，不是 runtime common 的内置能力。

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
-> enabled config bit
-> core registry draft
-> core commit
```

这是当前已实现路线。它适合 workspace scan、package install、动态启停和 HMR 模块替换。它比企业 fixed catalog 的最低需求更重，重在：

- 要维护 module id 到 plugin ctor 的映射。
- 要支持 scan/package/cache/status 同步。
- 要处理模块替换、缺失依赖、enabled-but-stopped 等运行时状态。
- 要把动态目录的不确定性解释给 control-plane 和 workbench。

## 未来插件加载路线：static suite route

static suite route 还没有实现，不能从本文件推断为当前 API。它应该只作为 runtime 的第二条 catalog/startup 路线存在，详细设计写在 `proposals/runtime-routes.md`，并由 `proposals/README.md` 索引。

两条路线的隔离方式应该是：

```text
runtime common host layer
  -> loader route        当前实现：scan/package/dynamic module/HMR replaceModule
  -> static suite route  未来提案：known catalog/strict startup/bounded HMR
```

两条路线不应该复制 core 生命周期，也不应该复制 runtime 的配置、ops、web config、plugin UI protocols。共同逻辑留在 runtime common host layer；差异只放在 catalog resolution、startup policy 和 HMR submission adapter。

## Runtime 服务入口

- `packages/runtime/src/index.ts`：runtime public entry。
- `packages/runtime/src/runtime/register.ts`：runtime common services 注册副作用，不自动注册 loader route。
- `packages/runtime/src/services.ts`：runtime common services public surface。
- `packages/runtime/src/api/contributions.ts`：route package 对 GraphQL resolver、RPC handle、MCP tools 的最小注册点。
- `packages/runtime/src/plugin-catalog.ts`：route-neutral plugin catalog 契约和共享 extra keys。
- `packages/runtime/src/services/runtime/catalog/RuntimePluginCatalogService.ts`：runtime common 使用的插件 catalog 契约；没有 route 实现时会明确报错。
- `packages/runtime-loader/src/register.ts`：loader route services 注册副作用。
- `packages/runtime-loader/src/services.ts`：loader route services public surface。
- `packages/runtime-loader/src/loader/LoaderService.ts`：loader service 和 public loader API。
- `packages/runtime-loader/src/catalog/LoaderPluginCatalogService.ts`：把 loader registry/runtime/control 适配到 runtime plugin catalog 契约。
- `packages/runtime-loader/src/loader/PluginRegistry.ts`：loader declaration/status state。
- `packages/runtime-loader/src/loader/module-replacer.ts`：HMR/module replacement 接入 loader。
- `packages/runtime-loader/src/loader/support.ts`：loader batch/status/control helpers。
- `packages/runtime-loader/src/scan/ScanService.ts`：workspace/plugin entry 扫描。
- `packages/runtime-loader/src/package/PackageService.ts`：package install/remove/cache flows。
- `packages/runtime-loader/src/api/features/package-manager/**`：loader-specific package inventory/load issues GraphQL 查询。
- `packages/runtime-loader/src/api/http/rpc/PackageManagerHandle.ts`：`rpc.package()` 的 package install/remove/reload/retry 操作。
- `packages/runtime-loader/src/api/mcp/workspace-tools.ts`：`workspace.resolveEntry` / `workspace.listEntries` MCP dev tools。
- `packages/runtime/src/services/ConfigService.ts`：runtime 配置持久化。
- `packages/runtime/src/services/ops/OpsService.ts`：runtime op registry。
- `packages/runtime/src/api/**`：route-neutral HTTP、ops、MCP、feature APIs；loader package 通过 contribution registry 挂载 loader-specific 控制面。
- `packages/runtime/src/web/**`：browser/runtime web clients 和协议。

## 控制面原则

runtime 内部控制面统一建模为 operation。CLI、RPC、MCP、workbench 应该投影同一套 op registry，避免形成多套语义相近但行为不同的插件 handle。

安全管理面是例外：security/vault admin 走专用 security client，不并入 runtime canonical plugin/config ops。

## 和 core/HMR 的关系

依赖方向是：

```text
core <- runtime common <- runtime-loader <- hmr <- cli
```

runtime 依赖 core 来提交生命周期。loader route 依赖 runtime common 的配置、catalog 契约和宿主服务，并提供 scan/package/dynamic module 能力。HMR attach 到已有 runtime `Context`，并显式注册 loader route。runtime 不应该 import HMR；HMR 不应该重新定义 runtime 协议。
