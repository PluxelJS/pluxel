import { BasePlugin, Plugin, definePluginRef, pluginNodeAddressOf } from '@pluxel/core/test'
import { withCoreInternalTestHost } from '@pluxel/core/internal/test'
import { comparePluginNodeAddress } from '@pluxel/core'
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
			const provider = pluginNodeAddressOf(AdjacencyProvider)
			const requiredConsumer = pluginNodeAddressOf(AdjacencyRequiredConsumer)
			const optionalConsumer = pluginNodeAddressOf(AdjacencyOptionalConsumer)
			const isolated = pluginNodeAddressOf(AdjacencyIsolated)

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
})
