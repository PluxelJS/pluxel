import { describe, expect, it } from 'vitest'
import { pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { RuntimeRpcApi } from '../../../runtime/src/api/http/rpc/RuntimeRpcApi'
import { installWorkbench } from '../../../runtime/src/services/workbench'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestPlugin } from '../support/lowered-plugin'

async function loadModule(
	fixture: ReturnType<typeof createHmrTestContext>,
	moduleId: string,
	exports: Record<string, unknown>,
) {
	await fixture.ctx.loader.replaceModule(moduleId, exports)
}

function createRpcFixture() {
	const fixture = createHmrTestContext()
	installWorkbench(fixture.ctx)
	return { ...fixture, rpc: new RuntimeRpcApi(fixture.ctx) }
}

describe('runtime control-plane RPC', () => {
	it('exposes plugin status, config and dependency usecases through direct methods', async () => {
		const fixture = createRpcFixture()

		@Plugin()
		class Provider extends BasePlugin {
			readonly kind = 'primary'
		}
		lowerTestPlugin(Provider)

		@Plugin({ displayName: 'Provider alt' })
		class ProviderAlt extends BasePlugin {
			readonly kind = 'alt'
		}
		lowerTestPlugin(ProviderAlt)

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(readonly provider: Provider) {
				super()
			}
		}
		lowerTestPlugin(Consumer, { requires: [Provider] })

		await loadModule(fixture, 'Provider.ts', { Provider })
		await loadModule(fixture, 'ProviderAlt.ts', { ProviderAlt })
		await loadModule(fixture, 'Consumer.ts', { Consumer })

		const provider = pluginNodeAddressOf(Provider)
		const providerAlt = pluginNodeAddressOf(ProviderAlt)
		const consumer = pluginNodeAddressOf(Consumer)

		expect(await fixture.rpc.pluginConfig(consumer)).toMatchObject({
			ok: true,
			config: {},
			defaults: {},
		})
		expect(await fixture.rpc.patchPluginConfig(consumer, { missing: true })).toMatchObject({
			ok: false,
			code: 'config_not_found',
		})

		const status = await fixture.rpc.applyPluginStatusActions([
			{ address: provider, action: 'enable' },
			{ address: consumer, action: 'enable' },
		])
		expect(status.ok).toBe(true)
		expect(status.results.map((entry) => [entry.address, entry.ok, entry.lifecycleStage])).toEqual([
			[provider, true, 'running'],
			[consumer, true, 'running'],
		])

		expect(fixture.core.registry.getInstance(Consumer)?.provider.kind).toBe('primary')
		expect(fixture.rpc.pluginDependencies(consumer)).toMatchObject([
			{ address: provider, displayName: 'Provider' },
		])
		expect(fixture.rpc.inspectPluginDependencies(consumer)).toMatchObject([
			{
				index: 0,
				token: provider.definition,
				kind: 'plugin',
				effective: provider,
			},
		])

		await expect(
			fixture.rpc.setPluginDependencyTarget({
				consumer,
				index: 0,
				provider: providerAlt,
			}),
		).resolves.toEqual({ ok: true })

		expect(fixture.core.registry.getInstance(Consumer)?.provider.kind).toBe('alt')
		expect(fixture.rpc.inspectPluginDependencies(consumer)).toMatchObject([
			{
				index: 0,
				token: provider.definition,
				kind: 'plugin',
				selected: providerAlt,
				effective: providerAlt,
			},
		])
	})
})
