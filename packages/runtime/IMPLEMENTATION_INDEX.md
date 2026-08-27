# @pluxel/runtime — Implementation Index

## Runtime entry

- `src/index.ts`：唯一插件作者入口，并加载封闭的 Runtime Context contract；
- `src/context/runtime-plan.ts`：immutable capability plan 与常驻/可选能力安装；
- `src/services/vault.ts`：显式启用的 optional Vault capability；
- `src/services/workbench.ts`：宿主显式安装的 optional Workbench backend。

## Workbench Plane

- `src/workbench/contracts.ts`：module、resource、view、port、layout contract；
- `src/workbench/runtime.ts`：server bindings 与 mount；
- `src/workbench/ui-runtime.tsx`：browser typed resource client 与 host-injected View runtime；
- `src/workbench/ui-pane.tsx`：public Pane Kit declaration、契约校验与 host renderer bridge；
- `src/services/workbench/WorkbenchService.ts`：Context-isolated gate；
- `src/services/workbench/WorkbenchRegistry.ts`：target layout、relations、opaque grants、revision；
- `src/services/workbench/WorkbenchArtifactService.ts`：artifact store；
- `src/services/workbench/resources/`：RPC、live query、events 实现；
- `src/api/http/workbench.ts`：catalog/layout/artifact/resource/event routes。

## 常驻服务

- `src/services/http/ElysiaApplicationDirectory.ts`：generation-scoped native Elysia app、finalization、exact declared route settlement、
  immutable business dispatcher、owner HTTP/stream/WS admission 与原子 publication；
- `src/services/http/elysia-application-carrier.ts`：runtime-private physical carrier seam，只包含 metadata、request IP、WS upgrade/
  publish/pending；
- `src/context/runtime-http-capability.ts`：host-only HTTP backend resolver；Plugin Context 不投影 `HttpService`；
- `src/services/http/HttpService.ts`：host-only control plane、business directory dispatch 与 UI assets/fallback；
- `../runtime-node/src/node-elysia-application-carrier.ts`：srvx `NodeRequest` + crossws + Elysia public WS handler 的 Node carrier；
- `../runtime-dev/src/vite-node-carrier.ts`：复用 srvx Node handler 的 Vite Fetch/upgrade binding，保留 Vite HMR arbitration；
- `src/services/DatabaseService.ts`：database instance registry、lineage promotion、PostgreSQL/PGlite 与 invalidation；
- `src/services/admin-access/AdminAccessService.ts`：host admin gate；
- `src/services/vault/VaultService.ts`：加密存储；
- `src/services/persistence/PersistenceService.ts`：persistence backend；
- `src/services/ConfigService.ts`：配置读写；
- `src/api/http/rpc/RuntimeRpcApi.ts`：host control-plane 与 bound Workbench API dispatch。

### Native Elysia HTTP 当前边界

- `ctx.elysia` 是 Elysia `2.0.0-beta.7` 真实 instance，Plugin/Parts 共享 owning generation app；
- finalizer 等待 `app.modules`、读 public `app.routes`、attach owner Server view 并调用 native `app.compile()`/seal；
- settlement 只拒绝 `kind + method + declared path` exact collision，canonical-equivalent matcher collision 尚未实现；
- Node production 和 Node-backed Vite 已有 HTTP/stream/WS carrier，Bun/Deno 第二 carrier 与 portable WS conformance 尚未完成；
- `app.setup()` / `app.cleanup()` 因 beta.7 无 public external attach/detach epoch 而 fail-fast；
- dynamic singleton bridge 已统一 Elysia runtime identity，Plugin package peer-range admission 尚未进入 common catalog。

## Node artifact 与共享 worker

- `src/node-artifact/node-module.ts`：opaque Node module declaration 与 setup/cleanup contract；
- `src/node-artifact/NodeModuleService.ts`：owner lease、staged replacement 与 packaged/source artifact resolution；
- `src/node-artifact/worker-task.ts`：typed worker specialization、稳定错误与 host pool config contract；
- `src/node-artifact/WorkerTaskService.ts`：root shared pool、bounded fair admission、cancellation 与 shutdown。

## Browser

- `src/web/client.ts`：Level 1 discovery 与 stateless Management domain client；
- `src/web/transport-client.ts`：internal View-host layout、SSE、grant session 与清理；
- `src/web/rpc.ts`：internal request-scoped Cap'n Web proxy；
- `src/workbench/ui-runtime.tsx`：Remote View environment、host capabilities 与 resource clients；
- `../workbench-app/src/app/workbench/RemotePaneLayout.tsx`：host-owned Pane Kit geometry、responsive drawer 与 state adapter；
- `../workbench-app/src/workbench/client.ts`：browser catalog、target snapshot、route index 与 staged module lease；
