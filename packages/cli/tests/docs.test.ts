import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readDocumentation } from '../src/commands/docs'

describe('local development documentation', () => {
	it('reads current checkout content, not a remote URL', () => {
		const doc = readDocumentation(undefined)
		expect(doc.source.kind).toBe('git')
		expect(doc.content).toBe(readFileSync(doc.file, 'utf8'))
		expect(doc.file).toMatch(/docs\/development\/index.md$/)
	})
	it('rejects paths outside docs', () => {
		for (const path of ['../README.md', '/README.md', 'a\\b', 'a//b'])
			expect(() => readDocumentation(path)).toThrow(/relative path below docs/)
	})
})
