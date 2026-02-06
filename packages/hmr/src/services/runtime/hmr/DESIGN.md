# HMRService 设计（runtime/hmr）

HMRService 负责启动 Vite Dev Server（含 UI/扩展编译）、监听文件变化、在 SSR runner 环境中执行入口模块，并把执行结果（module exports）交给 LoaderService 完成插件注册/启停。

## 治理边界（Ownership）

- HMR **拥有**：Vite server + watcher、变更批处理（debounce）、执行/注入流水线（runner → loader batch）、桥接单例模块（bridgeModules/bridgeProviders）、HMR 报告。
- HMR **不拥有**：工作区发现（哪些包是入口）、profiles 管理、包安装/卸载、插件声明与启用策略。
- 治理规则（核心）：
  - `hmrService.entries` 是 **唯一冷启动入口列表**，必须由上层（workspace profiles / CLI / host）显式生成并传入。
  - HMR 不做“文件系统兜底发现”，避免出现“scan 两套理论”与隐式行为。

## 配置模型（最小关键项）

- `roots: string[]`：监听边界（用于 watcher 过滤与报告分组）。
- `entries: string[]`：冷启动入口（稳定顺序，root-relative 或绝对路径均可；会被归一化为 clean fs path）。
- `include/exclude: string[]`：额外过滤器（主要控制“哪些文件变化触发 HMR 批处理”）。
- `builtins?: BuiltinPluginSpec[]`：启动时 preload 到 Loader 的 baseline（避免后续批次失败回滚时丢失 builtins）。
- `deps`: bridgeModules / bridgeProviders / cjsExternal 等 runner 依赖规则。

## moduleId 规范（约定）

- HMR 对外（注入 Loader）只使用 `HmrPathResolver.toClean(...)` 的结果作为 moduleId：
  - Unix：`/abs/path/to/file.ts`
  - Windows：`C:/abs/path/...`
- runner import 优先使用 `/@fs` 形式（更稳定），但 **记录到 Loader 的 moduleId 始终是 clean fs path**。

## 关键不变量（Singleton / Path）

HMR 能否稳定，取决于两个不变量：

1) **单例不变量**：同一个 runtime singleton（例如 DI tokens / decorators / Context 实现）在 host 与 runner 中必须是同一实例（===）。
2) **路径不变量**：同一个模块在整个流水线中必须有“唯一且稳定”的 canonical id（否则会出现 prime cache 命中失败、重复评估、或 moduleGraph 追溯错误）。

下面的设计都围绕这两点展开。

## 生命周期与主流程

### 1) start（启动）

1. 构建 Vite config（HMR UI package 作为 root）。
2. `server.listen()` 与 `ensureBaseline()` 并行：
   - bridge host singletons（`deps.bridgeModules`）
   - preload builtins baseline（可选）
3. 配置 runner/pipeline/watcher，输出 URL。

### 2) baseline（正确性底座）

baseline 的目标是保证 “runner 与 host 的核心模块单例一致” 且 “builtins 已作为 baseline 存在于 loader”。

- 任何 baseline 失败都应 fail-fast（避免 HMR 半瘫痪）。

### 3) warmup（冷启动预热）

warmup 会执行：
- `entries`（去重、归一化）
- `+ anchors`（来自 `loader.api.anchors.snapshot()`；即使被 exclude 过滤也会强制加入）

执行路径与增量更新完全一致：`HmrExecutor.runAndLoadAllClean(...)` → `loader.beginBatch().replaceModule(...)` → `ctx.registry.commit()`。

### 4) 文件变化 → 批处理

- watcher 事件会先走 `toolkit.pathFilter`（roots/include/exclude），或命中 anchors。
- 批处理在 runner moduleGraph 上做“向上追溯 importers”的最小图计算，得到影响集合与 roots。
- 若配置了 anchors，会优先把更新目标收敛到最近 anchor（插件入口），避免把变化扩散到过多模块。

## runner 解析策略（workspace entry rewrite）

runner 的 `resolveId` 会对 **bare specifier** 做 workspace-only rewrite：
- 只 rewrite 工作区包到其 `@pluxel/hmr` TS 源入口（条件导出）。
- 绝不 rewrite：
  - bridgeModules（避免 runner 评估第二份副本）
  - node_modules 已安装依赖（运行时不做 installed fallback）

