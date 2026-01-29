export type SearchTokens = {
	plain: string[]
	pkg: string[]
	tag: string[]
	version: string[]
	id: string[]
}

export function parseSearchTokens(input: string): SearchTokens {
	const tokens = input
		.trim()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean)
	const result: SearchTokens = { plain: [], pkg: [], tag: [], version: [], id: [] }
	for (const token of tokens) {
		if (token.startsWith('@') && token.length > 1) {
			result.pkg.push(token.slice(1).toLowerCase())
		} else if (token.startsWith('#') && token.length > 1) {
			result.tag.push(token.slice(1).toLowerCase())
		} else if (token.startsWith('v:') && token.length > 2) {
			result.version.push(token.slice(2).toLowerCase())
		} else if (token.startsWith('id:') && token.length > 3) {
			result.id.push(token.slice(3).toLowerCase())
		} else {
			result.plain.push(token.toLowerCase())
		}
	}
	return result
}
