# @pluxel/runtime — Implementation Index

## Runtime entry

- `src/index.ts`：唯一 Plugin 作者入口，并加载封闭的 Runtime Context plan；
- `src/context/runtime-plan.ts`：immutable capability plan 与常驻/可选能力安装；
- `src/services/vault.ts`：显式启用的 optional Vault capability；
- `src/services/workbench.ts`：host 显式安装的 optional Workbench backend。

## Workbench author/runtime boundary

- `src/workbench/definition.ts`：Direct View、Attachment、placement、entry 和 exact binding types；
- `src/workbench/definition.type-probes.ts`：作者面 inference/variance 静态探针；
- `src/workbench/client-protocol.ts`：capability-free layout 与 `openView()` wire types；
- `src/workbench/client.ts`：layout validation、single-owner opened handle 和 `createRemoteValue()`；
- `src/workbench/react-context.tsx`：generated Bridge 内部 Context 与受限 host facade；
- `src/workbench/react.tsx`：作者 `useWorkbench(exactDescriptor)`、`useRemoteValue()` 和 Pane Kit exports；
- `src/workbench/react-internal.tsx`：toolchain-generated Bridge wrapper、payload/provider identity validation；
- `src/workbench/federation.ts`：页面唯一 MF Runtime、fixed shared、Bridge activation 与 per-open host handle；
- `src/workbench/ui-pane.tsx`：public Pane Kit declaration 与 host renderer boundary。

## Workbench server

- `src/services/workbench/WorkbenchService.ts`：owner-pinned `publish()` capability，并拒绝 PluginPart publication；
- `src/services/workbench/WorkbenchRegistry.ts`：generation publication、global/target layout、Attachment resolution、
  per-open owner invocation leases 与 fresh target factories；
- `src/services/workbench/WorkbenchSessionTarget.ts`：一个 authenticated socket epoch 的 layout/opened-root owner；
- `src/services/workbench/WorkbenchArtifactService.ts`：已验证 immutable MF producer revision inventory；
- `src/services/workbench/packaged-artifact.ts`：production `pluxel-workbench-producers.json` loader；
- `src/api/http/workbench.ts`：Workbench document、standard MF output 和 fixed Runtime WebSocket ingress。

## Runtime session 与 Management

- `src/web/session/protocol.ts`：authentication-required / management / workbench bootstrap union 和 invalidation event；
- `src/web/session/client.ts`：document-unique、non-reconnecting Cap’n Web WebSocket client；
- `src/web/session/server.ts`：same-socket auth → ready bootstrap、Management/Workbench root ownership 和 epoch close；
- `src/web/session/ingress.ts`：`/__pluxel/runtime/session` physical WebSocket ingress；
- `src/web/session/elysia-websocket.ts`：Elysia/crossws adapter；
- `src/web/management-target.ts`：portable Management target types；
- `src/services/management/RuntimeManagementTarget.ts`：server Management `RpcTarget`；
- `src/web/logs.ts`：range/follow observer client；
- `src/web/management-validation.ts`：browser boundary validation、clone 和 freeze。

## 常驻服务

- `src/services/http/ElysiaApplicationDirectory.ts`：generation-scoped native Elysia app、finalization、exact declared route settlement、
  immutable business dispatcher、owner HTTP/stream/WS admission 与原子 publication；
- `src/services/http/elysia-application-carrier.ts`：runtime-private physical carrier seam，只包含 metadata、request IP、WS upgrade/
  publish/pending；
- `src/context/runtime-http-capability.ts`：host-only HTTP backend resolver；Plugin Context 不投影 `HttpService`；
- `src/services/http/HttpService.ts`：host-only control plane、business directory dispatch 与 UI/MF assets；
- `../runtime-node/src/node-elysia-application-carrier.ts`：srvx `NodeRequest` + crossws + Elysia public WS handler 的 Node carrier；
- `../runtime-dev/src/vite-node-carrier.ts`：复用 srvx Node handler 的 Vite Fetch/upgrade binding，保留 Vite HMR arbitration；
- `src/services/DatabaseService.ts`：database instance registry、lineage promotion、PostgreSQL/PGlite 与 table invalidation；
- `src/services/admin-access/AdminAccessService.ts`：Management authentication authority；
- `src/services/vault/VaultService.ts`：加密存储；
- `src/services/persistence/PersistenceService.ts`：persistence backend；
- `src/services/ConfigService.ts`：配置读写。

## Node module 与共享 worker

- `src/node-artifact/node-module.ts`：opaque Node module declaration 与 setup/cleanup API；
- `src/node-artifact/NodeModuleService.ts`：owner lease、staged replacement 与 packaged/source resolution；
- `src/node-artifact/worker-task.ts`：typed worker specialization、稳定错误与 host pool config；
- `src/node-artifact/WorkerTaskService.ts`：root shared pool、bounded fair admission、cancellation 与 shutdown。

## Shell integration

- `../workbench-app/src/client.tsx`：document-unique session/bootstrap 与 authentication flow；
- `../workbench-app/src/workbench/client.ts`：layout read、View open 和 invalidation projection；
- `../workbench-app/src/workbench/runtime.tsx`：Bridge activation/cleanup 与 reload boundary；
- `../workbench-app/src/app/workbench/RemotePaneLayout.tsx`：host-owned Pane Kit geometry 与 responsive drawer。

完整不变量见 [`../../engineering/WORKBENCH.md`](../../engineering/WORKBENCH.md)。
