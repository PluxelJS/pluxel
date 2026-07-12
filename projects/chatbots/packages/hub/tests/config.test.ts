import { describe, expect, it } from 'vitest'
import { TokenBotConfigStore } from '../src/index.ts'

class MemoryKv {
	readonly values = new Map<string, unknown>()
	async get<Value>(key: string): Promise<Value | undefined> {
		return this.values.get(key) as Value | undefined
	}
	async set<Value>(key: string, value: Value): Promise<void> {
		this.values.set(key, value)
	}
	async delete(key: string): Promise<void> {
		this.values.delete(key)
	}
	async keys(): Promise<string[]> {
		return [...this.values.keys()]
	}
}

describe('TokenBotConfigStore', () => {
	it('stores sorted multi-account credentials and preserves omitted tokens', async () => {
		const kv = new MemoryKv()
		const store = new TokenBotConfigStore(kv, { defaultApiBase: 'https://api.test' })
		await store.upsert({ id: 'zeta', token: 'secret-z' })
		await store.upsert({ id: 'alpha', token: 'secret-a', apiBase: 'https://custom.test/' })
		await store.upsert({ id: 'alpha', apiBase: 'https://next.test/' })

		expect(await store.list()).toEqual(['alpha', 'zeta'])
		expect(await store.read('alpha')).toEqual({
			id: 'alpha',
			token: 'secret-a',
			apiBase: 'https://next.test',
		})
	})

	it('migrates and removes legacy single-account keys without overwriting new data', async () => {
		const kv = new MemoryKv()
		const store = new TokenBotConfigStore(kv, {
			defaultApiBase: 'https://api.test',
			legacyTokenKey: 'bot.token',
			legacyApiBaseKey: 'api.base_url',
		})
		await kv.set('bot.token', 'legacy')
		await kv.set('api.base_url', 'https://legacy.test')
		expect(await store.migrateLegacy()).toBe(true)
		expect(await store.read('default')).toMatchObject({
			token: 'legacy',
			apiBase: 'https://legacy.test',
		})
		expect(await kv.get('bot.token')).toBeUndefined()
	})

	it('serializes mutations for one bot so later configuration wins', async () => {
		const kv = new MemoryKv()
		const store = new TokenBotConfigStore(kv, { defaultApiBase: 'https://api.test' })
		await Promise.all([
			store.upsert({ id: 'primary', token: 'first', apiBase: 'https://first.test' }),
			store.upsert({ id: 'primary', token: 'second', apiBase: 'https://second.test' }),
		])
		expect(await store.read('primary')).toEqual({
			id: 'primary',
			token: 'second',
			apiBase: 'https://second.test',
		})
	})
})
