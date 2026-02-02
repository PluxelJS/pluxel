# HMRService 设计（runtime/hmr）

HMRService 负责启动 Vite Dev Server（含 UI/扩展编译）、监听文件变化、在 SSR runner 环境中执行入口模块，并把执行结果（module exports）交给 LoaderService 完成插件注册/启停。

## 治理边界（Ownership）

- HMR **拥有**：Vite server + watcher、变更批处理（debounce）、执行/注入流水线（runner → loader batch）、桥接单例模块（bridgeModules）、HMR 报告。
- HMR **不拥有**：工作区发现（哪些包是入口）、profiles 管理、包安装/卸载、插件声明与启用策略。
- 治理规则（核心）：
  - `hmrService.entries` 是 **唯一冷启动入口列表**，必须由上层（workspace profiles / CLI / host）显式生成并传入。
  - HMR 不做“文件系统兜底发现”，避免出现“scan 两套理论”与隐式行为。

## 配置模型（最小关键项）

- `roots: string[]`：监听边界（用于 watcher 过滤与报告分组）。
- `entries: string[]`：冷启动入口（稳定顺序，root-relative 或绝对路径均可；会被归一化为 clean fs path）。
- `include/exclude: string[]`：额外过滤器（主要控制“哪些文件变化触发 HMR 批处理”）。
- `builtins?: BuiltinPluginSpec[]`：启动时 preload 到 Loader 的 baseline（避免后续批次失败回滚时丢失 builtins）。
- `deps`: bridgeModules / cjsExternal 等 runner 依赖规则。

## moduleId 规范（约定）

- HMR 对外（注入 Loader）只使用 `HmrPathResolver.toClean(...)` 的结果作为 moduleId：
  - Unix：`/abs/path/to/file.ts`
  - Windows：`C:/abs/path/...`
- runner import 优先使用 `/@fs` 形式（更稳定），但 **记录到 Loader 的 moduleId 始终是 clean fs path**。

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

## 失败语义（commit 与回滚）

- 单文件执行失败：记录错误并跳过（不阻断整个 dev server）。
- replaceModule 失败：回滚 loader batch + `ctx.registry.resetDraft()`，本批次终止。
- commit 校验失败：回滚 loader batch + `ctx.registry.resetDraft()`，保证声明层与 runtime 不漂移。

## 性能要点

- 批处理 debounce（小窗口合并变更）+ moduleGraph 最小追溯。
- workspace entry rewrite 有 FIFO 缓存与上限（避免依赖图 churn 时无界增长）。
- warmup 可选 transform prefetch（减少 wall time，但不会阻塞启动）。
