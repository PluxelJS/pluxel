# Host 托管 TinyBase 状态

Core 固定提供 `ctx.tinybase`，托管 Plugin Store 的恢复、writer、快照和撤回。公开用法见[插件状态](../docs/plugin-development/tinybase.md)，文件后端见 [FS](FS.md)，Host config/state 由 [Config](CONFIG.md) 维护。

## 所有者与依赖

`open()` 返回原生 Store，`flush()` 确认保存。Core 只导出桥接类型/错误，Store、Queries、schema、Schematizer 从上游导入。

每个 canonical node（含 fork）在同一 Core 中只有一个 writer；Part/依赖视图共用 owning generation handle，不跟随动态 caller 改 owner。取得能力不执行 IO，未 open 不创建 Store、文件或监听；临时计算用原生 Store/普通对象。

应用通过 `coreConfig.zenfs` 选择 FS 后端，并通过 `coreConfig.tinybase.maxSnapshotBytes` 设定快照上限。首次异步操作等待 FS 准备。目标目录只读时，`open()` 拒绝写入。默认 InMemory 确认内存提交，跨 Host 恢复取决于后端。

## 原生实例与恢复

`open()` 创建 Store，`open(store)` 保留传入实例和类型。并发/重复 open 共用恢复任务，同 generation 换实例报 OPEN_CONFLICT。实例须全新、未绑定其他 Host/generation，无 listener、Persister、Synchronizer 或未完成 transaction，且不能是 MergeableStore。Core 以 listener 统计检查可见资源，dormant persister 仍靠 caller 遵守约定。

首次 await 前登记 writer/cleanup，防止晚到恢复逃逸。只有缺失 backing 才保留调用方初值；既有快照完整替换 Tables/Values，合法空内容也替换。恢复先校验格式/身份，再 setContent 并比较原始内容；schema 丢字段或补默认造成变化即失败，原文件保留。恢复期间 caller 不读写或公开 Store，成功后才安装 Queries/listener 并登记 effects。原生 API 不代理。

## Publication、保存与关闭

恢复只读。init mutation 修改候选，prepareCommit 检查完整快照/transaction，publishCommit 同步开启 autosave，IO 在 microtask 调度。publication 成功后保存缺失文件的初值；失败/撤回丢弃候选。publication 后 lazy open 同样开启 autosave。

原生 transaction listeners 捕获完整 Content，仅内容变化推进内部 revision，保存状态独立于 Store。setRow/setValue/transaction 同步返回只表示内存变化。队列最多一个 in-flight 和一个 latest pending，允许合并中间 revision。

flush 捕获调用时最后完整 transaction revision，等待它或更新快照确认，不被持续更新无限推迟。未 open、transaction 未结束、故障或撤回均拒绝。init 内显式 flush 可提交已验证候选，不等待自身 publication；此副作用不会因后续 init 失败回滚，也不提前开启 autosave。

stop 先关闭 admission、排空已接纳调用，再撤销保存监听、固定最后完整快照并排空。旧 Store 仍可改内存，但退役 writer 不再保存。init 撤回不保存候选，未完成 transaction 不写部分数据，关闭失败可观察。root final 在服务 flush 后、FS close 前排空 writers。

## 快照与预算

快照格式独立于 TinyBase 包版本：

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

identity 为 `{ kind: 'plugin', node: PluginNodeAddress }`，content 为原生 [Tables, Values]。只接受普通 data records 和 string/boolean/有限 number；nested object、null/undefined、accessor/class、非有限值均拒绝，JSON 不区分正负零。格式/身份/预算在写入前检查。

maxSnapshotBytes 默认每份完整 envelope UTF-8 8 MiB，要求正安全整数，包含键、身份和 Content。文件位于 `services/tinybase/nodes/<canonical node SHA-256>.json`，表/行名、displayName、包版本、安装路径不参与路径。

保存沿 FS 原子替换；停止、卸载、fork 删除保留快照。共享 backend 的完整写入可能互相覆盖，跨实例锁/CAS/合并业务使用数据库。

## 外部文件变化

fs/observe 定期读取快照，经身份、格式、预算及 native schema 保真校验后替换 Store，让原生 Queries/listener 观察变化。加载期间不启动 autosave 或回写外部快照，本地 transaction/save 仍按本实例 queue 结算。

读取/校验失败保留有效 Store 并报告，后续不同有效内容可恢复。删除接纳为空 Content，同样要求 schema 保真，不恢复调用方初值或后台重建文件。stop 先撤销观察并等待在途读取，再释放 owner/FS。观察和并发边界见 [FS](FS.md#共享文件与观察)。

## Host 文档边界

config/state、Logging policy、Management layout 使用 `services/host/<namespace>/<key>` 普通文档，不创建 TinyBase Store。Core 内部的 TinyBase host 视图只提供 Plugin writer 的 status/recover，status 不包含 Host namespace；该视图不作为插件服务注册。

## 故障与显式恢复

status 报告 owner、phase、current/saved/pending revision、最后错误及 confirmed/unknown，不暴露快照内容。保存失败锁定 writer；内存和 backing 可能已经改变，flush/autosave/close 不自动重试，故障 writer 阻止新 generation 接管。

停止失败 Plugin 后，Host 可显式 recover(node, 'retry') 保存保留的最新完整快照，或 recover(node, 'discard') 丢弃候选并校验实际 backing，然后显式启动新代。同 action 并发复用任务，冲突 action 拒绝；IO 结算前保持阻断。仍运行、恢复失败或 backing 无效不解锁；恢复成功后退役 writer 不能再提交旧值。

格式转换由显式维护工具完成，保留备份并验证新 Host 恢复。逐包迁移记录见 [TinyBase 迁移清单](records/plugin-state-adoption.md)。

## 版本与发行

Core 精确依赖 TinyBase runtime。共享原生 Store 的 Plugin 以同版 peer/dev 声明，通过 pluxel.tinybase facts 准入；只用固定 open 或 configs/DTO 的消费者不增加 TinyBase 依赖。Valibot schematizer 范围由上游 peer 决定。

Host shared-runtime helper 校验 semver/实际 manifest，Cap’n Web 复用同一机制。native、static、Vite 共用准入：shared 同版多路径统一，异版拒绝；private 异版原解析。全局 sharedPackages 不覆盖 tinybase/capnweb 的能力 owner。子路径按 Node/browser 条件绑定，浏览器上游 import 不加载 Host/FS，见 [Governance](GOVERNANCE.md) 和[插件包](../docs/development/plugin-package.md)。

## 实现与回归入口

- Core `tinybase/{types,options,error}.ts`：桥接、预算、错误。
- `internal/storage.ts`、`tinybase/{service,writer}.ts`：owner、publication、flush、撤回/恢复。
- `tinybase/codec.ts`：快照格式。

Core tests 覆盖原生互操作、fork/reopen、空快照、publication、flush、故障/readonly、晚到恢复、恢复互斥；Host tests 覆盖实际后端跨 Host 恢复与外部文件接纳。production/Rolldown/Services Vite 回归保护精确版本准入和上游绑定，Wretch/Fonts/Management 及独立 tarball/starter smoke 验证真实调用方与发行边界。
