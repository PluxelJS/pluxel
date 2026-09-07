import { requireConfigService } from '@pluxel/core/internal'

import {
	runtimeRouteConformance,
	type RuntimeRouteConformanceAdapter,
} from '../../runtime/tests/support/runtime-route-conformance'
import { requireLoaderService } from '../src/context-plan'
import { createHmrTestContext } from './support/hmr-context'

const FIXED_CATALOG_OWNER = 'pluxel:fixed:route-conformance'

const adapter: RuntimeRouteConformanceAdapter = {
	name: 'dynamic',
	async create(fixture) {
		const host = createHmrTestContext({
			autoStart: fixture.runtimeState.autoStart,
			runtimeState: {
				forks: fixture.runtimeState.forks,
				providerDefaults: fixture.runtimeState.providerDefaults,
				dependencyOverrides: fixture.runtimeState.dependencyOverrides,
			},
		})
		const config = requireConfigService(host.ctx)
		for (const record of fixture.configs) config.patchConfig(record.owner, record.config)
		await requireLoaderService(host.ctx).registerFixedPlugins(fixture.initialPlugins, {
			moduleId: FIXED_CATALOG_OWNER,
		})
		return {
			ctx: host.ctx,
			removeWorker: async (next) => {
				await requireLoaderService(host.ctx).registerFixedPlugins(next.withoutWorkerPlugins, {
					moduleId: FIXED_CATALOG_OWNER,
				})
			},
			replaceWorker: async (next) => {
				await requireLoaderService(host.ctx).registerFixedPlugins(next.replacementPlugins, {
					moduleId: FIXED_CATALOG_OWNER,
				})
			},
			dispose: host.dispose,
		}
	},
}

runtimeRouteConformance(adapter)
