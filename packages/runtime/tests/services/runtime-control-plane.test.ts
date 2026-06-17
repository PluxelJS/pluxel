import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { LoaderPluginCatalogService, LoaderService } from '../../../runtime-dynamic/src/services'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'
import { createHmrTestContext } from '../support/hmr-context'

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
	const loader = new LoaderService(fixture.ctx)
	fixture.ctx.loader = loader
	fixture.ctx.pluginCatalog = new LoaderPluginCatalogService(fixture.ctx)
	fixture.ctx.ext = {
		rpc: {
			createExtensionsView: () => ({}),
			getNamespaces: () => [],
		},
	} as any
	return { ...fixture, rpc: new RuntimeRpcApi(fixture.ctx) }
}

describe('runtime control-plane RPC', () => {
	it('exposes plugin status, config and dependency usecases through direct methods', async () => {
		const fixture = createRpcFixture()

		@Plugin({ name: 'Provider' })
		class Provider extends BasePlugin {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(readonly provider: Provider) {
				super()
			}
		}
		setParamToken(Consumer, 0, Provider)

		await loadModule(fixture, 'Provider.ts', { Provider })
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
	})
})
