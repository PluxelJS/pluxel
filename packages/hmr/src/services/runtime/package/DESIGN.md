# PackageService 设计（runtime/package）

PackageService 管理“插件包（node_modules / market）”的安装、加载、卸载与持久化状态，并把 **加载得到的模块导出** 交给 LoaderService 统一注册/运行。

## 治理边界（Ownership）

- Package **拥有**：包安装/卸载流程、加载记录与问题（issues）持久化、模块缓存、name→moduleId 绑定、对 HMR 模块缓存的桥接（prime/drop）。
- Package **不拥有**：工作区 profiles/发现、HMR watcher、插件声明与启用策略（由 Loader + ConfigService 统一处理）。
- Package **依赖**：
  - ScanService：解析包入口（workspace/installed）
  - LoaderService：把模块导出注入为插件声明/运行
  - HMRService：加速/一致化 runner 模块缓存（prime/drop）

## 关键数据模型

- `NormalizedPackageSpecifier`：`name@target` 的规范化表示（包含 tag/version/semver）。
- `moduleId`：当前加载绑定到的入口模块 id（优先使用“可稳定比较”的形式）。
- `PackageState`：持久化快照来源（loaded records + issues + blocklist + 依赖索引）。

## 关键流程

### load(spec)

1. `scanService.resolveEntry({ name })` 得到入口文件（可传 overrides 控制 conditions / workspaceOnly 等）。
2. `runtime.normalizeModuleId(entry)` → 得到用于缓存/对比的 moduleId。
3. import 模块（可选 fresh），写入本地缓存，并 `primeHmrModuleCache`。
4. `loader.replaceModule(moduleId, moduleNamespace)`：把模块导出解析成插件声明，并按持久启用位启动。
5. 写入 `PackageState` 记录（用于恢复/展示/卸载）。

### install(spec) / installMany(specs)

- 统一由 Installer 执行包管理器 IO（支持批量），完成后：
  - `scanService.invalidateResolverCache()`（让新的入口解析生效；并 emit `runtime:resolverCacheInvalidated` 让 HMR 清理派生解析缓存）
  - 记录 install 结果到 state（用于可观测性与恢复）

### removePackages(specs)

- 删除依赖（编辑 package.json/lockfile）完成后同样需要：
  - `scanService.invalidateResolverCache()`（避免 exsolve 缓存残留导致“已删除包仍可解析”；并触发 `runtime:resolverCacheInvalidated`）
  - 同步 tracked plugins（触发 resync）

### invalidate/unload/remove

- 移除/卸载时，必须同时收敛三层状态：
  - Loader：`pruneModule(moduleId)` / `prunePluginByName(...)`
  - HMR：drop runner/module cache
  - State：清理 records / issues / 依赖索引

### restore（启动恢复）

1. 读取持久化快照。
2. 逐条重新 import + 绑定 moduleId + prime cache。
3. 对标记为 anchor 的条目执行 `loader.replaceModule(...)` 恢复声明层。
4. 失败条目写入 issue，允许后续手动重试。

## 并发与一致性

- Keyed locks：按 spec key 互斥 install/load/remove，避免重复 IO 与状态撕裂。
- 事务边界：
  - Loader 的批量事务由 Loader 管；Package 只需要保证“调用顺序正确、失败时能回滚/清理”。

## 错误与可观测性

- 统一用结构化事件记录：install/load/restore 的开始/成功/失败（便于 UI/日志诊断）。
- issues 会持久化：重启后仍能看到失败原因与最后一次尝试信息。

## 性能要点

- 入口解析与扫描图有缓存（ScanService snapshot cache）。
- 模块 import 结果有缓存（PackageRuntime），并尽可能 prime 到 HMR runner 缓存以减少重复评估。
