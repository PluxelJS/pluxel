import { describe, expect, it } from 'vitest'
import { pointAtPreview, pointAtSource, type PreviewPoint } from '../src/renderer/source-navigation'

const text: PreviewPoint = {
	path: '报表/排版.typ',
	line: 4,
	column: 3,
	endLine: 4,
	endColumn: 9,
	page: 1,
	x: 50,
	y: 60,
	width: 100,
	height: 12,
}

describe('native preview source navigation', () => {
	it('uses page-local geometry and picks the most specific rendered span', () => {
		const glyph = { ...text, column: 6, endColumn: 7, x: 90, width: 10 }
		expect(pointAtPreview([text, glyph], 1, 94, 63)).toBe(glyph)
		expect(pointAtPreview([text], 2, 94, 63)).toBeUndefined()
		expect(pointAtPreview([text], 1, 300, 300)).toBeUndefined()
	})
	it('matches UTF-16 ranges with an exclusive end and keeps a reused span near the current page', () => {
		const repeated = { ...text, page: 5 }
		expect(pointAtSource([text, repeated], { path: text.path, line: 4, column: 8 }, 4)).toBe(
			repeated,
		)
		expect(pointAtSource([text], { path: text.path, line: 4, column: 9 }, 1)).toBeUndefined()
		expect(pointAtSource([text], { path: '共享/主题.typ', line: 4, column: 3 }, 1)).toBeUndefined()
	})
})
