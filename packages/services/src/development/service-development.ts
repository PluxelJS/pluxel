import type { Plugin, PluginOption } from 'vite'
import { HOST_VITE_ENVIRONMENT } from '@pluxel/host-dev/internal'
import type { HostDevelopmentPluginApi } from '@pluxel/host-dev/vite'

/** Only attach development resources for capabilities already installed by the application. */
export function serviceDevelopment(): PluginOption[] {
	const attachment = (
		property: string,
		explicitName: string,
		load: () => Promise<Plugin<HostDevelopmentPluginApi>>,
	): Plugin<HostDevelopmentPluginApi> => ({
		name: `${explicitName}:automatic`,
		apply: 'serve',
		api: {
			pluxelHost: {
				async attach(input) {
					if (!(property in input.host.ctx)) return
					if (input.server.config.plugins.some((plugin) => plugin.name === explicitName)) return
					const plugin = await load()
					return plugin.api!.pluxelHost.attach(input)
				},
			},
		},
	})
	let http: Plugin<HostDevelopmentPluginApi> | undefined
	return [
		attachment('nodeModules', 'pluxel:node-artifacts', async () => {
			const { nodeArtifacts } = await import('./node')
			return nodeArtifacts()
		}),
		attachment('workbench', 'pluxel:workbench-artifacts', async () => {
			const { workbenchArtifacts } = await import('@pluxel/workbench/dev')
			return workbenchArtifacts()
		}),
		attachment('elysia', 'pluxel:elysia', async () => {
			if (!http) {
				const { elysiaDevelopment } = await import('./elysia')
				http = elysiaDevelopment()
			}
			return http
		}),
		{
			name: 'pluxel:service-development',
			apply: 'serve',
			applyToEnvironment(environment) {
				return environment.name === HOST_VITE_ENVIRONMENT
			},
			async closeBundle(...args) {
				// The listener attachment survives Host replacement, and belongs to Vite.
				const hook = http?.closeBundle
				if (typeof hook === 'function') await hook.apply(this, args)
				else await hook?.handler.apply(this, args)
			},
		},
	]
}
