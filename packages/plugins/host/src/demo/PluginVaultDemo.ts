// 演示：在插件中使用 `ctx.vault` 做加密持久化（Portable Vault v1）。
//
// 目标：
// - 展示 token(字符串) 与 secret(JSON) 的基本读写
// - 展示 `batch()`：把多次写入合并为一次加密+落盘
// - 展示 `lock()`：清空进程内缓存（下次读会重新解密）
//
// 注意：
// - `LogRecord.timestamp` 永远是 epoch ms；这里讨论的是“格式化显示”。
// - vault 默认目录是 `data/vault/<namespace>/vault.json`（相对 cwd）。

import { BasePlugin, Plugin } from '@pluxel/hmr'

@Plugin({ name: 'PluginVaultDemo' })
export class PluginVaultDemo extends BasePlugin {
	override async init() {
		const vault = this.ctx.vault.open({ dir: './data/vault' })

		// Read-only: vault missing 时不会创建任何文件。
		const existingToken = await vault.getToken('demo.token')
		if (!existingToken) {
			await vault.setToken('demo.token', `token_${Date.now()}`)
		}

		// JSON secret：适合存插件偏好、缓存元信息等（不要存大对象）。
		const existingPrefs = await vault.getSecret<{ enabled: boolean; lastSeenAt: number }>(
			'demo.prefs',
		)
		await vault.setSecret('demo.prefs', {
			enabled: existingPrefs?.enabled ?? true,
			lastSeenAt: Date.now(),
		})

		// 合并多次变更：一次写入落盘（减少重复 encrypt/write）。
		await vault.batch(async (tx) => {
			tx.setToken('demo.counter', String((Number(tx.getToken('demo.counter') ?? '0') || 0) + 1))
			tx.setSecret('demo.meta', { updatedAt: Date.now() })
		})

		const keys = await vault.listKeys()
		this.ctx.logger.info('Vault demo ready', {
			dir: './data/vault',
			keys,
			token: await vault.getToken('demo.token'),
			counter: await vault.getToken('demo.counter'),
		})

		// Optional: clear in-memory cache (forces decrypt next time).
		vault.lock()
	}
}
