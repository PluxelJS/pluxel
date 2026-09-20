import { describe, expect, it } from 'vitest'
import { createOwnerContext } from '@pluxel/core/internal'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginHostCoordinator, readHostPluginStatusOverview } from '@pluxel/host/internal'
import { BasePlugin, Plugin as PluginDecorator } from '@pluxel/core/test'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { lowerTestPlugin } from './helpers/lowered-plugin'
const node = (definition: PluginDefinitionAddress): PluginNodeAddress => ({
	definition,
	variant: 'default',
})

describe('runtime host-owned graph state', () => {
	it('isolates coordinators by root and removes a disposed host identity', async () => {
		const first = await createServiceInternalTestHarness()
		const second = await createServiceInternalTestHarness()
		const firstCoordinator = requirePluginHostCoordinator(first.ctx)
		const child = createOwnerContext(first.ctx, 'child')
		try {
			expect(requirePluginHostCoordinator(child)).toBe(firstCoordinator)
			expect(requirePluginHostCoordinator(second.ctx)).not.toBe(firstCoordinator)
			await first.dispose()
			expect(() => requirePluginHostCoordinator(child)).toThrow(
				'root has no Plugin host coordinator',
			)
			expect(() => requirePluginHostCoordinator(second.ctx)).not.toThrow()
		} finally {
			await first.dispose()
			await second.dispose()
		}
	})

	it('keeps auto-start and stopped durable orphan nodes visible after source unlink', async () => {
		@PluginDecorator({ forkable: true })
		class Orphan extends BasePlugin {}
		lowerTestPlugin(Orphan)
		const host = await createServiceInternalTestHarness()
		const base = node(pluginDefinitionAddressOf(Orphan))
		const fork = host.fork(Orphan, 'stopped')
		try {
			host.cfg(Orphan).setAutoStart(true)
			host.start(Orphan)
			await host.commit()
			host.remove(Orphan)
			await host.commit()

			const statusOverview = await readHostPluginStatusOverview(host.ctx)
			const statuses = statusOverview.statuses
			const autoStart = statuses.find((status) => pluginNodeAddressEqual(status.address, base))
			const stopped = statuses.find((status) => pluginNodeAddressEqual(status.address, fork))
			expect(autoStart).toMatchObject({
				autoStart: true,
				sessionIntent: 'inherit',
				desiredState: 'running',
				activationReason: 'auto-start',
				lifecycleState: 'stopped',
				availability: 'unavailable',
			})
			expect(autoStart?.issues.map((issue) => issue.code)).toContain('consumer_unavailable')
			expect(autoStart?.issues.every((issue) => issue.id.length > 0)).toBe(true)
			expect(stopped).toMatchObject({
				autoStart: false,
				sessionIntent: 'inherit',
				desiredState: 'stopped',
				activationReason: null,
				lifecycleState: 'stopped',
				availability: 'unavailable',
			})
			expect(stopped?.issues.map((issue) => issue.code)).toContain('definition_unavailable')
			expect(stopped?.issues[0]?.id).toContain('definition_unavailable:')
		} finally {
			await host.dispose()
		}
	})
})
