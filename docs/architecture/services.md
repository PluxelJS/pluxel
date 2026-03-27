# Services (Runtime vs HMR)

目标：把 `@pluxel/runtime` 与 `@pluxel/hmr` 的 services 职责边界写清楚，避免 “dev-only 逻辑渗透到 kernel” 或 “kernel 反向依赖 Node/Vite”。

## 总原则

- `@pluxel/runtime` 是 **runtime kernel**：提供稳定协议与服务能力（HTTP/control plane、loader/package/scan、plugin-interaction、logging…）。
- `@pluxel/hmr` 是 **dev host wrapper**：workspace diagnose + Vite dev server + runner + watch + dev-only 编译管线。
- `@pluxel/build` 不是 service 容器；它只做 build-time rewrite / overlay。
- 依赖方向只允许：`@pluxel/core` → `@pluxel/runtime` → `@pluxel/hmr`。
- “启动时决定一切”：`attachHmrRuntime()` 是一次性 wiring，不做运行时切换/回滚。

如果你在追“插件前端整条链路”，这份文档只负责 service 边界；完整说明看：

- `docs/FRONTEND_ARCHITECTURE.md`

## @pluxel/runtime 服务概览

入口与导出：

- `@pluxel/runtime`：import 后即可 `new Context()`（side-effect 注册见 `packages/runtime/src/runtime/register.ts`）
- `@pluxel/runtime/services`：公开 runtime services 与类型（见 `packages/runtime/src/services.ts`）
- `@pluxel/runtime/logger`：日志 helper + UI log store（见 `packages/runtime/src/logger.ts`）
- `@pluxel/runtime/web/*`：浏览器侧协议与 UI contract（见 `packages/runtime/src/web.ts`）

核心原则：runtime services 允许使用宿主能力（例如 `ctx.root.fs`），但 **不包含 Vite/HMR/watch 实现**。

浏览器侧也要分清两层：

- `packages/runtime/src/services/**`
  解决的是 runtime kernel 里“服务如何注册与协作”
- `packages/runtime/src/web/**`
  解决的是浏览器宿主和插件 UI 如何消费 runtime 协议

不要把浏览器 `createPluginUi(...)` helper 误当成 service 层 API。

### `FsService`（`ctx.root.fs`）

- 职责：最小文件系统抽象（原子写、可切换 memory backend），给需要持久化的服务复用。
- 位置：`packages/runtime/src/services/fs/FsService.ts`
- 使用者：Config/Vault/PluginData 等。

### `ConfigService`（`ctx.configService`）

- 职责：配置读写、validated snapshot、profile 路径等。
- 位置：`packages/runtime/src/services/ConfigService.ts`
- 依赖：通过 `ctx.root.fs` 做持久化（不直接依赖 `node:fs`）。

### `VaultService`（`ctx.vault`）

- 职责：加密存储/密钥管理（面向插件 secrets）。
- 位置：`packages/runtime/src/services/vault/VaultService.ts`
- 依赖：通过 `ctx.root.fs` 做持久化。

### `PluginDataService`（`ctx.pluginData`）

- 职责：插件私有数据的存取（按 pluginId 分域）。
- 位置：`packages/runtime/src/services/PluginDataService.ts`
- 依赖：通过 `ctx.root.fs` 做持久化。

### `HttpService`（`ctx.http.fetch`）

- 职责：control plane 路由聚合、内部 API、SSE/RPC/GraphQL 入口、UI assets strategy（dev-server/static-built/disabled）。
- 位置：`packages/runtime/src/services/http/HttpService.ts`

### Loader/Package/Scan（运行时执行与解析）

- `LoaderService`：插件生命周期、commit/restart/replace 等
  - `packages/runtime/src/services/runtime/loader/LoaderService.ts`
- `PackageService`：包安装/卸载策略、enabled state 等
  - `packages/runtime/src/services/runtime/package/PackageService.ts`
- `ScanService`：workspace 扫描与入口解析
  - `packages/runtime/src/services/runtime/scan/ScanService.ts`

### Plugin interaction（`ctx.ext.*`）

- 职责：插件前端相关的运行时交互协议层。
- 位置：`packages/runtime/src/services/plugin-interaction/*`

其中：

