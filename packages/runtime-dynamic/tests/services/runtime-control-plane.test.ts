import { describe, expect, it } from 'vitest'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import type { PluginApplyReport } from '@pluxel/runtime/web'
import { RuntimeRpcApi } from '../../../runtime/src/api/http/rpc/RuntimeRpcApi'
import { requireLoaderService } from '../../src/context-plan'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestAbstract, lowerTestPlugin } from '../support/lowered-plugin'

async function loadModule(
	fixture: ReturnType<typeof createHmrTestContext>,
	moduleId: string,
	exports: Record<string, unknown>,
) {
	await requireLoaderService(fixture.ctx).replaceModule(moduleId, exports)
}

function createRpcFixture() {
	const fixture = createHmrTestContext()
	return { ...fixture, rpc: new RuntimeRpcApi(fixture.ctx) }
}

describe('runtime control-plane RPC', () => {
	it('exposes plugin status, config and dependency usecases through direct methods', async () => {
		const fixture = createRpcFixture()

		abstract class ProviderToken extends BasePlugin {
			abstract readonly kind: string
		}
		lowerTestAbstract(ProviderToken)

		@Plugin(ProviderToken)
		class Provider extends ProviderToken {
			readonly kind = 'primary'
		}
		lowerTestPlugin(Provider, { provides: pluginDefinitionAddressOf(ProviderToken) })

		@Plugin(ProviderToken, { displayName: 'Provider alt' })
		class ProviderAlt extends ProviderToken {
			readonly kind = 'alt'
		}
		lowerTestPlugin(ProviderAlt, { provides: pluginDefinitionAddressOf(ProviderToken) })

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(readonly provider: ProviderToken) {
				super()
			}
		}
		lowerTestPlugin(Consumer, { requires: [ProviderToken] })

		await loadModule(fixture, 'Provider.ts', { Provider })
		await loadModule(fixture, 'ProviderAlt.ts', { ProviderAlt })
		await loadModule(fixture, 'Consumer.ts', { Consumer })

		const provider = pluginNodeAddressOf(Provider)
		const providerAlt = pluginNodeAddressOf(ProviderAlt)
		const consumer = pluginNodeAddressOf(Consumer)
		const providerToken = pluginDefinitionAddressOf(ProviderToken)

		expect(await fixture.rpc.pluginConfig(consumer)).toMatchObject({
			ok: false,
			code: 'config_not_found',
			state: 'unchanged',
		})
		expect(await fixture.rpc.patchPluginConfig(consumer, { missing: true })).toMatchObject({
			ok: false,
			code: 'config_not_found',
		})
		const providerSelection = await fixture.rpc.setPluginProviderPolicyDefault({
			policyOwner: provider,
			provider,
		})
		expect(providerSelection).toMatchObject({
			ok: true,
			status: 'applied',
			report: { core: { status: 'unchanged' } },
		})
		if (providerSelection.ok) expectBrowserSafeReport(providerSelection.report)

		const status = await fixture.rpc.applyPluginLifecycleCommands([
			{ address: provider, command: 'start' },
			{ address: providerAlt, command: 'start' },
			{ address: consumer, command: 'start' },
		])
		expect(status.ok).toBe(true)
		expect(
			status.results.map((entry) => [
				entry.address,
				entry.ok,
				entry.ok ? entry.control.lifecycleState : undefined,
			]),
		).toEqual([
			[provider, true, 'running'],
			[providerAlt, true, 'running'],
			[consumer, true, 'running'],
		])

		expect(
			(requirePluginService(fixture.ctx).getInstance(consumer) as Consumer | undefined)?.provider
				.kind,
		).toBe('primary')
		expect(await fixture.rpc.inspectPluginConsumerRequirements(consumer)).toMatchObject({
			ok: true,
			items: [
				{
					requirement: providerToken,
					kind: 'abstract',
					consumerOverride: null,
					inheritedProvider: provider,
				},
			],
		})

		const dependencySelection = await fixture.rpc.setPluginConsumerOverride({
			consumer,
			requirement: providerToken,
			provider: providerAlt,
		})
		expect(dependencySelection).toMatchObject({
			ok: true,
			status: 'applied',
			report: { core: { status: 'committed' } },
		})
		if (dependencySelection.ok) expectBrowserSafeReport(dependencySelection.report)

		expect(
			(requirePluginService(fixture.ctx).getInstance(consumer) as Consumer | undefined)?.provider
				.kind,
		).toBe('alt')
		expect(await fixture.rpc.inspectPluginConsumerRequirements(consumer)).toMatchObject({
			ok: true,
			items: [
				{
					requirement: providerToken,
					kind: 'abstract',
					consumerOverride: providerAlt,
					inheritedProvider: provider,
				},
			],
		})
	})
})

function expectBrowserSafeReport(report: PluginApplyReport): void {
	expect(() => JSON.stringify(report)).not.toThrow()
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object') return
		expect(Object.isFrozen(value)).toBe(true)
		expect(Object.getOwnPropertySymbols(value)).toEqual([])
		expect(Object.hasOwn(value, 'graph')).toBe(false)
		for (const child of Object.values(value)) visit(child)
	}
	visit(report)
}
