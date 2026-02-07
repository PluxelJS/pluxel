# ScanService 设计（runtime/scan）

ScanService 的职责是：在 **给定 roots 与导出条件（conditions）** 的前提下，构建工作区扫描图并解析包入口；必要时可回退到已安装依赖（node_modules）解析。

它是 runtime 中唯一“入口解析/包图”来源，供 HMR（workspace entry rewrite）、PackageService（包加载）等服务复用。

## 治理边界（Ownership）

- Scan **拥有**：扫描图缓存（snapshot cache）、包入口解析规则、installed fallback 解析（可选）、聚焦扫描（focusPackages）。
- Scan **不拥有**：profiles 的“启用/禁用哪些包”、生成 entries 列表、Vite watcher、包安装/卸载。

## 输入与输出

### 输入（ScanOptions）

- `roots`：扫描范围（绝对路径或会被归一化为绝对路径）。
- `conditions`：解析 package exports 的条件序列（默认包含 `@pluxel/hmr` 相关条件）。
- `preferHmrExports`：优先选择 `exports["."]["@pluxel/hmr"]`（若存在）。
- `focusPackages`：只聚焦部分包（减少扫描/解析开销）。
- `tsFallback`：没有 package.json 时的 TS-only 回退（例如 `index.ts`）。

### 输出

- `resolveEntry(selector, opts)`：
  - workspace 命中：返回 `{ ok: true, dir, entry, reason }`
  - workspace miss：
    - `workspaceOnly=true`：返回 `{ ok: false, code: MISSING_PACKAGE }`
    - 否则尝试 installed fallback（node_modules）
- `listWorkspaceEntries(opts)`：列出 workspace 中“可解析入口”的条目（dir+entry）。
- `resolveInstalledEntry(name)`：直接走 installed 解析（跳过 workspace 扫描）。

## 解析规则（核心）

1. 以 roots 为边界扫描 package.json（必要时也会扫描 TS-only 入口）。
2. 对每个包：
   - 优先使用条件导出 `@pluxel/hmr`（当 `preferHmrExports=true`）
   - 否则使用默认 export / main / index 回退规则（由 EntryResolver 统一实现）
3. selector 支持：
   - `{ name }`（包名）
   - `{ dir }`（目录）
   - 混合 hints（用于 focusPackages 推断）

## 缓存与失效

- `ScanSnapshotCache`：以 `(roots, resolvedOptions)` 作为 key，缓存扫描图与入口解析结果。
- `invalidateResolverCache()`：只清理“模块解析缓存”（适合 install/remove 后调用）。
  - 同时会触发 Context 事件：`runtime:resolverCacheInvalidated`（让 HMR runner、工具等清理其派生解析缓存）。
- `clearCaches()`：清空所有缓存（下次重新扫描磁盘）。

### 解析缓存共享（exsolve）

ScanService 内部使用 `exsolve` 做条件导出解析，并维护一份 `resolverCache`（exsolve resolve cache map）。

这份 cache 暴露为：

- `scanService.resolverCache`

用于高级集成（推荐）：

- HMR runner：复用同一个 resolve cache，避免重复解析并与 `invalidateResolverCache()` 的语义保持一致。
- PackageInstaller：在没有 `node_modules` 的场景（PnP / 自定义 resolver）做 best-effort “是否已安装”判断。

## 与其他服务的契约

- HMR：只使用 workspace-only resolution（避免 runtime 隐式引入 node_modules 入口重写）。
- Package：通常允许 installed fallback（包管理器安装后的依赖需要解析到 node_modules 入口）。

## 性能要点

- 尽量使用增量缓存与聚焦扫描（focusPackages）减少全图扫描。
- 文件系统遍历统一复用 `@pluxel/cli/workspace` 的 crawler（避免两套 IO 实现）。
