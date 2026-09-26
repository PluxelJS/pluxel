import { describe, expect, it, vi } from 'vitest'
import { parseStandaloneWithLang, parseWithLang } from '../../src/rolldown/plugins/pluginUtils'

describe('plugin AST parsing', () => {
	it('shares exact-source parses across passes and interleaved revisions', () => {
		const id = '/virtual/shared-source.ts'
		const firstCode = 'export const value = 1'
		const first = parseStandaloneWithLang(firstCode, id)
		expect(first).not.toBeNull()

		const contextParse = vi.fn(() => {
			throw new Error('an exact cached source should not be parsed again')
		})
		expect(parseWithLang({ parse: contextParse }, firstCode, id)).toBe(first)
		expect(contextParse).not.toHaveBeenCalled()

		const second = parseStandaloneWithLang('export const value = 2', id)
		expect(second).not.toBeNull()
		expect(second).not.toBe(first)
		expect(parseWithLang({ parse: contextParse }, firstCode, id)).toBe(first)
		expect(contextParse).not.toHaveBeenCalled()
	})
	it('rejects syntax errors without retrying the context parser', () => {
		const id = '/virtual/invalid-source.ts'
		const code = 'export const value = ;'
		expect(parseStandaloneWithLang(code, id)).toBeNull()
		const parse = vi.fn(() => {
			throw new SyntaxError('invalid source')
		})
		expect(parseWithLang({ parse }, code, id)).toBeNull()
		expect(parse).toHaveBeenCalledTimes(1)
		expect(parseStandaloneWithLang('export const value = 1', id)).not.toBeNull()
	})
	it('lets query-owned ASTs bypass cache reads and writes', () => {
		const id = '/virtual/uncached-inspection.ts'
		const code = 'export const value = 1'
		const first = parseStandaloneWithLang(code, id, { cache: false })
		const second = parseStandaloneWithLang(code, id, { cache: false })
		expect(first).not.toBeNull()
		expect(second).not.toBe(first)
		const cached = parseStandaloneWithLang(code, id)
		expect(cached).not.toBe(first)
		expect(cached).not.toBe(second)
		expect(parseStandaloneWithLang(code, id, { cache: false })).not.toBe(cached)
		expect(parseStandaloneWithLang(code, id)).toBe(cached)
	})
})
