import { expect, it } from 'vitest'
import { searchWorkspace } from '../src/shared/search'
import type { FileEntry } from '../src/shared/contracts'
const entries: FileEntry[] = [
	{ path: '报表/季度经营分析', kind: 'directory', size: 0, version: '1' },
	{ path: '报表/季度经营分析/排版.typ', kind: 'file', size: 100, version: '1' },
	{ path: '共享/字体/中文.ttf', kind: 'file', binary: true, size: 100, version: '1' },
	{ path: 'large.ts', kind: 'file', size: 3 * 1024 * 1024, version: '1' },
]
it('finds Chinese paths and text with exact one-based line/column and case choice', () => {
	expect(
		searchWorkspace(entries, () => undefined, { query: '季度', mode: 'path' }).matches,
	).toHaveLength(2)
	const text = () => '#let Title = "季度"\n#text("毛利率")\n#TITLE'
	expect(searchWorkspace(entries, text, { query: '毛利率', mode: 'content' })).toEqual({
		matches: [
			{ path: entries[1]!.path, kind: 'file', line: 2, column: 8, text: '#text("毛利率")' },
		],
		skipped: 1,
		truncated: false,
	})
	expect(searchWorkspace(entries, text, { query: 'title', mode: 'content' }).matches).toHaveLength(
		2,
	)
	expect(
		searchWorkspace(entries, text, { query: 'title', mode: 'content', caseSensitive: true })
			.matches,
	).toHaveLength(0)
})
it('bounds large result sets and treats metacharacters literally', () => {
	const text = () => Array.from({ length: 210 }, () => 'a.*b').join('\n')
	const result = searchWorkspace(entries, text, { query: '.*', mode: 'content' })
	expect(result.matches).toHaveLength(200)
	expect(result.truncated).toBe(true)
	expect(searchWorkspace(entries, text, { query: '[', mode: 'content' }).matches).toHaveLength(0)
	expect(searchWorkspace(entries, text, { query: ' ', mode: 'content' }).matches).toHaveLength(0)
})
