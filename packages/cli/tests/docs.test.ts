import { expect, it } from 'vitest'
import { readDocumentation } from '../src/commands/docs'

it('rejects paths outside docs', () => {
	for (const path of ['../README.md', '/README.md', 'a\\b', 'a//b']) {
		expect(() => readDocumentation(path)).toThrow(/relative path below docs/)
	}
})
