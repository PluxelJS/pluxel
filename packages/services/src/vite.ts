import { serviceSharedPackages } from './sources'
import { dirname, resolve } from 'node:path'
import {
	assertSharedRuntimeAdmission,
	admitSharedRuntimeOwner,
	assertSharedRuntimeHost,
	nearestPackageManifest,
	installedSharedRuntimeVersion,
	participatesInSharedRuntime,
	readSharedRuntimePackage,
	sharedRuntimeForImport,
} from '@pluxel/host/internal/shared-runtime'
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

/** Preserve service and admitted native runtime identity. Entry identifies the Host package when Vite root differs. */
export function serviceSingletons(entry?: string): Plugin {
	const singletons = hostSingletons({
		packages: serviceSharedPackages,
	})
	const resolveSingleton = singletons.resolveId!
	const configureSingleton = singletons.configResolved!
	let root = ''
	// Linked workspaces can install the same version at different native module paths.
	// Bind admitted native imports to the selected service installation.
	return {
		...singletons,
		applyToEnvironment(environment) {
			return environment.name === HOST_VITE_ENVIRONMENT || environment.config.consumer === 'client'
		},
		configResolved(config) {
			root = config.root
			const handler =
				typeof configureSingleton === 'function' ? configureSingleton : configureSingleton.handler
			return handler.call(this, config)
		},
		async resolveId(source, importer, options) {
			const runtime = sharedRuntimeForImport(source)
			if (
				runtime &&
				importer &&
				(!options.ssr || this.environment.name === HOST_VITE_ENVIRONMENT)
			) {
				const publisher = readSharedRuntimePackage(importer, runtime)
				const serviceConsumer = runtime.name === 'tinybase' && source === runtime.entry
				const application =
					runtime.name === 'tinybase' &&
					publisher?.manifestPath ===
						nearestPackageManifest(resolve(root, entry ?? '__entry__.mjs'))
				if (
					publisher &&
					(application || serviceConsumer || participatesInSharedRuntime(publisher))
				) {
					const conditions = {
						conditionNames: [options.ssr ? 'node' : 'browser', 'import', 'default'],
					}
					const owner = resolveWithOxc(
						root,
						runtime.name === 'tinybase' ? `${runtime.owner}/package.json` : runtime.entry,
						conditions,
					)
					if (!owner)
						throw new Error(
							`[services/vite] ${publisher.owner} imports shared ${runtime.name}, but ${runtime.owner} is unavailable from ${root}`,
						)
					const canonical = resolveWithOxc(dirname(owner.path), runtime.name, conditions)
					if (!canonical)
						throw new Error(
							`[services/vite] Cannot resolve Host ${runtime.name} from ${owner.path}`,
						)
					const own = resolveWithOxc(
						dirname(importer),
						serviceConsumer ? runtime.name : source,
						conditions,
					)
					const admission = {
						runtime,
						package: publisher,
						supportedVersion: admitSharedRuntimeOwner(
							owner.path,
							canonical.path,
							runtime,
							'services/vite',
						),
						actualVersion: own ? installedSharedRuntimeVersion(own.path, runtime) : undefined,
						actualEntry: own?.path,
						development: publisher.dev !== undefined || publisher.marker === undefined,
						operation: 'services/vite',
					}
					if (application)
						assertSharedRuntimeHost({ ...admission, manifestPath: publisher.manifestPath })
					else assertSharedRuntimeAdmission(admission)
					if (!serviceConsumer) {
						const selected = resolveWithOxc(dirname(owner.path), source, conditions)
						if (!selected)
							throw new Error(`[services/vite] Cannot resolve Host ${source} from ${owner.path}`)
						if (options.ssr && this.environment.mode === 'dev')
							registerHostSingleton(this.environment, selected.path)
						return { id: selected.path, external: !!options.ssr }
					}
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
		serviceSingletons(options.entry),
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
