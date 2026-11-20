import type { Plugin, PluginOption } from 'vite'
import { defineServiceRef, type ServiceRef } from '@pluxel/core'
import type { WorkbenchHost } from '@pluxel/workbench/server'
import { HOST_VITE_ENVIRONMENT } from '@pluxel/host-vite/internal'
import type { HostVitePluginApi } from '@pluxel/host-vite'
import type { NodeModuleHost } from '../node/token'
import type { ElysiaRuntime } from '../elysia/runtime'

const NodeModuleHostRef = defineServiceRef<NodeModuleHost>()
const WorkbenchHostRef = defineServiceRef<WorkbenchHost>()
const ElysiaRuntimeRef = defineServiceRef<ElysiaRuntime>()

/** Only attach development resources for services already installed by the application. */
export function serviceDevelopment(): PluginOption[] {
	const attachment = <T>(
		service: ServiceRef<T>,
		explicitName: string,
		load: () => Promise<Plugin<HostVitePluginApi>>,
	): Plugin<HostVitePluginApi> => ({
		name: `${explicitName}:automatic`,
		apply: 'serve',
		api: {
			pluxelHost: {
				async attach(input) {
					if (input.host.ctx.service(service) === undefined) return
					if (input.server.config.plugins.some((plugin) => plugin.name === explicitName)) return
					const plugin = await load()
					return plugin.api!.pluxelHost.attach(input)
				},
			},
		},
	})
	let http: Plugin<HostVitePluginApi> | undefined
	return [
		attachment(NodeModuleHostRef, 'pluxel:node-artifacts', async () => {
			const { nodeArtifacts } = await import('./node')
			return nodeArtifacts()
		}),
		attachment(WorkbenchHostRef, 'pluxel:workbench-artifacts', async () => {
			const { workbenchArtifacts } = await import('@pluxel/workbench/vite')
			return workbenchArtifacts()
		}),
		attachment(ElysiaRuntimeRef, 'pluxel:elysia', async () => {
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
