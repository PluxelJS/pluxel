---
title: Vault：私密凭据与密钥管理
description: 在插件中安全存储 API Key、Token 与私密凭证，支持带版本控制的乐观写入与加密文件持久化。
---

对于需要长期存储 API Key、OAuth 访问令牌、私钥或用户凭证的场景，Pluxel 提供了专用的 `Vault` 服务。普通应用配置保存在标准配置 Schema 中，而私密敏感数据则交由 Vault 执行加密存储与隔离访问。

每个插件只能访问属于自身命名空间的 Vault 记录，确保私密数据不会被其他插件越权窥探。

## 存取私密记录

在插件中通过 `this.ctx.require(Vault).kv()` 访问当前插件的键值存储：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { Vault } from '@pluxel/services/vault'

@Plugin()
export class AuthServicePlugin extends BasePlugin {
	async updateToken(newToken: string): Promise<void> {
		const kv = this.ctx.require(Vault).kv()

		// 1. 读取已有记录及其版本号
		const current = await kv.get<{ token: string }>('primary-token')

		// 2. 携带 expectedRevision 进行乐观锁提交，防止并发覆盖
		await kv.set(
			'primary-token',
			{ token: newToken },
			{ expectedRevision: current.revision },
		)
	}

	async getToken(): Promise<string | undefined> {
		const kv = this.ctx.require(Vault).kv()
		const record = await kv.get<{ token: string }>('primary-token')
		return record.exists ? record.value?.token : undefined
	}
}
```

### 乐观并发控制（Revision）

- `get()` 返回的快照包含当前的 `revision` 版本号；
- 在调用 `set()` 时传入 `expectedRevision`，若在此期间记录被其他并发操作修改，调用将抛出 `REVISION_CONFLICT` 错误，便于开发者处理重试。

## 批量原子提交（Batch）

支持在同一个插件命名空间内原子性更新多条凭据：

```ts
const kv = this.ctx.require(Vault).kv()

await kv.batch((tx) => {
	const current = tx.get('account')
	tx.set('account', { token: nextToken }, { expectedRevision: current.revision })
	tx.set('active-id', 'account_123')
})
```

如果批处理内部出现版本冲突或校验失败，整批修改都不会被提交。

## 监听凭据变动（Watch）

当后台刷新 Token 或外部环境更新了密钥文件时，可通过 `watch` 实时响应：

```ts
const kv = this.ctx.require(Vault).kv()

// 订阅特定 Key 的变更，返回注销函数
const subscription = await kv.watch('primary-token', (snapshot) => {
	this.ctx.logger.info('Credential updated', { revision: snapshot.revision })
})

// 插件停止时自动释放
this.ctx.effects.defer(() => subscription.dispose())
```

## 小型加密二进制存储（Blobs）

如果需要加密保存私钥证书（`.pem`）或证书链文件，可以使用 Vault 提供的 `blobs()` 接口：

```ts
const blob = this.ctx.require(Vault).blobs().open('client-certificate')
await blob.writeBytes(certBytes)

const savedBytes = await blob.readBytes()
```
