---
title: Vault：私密凭据与密钥管理
description: 在插件中安全存储 API Key、Token 与私密凭证，支持带版本控制的乐观写入与加密文件持久化。
---

对于需要长期存储 API Key、OAuth 访问令牌、私钥或用户凭证的场景，Core 内建的 `ctx.vault` 提供加密存储与隔离访问。普通应用配置保存在标准配置 Schema 中，私密敏感数据交由 Vault 管理。

Plugin Context 始终提供 `vault`，无需安装服务。能力存在不代表密钥已配置、存储已解锁或记录存在：实际操作会报告锁定、解密失败和只读错误；`get()` 通过快照的 `exists` 表示记录是否存在。

每个插件只能访问属于自身命名空间的 Vault 记录，确保私密数据不会被其他插件越权窥探。

## 存取私密记录

在插件中通过 `this.ctx.vault.kv()` 访问当前插件的键值存储：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class AuthServicePlugin extends BasePlugin {
	async updateToken(newToken: string): Promise<void> {
		const kv = this.ctx.vault.kv()

		// 1. 读取已有记录及其版本号
		const current = await kv.get<{ token: string }>('primary-token')

		// 2. 携带 expectedRevision 进行乐观锁提交，防止并发覆盖
		await kv.set('primary-token', { token: newToken }, { expectedRevision: current.revision })
	}

	async getToken(): Promise<string | undefined> {
		const kv = this.ctx.vault.kv()
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
const kv = this.ctx.vault.kv()

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
const kv = this.ctx.vault.kv()

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
const blob = this.ctx.vault.blobs().open('client-certificate')
await blob.writeBytes(certBytes)

const savedBytes = await blob.readBytes()
```

## Host 后端与部署输入

Host 通过 `coreConfig.vault` 配置凭据后端。配置和记录类型、`VaultError` 从 `@pluxel/core/vault` 导入。默认加密后端借用 `coreConfig.zenfs` 选择的文件系统。首次数据操作按需初始化全新加密库，管理员也可通过管理面的解锁操作初始化或解锁存储。已有库缺少匹配密钥或解密失败时，由访问该库的操作报告错误。

```ts
import { defineHostApplication } from '@pluxel/host'

export default defineHostApplication((startup) => ({
	coreConfig: {
		vault: {
			backend: 'encrypted',
			deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY,
		},
	},
}))
```

Core 不读取进程环境变量；部署私钥由应用工厂显式传入。需要重开后保留加密记录时，同时[选择持久文件后端](../host/configuration.md#选择文件后端)。备份和恢复应在停机后复制完整的 `services/vault/` 数据目录。

只使用部署凭据的应用可设 `coreConfig.vault` 为 `{ backend: 'bindings' }`。在插件或 fork 条目上声明 `envBindings` 与 `fileBindings`，Host 校验并注入完整只读记录。部署记录驻留在内存中，使用加密后端时同名部署记录仍为只读。见[部署输入绑定](../host/configuration.md#绑定部署环境与-json-文件)。

调用方需要恢复时，捕获 `VaultError` 并检查稳定的 `code`：锁定或权限拒绝为 `ACCESS_DENIED`，无法解密为 `DECRYPT_FAILED`，只读写入为 `READ_ONLY`，乐观写入冲突为 `REVISION_CONFLICT`。不要解析错误消息，也不要在错误处理时输出凭据值。
