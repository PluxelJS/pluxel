import { host, hostSingletons } from '@pluxel/host-dev/vite'
import type { Plugin, PluginOption } from 'vite'
import { serviceDevelopment } from './development/service-development'

export type ServicesViteOptions = Readonly<{
	/** Application module default-exporting a HostApplication, relative to Vite root. */
	entry: string
	/** Enable the official local TypeScript console. @default false */
	devConsole?: boolean
}>

/** Preserve official service token identity across the Vite and native module graphs. */
export function serviceSingletons(): Plugin {
	const singletons = hostSingletons({
		packages: ['@pluxel/services', '@pluxel/workbench', '@pluxel/management', '@pluxel/logging'],
	})
	// Workbench and RPC Plugins own capnweb as a normal dependency. Keep native ESM identity
	// without requiring every application to declare that transitive transport package.
	return { ...singletons, config: () => ({ ssr: { external: ['capnweb'] } }) }
}

/** Official Host development composition; attaches resources only for installed services. */
export function vitePreset(options: ServicesViteOptions): PluginOption[] {
	if (options.devConsole !== undefined && typeof options.devConsole !== 'boolean')
		throw new TypeError('[services/vite] devConsole must be a boolean')
	return [
		serviceSingletons(),
		...serviceDevelopment(),
		...host({
			entry: options.entry,
			devConsole: options.devConsole,
		}),
	]
}
