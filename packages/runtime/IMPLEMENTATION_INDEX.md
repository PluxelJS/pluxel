# @pluxel/runtime — Implementation Index (for LLM)

目标：用最少的跳转把 “runtime kernel 的实现在哪里、边界在哪里、关键依赖链是什么” 讲清楚。

维护约束与设计目标（仓库级）见：

- `docs/ARCHITECTURE.md`
- `docs/PACKAGING.md`
- `docs/AGENT_RULES.md`

## Public Surface (package exports)

- `packages/runtime/package.json`
  - `.` → `packages/runtime/src/index.ts`
  - `./services` → `packages/runtime/src/services.ts`
  - `./logger` → `packages/runtime/src/logger.ts`
  - `./web` → `packages/runtime/src/web.ts`
  - `./web/ui` → `packages/runtime/src/web/ui.ts`
  - `./web/extensions` → `packages/runtime/src/web/extensions.ts`
  - `./web/federation` → `packages/runtime/src/web/federation.ts`
  - `./web/paths` → `packages/runtime/src/web/paths.ts`
  - `./capnweb` → `packages/runtime/src/capnweb.ts`
  - `./frozen` → `packages/runtime/src/frozen.ts`
  - `./shared` → `packages/runtime/src/shared.ts`
  - `./internal` → `packages/runtime/src/internal.ts`

## Runtime Entry / Service Registration

- `packages/runtime/src/index.ts`
  - 设置进程级 runtime 标记：`setPluxelRuntime('core')`
  - `import './runtime/register'`：注册 runtime services（依赖注入/Context augmentation）
  - 公开导出：最小 plugin authoring surface（`Context` / `Plugin` / `BasePlugin` …）+ `Config()` decorator

- `packages/runtime/src/services.ts`
  - `@pluxel/runtime/services`：runtime services（loader/package/http/config/scan…）+ 部分类型
  - 约束：dev-only 的 compile helpers 不在这里导出（改放到 `@pluxel/runtime/internal`）

- `packages/runtime/src/runtime/register.ts`
  - side-effect imports：把各 Service 的 `@Injectable` 注册进 `Context`
  - 这是“只要 import @pluxel/runtime 就能 new Context() 拿到服务”的关键。

## Core Services (入口文件)

- HTTP / Control Plane
  - `packages/runtime/src/services/http/HttpService.ts`：`ctx.http.fetch`、内部 API mount、UI 静态资源策略
  - `packages/runtime/src/services/http/internalApi.ts`：内部 API route 组装
  - `packages/runtime/src/server/ui-public.ts`：`/dist/public/*` 静态资源 handler

- Config
  - `packages/runtime/src/services/ConfigService.ts`：config 读写/readonly snapshot/profile path

- Loader / Package / Scan
  - `packages/runtime/src/services/runtime/loader/LoaderService.ts`
  - `packages/runtime/src/services/runtime/package/PackageService.ts`
  - `packages/runtime/src/services/runtime/scan/ScanService.ts`
  - `packages/runtime/src/services/runtime/scan/types.ts`：Scan/Package 共用 contracts（options/types/guards），避免跨服务 import 实现文件

- Plugin interaction (UI/RPC/SSE/Extension)
  - `packages/runtime/src/services/plugin-interaction/*`

## Web SDK / Protocol

- `packages/runtime/src/web.ts` + `packages/runtime/src/web/*`
  - 浏览器侧协议常量、RPC/SSE 客户端、plugin UI contract（历史上叫 `hmr-web`，现在归并为 `@pluxel/runtime/web`）
  - 公开入口：`@pluxel/runtime/web`

## Frozen Host Generator

- `packages/runtime/src/frozen.ts`
  - `buildFrozenHost()`：生成一个“冻结 Context 导出”的 `.mjs`，用于无 HMR 的部署场景
  - 类型：`packages/runtime/src/runtime/contracts.ts`

## Internal / Shared (给 @pluxel/hmr 用)

- `packages/runtime/src/internal.ts`
  - `dev-handles`：HMR 在 ctx 上挂 handle（`setDevRuntimeHandles` 等）
  - `module-runtime`：runtime module cache adapter（给 HMR runner 使用）
  - `paths`：storage/layout/profile materialize helpers（HMR host 与脚本复用）
  - dev-only compile helpers（给 `@pluxel/hmr` 复用，不扩张 public `services` surface）
    - `ExtensionModuleStore`
    - `normalizeJsxRuntime` / `toBrowserBundleResolve` / `transformVendorImports`

- `packages/runtime/src/shared.ts`
  - 纯工具与可复用策略：cache/conditions/exsolve/resolution/vite-id/missing-deps 等
  - 约束：不依赖 Vite dev server；允许存在 “Vite id 形态” 的字符串工具（仅协议层）

## Tests (runtime-only)

- `packages/runtime/tests/runtime/dynamic-host.test.ts`：验证 `new Context()` + service config 的最小可用性
- `packages/runtime/tests/runtime/host-paths.test.ts`：storage/profile path helpers
- `packages/runtime/tests/web/public-surface-compat.test.ts`：验证 `@pluxel/runtime/web` 的导出与内部实现一致
- `packages/runtime/tests/web/rpcExtensionsView.test.ts`：`createUiRpcView()` 行为与缓存/释放语义
