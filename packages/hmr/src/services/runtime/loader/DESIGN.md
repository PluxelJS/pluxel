# LoaderService 设计（runtime/loader）

LoaderService 是 **“插件声明层 + 运行层 + 配置启用位”** 的唯一协调者。它不做任何文件系统发现；所有模块变更都来自 HMR/Package 的“显式注入”。

## 治理边界（Ownership）

- Loader **拥有**：插件声明表（moduleId → exports）、name→ctor 映射、启用/停运操作、锚点（anchors）集合、批量注入事务。
- Loader **不拥有**：扫描工作区、选择哪些入口文件启动、Vite/HMR watcher、包安装逻辑。
- Loader **信任**：上游传入的 `moduleId` 已经是“稳定且可比较”的 id（通常是 HMR clean fs path；builtins 是合成 id）。

## 关键数据模型

- `moduleId`：声明来源标识。
  - HMR 注入：`/abs/path/to/file.ts`（clean fs path）
  - Builtins：`pluxel:builtins`（或自定义合成 id）
- “插件锚点（anchor）”：一个 `moduleId` **只要导出了 ≥1 个插件 ctor** 就是 anchor。
  - anchors 用来让 HMR 在过滤器之外“永远把插件入口当作 in-scope”。

## 关键流程

### replaceModule(moduleId, exports)

输入：一个模块的最新导出（module namespace object）。

流程（单模块）：
1. 停止旧运行态（只影响 runtime，不动持久启用位）。
2. 清除旧声明，解析新导出并声明插件（moduleId + exportKey）。
3. 归一化 ctor 构造参数 token（按 plugin id 映射到当前 runtime ctor，解决“同 id 不同 ctor 引用”导致的 MissingDependency）。
4. 应用持久化的依赖覆写（fork / base provider 等）。
5. 根据 `configService` 持久启用位同步运行层（enabled → ensure running）。
6. 更新 anchors：有插件导出 → add；否则 delete。

### beginBatch() / commit / rollback（批量注入事务）

- Loader 事务只保护 **Loader 的声明层与 anchors**（delta 回滚，不 clone 全表）。
- core DI 容器草稿回滚由 `ctx.registry.resetDraft()`/commit 负责。
- 语义：
  - `rollback()`：恢复声明层 + anchors
  - `commit()`：冻结本批次的声明层变更

### preloadPlugins(builtins)

- 用于建立 builtin baseline：
  - 以合成 `moduleId` 声明这些插件
  - 默认立即 commit，让后续 HMR 批次失败回滚时仍然有 baseline 可回退
  - 可选支持 fork catalog 写入（用于 UI/配置保持）

## 对外 API（最小稳定面）

- HMR/Package 侧：
  - `beginBatch()`
  - `replaceModule(moduleId, exports)`
  - `pruneModule(moduleId, scope)`
  - `prunePluginByName(name, scope)`
  - `preloadPlugins(builtins, { moduleId?, commit? })`
- 只读视图（RPC/UI）统一挂到 `loader.api`：
  - `loader.api.registry`：列出已注册插件、反查 moduleId、schema/source
  - `loader.api.status`：生命周期快照
  - `loader.api.anchors`：anchors 快照（给 HMR 用）
  - `loader.api.deps`：依赖检查
  - `loader.api.control`：启用/停用/停止

## 错误与一致性

- `commitFailed`：只停运失败 ctor（不回写持久启用位）。
- 批量注入遇到 commit 校验失败：上层（HMR/Package）调用 rollback + core resetDraft，Loader 声明层与 anchors 回到上一致状态。

## 性能要点

- 事务记录变更 key 的旧值，避免 O(N) 全量复制。
- 依赖者 token 归一化只刷新“受影响 ctor 的直接 dependents”，开销可控。
