import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Native ESM loader whose source graphs borrow the deployment's exact framework instances. */
export function createProductionSourceLoader(frameworkModules?: Readonly<Record<string, string>>) {
	const entries = new Set<string>()
	const ownedModules = new Set<string>()
	const loadedEntries = new Set<string>()
	const frameworks = new Map(Object.entries(frameworkModules ?? {}))
	const frameworkPackages = new Set([...frameworks.keys()].map(packageName))
	let closed = false
	const hooks =
		frameworks.size > 0
			? registerHooks({
					resolve(specifier, context, nextResolve) {
						const sourceOwned =
							entries.has(specifier) ||
							(context.parentURL !== undefined && ownedModules.has(context.parentURL))
						if (!sourceOwned) return nextResolve(specifier, context)
						const framework = frameworks.get(specifier)
						if (framework) return { url: framework, shortCircuit: true }
						if (frameworkPackages.has(packageName(specifier))) {
							throw Object.assign(
								new Error(
									`Plugin source imports an unavailable deployment framework entry: ${specifier}`,
								),
								{
									code: 'PLUGIN_SOURCE_FRAMEWORK_ENTRY_UNAVAILABLE',
								},
							)
						}
						const result = nextResolve(specifier, context)
						if (result.url.startsWith('file:')) ownedModules.add(result.url)
						return result
					},
				})
			: undefined
	return {
		async load(path: string): Promise<unknown> {
			if (closed) throw new Error('Production Plugin source loader is closed')
			const url = pathToFileURL(path).href
			if (loadedEntries.has(url)) {
				throw Object.assign(
					new Error(
						`Production Plugin source replacement requires a process restart: ${path}. Node ESM caches transitive imports; changing an entry URL cannot refresh its dependency graph.`,
					),
					{ code: 'PLUGIN_SOURCE_RESTART_REQUIRED' },
				)
			}
			loadedEntries.add(url)
			entries.add(url)
			return import(url)
		},
		/** Called after source admission, evaluation and every Plugin generation have drained. */
		close(): void {
			if (closed) return
			closed = true
			hooks?.deregister()
			entries.clear()
			ownedModules.clear()
		},
	}
}

function packageName(specifier: string): string {
	const parts = specifier.split('/')
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}
