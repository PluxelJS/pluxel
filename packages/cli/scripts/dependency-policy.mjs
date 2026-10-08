import { parse } from 'yaml'

// The source catalog is also the release policy: never maintain another version table.
export function dependencyPolicy(contents) {
	const workspace = parse(contents)
	const versions = {}
	for (const [catalog, entries] of [
		['default', workspace.catalog],
		...Object.entries(workspace.catalogs ?? {}),
	]) {
		if (catalog === 'peer' || entries === undefined) continue
		for (const [name, range] of Object.entries(entries)) {
			if (typeof range !== 'string')
				throw new Error(`Invalid dependency policy: ${catalog}.${name}`)
			if (range.startsWith('workspace:')) continue
			if (versions[name] !== undefined && versions[name] !== range)
				throw new Error(
					`Conflicting dependency policy for ${name}: ${versions[name]} and ${range} (catalog ${catalog})`,
				)
			versions[name] = range
		}
	}
	return versions
}
