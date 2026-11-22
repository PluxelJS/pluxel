import { relativePath, resolveModulePath } from '../source/paths.js'

export interface SourcePathCompletion {
	value: string
	label: string
	directory: boolean
}

/** Only immediate children of the typed directory, never a flat project-wide catalog. */
export function completeSourcePaths(
	files: readonly string[],
	from: string,
	value: string,
): SourcePathCompletion[] {
	const slash = value.lastIndexOf('/'),
		prefix = value.slice(0, slash + 1),
		fragment = value.slice(slash + 1)
	const directory = resolveModulePath(from, prefix || './')
	if (directory === undefined) return []
	const root = directory ? `${directory}/` : ''
	const entries = new Map<string, SourcePathCompletion>()
	if (directory && !fragment) {
		const parent = directory.split('/').slice(0, -1).join('/')
		const path = value.startsWith('/')
			? `/${parent}${parent ? '/' : ''}`
			: `${relativePath(from, parent).replace(/\/$/, '')}/`
		entries.set('..', { value: path, label: '../', directory: true })
	}
	for (const file of files) {
		if (!file.endsWith('.typ') || file === from || !file.startsWith(root)) continue
		const rest = file.slice(root.length),
			separator = rest.indexOf('/')
		const name = separator < 0 ? rest : rest.slice(0, separator + 1)
		if (!name || !name.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase())) continue
		entries.set(name, { value: prefix + name, label: name, directory: separator >= 0 })
	}
	return [...entries.values()]
		.sort((a, b) => Number(b.directory) - Number(a.directory) || a.label.localeCompare(b.label))
		.slice(0, 30)
}
