import { describe, expect, it, vi } from 'vitest'
import { parseStandaloneWithLang, parseWithLang } from '../../src/rolldown/plugins/pluginUtils'

describe('plugin AST parsing', () => {
	it('shares an exact-source parse across source passes and invalidates on change', () => {
		const id = '/virtual/shared-source.ts'
		const firstCode = 'export const value = 1'
		const first = parseStandaloneWithLang(firstCode, id)
		expect(first).toBeDefined()

		const contextParse = vi.fn(() => {
			throw new Error('an exact cached source should not be parsed again')
		})
		expect(parseWithLang({ parse: contextParse }, firstCode, id)).toBe(first)
		expect(contextParse).not.toHaveBeenCalled()

		const second = parseStandaloneWithLang('export const value = 2', id)
		expect(second).toBeDefined()
		expect(second).not.toBe(first)
	})
})
