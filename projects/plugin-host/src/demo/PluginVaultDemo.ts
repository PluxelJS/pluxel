// Read this when:
// - 你要在插件里做共享加密持久化
// - 你想看结构化 KV snapshot、原子更新和 blobs 的最小组合

import { BasePlugin, Plugin } from '@pluxel/core'
import { Vault, type VaultKvHandle } from '@pluxel/services/vault'

const KV_TOKEN = 'demo.token'
const KV_COUNTER = 'demo.counter'
const KV_PROFILE = 'demo.profile'

@Plugin()
export class PluginVaultDemo extends BasePlugin {
	override async init() {
		const vault = this.ctx.require(Vault)
		const space = vault.namespace()
		const kv = space.kv()
		const notes = space.blobs().open('notes')

		await this.ensureToken(kv)
		await this.bumpCounter(kv)
		await kv.set(KV_PROFILE, {
			enabled: true,
			lastSeenAt: Date.now(),
		})
		await notes.writeText(`vault-demo:${Date.now()}`)
		await vault.flush()

		const token = await kv.get(KV_TOKEN)
		const profile = await kv.get(KV_PROFILE)
		this.ctx.logger.info('Vault demo ready', {
			tokenPresent: token.exists,
			profile: profile.value,
			blob: await notes.readText(),
		})
	}

	private async ensureToken(kv: VaultKvHandle) {
		const token = await kv.get(KV_TOKEN)
		if (token.exists) return
		await kv.set(KV_TOKEN, { token: `token_${Date.now()}` })
	}

	private async bumpCounter(kv: VaultKvHandle) {
		await kv.batch((tx) => {
			const previous = tx.get<{ count: number }>(KV_COUNTER).value
			tx.set(KV_COUNTER, { count: (previous?.count ?? 0) + 1 })
		})
	}
}
