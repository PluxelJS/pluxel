import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import compileTypst from '../src/worker.ts'

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
		const result = compileTypst({ root, entry: 'main.typ', maxOutputBytes: 8_000_000 })
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('Expected compilation success')
		expect(result.vector.byteLength).toBeGreaterThan(0)
		expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
		expect(structuredClone(result).ok).toBe(true)
		// No retained compiler state may hide changes or removed dynamic files.
		await rm(join(root, 'inputs/b.json'))
		const failed = compileTypst({ root, entry: 'main.typ', maxOutputBytes: 8_000_000 })
		expect(failed.ok).toBe(false)
		expect(failed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
	})

	it('preserves source locations in cloneable compile diagnostics', async () => {
		const root = await workspace('#let x = missing\n#x')
		const result = compileTypst({ root, entry: 'main.typ', maxOutputBytes: 8_000_000 })
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
		expect(compileTypst({ root, entry: 'main.typ', maxOutputBytes: 1 })).toMatchObject({
			ok: false,
			code: 'LIMIT_EXCEEDED',
		})
	})
})
