// Read this when:
// - 你要在插件里做加密持久化
// - 你想看 token / secret / batch / lock 的最小组合

import { BasePlugin, Plugin } from '@pluxel/runtime'

const VAULT_DIR = './data/vault'
const TOKEN_KEY = 'demo.token'
const PREFS_KEY = 'demo.prefs'
const COUNTER_KEY = 'demo.counter'
const META_KEY = 'demo.meta'

@Plugin({ name: 'PluginVaultDemo' })
export class PluginVaultDemo extends BasePlugin {
	override async init() {
		const vault = this.ctx.vault.open({ dir: VAULT_DIR })
		await this.ensureToken(vault)
		await this.touchPrefs(vault)
		await this.bumpCounter(vault)

		const keys = await vault.listKeys()
		this.ctx.logger.info('Vault demo ready', {
			dir: VAULT_DIR,
			keys,
			token: await vault.getToken(TOKEN_KEY),
			counter: await vault.getToken(COUNTER_KEY),
		})

		vault.lock()
	}

	private async ensureToken(vault: ReturnType<typeof this.ctx.vault.open>) {
		const existingToken = await vault.getToken(TOKEN_KEY)
		if (existingToken) return
		await vault.setToken(TOKEN_KEY, `token_${Date.now()}`)
	}

	private async touchPrefs(vault: ReturnType<typeof this.ctx.vault.open>) {
		const existingPrefs = await vault.getSecret<{ enabled: boolean; lastSeenAt: number }>(PREFS_KEY)
		await vault.setSecret(PREFS_KEY, {
			enabled: existingPrefs?.enabled ?? true,
			lastSeenAt: Date.now(),
		})
	}

	private async bumpCounter(vault: ReturnType<typeof this.ctx.vault.open>) {
		await vault.batch(async (tx) => {
			tx.setToken(COUNTER_KEY, String((Number(tx.getToken(COUNTER_KEY) ?? '0') || 0) + 1))
			tx.setSecret(META_KEY, { updatedAt: Date.now() })
		})
	}
}
