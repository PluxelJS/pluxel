import { describe, expect, it } from 'vitest'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin, pluginNodeAddressOf, withCoreHost } from '@pluxel/core/test'

let observedSequence = 0

@Plugin({ displayName: 'Observed' })
class ObservedPlugin extends BasePlugin {
	readonly sequence = ++observedSequence
}

describe('PluginService watchInstance()', () => {
	it('publishes exact slot availability across restart and removal', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			observedSequence = 0
			const seen: Array<number | undefined> = []
			const node = registry.internNodeAddress(pluginNodeAddressOf(ObservedPlugin))
			const off = registry.watchInstance(node, (instance) =>
				seen.push((instance as ObservedPlugin | undefined)?.sequence),
			)
			expect(seen).toEqual([undefined])
			await host.start(ObservedPlugin)
			expect(seen).toEqual([undefined, 1])
			expect(registry.isRunning(node)).toBe(true)
			host.restart(ObservedPlugin)
			await host.commit()
			expect(seen).toEqual([undefined, 1, 2])
			host.remove(ObservedPlugin)
			await host.commit()
			expect(seen).toEqual([undefined, 1, 2, undefined])
			expect(registry.isRunning(node)).toBe(false)
			off()
		})
	})
})
