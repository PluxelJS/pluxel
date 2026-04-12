# @pluxel/runtime — Implementation Index

目标：快速定位 runtime kernel 的边界、公开面和关键实现。

前端整条链路说明见：

- [`docs/architecture/frontend.md`](../../docs/architecture/frontend.md)

## Package Exports

- `packages/runtime/package.json`
- `packages/runtime/src/index.ts`
- `packages/runtime/src/services.ts`
- `packages/runtime/src/web.ts`
- `packages/runtime/src/internal.ts`

## Runtime Entry

- `packages/runtime/src/index.ts`
  runtime 入口；设置 runtime 标记并注册 services
- `packages/runtime/src/runtime/register.ts`
  side-effect 注册 `Context` services

## Core Services

- `packages/runtime/src/services/http/HttpService.ts`
  HTTP / control plane / UI assets
- `packages/runtime/src/services/ConfigService.ts`
  配置读写
- `packages/runtime/src/services/runtime/loader/LoaderService.ts`
  插件加载
- `packages/runtime/src/services/runtime/package/PackageService.ts`
  包管理
- `packages/runtime/src/services/runtime/scan/ScanService.ts`
  workspace scan
- `packages/runtime/src/services/PluginDataService.ts`
  插件持久化数据

## Plugin Interaction

- `packages/runtime/src/services/plugin-interaction/ExtService.ts`
  `ctx.ext` 聚合入口
- `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
  packaged UI remote + builtin/doc 扩展
- `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`
  runtime-owned collection + sync transport
- `packages/runtime/src/services/plugin-interaction/RpcService.ts`
  RPC 暴露
- `packages/runtime/src/services/plugin-interaction/SseService.ts`
  SSE 暴露

这一组文件就是插件前端运行时语义的核心：

- `ctx.ext.ui`
  注册 packaged remote 或 host-rendered doc
- `ctx.ext.signaldb`
  提供状态同步 collection
- `ctx.ext.rpc` / `ctx.ext.sse`
  提供自定义 UI 的命令式交互通道

## Control Plane

- `packages/runtime/src/services/ops/OpsService.ts`
  `ctx.ops`；runtime / plugin / RPC / MCP / CLI 共享的 operation kernel，`ctx.ops.toolsets` 收敛 host-owned toolset 组织层
- `ctx.ops`
  runtime control-plane 的唯一能力入口；注册、列举、调用、CLI dispatch 和 toolset 组织层都从这里走

SignalDB 前后端链路：

- `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`
  服务端 authoritative collection、SSE 广播、HTTP sync entry
- `packages/runtime/src/web/plugin-ui/signaldb-runtime.ts`
  浏览器 replica、`SyncManager` 集成、React hooks

## Control Plane Ops

- `packages/runtime/src/api/ops/index.ts`
  runtime ops 的唯一聚合入口；负责注册、列举、调用与 CLI dispatch
- `packages/runtime/src/api/ops/plugin-status.ts`
  插件生命周期与状态类 op
- `packages/runtime/src/api/ops/plugin-dependencies.ts`
  插件依赖、base provider、fork 相关 op
- `packages/runtime/src/api/ops/plugin-config.ts`
  插件 schema/config/批处理配置 op
- `packages/runtime/src/api/ops/runtime-meta.ts`
  runtime 自省 op（列举/调用/dispatch）
- `packages/runtime/src/api/ops/schemas.ts`
  这组 op 共用的 schema contract
- `packages/runtime/src/api/ops/helpers.ts`
  这组 op 共用的少量批处理/错误辅助逻辑

`api/ops/*` 只负责 control-plane contract 和装配；实际业务逻辑继续下沉在 `packages/runtime/src/api/usecases/*`。

## MCP Carrier

- `packages/runtime/src/api/mcp/index.ts`
  MCP HTTP 入口；只负责 server/transport 装配
- `packages/runtime/src/api/mcp/ops-carrier.ts`
  把 `ctx.ops` 中已注册的 tool-visible op 投影成 MCP tools；不再维护第二套语义层
- `packages/runtime/src/api/mcp/dev-tools.ts`
  HMR / logs / workspace 等 runtime dev tools 注册
- `packages/runtime/src/api/mcp/shared.ts`
  MCP 响应与 schema 适配共用小工具

这里的原则是：

- runtime ops 仍然是 canonical control-plane API
- MCP 只是 carrier / host，不再是另一套 command 设计中心

## Web Surface

- `packages/runtime/src/web/ui.ts`
  插件 UI public surface
- `packages/runtime/src/web/client.ts`
  runtime transport client、HTTP links、RPC/SSE 接入
- `packages/runtime/src/web/rpc.ts`
  浏览器侧 canonical runtime ops client helper（`listRuntimeOps` / `invokeRuntimeOp` / `dispatchRuntimeCommand`）
- `packages/runtime/src/web/react.tsx`
  host-owned transport provider
- `packages/runtime/src/web/protocol.ts`
  浏览器/服务端共享协议类型与插件 UI augmentation contract
- `packages/runtime/src/web/extensions.ts`
  builtin/doc contract
- `packages/runtime/src/web/federation.ts`
  MF remote 名称、manifest 路径、shared contract
- `packages/runtime/src/web/plugin-ui/*`
  UI contract / authoring helpers / signaldb hooks

主要文件：

- `authoring.ts`
  插件 UI 浏览器侧 helper；解决的是“组件里怎么更顺手地拿 transport/rpc/signaldb”
- `client.ts`
  transport 客户端本体；浏览器低层入口
- `rpc.ts`
  runtime 通用 ops RPC helper；不再暴露 plugin-specific RPC handle
- `react.tsx`
  transport provider / hook；给宿主 app 提供唯一 transport 实例
- `signaldb-runtime.ts`
  浏览器侧 signaldb collection/doc hooks
- `federation.ts`
  MF remote 名称、manifest、shared contract

## Frozen / Internal / Shared

- `packages/runtime/src/frozen.ts`
  frozen host 构建
- `packages/runtime/src/internal.ts`
  runtime 与 hmr 的内部 glue
- `packages/runtime/src/shared.ts`
  纯工具与复用策略

## Tests

- `packages/runtime/tests/services/ops-service.test.ts`
  `ctx.ops` 服务边界与 descriptor/CLI help 稳定性
- `packages/runtime/tests/services/runtime-ops.test.ts`
  runtime plugin ops 的主流程与批处理语义
- `packages/runtime/tests/extension/extension-service-boundary.test.ts`
  plugin UI runtime/build 边界
- `packages/runtime/tests/extension/signaldb-service.test.ts`
  signaldb collection/sync 语义
- `packages/runtime/tests/web/public-subpath-surfaces.test.ts`
  public subpath surface 稳定性
- `packages/runtime/tests/web/demo-plugin-ui-contract.test.ts`
  demo UI contract 稳定性
