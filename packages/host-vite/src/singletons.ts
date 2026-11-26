import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	hostSharedPackages,
	resolveNativeImport,
	importPackageName,
	assertSharedPackageVersion,
} from '@pluxel/host/internal'
import {
	assertSharedRuntimeAdmission,
	admitSharedRuntimeOwner,
	installedSharedRuntimeVersion,
	participatesInSharedRuntime,
	readSharedRuntimePackage,
	sharedRuntimeForImport,
} from '@pluxel/host/internal/shared-runtime'
import { resolveWithOxc } from '@pluxel/rolldown/resolver/oxc'
import { normalizePath, type Plugin } from 'vite'
import { registerHostSingleton, HOST_VITE_ENVIRONMENT } from './environment'

const directory = dirname(fileURLToPath(import.meta.url))

/**
 * Pin Core/Host to this driver and explicitly selected packages to the application installation.
 * Use with host() or the Services Vite preset. Package names include exported subpaths.
 * Omitted packages selects only Core/Host.
 */
export function hostSingletons(options: Readonly<{ packages?: readonly string[] }> = {}): Plugin {
	let shared = hostSharedPackages({ root: directory, packages: options.packages })
	const packages = Object.freeze([...shared.keys()])
	let root = directory
	return {
		name: 'pluxel:host-singletons',
		enforce: 'pre',
		applyToEnvironment(environment) {
			return environment.name === HOST_VITE_ENVIRONMENT || environment.config.consumer === 'client'
		},
		configResolved(config) {
			root = config.root
			shared = hostSharedPackages({ root: config.root, packages })
		},
		async resolveId(source, _importer, resolveOptions) {
			const runtime = sharedRuntimeForImport(source)
			if (
				runtime &&
				_importer &&
				!_importer.startsWith('\0') &&
				(!resolveOptions?.ssr || this.environment.name === HOST_VITE_ENVIRONMENT)
			) {
				const importer = _importer.split('?', 1)[0]!
				const publisher = readSharedRuntimePackage(importer, runtime)
				if (
					publisher &&
					(publisher.owner === runtime.owner || participatesInSharedRuntime(publisher))
				) {
					const conditions = {
						conditionNames: [resolveOptions?.ssr ? 'node' : 'browser', 'import', 'default'],
					}
					const owner = resolveWithOxc(
						shared.get(runtime.owner) ?? root,
						runtime.name === 'tinybase' ? `${runtime.owner}/package.json` : runtime.entry,
						conditions,
					)
					if (!owner)
						throw new Error(
							`[host/vite] Cannot resolve ${runtime.owner} for shared ${runtime.name} in ${publisher.owner}`,
						)
					const canonical = resolveWithOxc(dirname(owner.path), runtime.name, conditions)
					if (!canonical) throw new Error(`[host/vite] Cannot resolve Core runtime ${runtime.name}`)
					const actual = resolveWithOxc(dirname(importer), source, conditions)
					assertSharedRuntimeAdmission({
						runtime,
						package: publisher,
						supportedVersion: admitSharedRuntimeOwner(
							owner.path,
							canonical.path,
							runtime,
							'host/vite',
						),
						actualVersion: actual ? installedSharedRuntimeVersion(actual.path, runtime) : undefined,
						actualEntry: actual?.path,
						development: publisher.dev !== undefined || publisher.marker === undefined,
						operation: 'host/vite',
					})
					const selected = resolveWithOxc(dirname(owner.path), source, conditions)
					if (!selected) throw new Error(`[host/vite] Cannot resolve shared ${source}`)
					if (resolveOptions?.ssr && this.environment.mode === 'dev')
						registerHostSingleton(this.environment, selected.path)
					return { id: selected.path, external: !!resolveOptions?.ssr }
				}
			}
			if (!resolveOptions?.ssr || this.environment.name !== HOST_VITE_ENVIRONMENT) return null
			// The public SDK is a Host namespace, with the same native identity in both loaders.
			const specifier =
				source === '@pluxel/agent-sdk/host' ? '@pluxel/host/internal/agent/host' : source
			const base = shared.get(importPackageName(specifier))
			if (base) {
				const path = normalizePath(resolveNativeImport(base, specifier))
				if (_importer && !_importer.startsWith('\0')) {
					const importer = _importer.split('?')[0]!
					const owner =
						specifier === source ? importer : resolveNativeImport(dirname(importer), source)
					const actual = resolveNativeImport(dirname(owner), specifier)
					assertSharedPackageVersion({
						specifier,
						actual,
						canonical: path,
						importer: _importer.split('?')[0],
					})
				}
				if (this.environment.mode === 'dev') registerHostSingleton(this.environment, path)
				return { id: path, external: true }
			}
			return null
		},
	}
}
