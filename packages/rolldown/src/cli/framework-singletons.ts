import type { Plugin, ResolvedId } from 'rolldown'

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
			if (!name || !packages.has(name)) return null
			let resolution = resolutions.get(id)
			if (!resolution) {
				resolution = this.resolve(id, entry, { ...options, skipSelf: true }).then((resolved) => {
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
