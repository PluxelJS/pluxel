import { describe, expect, it } from 'vitest'
import { BotAccountStore } from '../src/account-store.ts'

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

describe('BotAccountStore', () => {
	it('stores one atomic record per account and preserves omitted tokens', async () => {
		const kv = new MemoryKv()
		const store = new BotAccountStore(kv, 'https://api.test')
		await store.upsert({ id: 'zeta', token: 'secret-z' })
		await store.upsert({ id: 'alpha', token: 'secret-a', apiBase: 'https://custom.test/' })
		await store.upsert({ id: 'alpha', apiBase: 'https://next.test/' })

		expect(await store.list()).toEqual(['alpha', 'zeta'])
		expect(await store.read('alpha')).toEqual({
			id: 'alpha',
			token: 'secret-a',
			apiBase: 'https://next.test',
		})
		expect(await kv.keys()).toEqual(['accounts.zeta', 'accounts.alpha'])
	})

	it('deletes one account record without field-level cleanup', async () => {
		const kv = new MemoryKv()
		const store = new BotAccountStore(kv, 'https://api.test')
		await store.upsert({ id: 'primary', token: 'secret' })
		await store.remove('primary')
		expect(await store.list()).toEqual([])
		expect(await store.read('primary')).toBeUndefined()
	})

	it('rejects malformed persisted account records', async () => {
		const kv = new MemoryKv()
		kv.values.set('accounts.primary', { token: '', apiBase: 42 })
		const store = new BotAccountStore(kv, 'https://api.test')
		await expect(store.read('primary')).rejects.toThrow('Invalid Bot account configuration')
	})

	it('rejects API bases that cannot safely receive endpoint paths', async () => {
		const store = new BotAccountStore(new MemoryKv(), 'https://api.test')
		await expect(
			store.upsert({ id: 'primary', token: 'secret', apiBase: 'file:///tmp/api' }),
		).rejects.toThrow('Invalid Bot API base URL')
	})
})
