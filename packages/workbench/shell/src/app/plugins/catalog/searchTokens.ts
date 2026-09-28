export type SearchTokens = {
	plain: string[]
	pkg: string[]
	reference: string[]
	execution: string[]
}

export function parseSearchTokens(input: string): SearchTokens {
	const tokens = input
		.trim()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean)
	const result: SearchTokens = { plain: [], pkg: [], reference: [], execution: [] }
	for (const token of tokens) {
		if (token.startsWith('@') && token.length > 1) {
			result.pkg.push(token.slice(1).toLowerCase())
		} else if (token.startsWith('ref:') && token.length > 4) {
			result.reference.push(token.slice(4).toLowerCase())
		} else if (token.startsWith('exec:') && token.length > 5) {
			result.execution.push(token.slice(5).toLowerCase())
		} else {
			result.plain.push(token.toLowerCase())
		}
	}
	return result
}
