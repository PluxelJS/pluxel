---
title: Vault：私密凭据与密钥管理
description: 在插件中安全存储 API Key、Token 与私密凭证，支持带版本控制的乐观写入与加密文件持久化。
---

每个运行中的插件都可以从 `this.ctx.vault` 读取自己节点的凭据。部署方通过绑定注入的记录是只读的，三个 Host 入口都支持。需要由插件轮换或保存令牌时，Node 和浏览器可选用加密文件后端。后端的存储介质决定数据能保留多久。 [宿主配置](../host/configuration.md#部署凭据与-vault-绑定)

`kv().get(key)` 返回包含 `exists`、`value`、`writable` 和 `revision` 的快照。只读取部署凭据的插件检查 `exists` 后使用 `value`。向绑定记录写入会得到 `READ_ONLY`。

## 存取私密记录

下面的插件在可写后端保存令牌。更新时带上上次读取的版本，避免覆盖同一根上的并发修改。

```ts
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class AuthServicePlugin extends BasePlugin {
	async updateToken(newToken: string): Promise<void> {
		const kv = this.ctx.vault.kv()

		const current = await kv.get<{ token: string }>('primary-token')

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

`expectedRevision` 只检查此 Host 当前已加载的记录版本。同一个根上先提交的更新会使过期写入得到 `REVISION_CONFLICT`。多个 Host 共用文件时需要由应用协调写入，外部快照替换还可能使版本号重复或回退。

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

如果批处理内部出现未处理的版本冲突或校验失败，整批修改都不会被提交。

## 监听凭据变动（Watch）

`watch` 订阅当前根中该键的变化。加密后端也会通知已接纳的外部快照变化。部署绑定在根创建时固定，轮换它需要由宿主提供新的部署输入。

```ts
const kv = this.ctx.vault.kv()

await kv.watch('primary-token', (snapshot) => {
	this.ctx.logger.info('Credential updated', { revision: snapshot.revision })
})
```

订阅随插件作用域释放。需要提前结束时，可以调用订阅返回值的 `dispose()`。

## 小型加密二进制存储（Blobs）

使用加密后端时，可以通过 `blobs()` 存取证书或其他小型二进制文件。只读部署绑定仅提供键值记录。

```ts
const blob = this.ctx.vault.blobs().open('client-certificate')
await blob.writeBytes(certBytes)

const savedBytes = await blob.readBytes()
```

## Host 后端与部署输入

Host 通过 `coreConfig.vault` 配置凭据后端。配置和记录类型、`VaultError` 从 `@pluxel/core/vault` 导入。Node 和浏览器的默认加密后端借用 `coreConfig.zenfs` 选择的文件系统，Cloudflare 使用只读绑定。首次数据操作按需初始化全新加密库，管理员也可通过管理面的解锁操作初始化或解锁存储。已有库缺少匹配密钥或解密失败时，由访问该库的操作报告错误。

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

部署私钥由应用工厂显式传入。需要关闭并重开 Host 后保留记录时，给 `services/vault/` 配置持久后端，在 `zenfs.durableMounts` 声明覆盖该目录的挂载点及其子挂载，并设置 `coreConfig.vault.durable: true`。首次打开 Vault 时检查这些声明，缺少声明会在创建密钥或写入凭据前以 `ENOTSUP` 拒绝操作。备份和恢复应在停机后复制完整的 `services/vault/` 数据目录。见[选择文件后端](../host/configuration.md#选择文件后端)。

只使用部署凭据的应用可设 `coreConfig.vault` 为 `{ backend: 'bindings' }`。在插件或 fork 条目上用 `envBindings` 声明 schema、记录键和部署变量名。Node、浏览器和 Cloudflare 的应用启动入口在创建根时校验并注入完整只读记录。托管 Node 还支持用 `fileBindings` 读取部署侧 JSON 文件。读取这些内存记录无需加载 age 加密库。该后端在配置阶段拒绝 `durable: true`。使用加密后端时同名部署记录仍为只读。见[部署输入绑定](../host/configuration.md#绑定部署环境与-json-文件)。

调用方需要恢复时，捕获 `VaultError` 并检查稳定的 `code`：锁定或权限拒绝为 `ACCESS_DENIED`，无法解密为 `DECRYPT_FAILED`，只读写入为 `READ_ONLY`，乐观写入冲突为 `REVISION_CONFLICT`。不要解析错误消息，也不要在错误处理时输出凭据值。
