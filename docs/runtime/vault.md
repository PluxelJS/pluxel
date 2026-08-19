---
title: Vault 加密小数据
description: 用按 Plugin 隔离的 KV、文档和小型二进制对象保存加密状态。
---

# Vault 加密小数据

Vault 是一项需要宿主显式启用的运行时能力，为每个 Plugin 提供相互隔离、加密持久化的 KV、文档和小型二进制对象。它适合保存 token、checkpoint、小配置和少量领域状态，但不能替代关系数据库或对象存储。

## 何时选择 Vault

| 数据                                            | 选择                             |
| ----------------------------------------------- | -------------------------------- |
| token、cursor、checkpoint、少量加密 JSON        | Vault                            |
| 需要 query、index、join、migration 的结构化数据 | [数据库](./database.md)          |
| 大文件、用户上传和远端对象                      | [S3 存储](../plugins/storage.md) |
| 进程内/跨实例短期加速                           | [缓存](../plugins/cache.md)      |

Vault 只在 host 明确导入服务入口时注册，未启用时没有 backend、preflight 或管理成本。

## 启用入口

需要使用 Vault 的应用或固定插件闭包导入一次：

```ts no-twoslash
import '@pluxel/runtime/services/vault'
```

如果你发布一个可以在无 Vault 宿主中运行的通用插件，不要悄悄用 side-effect import 强迫 host 启用它；把 Vault 需求写进应用闭包或明确的 provider package。

## 一个 namespace，三种视图

```ts twoslash
import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Connector' })
export class ConnectorPlugin extends BasePlugin {
	override async init() {
		const space = this.ctx.vault.namespace()
		const kv = space.kv()
		const cursors = space.docs().collection<{ sequence: number; updatedAt: number }>('cursors')
		const certificate = space.blobs().open('client-certificate')

		await kv.set('access-token', 'secret')
		await cursors.set('events', {
			sequence: 42,
			updatedAt: Date.now(),
		})
		await certificate.writeText('certificate text')
		await this.ctx.vault.flush()
	}
}
```

`namespace()` 默认返回当前 Plugin owner 的稳定 namespace。不同 Plugin 即使使用同一个 key 或 collection name，也不会进入同一默认 namespace。

不要把 `namespace().name` 当业务 identity 或对外 API；它由 runtime owner address 派生。

## KV

```ts no-twoslash
const kv = this.ctx.vault.kv()

await kv.set('token', token)
const current = await kv.get<string>('token')
await kv.setMany({ cursor: '42', region: 'hk' })
const entries = await kv.entries<string>()
```

需要原子 read-modify-write 时使用 `batch()`：

```ts no-twoslash
await kv.batch((tx) => {
	const current = Number(tx.get<number>('attempts') ?? 0)
	tx.set('attempts', current + 1)
})
```

batch callback 操作内存中的 copy-on-write transaction，不在其中执行网络请求或长时间异步工作。

## Documents

```ts no-twoslash
const profiles = this.ctx.vault.docs().collection<{ enabled: boolean; label?: string }>('profiles')

await profiles.set('default', { enabled: true })
await profiles.patch('default', { label: 'Primary' })
const profile = await profiles.get('default')
const all = await profiles.list()
```

documents 是按 ID 读取的小型 JSON records，没有 query planner、secondary index 或 migration engine。出现扫描、筛选、关联和 schema evolution 需求时迁移到数据库。

## Blobs

```ts no-twoslash
const blob = this.ctx.vault.blobs().open('oauth-state')

await blob.writeText(serialized)
const restored = await blob.readText()
await blob.remove()
```

blobs 保存在 Vault snapshot 管理的文件区域，适合小型加密字节。大对象、流式上传、range request 和跨服务共享使用对象存储。

`describe().path` 只用于 server-side diagnostics，不暴露到 browser contract 或业务 API。

## 跨 KV 与 documents 的原子更新

稳定 namespace facade 支持一次更新 KV 和 documents：

```ts no-twoslash
const space = this.ctx.vault.namespace()

await space.batch((tx) => {
	tx.kv.set('cursor', 43)
	tx.docs.collection<{ processed: boolean }>('events').set('43', {
		processed: true,
	})
})
```

blob I/O 不进入这个 transaction。需要数据库级 durability、并发隔离或 outbox 时使用 database transaction。

## Unlock 与失败语义

Vault 不在普通 Plugin 调用时偷偷 auto-unlock。host 在启动/preflight 阶段通过 host identity 或部署环境中的 age identity 解锁；若 storage 尚未 ready，Plugin 访问会 fail fast。

默认部署 identity 环境变量是 `PLUXEL_VAULT_DEPLOY_IDENTITY`，host 可通过 `vault.deployIdentityEnv` 改名。私钥不得写进普通 Plugin config、日志、Workbench resource 或发行物。

`vaultAdmin` 是 root-owned 宿主管理 API，用于 preflight、unlock、rekey 和 deploy recipient 管理。业务 Plugin 只使用 `ctx.vault`，不调用 root admin API。

## Flush 与 durability

写入会进入内存状态并按 host debounce 策略持久化。需要在关键边界确认 snapshot 已落盘时调用：

```ts no-twoslash
await this.ctx.vault.flush()
```

不要在每次高频状态变化后强制 flush；批量 checkpoint 或 shutdown 边界更合适。host 可通过 `vault.flushDebounceMs` 控制后台合并窗口。

## 安全检查

- 默认 namespace 由 owner 隔离，没有跨 Plugin 隐式共享。
- log、status、HTTP 和 Workbench DTO 不包含 secret value。
- 解锁属于 host preflight，不发生在业务请求中。
- 关系查询、大文件和缓存分别交给 database/storage/cache。
- batch callback 短小、确定，不执行外部 I/O。
- 关键写入边界明确决定是否需要 `flush()`。
