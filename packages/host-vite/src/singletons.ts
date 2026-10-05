import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	hostSharedPackages,
	resolveNativeImport,
	importPackageName,
	assertSharedPackageVersion,
} from '@pluxel/host/internal'
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
	return {
		name: 'pluxel:host-singletons',
		enforce: 'pre',
		applyToEnvironment(environment) {
			return environment.name === HOST_VITE_ENVIRONMENT
		},
		configResolved(config) {
			shared = hostSharedPackages({ root: config.root, packages })
		},
		resolveId(source, _importer, resolveOptions) {
			if (!resolveOptions?.ssr || this.environment.name !== HOST_VITE_ENVIRONMENT) return null
			const base = shared.get(importPackageName(source))
			if (base) {
				const path = normalizePath(resolveNativeImport(base, source))
				if (_importer && !_importer.startsWith('\0')) {
					const actual = resolveNativeImport(dirname(_importer.split('?')[0]!), source)
					assertSharedPackageVersion({
						specifier: source,
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
