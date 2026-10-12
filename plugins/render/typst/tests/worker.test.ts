import { inflateSync } from 'node:zlib'
import { NodeCompiler } from '../src/native-binding.ts'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import compileTypst from '../src/worker.ts'

vi.mock('../src/native-binding.ts', async () => {
	const actual = await vi.importActual<typeof import('../src/native-binding.ts')>(
		'../src/native-binding.ts',
	)
	return { ...actual, NodeCompiler: { create: vi.fn((args) => actual.NodeCompiler.create(args)) } }
})

const roots: string[] = []

async function workspace(source: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-typst-worker-'))
	roots.push(root)
	await mkdir(join(root, 'inputs'))
	await writeFile(join(root, 'main.typ'), source)
	return root
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Typst native worker', () => {
	it('maps imported UTF-16 source spans, images and headings from the same paged output', async () => {
		const root = await workspace(
			'#include "共享.typ"\n#pagebreak()\n== Appendix\n#image("/inputs/logo.svg", width: 20pt)',
		)
		await writeFile(join(root, '共享.typ'), '= Overview\nA😀B\n#rotate(25deg)[Rotated]\n$x^2$')
		await writeFile(
			join(root, 'inputs/logo.svg'),
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
		)
		const result = compileTypst({ revision: 1, root, entry: 'main.typ', maxOutputBytes: 8_000_000 })
		if (!result.ok) throw new Error('Expected compilation success')
		expect(result.navigation.outline).toMatchObject([
			{ title: 'Overview', level: 1, page: 1 },
			{ title: 'Appendix', level: 2, page: 2 },
		])
		expect(result.navigation.points).toContainEqual(
			expect.objectContaining({
				path: '共享.typ',
				line: 2,
				column: 4,
				endColumn: 5,
				page: 1,
			}),
		)
		expect(result.navigation.points.some((point) => point.path.startsWith('inputs/'))).toBe(false)
		expect(
			result.navigation.points.some(
				(point) =>
					point.path === 'main.typ' && point.page === 2 && point.line === 4 && point.width === 20,
			),
		).toBe(true)
		expect(
			result.navigation.points.every((point) =>
				[point.x, point.y, point.width, point.height].every(Number.isFinite),
			),
		).toBe(true)
	})

	it('reads multiple JSON files and raw CBOR from disk and exports one document twice', async () => {
		const root = await workspace(`
#let a = json("/inputs/a.json")
#let b = json("/inputs/b.json")
#let c = cbor("/inputs/c.cbor")
#assert(a.n == 1 and b.n == 2 and c == 3)
Report
`)
		await writeFile(join(root, 'inputs/a.json'), '{"n":1}')
		await writeFile(join(root, 'inputs/b.json'), '{"n":2}')
		await writeFile(join(root, 'inputs/c.cbor'), Uint8Array.of(3))
		const result = compileTypst({ revision: 1, root, entry: 'main.typ', maxOutputBytes: 8_000_000 })
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('Expected compilation success')
		expect(result.vector.byteLength).toBeGreaterThan(0)
		expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
		expect(structuredClone(result).ok).toBe(true)
		// No retained compiler state may hide changes or removed dynamic files.
		await rm(join(root, 'inputs/b.json'))
		const failed = compileTypst({ revision: 1, root, entry: 'main.typ', maxOutputBytes: 8_000_000 })
		expect(failed.ok).toBe(false)
		expect(failed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
	})

	it('preserves source locations in cloneable compile diagnostics', async () => {
		const root = await workspace('#let x = missing\n#x')
		const result = compileTypst({ revision: 1, root, entry: 'main.typ', maxOutputBytes: 8_000_000 })
		expect(result).toMatchObject({
			ok: false,
			diagnostics: [
				{ severity: 'error', path: 'main.typ', range: { start: { line: 0, character: 9 } } },
			],
		})
		expect(result.diagnostics[0]?.message).toContain('missing')
	})

	it('rejects combined output overflow rather than publishing a partial revision', async () => {
		const root = await workspace('Report')
		expect(compileTypst({ revision: 1, root, entry: 'main.typ', maxOutputBytes: 1 })).toMatchObject(
			{
				ok: false,
				code: 'LIMIT_EXCEEDED',
			},
		)
	})
})

it('retains one native compiler and updates changed and removed shadow files', async () => {
	const root = await workspace('#include "shared.typ"')
	await writeFile(join(root, 'shared.typ'), 'Original')
	const create = vi.mocked(NodeCompiler.create)
	create.mockClear()
	try {
		const input = { revision: 1, root, entry: 'main.typ', maxOutputBytes: 8_000_000 }
		const first = compileTypst(input)
		expect(first.ok).toBe(true)
		await writeFile(join(root, 'shared.typ'), 'Edited shared content')
		const changed = compileTypst(input)
		expect(changed.ok).toBe(true)
		if (!first.ok || !changed.ok) throw new Error('Expected document')
		expect(changed.vector).not.toEqual(first.vector)
		await rm(join(root, 'shared.typ'))
		expect(compileTypst(input).ok).toBe(false)
		await writeFile(join(root, 'shared.typ'), 'Recovered')
		expect(compileTypst(input).ok).toBe(true)
		expect(create).toHaveBeenCalledTimes(1)
	} finally {
		create.mockClear()
	}
})

