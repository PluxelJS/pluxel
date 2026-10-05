import { serviceSharedPackages } from './sources'
import { dirname } from 'node:path'
import {
	assertWorkbenchCapnwebAdmission,
	installedWorkbenchCapnwebVersion,
	readWorkbenchCapnwebPackage,
} from '@pluxel/workbench/internal/transport'
import { resolveWithOxc } from '@pluxel/rolldown/resolver/oxc'
import { host, hostSingletons } from '@pluxel/host-vite'
import { HOST_VITE_ENVIRONMENT, registerHostSingleton } from '@pluxel/host-vite/internal'
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

/** Preserve official service token identity across the Vite and native module graphs. */
export function serviceSingletons(): Plugin {
	const singletons = hostSingletons({
		packages: serviceSharedPackages,
	})
	const resolveSingleton = singletons.resolveId!
	const configureSingleton = singletons.configResolved!
	let root = ''
	// Linked workspaces can install the same version at different native module paths.
	// Resolve RpcTarget from the selected Workbench installation, not each publisher.
	return {
		...singletons,
		configResolved(config) {
			root = config.root
			const handler =
				typeof configureSingleton === 'function' ? configureSingleton : configureSingleton.handler
			return handler.call(this, config)
		},
		async resolveId(source, importer, options) {
			if (
				source === 'capnweb' &&
				importer &&
				options.ssr &&
				this.environment.name === HOST_VITE_ENVIRONMENT
			) {
				const publisher = await readWorkbenchCapnwebPackage(importer)
				// A source publisher has an explicit peer before build metadata exists. Private RPC has neither.
				if (publisher && (publisher.peer !== undefined || publisher.marker !== undefined)) {
					const conditions = { conditionNames: ['node', 'import', 'default'] }
					const workbench = resolveWithOxc(root, '@pluxel/workbench', conditions)
					if (!workbench)
						throw new Error(
							`[services/vite] ${publisher.owner} imports shared capnweb, but @pluxel/workbench is unavailable from ${root}`,
						)
					const canonical = resolveWithOxc(dirname(workbench.path), 'capnweb', conditions)
					if (!canonical)
						throw new Error(
							`[services/vite] Cannot resolve Workbench capnweb from ${workbench.path}`,
						)
					const own = resolveWithOxc(dirname(importer), 'capnweb', conditions)
					assertWorkbenchCapnwebAdmission({
						package: publisher,
						supportedVersion: await installedWorkbenchCapnwebVersion(canonical.path),
						actualVersion: own ? await installedWorkbenchCapnwebVersion(own.path) : undefined,
						actualEntry: own?.path,
						development: publisher.dev !== undefined || publisher.marker === undefined,
						operation: 'services/vite',
					})
					if (this.environment.mode === 'dev')
						registerHostSingleton(this.environment, canonical.path)
					return { id: canonical.path, external: true }
				}
			}
			const handler =
				typeof resolveSingleton === 'function' ? resolveSingleton : resolveSingleton.handler
			return handler.call(this, source, importer, options)
		},
	}
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
