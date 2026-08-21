import type { PluginNodeAddressSnapshot } from '@pluxel/core'
import { describe, expect, it } from 'vitest'
import { assignPluginPublicIds } from '../../src/api/features/plugins/catalog-projection'
import { pluginNodeAddressKey } from '../../src/runtime/plugin-address'

function owner(
	packageName: string,
	exportName: string,
	instance: 'default' | { forkId: string } = 'default',
): PluginNodeAddressSnapshot {
	const definition = {
		entry: { kind: 'package-root' as const, packageName },
		exportName,
	}
	return instance === 'default'
		? { definition, instance }
		: { definition, instance: 'fork', forkId: instance.forkId }
}

describe('Plugin catalog public IDs', () => {
	it('keeps an unambiguous default Plugin on its ordinary root export name', () => {
		const address = owner('@acme/orders', 'OrdersPlugin')
		const ids = assignPluginPublicIds([{ address, rootExportName: 'OrdersPlugin' }])

		expect(ids.get(pluginNodeAddressKey(address))).toBe('OrdersPlugin')
	})

	it('adds short stable suffixes only for collisions and forks', () => {
		const first = owner('@acme/first', 'CachePlugin')
		const second = owner('@acme/second', 'CachePlugin')
		const fork = owner('@acme/first', 'CachePlugin', { forkId: 'tenant-a' })
		const entries = [first, second, fork].map((address) => ({
			address,
			rootExportName: 'CachePlugin',
		}))
		const ids = assignPluginPublicIds(entries)
		const values = entries.map(({ address }) => ids.get(pluginNodeAddressKey(address)))

		expect(new Set(values).size).toBe(3)
		expect(values[0]).toMatch(/^CachePlugin~[a-f0-9]{12}$/)
		expect(values[1]).toMatch(/^CachePlugin~[a-f0-9]{12}$/)
		expect(values[2]).toMatch(/^CachePlugin~[a-f0-9]{12}$/)
	})
})
