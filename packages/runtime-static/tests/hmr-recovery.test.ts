import { beforeAll, describe, expect, it } from 'vitest'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/test/unsafe'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { reloadStaticRuntime } from '../src/hmr'
import { createStaticRuntimeHost } from '../src/internal/host'
import { RequiredConsumer } from './plugins/RequiredConsumer'
import { RequiredProvider } from './plugins/RequiredProvider'

@Plugin()
class StartOk extends BasePlugin {}

const RequiredProviderBroken = class RequiredProviderBroken extends BasePlugin {
	override init(): void {
		throw new Error('replacement provider failed')
	}
}

const RequiredProviderFixed = class RequiredProviderFixed extends BasePlugin {
	readonly source = 'fixed-provider'
}

beforeAll(() => {
	for (const implementation of [RequiredProviderBroken, RequiredProviderFixed]) {
		Plugin({ displayName: 'Required Provider Replacement' })(implementation)
		__setPluginDefinition(implementation, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: pluginDefinitionAddressOf(RequiredProvider),
		})
	}
})

describe('static HMR recovery', () => {
	it('does not let a rejected queued edit block the valid edit queued behind it', async () => {
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'hmr-queued-recovery',
				plugins: [RequiredProvider, RequiredConsumer],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: { autoStart: [pluginNodeAddressOf(RequiredConsumer)] },
				},
			},
		)
		try {
			await host.start()
			const [rejected, repaired] = await Promise.allSettled([
				reloadStaticRuntime({
					host,
					definition: defineStaticRuntime({
						name: 'hmr-queued-recovery',
						plugins: [RequiredProviderBroken, RequiredProviderFixed, RequiredConsumer],
					}),
				}),
				reloadStaticRuntime({
					host,
					definition: defineStaticRuntime({
						name: 'hmr-queued-recovery',
						plugins: [RequiredProviderFixed, RequiredConsumer],
					}),
				}),
			])
			expect(rejected).toMatchObject({
				status: 'rejected',
				reason: { code: 'plugin_definition_collision' },
			})
			expect(repaired).toMatchObject({
				status: 'fulfilled',
				value: { replaced: [pluginNodeAddressOf(RequiredProvider)] },
			})
			const service = requirePluginService(host.ctx)
			expect(service.isRunning(RequiredProvider)).toBe(true)
			expect(service.isRunning(RequiredConsumer)).toBe(true)
			expect(service.getInstance(RequiredConsumer)?.provider.source).toBe('fixed-provider')
		} finally {
			await host.stop()
		}
	})

	it('automatically recovers an unchanged required consumer when only its failed provider is fixed', async () => {
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'hmr-required-recovery',
				plugins: [RequiredProvider, RequiredConsumer, StartOk],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: {
						autoStart: [pluginNodeAddressOf(RequiredConsumer), pluginNodeAddressOf(StartOk)],
					},
				},
			},
		)
		try {
			await host.start()
			const service = requirePluginService(host.ctx)
			const originalConsumer = service.getInstance(RequiredConsumer)
			const independent = service.getInstance(StartOk)
			expect(originalConsumer).toBeInstanceOf(RequiredConsumer)
			expect(independent).toBeInstanceOf(StartOk)

			await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({
					name: 'hmr-required-recovery',
					plugins: [RequiredProviderBroken, RequiredConsumer, StartOk],
				}),
			})
			expect(service.isRunning(RequiredProvider)).toBe(false)
			expect(service.isRunning(RequiredConsumer)).toBe(false)
			expect(service.getInstance(StartOk)).toBe(independent)

			const recovered = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({
					name: 'hmr-required-recovery',
					plugins: [RequiredProviderFixed, RequiredConsumer, StartOk],
				}),
			})
			expect(recovered.replaced).toEqual([pluginNodeAddressOf(RequiredProvider)])
			expect(service.isRunning(RequiredProvider)).toBe(true)
			expect(service.isRunning(RequiredConsumer)).toBe(true)
			const consumer = service.getInstance(RequiredConsumer)
			expect(consumer).toBeInstanceOf(RequiredConsumer)
			expect(consumer === originalConsumer).toBe(false)
			expect(consumer?.provider.source).toBe('fixed-provider')
			expect(service.getInstance(StartOk)).toBe(independent)
		} finally {
			await host.stop()
		}
	})
})
