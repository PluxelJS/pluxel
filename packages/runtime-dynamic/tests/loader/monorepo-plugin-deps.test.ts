import { describe, expect, it } from 'vitest'
import { clonePluginDefinition, getPluginDefinitionFacts } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestAbstract, lowerTestPlugin } from '../support/lowered-plugin'
import { enablePlugins } from '../support/runtime-state'

describe('monorepo plugin dependencies', () => {
	it('commits successfully when dependent plugin modules are both loaded (separate moduleIds)', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		@Plugin({ displayName: 'Provider' })
		class Provider extends BasePlugin {}
		lowerTestPlugin(Provider)

		@Plugin({ displayName: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: Provider) {
				super()
			}
		}
		lowerTestPlugin(Consumer, { requires: [Provider] })

		enablePlugins(ctx, Provider, Consumer)

		const batch = loader.beginBatch()
		await batch.replaceModule('packages/provider/src/entry.ts', { Provider })
		await batch.replaceModule('packages/consumer/src/entry.ts', { Consumer })
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

		expect(core.registry.isRunning(Provider)).toBe(true)
		expect(core.registry.isRunning(Consumer)).toBe(true)
	})

	it('fails commit when a runtime-enabled plugin depends on another plugin that is not loaded via entries', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		@Plugin({ displayName: 'Provider' })
		class Provider extends BasePlugin {}
		lowerTestPlugin(Provider)

		@Plugin({ displayName: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: Provider) {
				super()
			}
		}
		lowerTestPlugin(Consumer, { requires: [Provider] })

		// Simulate: profile selected Consumer's package entry, but not Provider's package entry.
		// Runtime config enables Consumer anyway -> DI commit must fail.
		enablePlugins(ctx, Consumer)

		const batch = loader.beginBatch()
		await batch.replaceModule('packages/consumer/src/entry.ts', { Consumer })
		const res = await core.registry.commit()
		expect(res.ok).toBe(false)
		batch.rollback()
		core.registry.resetDraft()
	})

	it('supports project-local packages where a consumer depends on an abstract base provider', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader
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
			provides: getPluginDefinitionFacts(UsageRecorderPlugin).definition,
		})

		@Plugin({ displayName: 'Zhipu provider' })
		class ZhipuProviderPlugin extends BasePlugin {
			readonly seq = ++providerSeq

			constructor(readonly recorder: UsageRecorderPlugin) {
				super()
			}
		}
		lowerTestPlugin(ZhipuProviderPlugin, { requires: [UsageRecorderPlugin] })

		enablePlugins(ctx, UsageBillingPlugin, ZhipuProviderPlugin)

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('projects/example-app/plugins/billing/src/index.ts', {
				UsageBillingPlugin,
			})
			await batch.replaceModule('projects/example-app/plugins/provider/src/index.ts', {
				ZhipuProviderPlugin,
			})
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		const firstProvider = core.registry.getInstance(ZhipuProviderPlugin)
		expect(core.registry.isRunning(UsageRecorderPlugin)).toBe(true)
		expect(firstProvider?.seq).toBe(1)
		expect(firstProvider?.recorder.seq).toBe(1)

		class UsageBillingPluginNext extends UsageRecorderPlugin {
			readonly seq = ++billingSeq
		}
		clonePluginDefinition(UsageBillingPlugin, UsageBillingPluginNext)

		const batch = loader.beginBatch()
		await batch.replaceModule('projects/example-app/plugins/billing/src/index.ts', {
			UsageBillingPlugin: UsageBillingPluginNext,
		})
		expect(new Set(batch.getAffectedModules())).toEqual(
			new Set([
				'projects/example-app/plugins/billing/src/index.ts',
				'projects/example-app/plugins/provider/src/index.ts',
			]),
		)
		await batch.syncModules(batch.getAffectedModules())
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

		const nextProvider = core.registry.getInstance(ZhipuProviderPlugin)
		expect(nextProvider?.seq).toBe(2)
		expect(nextProvider?.recorder.seq).toBe(2)
		expect(nextProvider).not.toBe(firstProvider)
	})
})
