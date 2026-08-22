import { requireConfigService } from '@pluxel/core/internal'

import {
	runtimeRouteConformance,
	type RuntimeRouteConformanceAdapter,
} from '../../runtime/tests/support/runtime-route-conformance'
import { createHmrTestContext } from './support/hmr-context'

const FIXED_CATALOG_OWNER = 'pluxel:fixed:route-conformance'

const adapter: RuntimeRouteConformanceAdapter = {
	name: 'dynamic',
	async create(fixture) {
		const host = createHmrTestContext({
			enabled: fixture.runtimeState.enabled,
			runtimeState: {
				forks: fixture.runtimeState.forks,
				providerDefaults: fixture.runtimeState.providerDefaults,
				dependencyOverrides: fixture.runtimeState.dependencyOverrides,
			},
		})
		const config = requireConfigService(host.ctx)
		for (const record of fixture.configs) config.patchConfig(record.owner, record.config)
		await host.ctx.loader.registerFixedPlugins(fixture.initialPlugins, {
			moduleId: FIXED_CATALOG_OWNER,
		})
		return {
			ctx: host.ctx,
			removeWorker: async (next) => {
				await host.ctx.loader.registerFixedPlugins(next.withoutWorkerPlugins, {
					moduleId: FIXED_CATALOG_OWNER,
				})
			},
			replaceWorker: async (next) => {
				await host.ctx.loader.registerFixedPlugins(next.replacementPlugins, {
					moduleId: FIXED_CATALOG_OWNER,
				})
			},
			dispose: host.dispose,
		}
	},
}

runtimeRouteConformance(adapter)
