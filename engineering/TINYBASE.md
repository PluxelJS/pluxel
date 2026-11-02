# Host 托管 TinyBase 状态

公开写法见[插件状态](../docs/plugin-development/tinybase.md)，Host 接线见[配置与运行策略存储](../docs/host/configuration.md#保存配置和运行策略)。本页拥有 Core 内建 Store、快照、保存与撤回边界；配置权威仍由 [Config](CONFIG.md)维护，文件后端由 [FS](FS.md)维护。

## 所有者与依赖

每个 Core 固定提供 `PluginContext.tinybase`，通过 `open()` 获取原生 Store，通过 `flush()` 确认保存；无需 token、`ctx.require()` 或服务安装。`@pluxel/core` 仅公开必要桥接类型与错误，原生 Store、Queries、schema、Schematizer 继续从上游导入。

`CoreHostConfig.zenfs` 选择 FS 后端，`tinybase` 只配置 `maxSnapshotBytes` 预算。Core 拥有 Plugin owner 绑定、快照、writer 与关闭，不反向导入 Host 或 Services。取得 handle 无 IO，首个异步操作等待共享 FS 准备任务。Plugin snapshot 目录只读时拒绝可写 `open()`；其他挂载的只读状态不影响此目录。默认 InMemory 只确认内存提交，跨 Host 恢复由所选后端保证。

同一 Core 内，每个 canonical Plugin node（含 fork）只有一个 writer；Part 与依赖视图使用 owning Plugin generation 的同一 handle。handle 不随动态 caller 改变 owner。获取能力但未 open 不创建 Store、文件或持久化监听。临时计算直接使用原生 Store 或普通对象。

## 原生实例与恢复

`open()` 创建普通 native Store；`open(store)` 返回传入的同一实例并保留其类型。重复、并发 open 共用一次恢复；同一 generation 再传其他实例报 `OPEN_CONFLICT`。实例不得曾属于其他 generation/Host，必须没有已挂载 listener、Persister、Synchronizer 或未结束 transaction，不接受 MergeableStore。业务 Queries 和 listener 在 open 成功后挂载，用原生方法和 effects 释放；不修改或代理 native API。

open 首次 await 前登记 writer 与 generation 清理，防止晚到恢复结果逃逸。只有 backing 缺失才保留调用方初值，已有快照完整替换 Tables/Values，包括合法空内容。先校验快照与身份，再 `setContent()`，并比较原始与恢复后的内容；schema 丢字段或填默认值导致不一致时明确失败，源文件不变。等待恢复时调用方不修改、读取或公开 Store。

普通 Store 没有可靠的“所有 dormant persister”枚举接口，Core 通过 listener 统计拒绝已挂载资源；调用方仍必须履行传入全新、未交给其他持久化工具的实例契约。

## Publication、保存与关闭

恢复不写回。初始化期间 native mutation 仅改变候选；Core `prepareCommit` 检查当前完整快照与事务状态，`publishCommit` 同步开启 autosave，IO 在回调外的 microtask 调度。成功 publication 后保存缺失文件的初值；失败或撤回丢弃未提交候选。成功发布后才首次 lazy open 同样启用 autosave。

原生 start/did-finish transaction listener 捕获完整 Content，内部 revision 只在内容改变时推进；保存状态不写入 Store。`setRow()`、`setValue()` 和 `transaction()` 的同步返回只表示内存变化。保存队列至多一个 in-flight 与一个 latest pending snapshot；合并中间 revision，不承诺每个中间状态落盘。

`flush()` 捕获调用时最后一个完整事务的 revision，等待该 revision 或更新快照被后端确认；持续更新不推迟已经捕获的屏障。未 open、未结束 transaction、已故障或已撤回时拒绝。init 内显式 flush 直接提交已校验候选，不等待自身 publication；其成功是已发生的持久副作用，随后 init 失败不会回滚，也不会开启后续 autosave。

停止沿用 Core admission/drain：先关闭新领域操作并等待已接纳调用，再移除保存监听、固定最后完整快照并排空。旧 Store 仍可发生内存 mutation，但退役 writer 不再写 backing。init 撤回不保存未确认候选。未结束 transaction 不保存部分数据，关闭失败可观察。TinyBase 的 root final 清理晚于领域服务 flush，早于 FS final 关闭；FS 文档的在途任务由 FS owner 排空。

## 快照与预算

格式由应用数据 envelope 管理，与 TinyBase 包版本分开演进：

```json
{
	"format": "pluxel.tinybase",
	"formatVersion": 1,
	"identity": {
		"kind": "plugin",
		"node": {
			"definition": {
				"entry": { "kind": "package-root", "packageName": "@app/example" },
				"exportName": "ExamplePlugin"
			},
			"variant": "default"
		}
	},
	"content": [{}, {}]
}
```

Plugin identity 为 `{ kind: 'plugin', node: PluginNodeAddress }`。Content 是原生 `[Tables, Values]`，仅接受普通 data records 和 string/boolean/有限 number；不把嵌套对象、null、undefined、非有限数、accessor 或 class instance 静默转为有效数据。JSON 数值语义不区分正负零。未知格式、身份不匹配或超限均在写入前拒绝。

`runtime.tinybase.maxSnapshotBytes` 默认每份完整 envelope 8 MiB（UTF-8）；必须是正安全整数。预算包含键、身份与完整原生 Content，不是仅统计业务 payload。快照写入使用 FS 完整原子替换，不增加 fsync、跨文件事务、多进程锁或断电保证。

| 所有者      | FS 固定目录               | 文件 key                                  |
| ----------- | ------------------------- | ----------------------------------------- |
| Plugin node | `services/tinybase/nodes` | canonical node bytes 的 SHA-256 + `.json` |

表名、行 ID、display name、包版本与安装路径不参与物理路径。停止、卸载、fork 删除不隐式删除快照。多个 Host 可以读取实际共享后端中的同一快照；并发完整快照写入可能覆盖彼此的变化，不提供跨实例锁、条件提交或合并。需要并发一致性的业务数据使用数据库。

## 外部文件变化

托管 Plugin Store 通过 `fs/observe.ts` 定期异步读取快照内容。变化后的 envelope 必须通过身份、格式、预算和原生 schema 保真校验，再替换 native Store；原生查询和监听器观察这一更新。加载期间不启动 autosave，不把外部快照原样写回。正在进行的本地 transaction 与保存按本实例的队列结算；这不是跨实例并发协调。

观察器比较实际文件内容，串行执行读取与接纳；没有数据复制、网络协议或全局 revision。读取／校验失败保留当前有效 Store 并报告错误，后续不同的有效内容可恢复加载。外部删除按空 Content 接纳，仍需通过原生 schema 保真校验；不恢复调用方初值，也不由后台观察器重建文件。停止时先撤销观察并等待在途读取，再释放 owner 和 FS。

## Host 文档边界

Host config/state、Logging policy 和 Management layout 是普通领域文档，直接通过 Core FS 保存到 `services/host/<namespace>/<key>`，不创建 TinyBase Store 或 Host identity。`TinyBaseHostService` 只提供 Plugin writer 的 status/recover，状态列表不包含 Host namespace。目录、订阅和关闭排空见 [FS](FS.md#host-文档与关闭)，配置的原始输入与应用规则见 [Config](CONFIG.md)。

## 故障与显式恢复

Core 内部 TinyBase Host 的 `status()` 报 owner、phase、current/saved/pending revision、最后错误与 confirmed/unknown outcome，不把快照或敏感内容写入诊断。保存失败锁定 writer：Store 内存可能已更新，backing 也可能在错误前已提交，不能声称回滚。后续 flush、autosave 与关闭不自动重试，旧失败 writer 阻止新代接管。

Host 在停止失败 Plugin 后，可显式 `recover(node, 'retry')` 重存保留的最新完整快照，或 `recover(node, 'discard')` 丢弃候选并验证实际 backing 后解除阻塞，再显式启动新代。同 action 的并发恢复共用一次任务，冲突 action 明确拒绝；所有恢复 IO 结算前继续阻断新代接管。成功恢复后退役 writer 不可再次提交旧快照。故障仍在运行、重试失败或实际 backing 无效时不解除阻塞。

恢复、格式升级与数据转换是显式维护行为。运行时没有旧 JSON reader、双写或启动迁移；已有设置转换需核对 owner、备份、校验、原子提交和新 Host 恢复，失败保留原文件。官方逐包范围及验证记录见[迁移清单](TINYBASE_MIGRATION.md)。

## 版本与发行

`tinybase` 及子路径保持上游导入；Core 持有精确 runtime dependency；共享原生 Store 的 Plugin 声明同版 peer/dev 并由 `pluxel.tinybase` facts 记录接纳版本。只使用固定 open 的消费者不新增上游依赖。只消费 `configs.use()` 或 DTO 的包不添加 TinyBase 依赖。支持 Valibot schematizer 的版本范围由上游 TinyBase 自身 peer 声明决定。

Host 内部 shared-runtime helper 负责精确 semver/安装事实与上游 manifest 校验，Workbench Cap’n Web 复用同一机制。原生启动、静态制品与 Vite 使用同一 admission；同版多路径统一模块，shared 异版拒绝，private 异版保留原解析。全局 `sharedPackages` 不接受 `tinybase` 或 `capnweb` 绕开能力所有者。Node/browser 子路径按目标条件绑定，浏览器原生 import 不加载 Host/FS。细节见[Governance](GOVERNANCE.md)与[插件包](../docs/development/plugin-package.md)。

## 实现与回归入口

- `packages/core/src/tinybase/types.ts`、`options.ts`、`error.ts`：公开桥接、预算与错误。
- `packages/core/src/internal/storage.ts`、`tinybase/service.ts`、`writer.ts`：owner、publication、保存屏障、故障和撤回。
- `packages/core/src/tinybase/codec.ts`：Plugin Store 的独立快照格式。
- Core TinyBase tests：原生互操作、fork、重开、空快照、publication、flush、故障、readonly、晚到恢复与显式恢复互斥。
- Host config/state tests：默认文档、真实后端跨 Host 恢复、保存后 apply 与外部文件重新加载。
- Host production、Rolldown TinyBase/static 与 Services Vite tests：Core 精确版本准入和真实上游副本绑定。
- Wretch/Fonts、配置与 Management regressions，以及工作区外 tarball 和 generated starter smoke：真实调用方与发行边界。