it('renders retained pages and exact gradient crops without compiling again, with bounded and stale errors', async () => {
	const { renderTypstPage } = await import('../src/worker.ts')
	const root = await workspace(
		'#set page(width: 100pt, height: 80pt, margin: 0pt, fill: gradient.linear(red, blue))\nHello\n#pagebreak()\nSecond',
	)
	const input = { root, revision: 10, entry: 'main.typ', maxOutputBytes: 8_000_000 }
	const first = compileTypst(input)
	if (!first.ok) throw new Error(JSON.stringify(first.diagnostics))
	expect(first.navigation.pages).toEqual([
		{ page: 1, width: 100, height: 80 },
		{ page: 2, width: 100, height: 80 },
	])
	const compiler = vi.mocked(NodeCompiler.create).mock.results.at(-1)!.value
	const compile = vi.spyOn(compiler, 'compile')
	const options = { kind: 'render' as const, revision: 10, page: 1, maxOutputBytes: 8_000_000 }
	try {
		const whole = renderTypstPage(options)
		const cropped = renderTypstPage({ ...options, region: { x: 20, y: 10, width: 30, height: 20 } })
		const second = renderTypstPage({ ...options, page: 2, scale: 1 })
		expect(whole).toMatchObject({ revision: 10, page: 1, format: 'png', width: 200, height: 160 })
		expect(second).toMatchObject({ width: 100, height: 80 })
		expect(cropped).toMatchObject({
			width: 60,
			height: 40,
			region: { x: 20, y: 10, width: 30, height: 20 },
		})
		const wholePixels = pngPixels(whole.data)
		const cropPixels = pngPixels(cropped.data)
		for (let row = 0; row < 40; row++) {
			expect(cropPixels.subarray(row * 60 * 4, (row + 1) * 60 * 4)).toEqual(
				wholePixels.subarray(((row + 20) * 200 + 40) * 4, ((row + 20) * 200 + 100) * 4),
			)
		}
		expect(compile).not.toHaveBeenCalled()
		for (const extra of [
			{ page: 3 },
			{ scale: NaN },
			{ region: { x: 90, y: 0, width: 20, height: 10 } },
		]) {
			expect(() => renderTypstPage({ ...options, ...extra })).toThrow(
				expect.objectContaining({ code: 'INVALID_INPUT' }),
			)
		}
		expect(() => renderTypstPage({ ...options, maxOutputBytes: 1 })).toThrow(
			expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
		)
		expect(() => renderTypstPage({ ...options, scale: 9 })).toThrow(
			expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
		)
		expect(compileTypst({ ...input, revision: 11 }).ok).toBe(true)
		expect(() => renderTypstPage(options)).toThrow(
			expect.objectContaining({ code: 'STALE_REVISION' }),
		)
		await writeFile(join(root, 'main.typ'), '#missing()')
		expect(compileTypst({ ...input, revision: 12 }).ok).toBe(false)
		expect(renderTypstPage({ ...options, revision: 11 }).width).toBe(200)
	} finally {
		compile.mockRestore()
	}
})

/** Decode the binding's RGBA8 PNG so crop tests compare pixels, not encoder bytes. */
function pngPixels(bytes: Uint8Array): Buffer {
	const data = Buffer.from(bytes)
	expect(data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	expect(data[24]).toBe(8)
	expect(data[25]).toBe(6)
	const width = data.readUInt32BE(16),
		height = data.readUInt32BE(20)
	const chunks: Buffer[] = []
	for (let offset = 8; offset < data.length;) {
		const length = data.readUInt32BE(offset)
		if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT')
			chunks.push(data.subarray(offset + 8, offset + 8 + length))
		offset += length + 12
	}
	const raw = inflateSync(Buffer.concat(chunks)),
		pixels = Buffer.alloc(width * height * 4),
		stride = width * 4
	for (let row = 0; row < height; row++) {
		const filter = raw[row * (stride + 1)]!
		for (let x = 0; x < stride; x++) {
			const index = row * stride + x,
				a = x >= 4 ? pixels[index - 4]! : 0,
				b = row ? pixels[index - stride]! : 0,
				c = row && x >= 4 ? pixels[index - stride - 4]! : 0
			const p = a + b - c,
				pa = Math.abs(p - a),
				pb = Math.abs(p - b),
				pc = Math.abs(p - c)
			const predictor = [
				0,
				a,
				b,
				Math.floor((a + b) / 2),
				pa <= pb && pa <= pc ? a : pb <= pc ? b : c,
			][filter]
			if (predictor === undefined) throw new Error('Unsupported PNG filter')
			pixels[index] = (raw[row * (stride + 1) + x + 1]! + predictor) & 255
		}
	}
	return pixels
}

it('bounds the complete raster even for a small crop, then allows a lower scale', async () => {
	const { renderTypstPage } = await import('../src/worker.ts')
	const root = await workspace('#set page(width: 10000pt, height: 20pt, margin: 0pt)\nWide')
	expect(compileTypst({ revision: 1, root, entry: 'main.typ', maxOutputBytes: 8_000_000 }).ok).toBe(
		true,
	)
	const input = {
		kind: 'render' as const,
		revision: 1,
		page: 1,
		scale: 1,
		region: { x: 0, y: 0, width: 10, height: 10 },
		maxOutputBytes: 8_000_000,
	}
	expect(() => renderTypstPage(input)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
	expect(renderTypstPage({ ...input, scale: 0.5 })).toMatchObject({ width: 5, height: 5 })
})
