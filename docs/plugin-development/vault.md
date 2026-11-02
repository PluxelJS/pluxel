---
title: Vault：凭据与结构化记录
description: 选择 Vault 后端，绑定部署凭据，并读写带版本的私有记录。
---

Vault 存放 API key、账号 token 和需要加密的业务状态。普通运行设置留在 Plugin config，通过账号 ID 引用 Vault 记录；插件只读取自己的记录，不读取整个环境。
插件自行读写私有 KV 时不必声明 Vault 根 schema；只有宿主从环境变量或 JSON 文件安装部署凭据时才需要它。

刷新 token 或完成登录前检查记录的 `writable`，并用开始操作时的 revision 条件提交。该检查只协调同一 Vault 实例内的操作；需要多个实例共同修改同一业务状态时使用数据库。登录挑战、计时器和网络请求由 Plugin generation 回收。

## 读取、保存与并发更新

```ts
const kv = this.ctx.require(Vault).kv()
const before = await kv.get<{ token: string }>('primary')
if (before.exists) useToken(before.value!.token)

const committed = await kv.set(
	'primary',
	{ token: 'new-token' },
	{
		expectedRevision: before.revision,
	},
)
```

`get()`、`set()` 和 `delete()` 共用不可变快照：`key`、`exists`、`value`、`revision`、`source`、`writable`。`source` 为 `kv`、`env` 或 `file`。未出现过的 key revision 为 0；本实例删除保留递增的 revision，因此删除重建后旧条件写入仍冲突。其他实例写入或恢复备份可能使载入的 revision 重复或变小，它不是跨实例全局版本。

`expectedRevision` 不匹配抛出 `VaultError`，`code` 为 `REVISION_CONFLICT`。部署记录或无写后端抛出 `READ_ONLY`。持久写失败不发布值或 revision；调用成功表示已完成加密 snapshot 的原子持久提交。

值只能是无环、有限数值的普通 JSON 数据。Vault 克隆写入输入并深冻结读取快照；class、函数、accessor、undefined 和循环引用不能作为值。删除使用 `delete()`。

```ts
await kv.batch((tx) => {
	const account = tx.get('primary')
	tx.set('primary', { token: nextToken }, { expectedRevision: account.revision })
	tx.set('active-account', 'primary')
})
```

Batch 在同一 namespace 中原子提交；任一校验、冲突或持久写失败使整批不发布。事务 callback 可异步，但不能从 callback 再调用该 Vault 的异步方法；使用 `tx`，不要在锁内做远程请求。callback 结束后保留的 tx 失效。

`keys({ prefix, after, limit })` 返回按 key 排序的有界页面；默认 100，最大 1000。下一页使用上一页最后一个 key 作为 `after`。复杂查询使用数据库。

## 保存后应用与观察

```ts
const subscription = await kv.watch('primary', async (snapshot) => {
	await applyCredential(snapshot)
})
await applyCredential(subscription.snapshot)
```

`watch()` 原子取得初始快照并建立订阅，避免先读取再订阅之间漏更新。多账号使用 `watchPrefix('account/', listener)`，返回 `{ snapshots, dispose }`；会观察后续新增与删除，初始匹配超过 1000 条时明确拒绝。

消费者应按账号串行处理初始快照和后续通知，初始化完成前先等待或暂存通知；初始快照返回时可能已有后续通知。不要仅按 revision 大小丢弃外部更新。通知在存储锁外执行，可合并同一 key 的中间状态；一个订阅的 callback 串行，多个订阅相互独立。`set()` 不等待客户端连接或观察 callback，callback 失败不会把已提交写入误报为未保存。插件自己跟踪 committed/applied revision、重试和连接切换。

`dispose()` 手动撤销订阅；owner 停止也自动撤销。Plugin/Part/caller 的旧 handle 在停止后拒绝新操作；已经接纳的事务与 blob IO 先排空再清理。

## 外部文件更新

加密后端会观察实际保存的密文文件。其他实例写入后，本实例重新解密、校验 snapshot，再切换内存视图并通知 `watch()` / `watchPrefix()`；部署 env/file 记录继续覆盖对应 KV，外部加载不写回文件。Vault 仍直接使用 Core FS，不依赖 TinyBase。

缺失、损坏或无法解密的外部更新保留当前有效视图，并通过日志和 `VaultAdmin.describe().lastError` 报告；新文件修正后可继续加载。blob 在每次读取时访问自己的文件，不具有 KV watch 语义。

完整快照写入可能覆盖其他实例尚未被本实例读到的修改。原子文件替换、`expectedRevision` 与 batch 都不提供跨实例并发保证；需要共享事务、条件更新或并发写入不丢失时使用[数据库](./database.md)。共享后端和备份范围见 [Host 配置](../host/configuration.md#共享文件与外部修改)。

## Owner 与 namespace

默认 namespace 来自 Plugin node identity。`namespace('accounts')` 或 `kv({ namespace: 'accounts' })` 是该 owner 的子空间，不能借另一个插件的名称访问它。Part 与所属 Plugin 使用同一 owner；fork 各自隔离。Root 是受信任管理代码，能够按完整持久 namespace 名读取。

结构化 KV 是唯一记录模型。账号用 `account/<id>` 等业务 key 组织，不需要 collection。

小型二进制仍使用加密 blob；例如证书、密钥文件或少量缓存字节：

```ts no-twoslash
const blob = this.ctx.require(Vault).blobs().open('client-certificate')
await blob.writeBytes(certificateBytes)
const bytes = await blob.readBytes() // 不存在时为 undefined
```

`readText()` / `writeText()` 使用同一 blob 入口。blob 是独立文件，不参与 KV batch，也没有 KV revision 或 watch；读写会处理完整字节数组，大对象和流式文件应交给对象存储。

后端、只读部署绑定、密钥备份与管理页面由[Host 配置](../host/configuration.md#选择后端)维护。
