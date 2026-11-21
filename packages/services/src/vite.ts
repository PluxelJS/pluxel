import { serviceSharedPackages } from './sources'
import { host, hostSingletons, type HostViteOptions } from '@pluxel/host-vite'
import { HOST_VITE_ENVIRONMENT } from '@pluxel/host-vite/internal'
import { perEnvironmentPlugin, type Plugin, type PluginOption } from 'vite'
import { serviceDevelopment } from './development/service-development'

/** Select official service identities; Core-owned native runtime binding belongs to Host Vite. */
export function serviceSingletons(): Plugin {
	return hostSingletons({ packages: serviceSharedPackages })
}

/** Official Host development composition; attaches resources only for installed services. */
export function vitePreset(options: HostViteOptions): PluginOption[] {
	return [
		serviceSingletons(),
		{
			...perEnvironmentPlugin('pluxel:database-source', async (environment) => {
				if (environment.name !== HOST_VITE_ENVIRONMENT) return false
				const { databaseSourceVitePlugin } = await import('@pluxel/rolldown/vite')
				return databaseSourceVitePlugin({ root: environment.config.root })
			}),
			enforce: 'pre',
		},
		...serviceDevelopment(),
		...host(options),
	]
}
