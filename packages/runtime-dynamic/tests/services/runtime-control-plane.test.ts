import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { RuntimeRpcApi } from '../../../runtime/src/api/http/rpc/RuntimeRpcApi'
import { installWebManagement } from '../../../runtime/src/services/web-management'
import { createHmrTestContext } from '../support/hmr-context'

function defineParamTypes(ctor: new (...args: any[]) => BasePlugin, paramTypes: unknown[]): void {
	;(
		Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void }
	).defineMetadata?.('design:paramtypes', paramTypes, ctor)
}

async function loadModule(
	fixture: ReturnType<typeof createHmrTestContext>,
	moduleId: string,
	exports: Record<string, unknown>,
) {
	const batch = fixture.ctx.loader.beginBatch()
	await batch.replaceModule(moduleId, exports)
	const commit = await fixture.core.registry.commit()
	expect(commit.ok).toBe(true)
	batch.commit()
}

function createRpcFixture() {
	const fixture = createHmrTestContext()
	installWebManagement(fixture.ctx)
	return { ...fixture, rpc: new RuntimeRpcApi(fixture.ctx) }
}

describe('runtime control-plane RPC', () => {
	it('exposes plugin status, config and dependency usecases through direct methods', async () => {
		const fixture = createRpcFixture()

		class Provider extends BasePlugin {
			readonly kind = 'primary'
		}
		Plugin({ name: 'Provider' })(Provider)

		class ProviderAlt extends BasePlugin {
			readonly kind = 'alt'
		}
		Plugin({ name: 'ProviderAlt' })(ProviderAlt)

		class Consumer extends BasePlugin {
			constructor(readonly provider: Provider) {
				super()
			}
		}
		defineParamTypes(Consumer, [Provider])
		Plugin({ name: 'Consumer' })(Consumer)
		setParamToken(Consumer, 0, Provider)

		await loadModule(fixture, 'Provider.ts', { Provider })
		await loadModule(fixture, 'ProviderAlt.ts', { ProviderAlt })
		await loadModule(fixture, 'Consumer.ts', { Consumer })

		expect(await fixture.rpc.pluginConfig('Consumer')).toMatchObject({
			ok: true,
			config: {},
			defaults: {},
		})
		expect(await fixture.rpc.patchPluginConfig('Consumer', { missing: true })).toMatchObject({
			ok: false,
			code: 'config_not_found',
		})

		expect(fixture.rpc.pluginDependencies('Consumer')).toMatchObject([{ name: 'Provider' }])
		expect(fixture.rpc.inspectPluginDependencies('Consumer')).toMatchObject([
			{
				index: 0,
				token: 'Provider',
				kind: 'plugin',
				effective: 'Provider',
			},
		])

		const status = await fixture.rpc.applyPluginStatusActions([
			{ name: 'Provider', action: 'enable' },
			{ name: 'Consumer', action: 'enable' },
		])
		expect(status.ok).toBe(true)
		expect(status.results.map((entry) => [entry.name, entry.ok, entry.lifecycleStage])).toEqual([
			['Provider', true, 'running'],
			['Consumer', true, 'running'],
		])

		expect(fixture.core.registry.getInstance(Consumer)?.provider.kind).toBe('primary')

		await expect(
			fixture.rpc.setPluginDependencyTarget({
				name: 'Consumer',
				index: 0,
				targetName: 'ProviderAlt',
			}),
		).resolves.toEqual({ ok: true })

		expect(fixture.core.registry.getInstance(Consumer)?.provider.kind).toBe('alt')
		expect(fixture.rpc.inspectPluginDependencies('Consumer')).toMatchObject([
			{
				index: 0,
				token: 'Provider',
				kind: 'plugin',
				selected: 'ProviderAlt',
				effective: 'ProviderAlt',
			},
		])
	})
})
