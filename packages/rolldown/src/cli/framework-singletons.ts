import type { Plugin, ResolvedId } from 'rolldown'
import { dirname } from 'pathe'
import { resolveWithOxc } from '../resolver/oxc'

/** Official Services resolve as one published build; see the comment in resolveId. */
const PublishedServicesPackage = '@pluxel/services'

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
			const published = name === PublishedServicesPackage
			if (!name || (!packages.has(name) && !published)) return null
			let resolution = resolutions.get(id)
			if (!resolution) {
				// The official Services Plugin entry owns a published Workbench inventory, so it must
				// not be rebuilt through @pluxel/hmr (that would merge a second producer with the
				// same revision). Its published chunks carry their own copy of the Services
				// capability tokens (Vault, database, …), and Context capabilities are compared by
				// identity: every other Services entry must come from the same published build, or
				// a Plugin such as VaultAdminPlugin requires a Vault the host never installed.
				const publishedEntry = published
					? resolveWithOxc(dirname(entry), id, {
							conditionNames: ['node', 'import', 'module', 'production', 'default'],
							tsconfig: false,
						})
					: undefined
				if (published && !publishedEntry)
					this.error(
						`[static-application] Cannot resolve published Services entry ${id} from ${entry}`,
					)
				resolution = this.resolve(publishedEntry?.path ?? id, entry, {
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
