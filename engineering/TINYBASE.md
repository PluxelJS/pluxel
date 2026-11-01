# Host 托管 TinyBase 状态

公开写法见[插件状态](../docs/plugin-development/tinybase.md)，Host 接线见[配置与运行策略存储](../docs/host/configuration.md#保存配置和运行策略)。本页拥有 Core 内建 Store、快照、保存与撤回边界；配置权威仍由 [Config](CONFIG.md)维护，文件后端由 [FS](FS.md)维护。

## 所有者与依赖

每个 Core 固定提供 `PluginContext.tinybase`，通过 `open()` 获取原生 Store，通过 `flush()` 确认保存；无需 token、`ctx.require()` 或服务安装。`@pluxel/core` 仅公开必要桥接类型与错误，原生 Store、Queries、schema、Schematizer 继续从上游导入。

`CoreHostConfig.storage` 选择 FS 后端，`tinybase` 只配置 `maxSnapshotBytes` 预算。Core 拥有 owner 绑定、快照、writer、私有文档与关闭，不反向导入 Host 或 Services。取得 handle 与内部 `documents()` 无 IO，首个异步操作等待共享 FS 准备任务。FS 只读时拒绝可写 `open()`；Host 文档可读取已有数据。默认 InMemory 只确认内存提交，跨 Host 恢复由所选后端保证。

每个 canonical Plugin node（含 fork）只有一个 writer；Part 与依赖视图使用 owning Plugin generation 的同一 handle。handle 不随动态 caller 改变 owner。获取能力但未 open 不创建 Store、文件或持久化监听。临时计算直接使用原生 Store 或普通对象。

## 原生实例与恢复

`open()` 创建普通 native Store；`open(store)` 返回传入的同一实例并保留其类型。重复、并发 open 共用一次恢复；同一 generation 再传其他实例报 `OPEN_CONFLICT`。实例不得曾属于其他 generation/Host，必须没有已挂载 listener、Persister、Synchronizer 或未结束 transaction，不接受 MergeableStore。业务 Queries 和 listener 在 open 成功后挂载，用原生方法和 effects 释放；不修改或代理 native API。

open 首次 await 前登记 writer 与 generation 清理，防止晚到恢复结果逃逸。只有 backing 缺失才保留调用方初值，已有快照完整替换 Tables/Values，包括合法空内容。先校验快照与身份，再 `setContent()`，并比较原始与恢复后的内容；schema 丢字段或填默认值导致不一致时明确失败，源文件不变。等待恢复时调用方不修改、读取或公开 Store。

普通 Store 没有可靠的“所有 dormant persister”枚举接口，Core 通过 listener 统计拒绝已挂载资源；调用方仍必须履行传入全新、未交给其他持久化工具的实例契约。

## Publication、保存与关闭

恢复不写回。初始化期间 native mutation 仅改变候选；Core `prepareCommit` 检查当前完整快照与事务状态，`publishCommit` 同步开启 autosave，IO 在回调外的 microtask 调度。成功 publication 后保存缺失文件的初值；失败或撤回丢弃未提交候选。成功发布后才首次 lazy open 同样启用 autosave。

原生 start/did-finish transaction listener 捕获完整 Content，内部 revision 只在内容改变时推进；保存状态不写入 Store。`setRow()`、`setValue()` 和 `transaction()` 的同步返回只表示内存变化。保存队列至多一个 in-flight 与一个 latest pending snapshot；合并中间 revision，不承诺每个中间状态落盘。

`flush()` 捕获调用时最后一个完整事务的 revision，等待该 revision 或更新快照被后端确认；持续更新不推迟已经捕获的屏障。未 open、未结束 transaction、已故障或已撤回时拒绝。init 内显式 flush 直接提交已校验候选，不等待自身 publication；其成功是已发生的持久副作用，随后 init 失败不会回滚，也不会开启后续 autosave。

停止沿用 Core admission/drain：先关闭新领域操作并等待已接纳调用，再移除保存监听、固定最后完整快照并排空。旧 Store 仍可发生内存 mutation，但退役 writer 不再写 backing。init 撤回不保存未确认候选。未结束 transaction 不保存部分数据，关闭失败可观察。TinyBase 的 root final 清理晚于领域服务 flush，早于 FS final 关闭；Host documents 的在途任务被排空。

## 快照与预算

格式由应用数据 envelope 管理，与 TinyBase 包版本分开演进：

```json
{
	"format": "pluxel.tinybase",
	"formatVersion": 1,
	"identity": { "kind": "host", "namespace": "config" },
	"content": [{}, {}]
}
```

Plugin identity 为 `{ kind: 'plugin', node: PluginNodeAddress }`。Content 是原生 `[Tables, Values]`，仅接受普通 data records 和 string/boolean/有限 number；不把嵌套对象、null、undefined、非有限数、accessor 或 class instance 静默转为有效数据。JSON 数值语义不区分正负零。未知格式、身份不匹配或超限均在写入前拒绝。

`config.tinybase.maxSnapshotBytes` 默认每份完整 envelope 8 MiB（UTF-8）；必须是正安全整数。预算包含键、身份和嵌套文档文本，不是仅统计业务 payload。快照写入使用 FS 完整原子替换，不增加 fsync、跨文件事务、多进程锁或断电保证。

| 所有者         | FS 固定目录               | 文件 key                                  |
| -------------- | ------------------------- | ----------------------------------------- |
| Plugin node    | `services/tinybase/nodes` | canonical node bytes 的 SHA-256 + `.json` |
| Host namespace | `services/tinybase/host`  | namespace UTF-8 的 SHA-256 + `.json`      |

表名、行 ID、display name、包版本与安装路径不参与物理路径。停止、卸载、fork 删除不隐式删除快照。文件需要同一部署单 Host writer；多进程共享写入、离线同步和自动接管不在契约内。

## Host 私有文档

Core 内部 `requireTinyBaseHost(root).documents(namespace)` 返回借用的 `HostDocumentStorage`，内部独立 schema Store 的 `documents` 表按文档 key 存 text，不公开可变 Store。官方 namespace：`config`、`state`、`logging`、`management`；Plugin 的 `open()` 不可访问这些数据。

同 namespace 的整个 read → copy → modify → encode → atomic put → confirm 进入一条串行队列，避免不同 key 的并发写入相互覆盖。保存使用独立 candidate Store，只有 backing put 成功才切换 confirmed read view。`getText()` 只读 confirmed 内容；失败候选不会进入下次保存。factory 无 IO，首次读取共享准备任务。

单实例 HostConfigStore 的 v3 与 HostStateStore 的 v5 文档保持不变，只把原文档文本装入 TinyBase；启用配置同步时使用 [Config](CONFIG.md#saved-config-replication) 定义的 v4 外层原子封装。Core records/revision、Valibot、env/base/saved 优先级、readonly 和 saved-not-applied 不变。Logging policy v3 与 Management groups v1 同样保持领域编码和提交回执。嵌入式 Host 仍可在既有 factory 位置提供应用拥有的借用 adapter，不要求反向导入 Services。

## 故障与显式恢复

Core 内部 TinyBase Host 的 `status()` 报 owner、phase、current/saved/pending revision、最后错误与 confirmed/unknown outcome，不把快照或敏感内容写入诊断。保存失败锁定 writer：Store 内存可能已更新，backing 也可能在错误前已提交，不能声称回滚。后续 flush、autosave 与关闭不自动重试，旧失败 writer 阻止新代接管。

Host 在停止失败 Plugin 后，可显式 `recover(node, 'retry')` 重存保留的最新完整快照，或 `recover(node, 'discard')` 丢弃候选并验证实际 backing 后解除阻塞，再显式启动新代。同 action 的并发恢复共用一次任务，冲突 action 明确拒绝；所有恢复 IO 结算前继续阻断新代接管。成功恢复后退役 writer 不可再次提交旧快照。故障仍在运行、重试失败或实际 backing 无效时不解除阻塞。Host documents 写失败保留 confirmed view 并阻断后续 put；关闭后重新打开 Host 检查实际 backing，不自动提交失败 candidate。

恢复、格式升级与数据转换是显式维护行为。运行时没有旧 JSON reader、双写或启动迁移；已有设置转换需核对 owner、备份、校验、原子提交和新 Host 恢复，失败保留原文件。官方逐包范围及验证记录见[迁移清单](TINYBASE_MIGRATION.md)。

## 版本与发行

`tinybase` 及子路径保持上游导入；Core 持有精确 runtime dependency；共享原生 Store 的 Plugin 声明同版 peer/dev 并由 `pluxel.tinybase` facts 记录接纳版本。只使用固定 open 的消费者不新增上游依赖。只消费 `configs.use()` 或 DTO 的包不添加 TinyBase 依赖。支持 Valibot schematizer 的版本范围由上游 TinyBase 自身 peer 声明决定。

Host 内部 shared-runtime helper 负责精确 semver/安装事实与上游 manifest 校验，Workbench Cap’n Web 复用同一机制。原生启动、静态制品与 Vite 使用同一 admission；同版多路径统一模块，shared 异版拒绝，private 异版保留原解析。全局 `sharedPackages` 不接受 `tinybase` 或 `capnweb` 绕开能力所有者。Node/browser 子路径按目标条件绑定，浏览器原生 import 不加载 Host/FS。细节见[Governance](GOVERNANCE.md)与[插件包](../docs/development/plugin-package.md)。

## 实现与回归入口

- `packages/core/src/tinybase/types.ts`、`options.ts`、`error.ts`：公开桥接、预算与错误。
- `packages/core/src/internal/storage.ts`、`tinybase/service.ts`、`writer.ts`：owner、publication、保存屏障、故障和撤回。
- `packages/core/src/tinybase/codec.ts`、`documents.ts`：独立快照格式和 Host confirmed document adapter。
- Core TinyBase tests：原生互操作、fork、重开、空快照、publication、flush、故障、readonly、并发文档、晚到恢复与显式恢复互斥。
- Host config/state tests：默认文档、真实后端跨 Host 恢复、保存后 apply 与配置同步。
- Host production、Rolldown TinyBase/static 与 Services Vite tests：Core 精确版本准入和真实上游副本绑定。
- Wretch/Fonts、配置与 Management regressions，以及工作区外 tarball 和 generated starter smoke：真实调用方与发行边界。
