import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginNodeAddressOf } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { afterEach, expect, it, vi } from 'vitest'
import { createMiTeXFiles } from '../src/tiptap/mitex.js'
import { TypstPlugin } from '../src/wasm.ts'
import runTypst from '../src/worker.ts'

const require = createRequire(import.meta.url)
const fontFamily = 'DejaVu Math TeX Gyre'
const template = String.raw`#set text(font: "DejaVu Math TeX Gyre")
#show math.equation: set text(font: "DejaVu Math TeX Gyre")
#set page(width: 180mm, height: auto)
#set math.equation(numbering: "(1)", supplement: "Equation")
#include "sections/formulas.typ"
#include "sections/references.typ"
#context {
  let equations = query(math.equation.where(block: true))
  assert.eq(equations.len(), 2)
  assert.eq(query(<eq:integral>).first().numbering, "(1)")
  assert.eq(counter(math.equation).at(query(<eq:integral>).first().location()), (1,))
  assert.eq(counter(math.equation).at(query(<eq:matrix>).first().location()), (2,))
}
`
const body = String.raw`#import "/lib/mitex/mitex.typ": mi, mitex
Inline #mi("x_1^2 + \\alpha") and #mi("\\frac{1}{2}").
#mitex("\\int_0^1 x^2 \\, dx = \\frac{1}{3}") <eq:integral>
#mitex("\\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix}") <eq:matrix>
`
function documentFiles(): Record<string, string> {
	return {
		...Object.fromEntries(
			Object.entries(createMiTeXFiles()).map(([path, text]) => [
				path.replace('_editor/mitex/', 'lib/mitex/'),
				text,
			]),
		),
		'sections/formulas.typ': body,
		'sections/references.typ': 'See @eq:integral and @eq:matrix.',
	}
}

function hostMathFont(): string {
	// Like the consumer's font setup, resolve the host font rather than fetching a CDN.
	const [matchedFamily, fontPath] = execFileSync(
		'fc-match',
		['-f', '%{family}\n%{file}', fontFamily],
		{ encoding: 'utf8' },
	).split('\n')
	if (matchedFamily !== fontFamily || !fontPath)
		throw new Error(`MiTeX regression requires the host font ${fontFamily}`)
	return fontPath
}

afterEach(() => vi.restoreAllMocks())

it('renders pinned LaTeX in native Typst with template numbering and references from another included file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-mitex-native-'))
	try {
		for (const [path, content] of Object.entries({ ...documentFiles(), 'main.typ': template })) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), content)
		}
		const input = {
			root,
			entry: 'main.typ',
			fontPaths: [hostMathFont()],
			maxOutputBytes: 8_000_000,
			bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		}
		const compiled = runTypst({ ...input, revision: 1 })
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
		expect(Buffer.from(compiled.pdf).subarray(0, 5).toString()).toBe('%PDF-')
		expect(compiled.vector.byteLength).toBeGreaterThan(100)
		await writeFile(join(root, 'sections/references.typ'), 'See @eq:missing.')
		const missing = runTypst({ ...input, revision: 2 })
		expect(missing).toMatchObject({ ok: false, code: 'COMPILE_FAILED' })
		await writeFile(join(root, 'sections/references.typ'), 'See @eq:matrix.')
		expect(runTypst({ ...input, revision: 3 })).toMatchObject({ ok: true })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('renders the same LaTeX and cross-file references in WASM using only explicit files and a host math font', async () => {
	const assets = new Map([
		[
			'https://example.test/compiler.wasm',
			require.resolve('@myriaddreamin/typst-ts-web-compiler/wasm'),
		],
		[
			'https://example.test/renderer.wasm',
			require.resolve('@myriaddreamin/typst-ts-renderer/wasm'),
		],
		['https://example.test/math.ttf', hostMathFont()],
	])
	const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const path = assets.get(String(url))
		if (!path) throw new Error(`Unexpected request: ${url}`)
		return new Response(await readFile(path))
	})
	await using host = await createTestHost({
		configRecords: {
			initial: [
				{
					owner: pluginNodeAddressOf(TypstPlugin),
					config: {
						compilerWasmUrl: 'https://example.test/compiler.wasm',
						rendererWasmUrl: 'https://example.test/renderer.wasm',
						fontUrls: ['https://example.test/math.ttf'],
					},
				},
			],
		},
	})
	const typst = await host.start(TypstPlugin)
	const source = template
	const files = Object.fromEntries(
		Object.entries(documentFiles()).map(([path, content]) => [`/${path}`, content]),
	)
	const svg = new TextDecoder().decode(await typst.renderSvg(source, { files }))
	expect(svg).toContain('<svg')
	expect(svg).toContain('<path')
	await expect(
		typst.renderSvg(source, {
			files: {
				...files,
				'/sections/formulas.typ': body.replace('\\\\alpha', '\\\\unknownPluxelCommand'),
			},
		}),
	).rejects.toMatchObject({ code: 'COMPILE_FAILED' })
	expect(await typst.renderSvg(source, { files })).toEqual(new TextEncoder().encode(svg))
	expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([...assets.keys()])
}, 30_000)