实现依赖 ScanService：
- `scanService.resolveEntry({ name }, { workspaceOnly: true, scan: { conditions, preferHmrExports } })`

## 单例桥接：`bridgeModules` / `bridgeProviders`

### `bridgeModules`（“必须共享实例”的 specifier 列表）

用途：把这些模块的 host exports“注入/复用”到 runner 的 `evaluatedModules` 缓存里，避免 runner 再评估一份实现。

- 典型场景：`@pluxel/core`、`@pluxel/hmr`、`@pluxel/context` 等核心包（包含 decorators、基类、DI tokens）。
- 注意：桥接只适用于 TS/ESM 的 singleton；CommonJS-only 包不要放到这里（应走 `cjsExternal` externalize）。

### `bridgeProviders`（“逻辑 specifier → 实际提供者”）

用途：解决“逻辑模块被内联/打包进另一个模块”的场景（例如 `@pluxel/context` 被内联到 `@pluxel/core`）。

如果 runner/host 同时把 `@pluxel/context` 当成独立包去 import，就会评估出 **两份** Context 实现并触发 guard：

- host: `@pluxel/core` 内部带了一份 Context
- runner: 又从某个路径解析出一份 `@pluxel/context`

解决办法是把逻辑 specifier 映射到提供者模块：

- `bridgeProviders: { '@pluxel/context': '@pluxel/core' }`

语义（重要）：

- runner 会从 host runtime import “provider” 的 exports；
- 但会把 runner cache prime 在“原 specifier”（`@pluxel/context`）上；
- 同时 `runner.import('@pluxel/context')` 会被透明重定向到 `runner.import('@pluxel/core')`。

这样既能保持 `import '@pluxel/context'` 的调用点不变，又能确保运行时只有一个实现。

### 自动探测（best-effort）

当 host workspace **未安装** `@pluxel/context`，但安装了 `@pluxel/core` 时，HMR 会自动假定 context 由 core 提供并生成映射。
这能覆盖 pnpm workspace link/monorepo 下“context 不作为独立依赖存在”的常见开发形态。

## 路径归一化：`HmrPathResolver`

Vite dev server 的 root 是 HMR UI 包，而不是 host cwd，所以 runner 在运行时会同时看到两类 id：

- **Vite root-relative URL path**：例如 `/src/client.tsx`（应 rebase 到 serverRoot 才是实际文件）
- **真实绝对 FS path**：例如 `/home/.../packages/foo/src/index.ts`（尤其是 scanRoots 外的 linked workspace）

如果把真实绝对路径错误地 rebase 到 serverRoot，会导致：

- bridge prime 失败（runner 认为这是另一个模块 id）
- runner 重复评估（触发 singleton guard，例如 `@pluxel/context`）

因此归一化规则是：

- 若 rebase 到 serverRoot 后的路径在磁盘上存在 → 这是 Vite root-relative URL path，返回 rebased
- 否则若原始绝对路径在磁盘上存在 → 这是真实 FS path，保持不变

同时保留以下约定：

- `file:` / `/@fs/` 会被统一为 clean fs path
- `/@id/*`、`\0virtual` 等虚拟 id 不会被错误重写

## 统一解析器/缓存：exsolve + 共享 cache map

解析与 cache 统一遵循以下原则：

- 使用 `exsolve` 作为“稳定、可缓存、可控制 export conditions”的 resolver（Scan/HMR/Installer 共用）
- 复用 `ctx.scanService.resolverCache` 作为全局 resolve cache map（避免重复解析，并与 `invalidateResolverCache()` 的语义一致）
- resolver 实例按“group + baseKey”做小 LRU（避免无限增长但又保留热点 base）

## 失败语义（commit 与回滚）

- 单文件执行失败：记录错误并跳过（不阻断整个 dev server）。
- replaceModule 失败：回滚 loader batch + `ctx.registry.resetDraft()`，本批次终止。
- commit 校验失败：回滚 loader batch + `ctx.registry.resetDraft()`，保证声明层与 runtime 不漂移。

## 性能要点

- 批处理 debounce（小窗口合并变更）+ moduleGraph 最小追溯。
- workspace entry rewrite 有 FIFO 缓存与上限（避免依赖图 churn 时无界增长）。
- warmup 可选 transform prefetch（减少 wall time，但不会阻塞启动）。
