import { createStaticRuntimeHost } from '../src/internal/host'
import {
	runtimeRouteConformance,
	type RuntimeRouteConformanceAdapter,
} from '../../runtime/tests/support/runtime-route-conformance'

const adapter: RuntimeRouteConformanceAdapter = {
	name: 'static',
	async create(fixture) {
		const host = await createStaticRuntimeHost(
			{ name: 'route-conformance', plugins: fixture.initialPlugins },
			{
				configService: { mode: 'memory', snapshot: { plugins: fixture.configs } },
				runtimeState: { mode: 'memory', snapshot: fixture.runtimeState },
				logging: false,
				workbench: false,
			},
		)
		await host.start()
		return {
			ctx: host.ctx,
			removeWorker: async (next) => {
				await host.hmr.reload({
					name: 'route-conformance',
					plugins: next.withoutWorkerPlugins,
				})
			},
			replaceWorker: async (next) => {
				await host.hmr.reload({
					name: 'route-conformance',
					plugins: next.replacementPlugins,
				})
			},
			dispose: () => host.stop(),
		}
	},
}

runtimeRouteConformance(adapter)
