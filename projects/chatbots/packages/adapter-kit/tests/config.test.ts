import { describe, expect, it } from 'vitest'
import { TokenBotConfigStore } from '../src/config.ts'

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
