import { serviceSharedPackages } from './sources'
import { host, hostSingletons } from '@pluxel/host-vite'
import { HOST_VITE_ENVIRONMENT } from '@pluxel/host-vite/internal'
import { perEnvironmentPlugin, type Plugin, type PluginOption } from 'vite'
import { serviceDevelopment } from './development/service-development'

export type PresetViteOptions = Readonly<{
	/** Application module default-exporting defineHostApplication(factory), relative to Vite root. */
	entry: string
	/** Enable the official local TypeScript console. @default false */
	devConsole?: boolean
	/** Shallow immutable Host startup bindings; defaults to an empty record. */
	bindings?: Readonly<Record<string, unknown>>
}>

/** Select official service identities; Core-owned native runtime binding belongs to Host Vite. */
export function serviceSingletons(): Plugin {
	return hostSingletons({ packages: serviceSharedPackages })
}

/** Official Host development composition; attaches resources only for installed services. */
export function vitePreset(options: PresetViteOptions): PluginOption[] {
	if (options.devConsole !== undefined && typeof options.devConsole !== 'boolean')
		throw new TypeError('[services/vite] devConsole must be a boolean')
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
		...host({
			entry: options.entry,
			devConsole: options.devConsole,
			bindings: options.bindings,
		}),
	]
}
