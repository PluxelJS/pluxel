# @pluxel/runtime — Implementation Index

## Runtime entry

- `src/index.ts`：唯一插件作者入口，并加载常驻 runtime services；
- `src/services/index.ts`：常驻 service 注册清单；
- `src/services/vault.ts`：显式启用的 optional Vault capability；
- `src/services/workbench.ts`：宿主显式安装的 optional Workbench backend。

## Workbench Plane

- `src/workbench/contracts.ts`：module、resource、view、port、layout contract；
- `src/workbench/runtime.ts`：server bindings 与 mount；
- `src/workbench/ui-runtime.tsx`：browser typed resource client；
- `src/services/workbench/WorkbenchService.ts`：Context-isolated gate；
- `src/services/workbench/WorkbenchRegistry.ts`：target layout、relations、opaque grants、revision；
- `src/services/workbench/WorkbenchArtifactService.ts`：artifact store；
- `src/services/workbench/resources/`：RPC、live query、events 实现；
- `src/api/http/workbench.ts`：catalog/layout/artifact/resource/event routes。

## 常驻服务

- `src/services/http/HttpService.ts`：HTTP 与 UI assets；
- `src/services/DatabaseService.ts`：database instance registry、lineage promotion、PostgreSQL/PGlite 与 invalidation；
- `src/services/admin-access/AdminAccessService.ts`：host admin gate；
- `src/services/vault/VaultService.ts`：加密存储；
- `src/services/persistence/PersistenceService.ts`：persistence backend；
- `src/services/ConfigService.ts`：配置读写；
- `src/api/http/rpc/RuntimeRpcApi.ts`：host control-plane 与 bound Workbench API dispatch。

## Browser

- `src/web/client.ts`：HTTP/RPC/SSE transport；
- `src/web/rpc.ts`：request-scoped Cap'n Web proxy；
- `src/web/host-ui.ts`：Workbench context 与 placement types；
