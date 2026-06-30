# @pluxel/runtime — Implementation Index

目标：快速定位 runtime kernel 的公开面和关键实现。

## Runtime Entry

- `packages/runtime/src/index.ts`
  runtime 入口
- `packages/runtime/src/runtime/register.ts`
  side-effect 注册 `Context` services

## Core Services

- `packages/runtime/src/services/http/HttpService.ts`
  HTTP / control plane / UI assets
- `packages/runtime/src/services/verification/VerificationService.ts`
  host verification gate
- `packages/runtime/src/services/vault/VaultService.ts`
  `ctx.vault` 存储面与 host-only `ctx.root.vaultAdmin`
- `packages/runtime/src/services/security/identity.ts`
  `data/security/identity.json` 读写
- `packages/runtime/src/services/ConfigService.ts`
  配置读写
- `packages/runtime/src/plugin-catalog.ts`
  route-neutral plugin catalog 契约
- `packages/runtime/src/api/contributions.ts`
  route package 挂载 GraphQL/RPC 控制面的最小注册点
- `packages/runtime-dynamic/src/loader/LoaderService.ts`
  loader route 插件加载
- `packages/runtime-dynamic/src/package/PackageService.ts`
  loader route 包管理 facade
- `packages/runtime-dynamic/src/package/mutation.ts`
  package install/remove/reinstall flow
- `packages/runtime-dynamic/src/package/load-runtime.ts`
  package load/retry/runtime cache flow
- `packages/runtime-dynamic/src/package/inventory.ts`
  package inventory/load issue read model
- `packages/runtime-dynamic/src/scan/ScanService.ts`
  loader route workspace scan

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

## Control Plane

- `packages/runtime/src/api/usecases/pluginStatus.ts`
  插件生命周期批量操作
- `packages/runtime/src/api/usecases/pluginConfig.ts`
  插件 schema/config 读取、校验和 patch
- `packages/runtime/src/api/usecases/pluginDependencies.ts`
  插件依赖、base provider、fork 相关操作
- `packages/runtime/src/api/http/rpc/RuntimeRpcApi.ts`
  host control-plane 的具体 RPC 方法入口

## Host Security

- `packages/runtime/HOST_VERIFICATION_DESIGN.md`
  安全模型与原则
- `packages/runtime/src/api/http/security.ts`
  host-only security 管理 API
- `packages/runtime/src/api/http/meta.ts`
  verification state snapshot
- `packages/runtime/src/services/http/internalApi.ts`
  internal API verification gate
- `packages/runtime/src/services/vault/加密实现规范.md`
  vault 使用边界

## Web Surface

- `packages/runtime/src/web/client.ts`
  transport client、HTTP links、RPC/SSE 接入
- `packages/runtime/src/web/rpc.ts`
  RPC client/session helper
- `packages/runtime/src/web/protocol.ts`
  浏览器/服务端共享协议类型
- `packages/runtime/src/web/react.tsx`
  transport provider
- `packages/runtime/src/web/federation.ts`
  MF remote/shared contract
- `packages/runtime/src/web/plugin-ui/*`
  UI authoring helpers / signaldb hooks

## Tests

- `packages/runtime/tests/services/vault-service.test.ts`
  vault 状态、密钥与预检
- `packages/runtime/tests/verification/host-verification-flow.test.ts`
  verification gate 与 security API
