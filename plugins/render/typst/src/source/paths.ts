/** Project paths stay local; spelling in authored Typst remains relative to its file. */
export function relativePath(from: string, to: string): string {
	const base = from.split('/').slice(0, -1),
		target = to.split('/').filter(Boolean)
	while (base.length > 0 && target.length > 0 && base[0] === target[0]) {
		base.shift()
		target.shift()
	}
	const path = [...base.map(() => '..'), ...target].join('/') || './'
	return path.startsWith('@') ? `./${path}` : path
}

/** Resolve Typst file literals without interpreting URL escapes, queries or fragments. */
export function resolveSourcePath(from: string, value: string): string | undefined {
	if (!value || value.includes('\\') || value.includes('\0')) return
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

/** Module operands starting with @ are Typst packages. */
export function resolveModulePath(from: string, value: string): string | undefined {
	return value.startsWith('@') ? undefined : resolveSourcePath(from, value)
}

export function moduleBindingName(source: string): string {
	const name = source.split('/').findLast(Boolean) ?? ''
	return source.startsWith('@') ? name.split(':')[0]! : name.replace(/\.typ$/, '')
}

export function sourceLiteral(value: string | number): string {
	if (typeof value === 'number') return String(value)
	if (!value.isWellFormed()) throw new Error('Expected a well-formed Typst string literal')
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
