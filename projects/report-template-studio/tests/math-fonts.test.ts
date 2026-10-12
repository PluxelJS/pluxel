import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

// Exercise the same native compiler version owned by the official Typst plugin.
const requireTypst = createRequire(import.meta.resolve('@pluxel/typst'))
const { NodeCompiler } = requireTypst('@myriaddreamin/typst-ts-node-compiler')
const assets = fileURLToPath(new URL('../financial-document-assets/', import.meta.url))

test('shared theme supplies real CJK glyphs inside mathematical equations', () => {
	const compiler = NodeCompiler.create({
		workspace: assets,
		fontArgs: [{ fontPaths: [`${assets}/fonts`] }],
	})
	const result = compiler.compile({
		mainFileContent: `
#import "templates/financial-correspondence.typ": correspondence
#show: correspondence
$ "毛利率" $
`,
	})
	assert.ok(result.result)
	const svg = String(compiler.svg(result.result))
	const glyphs = [...svg.matchAll(/<use[^>]*href="([^"]+)"/g)].map((match) => match[1])
	// Previously all three letters referenced the same .notdef square without any diagnostic.
	assert.equal(glyphs.length, 3)
	assert.equal(new Set(glyphs).size, 3)
})
