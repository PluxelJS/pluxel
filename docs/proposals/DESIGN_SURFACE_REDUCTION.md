# SignalDB Replacement Boundary

状态：提案，延后实施。

runtimeDev mirror、永久失败的 RPC、package-manager 双控制面和 public-looking runtime subpath 已独立收缩；当前剩余议题只有 Workbench managed collection 的底层实现。

## 当前决定

在自研替代品可用之前保留完整 SignalDB 能力：

- `workbench.bind.managedCollection()`、`WorkbenchMount` 与 managed collection handle；
- server-side collection、changeset、selector、modifier、CRUD 与可选 plugin-data persistence；
- browser replica、SyncManager、client write negotiation 与 push queue；
- builtin document 的 SignalDB ref、form、action、resourceSelect 和配置 directive；
- `PluginDataService` 以及 static/dynamic host 的 `pluginData` 配置；
- `@signaldb/core`、`@signaldb/maverickjs`、`@signaldb/react`、`@signaldb/sync` 和 Maverick signals 依赖。

仓库内插件继续使用现有 managed collection API，不提前改写为临时数组、Map 或另一套半成品投影层。

## 未来替换条件

只有自研实现已经覆盖当前真实能力并具备迁移测试时，才开始替换 SignalDB。替代实现至少需要明确：

- collection identity、selector、modifier、CRUD 和 snapshot 语义；
- server/browser subscription、changeset 顺序、重连和冲突方向；
- client write 权限、push 失败和 last-known-good 行为；
- plugin-owned persistence、初始化、flush、unregister 和 owner cleanup；
- grant revoke、HMR replacement、Workbench disabled 和 browser lifecycle；
- React reactivity adapter 与 builtin form/action/ref 的兼容或正式替代方案。

## 可以先做的工作

- 为现有行为补充 characterization tests；
- 记录仓库内外真实消费者使用了哪些 selector、write 和 persistence 能力；
- 在不改变 public API 的前提下测量 server/browser bundle closure 和同步开销；
- 设计自研实现的数据模型、transaction、index、durability 与 migration strategy。

## 暂时不做

- 不删除、改名或降级 `managedCollection()`；
- 不把插件迁移到仅为过渡存在的数组/Map projection；
- 不先删除 client write、builtin interaction、browser replica 或 plugin data；
- 不建立只能覆盖 `read() + invalidate()` 的替代 port；
- 不宣称 `mount()` 是 registration-only；
- 不在替代实现落地前移除 SignalDB 依赖和测试。

完成替代实现后，应以一次端到端迁移替换当前内核，同时更新维护者文档、用户文档和 Changeset；本提案届时删除。