- `ExtService`：`ctx.ext` 聚合入口，只负责把当前 plugin ctx 回灌到 `ui/rpc/sse/signaldb` 四个子服务
  - `packages/runtime/src/services/plugin-interaction/ExtService.ts`
- `ExtensionService`：runtime 对 packaged UI remote 与 host-rendered doc/builtin 的稳定入口
  - `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
- `SignalDbService`：runtime-owned collection、sync transport、SSE 广播、builtin/doc binding
  - `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`
- `RpcService`：插件对自定义 UI 暴露 RPC
  - `packages/runtime/src/services/plugin-interaction/RpcService.ts`
- `SseService`：插件对自定义 UI 或 SignalDB sync 暴露 SSE 流
  - `packages/runtime/src/services/plugin-interaction/SseService.ts`
- `ExtensionModuleStore`：给 `@pluxel/hmr` compiler 使用的最小 bridge，只暴露 compiled module 读写能力
  - 定义于 `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`

当前判断：

- 这组实现的边界已经明确：`rpc/sse/signaldb` 负责数据与交互，`ui` 负责呈现注册；
- runtime 只消费 packaged remote 和 host-rendered doc/builtin，不消费 `ui(...).bind(ctx)` 这类 authoring 语义；
- 如果后续继续优化，优先整理类内状态与 transport 细节，不再新增一层公开概念。

对插件前端作者来说，服务层最终会在浏览器侧收敛为一组更小的 contract：

- 后端注册：`ctx.ext.*`
- 浏览器消费：`@pluxel/runtime/web/ui`

service 文档只解释前者，不试图替代前端 contract 文档。

## @pluxel/hmr 服务概览（dev-only）

入口与导出：

- 推荐入口：`@pluxel/hmr/host` 的 `startHmrHostFromConfig(...)`
- 低级入口：`attachHmrRuntime(ctx, ...)`（一次性 attach）
- `@pluxel/hmr/diagnose`：读取/校验配置并生成 `HmrWorkspaceSnapshot`

### `HMRService`

- 职责：Vite dev server 生命周期、runner、pipeline、执行入口、builtins preload。
- 位置：`packages/hmr/src/dev/hmr/HMRService.ts`

### `BundlerService`

- 职责：dev-only bundling（worker/tinypool），给扩展编译与其他 dev 管线复用。
- 位置：`packages/hmr/src/dev/compile/bundler/BundlerService.ts`

### `ExtensionCompilerService`

- 职责：开发期消费 `ui(...).bind(ctx)`，编译插件 UI 源码，并写入 runtime 的 `ExtensionModuleStore`。
- 位置：`packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`
- 依赖：
  - Node FS（磁盘 cache、watcher target 扫描）
  - runtime internal helpers
    - 来自 `@pluxel/runtime/internal`
- 缓存策略：
  - 进程内：如果 compiled module 的 `sourceHash` 命中则跳过编译
  - 进程重启：优先从磁盘 artifact/cache 恢复，再回灌到 runtime store

当前判断：

- `ExtensionCompilerService` 继续留在 `@pluxel/hmr` 是对的；
- runtime 只保留 `ExtensionModuleStore` bridge，已经是比较合适的最小注入面；
- build 期的 `ui(...).bind(ctx)` rewrite 与 MF2 remote 构建属于 `@pluxel/build` / `@pluxel/hmr/plugin-build`，不应该再回灌到 runtime service 层。

## `@pluxel/build` 为什么不写在这里

因为它不是 service graph 的一部分。

`@pluxel/build` 负责的是：

- AST rewrite
- bundler overlay
- 让最终产物不再残留 authoring/HMR 语义

它不持有 `Context`，也不和 runtime service 生命周期协作。所以它应该在架构文档和 build README 里讲，而不是在 service 边界里假装自己也是一个 runtime service。

## 典型用法

生产（无 HMR）：

- `new Context({ ...runtime config... })`
- 暴露 `ctx.http.fetch` 到你的 HTTP server

开发（HMR）：

- `startHmrHostFromConfig({ root, configPath, profile, logging })`
- 或：自定义 `new Context()` 后 `attachHmrRuntime(ctx, { workspaceSnapshot })`，然后 `hmr.start()`
