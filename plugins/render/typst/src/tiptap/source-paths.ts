/** Project paths stay local; spelling in authored Typst remains relative to its file. */
export function relativePath(from: string, to: string): string {
	const base = from.split('/').slice(0, -1),
		target = to.split('/').filter(Boolean)
	while (base.length > 0 && target.length > 0 && base[0] === target[0]) {
		base.shift()
		target.shift()
	}
	return [...base.map(() => '..'), ...target].join('/') || './'
}

export function resolveSourcePath(from: string, value: string): string | undefined {
	if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('@')) return
	const parts = value.startsWith('/') ? [] : from.split('/').slice(0, -1)
	for (const part of value.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') {
			if (parts.length === 0) return
			parts.pop()
		} else parts.push(part)
	}
	return parts.join('/')
}

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
	const directory = resolveSourcePath(from, prefix || './')
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

export function sourceLiteral(value: string | number): string {
	if (typeof value === 'number') return String(value)
	if (!value.isWellFormed()) throw new Error('路径含无效 Unicode')
	let text = '"'
	for (const character of value) {
		const code = character.codePointAt(0)!
		text +=
			character === '"' || character === '\\'
				? `\\${character}`
				: character === '\n'
					? '\\n'
					: character === '\r'
						? '\\r'
						: character === '\t'
							? '\\t'
							: code < 0x20 || code === 0x7f
								? `\\u{${code.toString(16)}}`
								: character
	}
	return text + '"'
}
