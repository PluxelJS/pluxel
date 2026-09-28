import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
	let root = directory
	return {
		name: 'pluxel:host-singletons',
		enforce: 'pre',
		applyToEnvironment(environment) {
			return environment.name === HOST_VITE_ENVIRONMENT
		},
		configResolved(config) {
			root = config.root
		},
		resolveId(source, _importer, resolveOptions) {
			if (!resolveOptions?.ssr || this.environment.name !== HOST_VITE_ENVIRONMENT) return null
			const selected = (options.packages ?? []).some(
				(name) => source === name || source.startsWith(`${name}/`),
			)
			if (
				selected ||
				['@pluxel/core', '@pluxel/host'].some(
					(name) => source === name || source.startsWith(`${name}/`),
				)
			) {
				const result = resolveWithOxc(selected ? root : directory, source, {
					conditionNames: ['node', 'import', 'default'],
				})
				if (!result) throw new Error(`Cannot resolve host singleton: ${source}`)
				const path = normalizePath(result.path)
				if (this.environment.mode === 'dev') registerHostSingleton(this.environment, path)
				return { id: path, external: true }
			}
			return null
		},
	}
}
