import {
	BasePlugin,
	Plugin,
	definePluginRef,
	withCoreInternalTestHost,
} from '@pluxel/core/internal/test'
import { comparePluginNodeAddress, parsePluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { describe, expect, it } from 'vitest'

@Plugin()
class AdjacencyProvider extends BasePlugin {}

@Plugin()
class AdjacencyRequiredConsumer extends BasePlugin {
	constructor(readonly provider: AdjacencyProvider) {
		super()
	}
}

const AdjacencyProviderRef = definePluginRef<AdjacencyProvider>()

@Plugin()
class AdjacencyOptionalConsumer extends BasePlugin {
	override init(): void {
		this.plugins.use(AdjacencyProviderRef, () => undefined)
	}
}

@Plugin()
class AdjacencyIsolated extends BasePlugin {}

describe('PluginService committed dependency adjacency', () => {
	it('projects canonical required and optional address edges including isolated nodes', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add([
				AdjacencyProvider,
				AdjacencyRequiredConsumer,
				AdjacencyOptionalConsumer,
				AdjacencyIsolated,
			])

			const pending = registry.readCommittedDependencyAdjacency()
			expect(pending).toEqual({ nodes: [], required: [], optional: [] })

			await host.commit()
			const adjacency = registry.readCommittedDependencyAdjacency()
			const provider = parsePluginNodeAddress(AdjacencyProvider.nodeAddress())
			const requiredConsumer = parsePluginNodeAddress(AdjacencyRequiredConsumer.nodeAddress())
			const optionalConsumer = parsePluginNodeAddress(AdjacencyOptionalConsumer.nodeAddress())
			const isolated = parsePluginNodeAddress(AdjacencyIsolated.nodeAddress())

			expect(adjacency.nodes).toEqual(
				[provider, requiredConsumer, optionalConsumer, isolated].sort(comparePluginNodeAddress),
			)
			expect(adjacency.required).toEqual([{ consumer: requiredConsumer, provider }])
			expect(adjacency.optional).toEqual([{ consumer: optionalConsumer, provider }])
			expect(adjacency.nodes).toContainEqual(isolated)
			expect(Object.isFrozen(adjacency)).toBe(true)
			expect(Object.isFrozen(adjacency.nodes)).toBe(true)
			expect(Object.isFrozen(adjacency.required[0])).toBe(true)
			expect(Object.isFrozen(adjacency.optional[0])).toBe(true)
		})
	})

	it('reuses the committed projection and resolves its edges against that publication', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add([AdjacencyProvider, AdjacencyOptionalConsumer])
			await host.commit()
			const before = registry.readCommittedDependencyAdjacency()
			expect(registry.readCommittedDependencyAdjacency()).toBe(before)
			const consumer = parsePluginNodeAddress(AdjacencyOptionalConsumer.nodeAddress())
			const provider = parsePluginNodeAddress(AdjacencyProvider.nodeAddress())
			expect(before.nodes).toContainEqual(consumer)

			host.remove(AdjacencyOptionalConsumer)
			await host.commit()
			const after = registry.readCommittedDependencyAdjacency()
			expect(after.nodes).toEqual([provider])
			expect(after.optional).toEqual([])
			expect(before.optional).toEqual([{ consumer, provider }])
			expect(before.optional).toBe(before.optional)
		})
	})
})
