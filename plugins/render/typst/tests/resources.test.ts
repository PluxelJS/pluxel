import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { TypstFiles } from '../src/contracts.js'
import { prepareInputs, prepareTemplate, type ResourceLimits } from '../src/resources.js'

const limits: ResourceLimits = {
	maxBytes: 1_000_000,
	maxFiles: 100,
	maxJsonDepth: 32,
	maxJsonValues: 10_000,
}
const temporary: string[] = []
async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'typst-resources-test-'))
	temporary.push(path)
	return path
}
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('resource preparation', () => {
	it('accepts typed readonly data, multiple JSON files and independently snapshots disk and bytes', async () => {
		interface Report {
			readonly title: string
			readonly items: readonly number[]
		}
		const report: Report = { title: 'report', items: [1, 2] }
		const source = await directory()
		const target = await directory()
		const disk = join(source, 'data.cbor')
		await writeFile(disk, new Uint8Array([0x82, 1, 2]))
		const bytes = new Uint8Array([1, 2, 3])
		const files = {
			'/inputs/report.json': { kind: 'json', value: report },
			'/inputs/items.json': { kind: 'json', value: report.items },
			'/inputs/text.txt': { kind: 'text', text: '𠮷'.repeat(20_000) },
			'/inputs/data.cbor': { kind: 'file', path: pathToFileURL(disk) },
			'/inputs/image.bin': { kind: 'bytes', bytes },
		} satisfies TypstFiles
		await prepareInputs(files, target, limits)
		await writeFile(disk, 'changed')
		bytes.fill(0)
		expect(JSON.parse(await readFile(join(target, 'inputs/report.json'), 'utf8'))).toEqual(report)
		expect(JSON.parse(await readFile(join(target, 'inputs/items.json'), 'utf8'))).toEqual([1, 2])
		expect(await readFile(join(target, 'inputs/text.txt'), 'utf8')).toBe('𠮷'.repeat(20_000))
		expect([...(await readFile(join(target, 'inputs/data.cbor')))]).toEqual([0x82, 1, 2])
		expect([...(await readFile(join(target, 'inputs/image.bin')))]).toEqual([1, 2, 3])
	})

	it('preserves escaped strings across chunk boundaries and repeated noncyclic objects', async () => {
		const target = await directory()
		const shared = { text: `${'a'.repeat(16_382)}𠮷\n"\\\ud800` }
		const value = [shared, shared]
		await prepareInputs({ '/inputs/data.json': { kind: 'json', value } }, target, limits)
		expect(JSON.parse(await readFile(join(target, 'inputs/data.json'), 'utf8'))).toEqual(value)
	})

	it.each([
		undefined,
		NaN,
		Infinity,
		new Date(),
		{ field: undefined },
		[undefined],
		Array(1),
		{ field: () => 0 },
	])('rejects non-JSON values without silent conversion: %s', async (value) => {
		await expect(
			prepareInputs({ '/inputs/data.json': { kind: 'json', value } }, await directory(), limits),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
	})

	it('rejects cycles and accessors without executing user getters', async () => {
		const value: Record<string, unknown> = {}
		value.self = value
		await expect(
			prepareInputs({ '/inputs/data.json': { kind: 'json', value } }, await directory(), limits),
		).rejects.toThrow('cyclic')
		const getter = {
			get data(): unknown {
				throw new Error('getter ran')
			},
		}
		await expect(
			prepareInputs(
				{ '/inputs/data.json': { kind: 'json', value: getter } },
				await directory(),
				limits,
			),
		).rejects.toThrow('accessors')
	})

	it.each([
		'/main.typ',
		'/inputs/../main.typ',
		'/inputs//data',
		'/inputs/./data',
		'/inputs/a\\b',
		'/inputs/',
	])('rejects noncanonical or reserved paths: %s', async (path) => {
		await expect(
			prepareInputs({ [path]: { kind: 'text', text: '' } }, await directory(), limits),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
	})

	it('rejects file/directory conflicts regardless of insertion order', async () => {
		for (const paths of [
			['/inputs/a', '/inputs/a/b'],
			['/inputs/a/b', '/inputs/a'],
		]) {
			const files = Object.fromEntries(
				paths.map((path) => [path, { kind: 'text', text: '' }]),
			) as TypstFiles
			await expect(prepareInputs(files, await directory(), limits)).rejects.toThrow('conflict')
		}
	})

	it('enforces bytes, count, depth and JSON traversal budgets', async () => {
		const cases: [TypstFiles, Partial<ResourceLimits>][] = [
			[{ '/inputs/data': { kind: 'text', text: '𠮷' } }, { maxBytes: 3 }],
			[{ '/inputs/data': { kind: 'bytes', bytes: new Uint8Array(4) } }, { maxBytes: 3 }],
			[{ '/inputs/data': { kind: 'json', value: { a: 1 } } }, { maxJsonValues: 1 }],
			[{ '/inputs/data': { kind: 'json', value: { a: {} } } }, { maxJsonDepth: 0 }],
			[
				{ '/inputs/a': { kind: 'text', text: '' }, '/inputs/b': { kind: 'text', text: '' } },
				{ maxFiles: 1 },
			],
		]
		for (const [files, overrides] of cases)
			await expect(
				prepareInputs(files, await directory(), { ...limits, ...overrides }),
			).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
	})

	it('snapshots the template and internal symlinks independently of the original', async () => {
		const source = await directory()
		const target = join(await directory(), 'snapshot')
		await writeFile(join(source, 'main.typ'), '#include "alias.typ"')
		await writeFile(join(source, 'part.typ'), 'original')
		await symlink('part.typ', join(source, 'alias.typ'))
		expect(
			await prepareTemplate({ root: source, entry: 'main.typ' }, target, limits),
		).toMatchObject({ entry: 'main.typ' })
		await writeFile(join(source, 'part.typ'), 'changed')
		expect(await readFile(join(target, 'alias.typ'), 'utf8')).toBe('original')
	})

	it('rejects escaping symlinks and reserved static inputs', async () => {
		const source = await directory()
		const external = await directory()
		await writeFile(join(source, 'main.typ'), 'test')
		await symlink(external, join(source, 'external'))
		await expect(
			prepareTemplate(
				{ root: source, entry: 'main.typ' },
				join(await directory(), 'snapshot'),
				limits,
			),
		).rejects.toThrow('escapes')
		await rm(join(source, 'external'))
		await mkdir(join(source, 'inputs'))
		await expect(
			prepareTemplate(
				{ root: source, entry: 'main.typ' },
				join(await directory(), 'snapshot'),
				limits,
			),
		).rejects.toThrow('reserved')
	})

	it('observes cancellation during preparation', async () => {
		const controller = new AbortController()
		controller.abort(new Error('cancelled'))
		await expect(
			prepareInputs(
				{ '/inputs/data': { kind: 'text', text: '' } },
				await directory(),
				limits,
				controller.signal,
			),
		).rejects.toThrow('cancelled')
	})
})
