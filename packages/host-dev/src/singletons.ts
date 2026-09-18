import { dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveWithOxc } from '@pluxel/rolldown/resolver/oxc'
import { normalizePath, type Plugin } from 'vite'
import { registerViteSsrExternalModuleUrls } from './runner'

const directory = dirname(fileURLToPath(import.meta.url))

/**
 * Pin Core/Host to this driver and explicitly selected packages to the application installation.
 * Package names include their exported subpaths. Omitted packages selects only Core/Host.
 */
export function hostSingletons(options: Readonly<{ packages?: readonly string[] }> = {}): Plugin {
	const urls = new Map<string, string>()
	let unregister: (() => void) | undefined
	let root = directory
	return {
		name: 'pluxel:host-singletons',
		enforce: 'pre',
		configureServer(server) {
			root = server.config.root
			unregister = registerViteSsrExternalModuleUrls(server, urls)
		},
		resolveId(source, _importer, resolveOptions) {
			if (!resolveOptions?.ssr) return null
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
				const url = pathToFileURL(result.path).href
				// Vite can request a resolved external file a second time through ModuleRunner.
				// Preserve native ESM identity there as well as at the initial bare resolution.
				for (const request of [source, path, `/@fs/${path}`, `/@fs${path}`, url])
					urls.set(request, url)
				if (root) {
					const local = normalizePath(relative(root, path))
					if (!local.startsWith('../') && !isAbsolute(local)) urls.set(`/${local}`, url)
				}
				return { id: path, external: true }
			}
			return null
		},
		closeBundle() {
			unregister?.()
			unregister = undefined
		},
	}
}
