import type { FileEntry } from './contracts'

export interface SearchOptions {
	query: string
	mode: 'path' | 'content'
	caseSensitive?: boolean
}
export interface SearchMatch {
	path: string
	kind: 'file' | 'directory'
	line?: number
	column?: number
	text?: string
}
export interface SearchResult {
	matches: SearchMatch[]
	truncated: boolean
	skipped: number
}

/** Literal search: one result per matching line, bounded independently of workspace size. */
export function searchWorkspace(
	entries: FileEntry[],
	text: (path: string) => string | undefined,
	options: SearchOptions,
): SearchResult {
	const result: SearchResult = { matches: [], truncated: false, skipped: 0 }
	if (!options.query.trim()) return result
	if (options.query.length > 500) throw new Error('搜索词不能超过 500 字符')
	const normalize = (value: string) => (options.caseSensitive ? value : value.toLowerCase())
	const query = normalize(options.query)
	const add = (match: SearchMatch) => {
		if (result.matches.length === 200) {
			result.truncated = true
			return false
		}
		result.matches.push(match)
		return true
	}
	for (const entry of entries) {
		if (options.mode === 'path') {
			if (normalize(entry.path).includes(query) && !add({ path: entry.path, kind: entry.kind }))
				break
			continue
		}
		if (entry.kind !== 'file' || entry.binary) continue
		if (entry.size > 2 * 1024 * 1024) {
			result.skipped++
			continue
		}
		const content = text(entry.path)
		if (content === undefined) continue
		const lines = content.split('\n')
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!
			const column = normalize(line).indexOf(query)
			if (column < 0) continue
			const start = Math.max(0, column - 50)
			if (
				!add({
					path: entry.path,
					kind: 'file',
					line: index + 1,
					column: column + 1,
					text: (start ? '…' : '') + line.slice(start, start + 200),
				})
			)
				return result
		}
	}
	return result
}
