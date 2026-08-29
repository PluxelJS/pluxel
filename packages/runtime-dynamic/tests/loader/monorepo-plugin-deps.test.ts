import { describe, expect, it } from 'vitest'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { requireLoaderService } from '../../src/context-plan'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestAbstract, lowerTestPlugin, lowerTestReplacement } from '../support/lowered-plugin'
import { pluginsAutoStartPatch } from '../support/runtime-state'

describe('monorepo plugin dependencies', () => {
	it('commits successfully when dependent plugin modules are both loaded (separate moduleIds)', async () => {
		const { host, ctx } = createHmrTestContext()
		const loader = requireLoaderService(ctx)

		@Plugin()
		class Provider extends BasePlugin {}
		lowerTestPlugin(Provider)

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(_dep: Provider) {
				super()
			}
		}
		lowerTestPlugin(Consumer, { requires: [Provider] })

		const batch = loader.beginBatch()
		await batch.replaceModule('packages/provider/src/entry.ts', { Provider })
		await batch.replaceModule('packages/consumer/src/entry.ts', { Consumer })
		await batch.commit({ statePatch: pluginsAutoStartPatch(true, Provider, Consumer) })

		expect(host.isRunning(Provider)).toBe(true)
		expect(host.isRunning(Consumer)).toBe(true)
	})

	it('fails commit when an auto-start plugin depends on another plugin that is not loaded via entries', async () => {
		@Plugin()
		class Provider extends BasePlugin {}
		lowerTestPlugin(Provider)

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(_dep: Provider) {
				super()
			}
		}
		lowerTestPlugin(Consumer, { requires: [Provider] })
		const { ctx } = createHmrTestContext({ autoStart: [pluginNodeAddressOf(Consumer)] })
		const loader = requireLoaderService(ctx)

		// Simulate: profile selected Consumer's package entry, but not Provider's package entry.
		// Cold-boot state retains the absent Consumer intent; live catalog admission must reject a
		// newly available but structurally blocked Consumer atomically.
		await loader.beginBatch().commit({ reason: 'test-cold-boot' })

		const batch = loader.beginBatch()
		await batch.replaceModule('packages/consumer/src/entry.ts', { Consumer })
		await expect(batch.commit()).rejects.toMatchObject({
			code: 'graph_rejected',
			issues: [{ kind: 'missing_required_provider' }],
		})
		expect(loader.api.registry.listRegistered()).toEqual([])
	})

	it('supports project-local packages where a consumer depends on an abstract base provider', async () => {
		const { host, ctx } = createHmrTestContext()
		const loader = requireLoaderService(ctx)
		let billingSeq = 0
		let providerSeq = 0

		abstract class UsageRecorderPlugin extends BasePlugin {
			abstract readonly seq: number
		}
		lowerTestAbstract(UsageRecorderPlugin)

		@Plugin(UsageRecorderPlugin, { displayName: 'Usage billing' })
		class UsageBillingPlugin extends UsageRecorderPlugin {
			readonly seq = ++billingSeq
		}
		lowerTestPlugin(UsageBillingPlugin, {
			provides: pluginDefinitionAddressOf(UsageRecorderPlugin),
		})

		@Plugin({ displayName: 'Zhipu provider' })
		class ZhipuProviderPlugin extends BasePlugin {
			readonly seq = ++providerSeq

			constructor(readonly recorder: UsageRecorderPlugin) {
				super()
			}
		}
		lowerTestPlugin(ZhipuProviderPlugin, { requires: [UsageRecorderPlugin] })

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('projects/example-app/plugins/billing/src/index.ts', {
				UsageBillingPlugin,
			})
			await batch.replaceModule('projects/example-app/plugins/provider/src/index.ts', {
				ZhipuProviderPlugin,
			})
			await batch.commit({
				statePatch: pluginsAutoStartPatch(true, UsageBillingPlugin, ZhipuProviderPlugin),
			})
		}

		const firstProvider = host.get(ZhipuProviderPlugin)
		expect(host.isRunning(UsageBillingPlugin)).toBe(true)
		expect(firstProvider?.seq).toBe(1)
		expect(firstProvider?.recorder.seq).toBe(1)

		@Plugin(UsageRecorderPlugin, { displayName: 'Usage billing next' })
		class UsageBillingPluginNext extends UsageRecorderPlugin {
			readonly seq = ++billingSeq
		}
		lowerTestReplacement(UsageBillingPlugin, UsageBillingPluginNext, {
			provides: pluginDefinitionAddressOf(UsageRecorderPlugin),
		})

		const batch = loader.beginBatch()
		await batch.replaceModule('projects/example-app/plugins/billing/src/index.ts', {
			UsageBillingPlugin: UsageBillingPluginNext,
		})
		await batch.commit()

		const nextProvider = host.get(ZhipuProviderPlugin)
		expect(nextProvider?.seq).toBe(2)
		expect(nextProvider?.recorder.seq).toBe(2)
		expect(nextProvider === firstProvider).toBe(false)
	})
})
