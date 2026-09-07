import { describe, expect, it } from 'vitest'
import { resolveDocumentationUrl } from '../src/commands/docs'

describe('documentation locator', () => {
	it('links to the canonical upstream docs without copying a snapshot', () => {
		expect(resolveDocumentationUrl(undefined)).toBe(
			'https://github.com/PluxelJS/pluxel/blob/main/docs/index.md',
		)
		expect(resolveDocumentationUrl('development/testing.md')).toBe(
			'https://github.com/PluxelJS/pluxel/blob/main/docs/development/testing.md',
		)
	})

	it('keeps paths below the upstream docs root', () => {
		for (const path of ['../README.md', '/README.md', 'development\\testing.md', 'a//b.md']) {
			expect(() => resolveDocumentationUrl(path)).toThrow(/relative path below docs/)
		}
	})
})
