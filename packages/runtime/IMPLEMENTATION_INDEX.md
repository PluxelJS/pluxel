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

SignalDB 前后端链路：

- `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`
  服务端 authoritative collection、SSE 广播、HTTP sync entry
- `packages/runtime/src/web/plugin-ui/signaldb-runtime.ts`
  浏览器 replica、`SyncManager` 集成、React hooks

## Web Surface

- `packages/runtime/src/web/ui.ts`
  插件 UI public surface
- `packages/runtime/src/web/client.ts`
  runtime transport client、HTTP links、RPC/SSE 接入
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

- `packages/runtime/tests/extension/extension-service-boundary.test.ts`
  plugin UI runtime/build 边界
- `packages/runtime/tests/extension/signaldb-service.test.ts`
  signaldb collection/sync 语义
- `packages/runtime/tests/web/public-subpath-surfaces.test.ts`
  public subpath surface 稳定性
- `packages/runtime/tests/web/demo-plugin-ui-contract.test.ts`
  demo UI contract 稳定性
