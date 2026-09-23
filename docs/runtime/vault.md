---
title: Vault：凭据与结构化记录
description: 选择 Vault 后端，绑定部署凭据，并读写带版本的私有记录。
---

# Vault：凭据与结构化记录

Vault 存放 API key、账号 token 和需要加密的业务状态。普通运行设置留在 Plugin config，通过账号 ID 引用 Vault 记录；插件只读取自己的记录，不读取整个环境。
插件自行读写私有 KV 时不必声明 Vault 根 schema；只有宿主从环境变量或 JSON 文件安装部署凭据时才需要它。

## 选择后端

可写记录使用加密后端，并显式安装 Persistence：

```ts
services: [
	persistence('./data/persistence'),
	vault({
		deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY,
	}),
]
```

只有部署凭据时选择 `vault({ backend: 'bindings' })`。它不依赖 Persistence，不创建密钥或磁盘文件；没有绑定的记录不存在，所有写入拒绝。`servicesPreset(startup, options)` 显式从该 startup 环境读取部署解锁身份，`options.vault` 可以覆盖后端和迁移配置。直接 `vault()` 不读取进程环境。

## 部署凭据

宿主在应用工厂中通过 `envBindings` 或 `fileBindings` 用 `envBinding` / `fileBinding` 把导出的凭据根 schema 绑定到输入。Host 先完成 schema 校验、准备服务，再安装绑定，最后启动插件。见[应用入口](../getting-started/host-setup.md)。

```ts no-twoslash
import { defineHostApplication, envBinding } from '@pluxel/host'
import * as v from 'valibot'
import { MyPlugin } from './MyPlugin.ts'

const Credentials = v.object({ primary: v.object({ token: v.string() }) })

export default defineHostApplication(() => ({
	plugins: [MyPlugin],
	envBindings: [
		envBinding(MyPlugin, {
			vault: { schema: Credentials, mapping: { primary: { token: 'APP_TOKEN' } } },
		}),
	],
}))
```

若凭据由挂载的 JSON 文件提供，则在同一个应用入口中用 `fileBindings: [fileBinding(MyPlugin, { vault: { schema: Credentials, paths: { primary: './credentials.json' } } })]` 替换上面的 `envBindings`。同一记录只能绑定一个来源。

显式绑定的 env/file 是整条只读记录，绝不与已存 KV 拼接。缺失输入不会偷偷回退到旧凭据；移除绑定后才重新读取持久记录。部署输入不写入加密 snapshot。

导出的凭据根 schema 使用 `v.object({ primary: CredentialSchema })` 声明固定记录，或 `v.record(KeySchema, CredentialSchema)` 声明账号记录。宿主显式导入这个 schema，传给绑定的 `vault.schema`，在 `mapping` / `paths` 中填写记录 key 和环境名/JSON 路径。它是本次 Host 的部署入口契约，修改它需要重新创建 Host；Plugin 热替换不会自动替换该契约。私有 KV 的写入仍由业务用例校验，不会自动成为部署入口。每个明确映射的环境名都必须存在；schema 的 optional 字段可以不映射。

刷新 token 或完成二维码登录前检查 `writable`，并用开始操作时读取的 revision 条件提交。`REVISION_CONFLICT` 表示期间已有其他登录或更新，不能无条件重写；重新读取并由业务决定下一步。二维码挑战、计时器和网络请求归 Plugin generation 所有，停止后释放。

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

`get()`、`set()` 和 `delete()` 共用不可变快照：`key`、`exists`、`value`、`revision`、`source`、`writable`。`source` 为 `kv`、`env` 或 `file`。未出现过的 key revision 为 0；删除保留递增的 revision，因此删除重建后旧条件写入仍冲突。

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

消费者应按账号串行处理并忽略已应用的旧 revision：初始快照返回后可能已有更晚通知。通知在存储锁外执行，可合并同一 key 的中间状态；一个订阅的 callback 串行，多个订阅相互独立。`set()` 不等待客户端连接或观察 callback，callback 失败不会把已提交写入误报为未保存。插件自己跟踪 committed/applied revision、重试和连接切换。

`dispose()` 手动撤销订阅；owner 停止也自动撤销。Plugin/Part/caller 的旧 handle 在停止后拒绝新操作；已经接纳的事务与 blob IO 先排空再清理。

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

## 迁移、密钥与备份

旧 snapshot 中的 KV 原样保留；旧 Documents 自动映射为 `documents/<encodeURIComponent(collection)>/<encodeURIComponent(id)>`。与已有 KV key 冲突时启动失败，避免覆盖数据。首次后续提交写入带 revision 的新格式。

旧自定义 namespace 曾是全局分区，框架不能猜测其 owner。应用显式声明归属：

```ts
vault({
	legacyNamespaces: [
		{
			owner: pluginNodeAddressOf(AccountPlugin),
			namespace: 'accounts',
			from: 'old-accounts',
		},
	],
})
```

启动时复制 KV 与加密 blobs，并在持久 snapshot 中提交一次性迁移标记；再次启动不会从旧分区覆盖新记录。原分区保留为审计副本，目标有冲突时明确拒绝。默认 owner namespace 的原身份保持不变，无需这项映射。

加密后端使用 `global/keys.age` 包装数据密钥，`global/state.enc` 保存记录，`global/blobs/` 保存独立 blob。`security/identity.json` 保存宿主身份。已有仓库无法解锁、损坏或缺失 snapshot 时启动失败，不作为空仓库覆盖。

Root 通过 `VaultAdmin` 管理解锁、宿主密钥和部署 recipients。`rekey()` 原子重写密钥 envelope，数据密钥与密文内容保持；失败保留先前可用数据。部署私钥由宿主显式输入，不放入 Plugin config、日志或 UI。

备份与回滚应在 Host 停止后整体复制 Persistence 的 `vault` namespace：包括 `security/identity.json`、`global/keys.age`、`global/state.enc` 和 `global/blobs/`。保留迁移前副本可以恢复原格式与原 namespace。不要分别恢复不匹配的 key envelope 与数据文件；本轮不提供跨进程 writer 或跨 config/Vault 事务。
