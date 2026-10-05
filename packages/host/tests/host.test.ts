import { BasePlugin, Plugin, pluginDefinitionAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { describe, expect, it } from 'vitest'
import {
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
	lowerTestReplacement,
} from '@pluxel/test/unsafe'
import { createHost } from '../src/index'
import { requireHostStateStore } from '../src/host'

describe('Core-only Host', () => {
	it('owns one catalog and queue, separates admission from intent, and drains shutdown', async () => {
		abstract class LifecycleBackend extends BasePlugin {}
		__setPluginDefinition(LifecycleBackend, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'abstract',
			definition: {
				entry: { kind: 'package-root', packageName: '@test/host' },
				exportName: 'LifecycleBackend',
			},
		})
		@Plugin(LifecycleBackend)
		class LifecyclePlugin extends LifecycleBackend {
			static starts = 0
			static stops = 0
			init() {
				LifecyclePlugin.starts++
				this.ctx.effects.defer(() => {
					LifecyclePlugin.stops++
				})
			}
		}
		__setPluginDefinition(LifecyclePlugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: {
				entry: { kind: 'package-root', packageName: '@test/host' },
				exportName: 'LifecyclePlugin',
			},
			provides: pluginDefinitionAddressOf(LifecycleBackend),
		})
		const host = await createHost({ plugins: [LifecyclePlugin] })
		const state = requireHostStateStore(host.ctx)
		const address = {
			definition: pluginDefinitionAddressOf(LifecyclePlugin),
			variant: 'default' as const,
		}
		try {
			await host.start()
			expect(host.catalog().entries).toHaveLength(1)
			expect(requirePluginService(host.ctx).isRunning(address)).toBe(false)
			const status1 = await host.status()
			expect(status1.statuses[0]).toMatchObject({
				autoStart: false,
				lifecycleState: 'stopped',
			})
			await host.setAutoStart(address, true)
			const status2 = await host.status()
			expect(status2.statuses[0]).toMatchObject({
				autoStart: true,
				lifecycleState: 'stopped',
			})
			await host.startNode(address)
			expect(requirePluginService(host.ctx).isRunning(address)).toBe(true)
			await host.updateCatalog([LifecyclePlugin])
			expect(LifecyclePlugin.starts).toBe(1)
			await host.stopNode(address)
			await host.updateCatalog([LifecyclePlugin])
			expect(requirePluginService(host.ctx).isRunning(address)).toBe(false)
			await host.startNode(address)
		} finally {
			await host.close()
		}
		expect(LifecyclePlugin.stops).toBe(2)
		expect(requirePluginService(host.ctx).readCommittedDependencyAdjacency().nodes).toEqual([])
		// Shutdown withdraws only live bindings; next startup retains its desired provider policy.
		expect(state.snapshot().providerDefaults).toEqual([
			{ token: pluginDefinitionAddressOf(LifecycleBackend), provider: address },
		])
		await expect(host.close()).resolves.toBeUndefined()
		await expect(host.startNode(address)).rejects.toThrow('closed')
	})
	it('retains rejected catalogs, replaces definitions, and drains shutdown', async () => {
		const events: string[] = []
		@Plugin()
		class Original extends BasePlugin {
			init() {
				events.push('original')
				this.ctx.effects.defer(() => {
					events.push('stop original')
				})
			}
		}
		__setPluginDefinition(Original, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: {
				entry: { kind: 'package-root', packageName: '@test/source' },
				exportName: 'Plugin',
			},
		})
		class Replacement extends BasePlugin {
			init() {
				events.push('replacement')
				this.ctx.effects.defer(() => {
					events.push('stop replacement')
				})
			}
		}
		lowerTestReplacement(Original, Replacement)
		const host = await createHost({
			plugins: [Original],
			state: {
				initial: {
					autoStart: [{ definition: pluginDefinitionAddressOf(Original), variant: 'default' }],
				},
			},
		})
		try {
			await host.start()
			await expect(host.updateCatalog([null as never])).rejects.toThrow(TypeError)
			expect(events).toEqual(['original'])
			await host.updateCatalog([Replacement])
			expect(events).toEqual(['original', 'stop original', 'replacement'])
		} finally {
			await host.close()
		}
		await expect(host.updateCatalog([Replacement])).rejects.toThrow('closed')
		expect(events).toEqual(['original', 'stop original', 'replacement', 'stop replacement'])
	})
})
