import { BasePlugin, Plugin, pluginDefinitionAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { describe, expect, it } from 'vitest'
import {
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
	lowerTestReplacement,
} from '@pluxel/test/unsafe'
import { createHost, type PluginSourceOpenOptions } from '../src/index'

describe('Core-only Host', () => {
	it('owns one catalog and queue, separates admission from intent, and drains shutdown', async () => {
		@Plugin()
		class LifecyclePlugin extends BasePlugin {
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
		})
		const host = createHost({ plugins: [LifecyclePlugin] })
		const address = {
			definition: pluginDefinitionAddressOf(LifecyclePlugin),
			variant: 'default' as const,
		}
		try {
			await host.start()
			expect(host.catalog().entries).toHaveLength(1)
			expect(requirePluginService(host.ctx).isRunning(address)).toBe(false)
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
		await expect(host.close()).resolves.toBeUndefined()
		await expect(host.startNode(address)).rejects.toThrow('closed')
	})
	it('shares the production source path, retaining rejected candidates and closing watcher admission', async () => {
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
		let callbacks!: PluginSourceOpenOptions
		let loaded: unknown = { Original }
		let error: unknown
		let closed = false
		const host = createHost({
			plugins: [],
			root: '/',
			state: {
				autoStart: [{ definition: pluginDefinitionAddressOf(Original), variant: 'default' }],
			},
			sources: [
				{
					covers: () => true,
					async open(options) {
						callbacks = options
						return {
							entries: ['entry.mjs'],
							close: async () => {
								closed = true
							},
						}
					},
				},
			],
			loadModule: async () => loaded,
			onSourceError: (cause) => {
				error = cause
			},
		})
		try {
			await host.start()
			loaded = null
			callbacks.onChange({ type: 'change', path: 'entry.mjs' })
			await host.updateCatalog([])
			expect(error).toBeInstanceOf(TypeError)
			expect(events).toEqual(['original'])
			loaded = { Replacement }
			callbacks.onChange({ type: 'change', path: 'entry.mjs' })
			await host.updateCatalog([])
			expect(events).toEqual(['original', 'stop original', 'replacement'])
		} finally {
			await host.close()
		}
		expect(closed).toBe(true)
		callbacks.onChange({ type: 'change', path: 'entry.mjs' })
		expect(events).toEqual(['original', 'stop original', 'replacement', 'stop replacement'])
	})
})
