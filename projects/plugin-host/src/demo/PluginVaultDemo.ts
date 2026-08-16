// Read this when:
// - 你要在插件里做共享加密持久化
// - 你想看 kv / docs / blobs 的最小组合

import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'

const KV_TOKEN = 'demo.token'
const KV_COUNTER = 'demo.counter'

@Plugin()
export class PluginVaultDemo extends BasePlugin {
	override async init() {
		const vault = this.ctx.vault
		const space = vault.namespace()
		const kv = space.kv()
		const profiles = space.docs().collection<{ enabled: boolean; lastSeenAt: number }>('profiles')
		const notes = space.blobs().open('notes')

		await this.ensureToken(kv)
		await this.bumpCounter(kv)
		await profiles.patch('default', {
			enabled: true,
			lastSeenAt: Date.now(),
		})
		await notes.writeText(`vault-demo:${Date.now()}`)
		await vault.flush()

		this.ctx.logger.info('Vault demo ready', {
			kv: await kv.entries(),
			profile: await profiles.get('default'),
			blob: await notes.readText(),
		})
	}

	private async ensureToken(kv: ReturnType<typeof this.ctx.vault.kv>) {
		if (await kv.has(KV_TOKEN)) return
		await kv.set(KV_TOKEN, `token_${Date.now()}`)
	}

	private async bumpCounter(kv: ReturnType<typeof this.ctx.vault.kv>) {
		await kv.batch((tx) => {
			tx.set(KV_COUNTER, String((Number(tx.get<string>(KV_COUNTER) ?? '0') || 0) + 1))
		})
	}
}
