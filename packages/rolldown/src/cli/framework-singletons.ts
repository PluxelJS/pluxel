import type { Plugin, ResolvedId } from 'rolldown'
import { dirname } from 'pathe'
import { resolveWithOxc } from '../resolver/oxc'

/** Shared framework identities always resolve through the application, including package subpaths. */
export function staticFrameworkSingletonPlugin(
	entry: string,
	specifiers: readonly string[],
): Plugin {
	const packages = new Set(specifiers.map(packageName).filter((name) => name !== null))
	const resolutions = new Map<string, Promise<ResolvedId | null>>()
	return {
		name: 'pluxel:static-framework-singletons',
		buildStart() {
			resolutions.clear()
		},
		resolveId(id, _importer, options) {
			const name = packageName(id)
			const publishedPlugins = id === '@pluxel/services/plugins'
			if (!name || (!packages.has(name) && !publishedPlugins)) return null
			let resolution = resolutions.get(id)
			if (!resolution) {
				// The official Services Plugin entry owns a published Workbench inventory. Resolve
				// that exact entry as published, rather than rebuilding it through @pluxel/hmr
				// and then merging a second producer with the same revision. Other Services
				// imports are not made singletons by this rule; ordinary Plugin HMR is unchanged.
				const published = publishedPlugins
					? resolveWithOxc(dirname(entry), id, {
							conditionNames: ['node', 'import', 'module', 'production', 'default'],
							tsconfig: false,
						})
					: undefined
				if (publishedPlugins && !published)
					this.error(
						`[static-application] Cannot resolve published Plugin entry ${id} from ${entry}`,
					)
				resolution = this.resolve(published?.path ?? id, entry, {
					...options,
					skipSelf: true,
				}).then((resolved) => {
					if (!resolved)
						this.error(
							`[static-application] Cannot resolve shared framework entry ${id} from ${entry}`,
						)
					return resolved
				})
				resolutions.set(id, resolution)
			}
			return resolution
		},
	}
}

function packageName(id: string): string | null {
	if (!id || id.startsWith('.') || id.startsWith('/') || id.includes(':') || id.startsWith('\0'))
		return null
	const parts = id.split('/')
	return id.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0]
}
