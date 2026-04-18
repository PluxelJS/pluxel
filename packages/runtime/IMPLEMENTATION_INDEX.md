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
- `packages/runtime/src/services/runtime/loader/LoaderService.ts`
  插件加载
- `packages/runtime/src/services/runtime/package/PackageService.ts`
  包管理
- `packages/runtime/src/services/runtime/scan/ScanService.ts`
  workspace scan

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

- `packages/runtime/src/services/ops/OpsService.ts`
  `ctx.ops`；runtime / plugin / RPC / MCP / CLI 共用的 operation kernel
- `packages/runtime/src/api/ops/index.ts`
  runtime ops 聚合入口
- `packages/runtime/src/api/ops/plugin-status.ts`
  插件生命周期与状态类 op
- `packages/runtime/src/api/ops/plugin-dependencies.ts`
  插件依赖、base provider、fork 相关 op
- `packages/runtime/src/api/ops/plugin-config.ts`
  插件 schema/config/批处理配置 op
- `packages/runtime/src/api/ops/runtime-meta.ts`
  runtime 自省 op

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
  runtime ops 浏览器 helper
- `packages/runtime/src/web/protocol.ts`
  浏览器/服务端共享协议类型
- `packages/runtime/src/web/react.tsx`
  transport provider
- `packages/runtime/src/web/federation.ts`
  MF remote/shared contract
- `packages/runtime/src/web/plugin-ui/*`
  UI authoring helpers / signaldb hooks

## Tests

- `packages/runtime/tests/services/runtime-ops.test.ts`
  runtime ops 主流程
- `packages/runtime/tests/services/vault-service.test.ts`
  vault 状态、密钥与预检
- `packages/runtime/tests/verification/host-verification-flow.test.ts`
  verification gate 与 security API
