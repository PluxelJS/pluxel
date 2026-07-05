import { parseSync } from 'oxc-parser'
import { describe, expect, it } from 'vitest'
import { collectImportSpecifiers } from '../../src/rolldown/plugins/importCollector'

function parse(code: string) {
	return parseSync('fixture.ts', code, { sourceType: 'module', lang: 'ts' }).program
}

describe('collectImportSpecifiers', () => {
	it('collects static and literal dynamic imports from the AST', () => {
		const ast = parse(`
			import value from 'plugin-static'
			import type { T } from 'plugin-type'
			export { value as other } from 'plugin-reexport'
			export * from 'plugin-star'

			const ignored = "import('plugin-string')"
			// import('plugin-comment')
			await import('plugin-dynamic')
			await import(\`plugin-template\`)
			await import(\`plugin-\${name}\`)
		`)

		expect(collectImportSpecifiers(ast).map((item) => [item.kind, item.specifier])).toEqual([
			['static', 'plugin-static'],
			['static', 'plugin-type'],
			['static', 'plugin-reexport'],
			['static', 'plugin-star'],
			['dynamic', 'plugin-dynamic'],
			['dynamic', 'plugin-template'],
		])
	})
})
