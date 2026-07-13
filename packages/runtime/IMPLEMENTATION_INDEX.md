# @pluxel/runtime — Implementation Index

## Runtime entry

- `src/index.ts`：插件作者与常驻 runtime；
- `src/runtime/register/static.ts`：common service registration；
- `src/runtime/register/full.ts`：dynamic/dev common registration；
- `src/services/management.ts`：宿主显式安装的 optional Management backend。

## Management Plane

- `src/management/contracts.ts`：module、resource、view、port、layout contract；
- `src/management/runtime.ts`：server bindings 与 mount；
- `src/management/ui-runtime.tsx`：browser typed resource client；
- `src/services/management/ManagementService.ts`：Context-isolated gate；
- `src/services/management/ManagementRegistry.ts`：target layout、relations、opaque grants、revision；
- `src/services/management/ManagementArtifactService.ts`：artifact store；
- `src/services/management/resources/`：API、collection、stream 实现；
- `src/api/http/management.ts`：catalog/layout/artifact/resource/event routes。

## 常驻服务

- `src/services/http/HttpService.ts`：HTTP 与 UI assets；
- `src/services/admin-access/AdminAccessService.ts`：host admin gate；
- `src/services/vault/VaultService.ts`：加密存储；
- `src/services/persistence/PersistenceService.ts`：persistence backend；
- `src/services/ConfigService.ts`：配置读写；
- `src/api/http/rpc/RuntimeRpcApi.ts`：host control-plane 与 bound Management API dispatch。

## Browser

- `src/web/client.ts`：HTTP/RPC/SSE transport；
- `src/web/rpc.ts`：request-scoped Cap'n Web proxy；
- `src/web/host-ui.ts`：Workbench context 与 placement types；
- `src/management/federation.ts`：Management remote shared contract。
