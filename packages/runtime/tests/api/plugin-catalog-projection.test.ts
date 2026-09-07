import type { PluginNodeAddress } from '@pluxel/core'
import { describe, expect, it } from 'vitest'
import { buildPluginNodeLabels } from '../../src/api/features/plugins/catalog-projection'

function packageNode(packageName: string, exportName: string, forkId?: string): PluginNodeAddress {
	const definition = {
		entry: { kind: 'package-root' as const, packageName },
		exportName,
	}
	return forkId ? { definition, variant: 'fork', forkId } : { definition, variant: 'default' }
}

describe('Plugin catalog labels', () => {
	it('keeps a unique display name short', () => {
		const address = packageNode('@acme/orders', 'OrdersPlugin')
		const labels = buildPluginNodeLabels([{ nodeAddress: address, displayName: 'Orders' }])

		expect([...labels.values()]).toEqual([{ title: 'Orders', text: 'Orders' }])
	})

	it('qualifies only colliding names and keeps forks visible', () => {
		const first = packageNode('@acme/first', 'CachePlugin')
		const second = packageNode('@acme/second', 'CachePlugin')
		const fork = packageNode('@acme/first', 'CachePlugin', 'tenant-a')
		const labels = buildPluginNodeLabels(
			[first, second, fork].map((nodeAddress) => ({ nodeAddress, displayName: 'Cache' })),
		)

		expect([...labels.values()].map(({ text }) => text)).toEqual([
			'Cache (@acme/first)',
			'Cache (@acme/second)',
			'Cache / tenant-a',
		])
	})

	it('adds the export when colliding definitions share provenance', () => {
		const first = packageNode('@acme/cache', 'MemoryCachePlugin')
		const second = packageNode('@acme/cache', 'DiskCachePlugin')
		const labels = buildPluginNodeLabels([
			{ nodeAddress: first, displayName: 'Cache' },
			{ nodeAddress: second, displayName: 'Cache' },
		])

		expect([...labels.values()].map(({ text }) => text)).toEqual([
			'Cache (@acme/cache::MemoryCachePlugin)',
			'Cache (@acme/cache::DiskCachePlugin)',
		])
	})

	it('rejects duplicate node addresses as a catalog invariant violation', () => {
		const address = packageNode('@acme/orders', 'OrdersPlugin')
		expect(() =>
			buildPluginNodeLabels([
				{ nodeAddress: address, displayName: 'Orders' },
				{ nodeAddress: address, displayName: 'Other name' },
			]),
		).toThrow(/duplicate address/i)
	})
})
