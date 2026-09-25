import { createTestHost } from '@pluxel/test'
import { expect, it } from 'vitest'
import { CachePlugin, MemoryCacheBackendPlugin } from '../src/index.ts'
import { AccountSource, CachedAccounts } from './fixtures/result-consumer.ts'

it('caches plain accounts and deliberate absence, but never caches a rejected load as an Err', async () => {
	await using host = await createTestHost()
	await host.start([MemoryCacheBackendPlugin, CachePlugin, AccountSource, CachedAccounts])
	const source = host.require(AccountSource)
	const accounts = host.require(CachedAccounts)

	const first = await accounts.find('alice')
	const cached = await accounts.find('alice')
	expect(first.unwrap()).toEqual({ id: 'alice', name: 'Alice' })
	expect(cached.unwrap()).toEqual({ id: 'alice', name: 'Alice' })
	expect(source.loadCount()).toBe(1)
	for (let i = 0; i < 2; i++) {
		const missing = await accounts.find('missing')
		expect(missing.isErr()).toBe(true)
		if (missing.isOk()) throw new Error('Unexpected Result branch')
		expect(missing.error._tag).toBe('AccountNotFound')
	}
	expect(source.loadCount()).toBe(2)
	await accounts.invalidate('missing')
	source.put({ id: 'missing', name: 'New account' })
	const created = await accounts.find('missing')
	expect(created.isOk()).toBe(true)

	const offline = new Error('repository offline')
	source.setFailure(offline)
	await expect(accounts.find('retry')).rejects.toBe(offline)
	source.setFailure()
	source.put({ id: 'retry', name: 'Recovered' })
	const recovered = await accounts.find('retry')
	expect(recovered.unwrap().name).toBe('Recovered')
})
