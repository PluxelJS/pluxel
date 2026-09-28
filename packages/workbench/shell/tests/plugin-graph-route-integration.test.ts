import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('plugin graph file routes', () => {
	it('generates native Workbench matches for both the base page and focus splat', () => {
		const routeTree = readFileSync(
			new URL('../src/app/router/routeTree.gen.ts', import.meta.url),
			'utf8',
		)

		expect(routeTree).toContain("fullPath: '/plugin-graph'")
		expect(routeTree).toContain("fullPath: '/plugin-graph/$kind/$'")
		expect(routeTree).toContain("id: '/_workbench/plugin-graph'")
		expect(routeTree).toContain("id: '/_workbench/plugin-graph_/$kind/$'")
	})
})
