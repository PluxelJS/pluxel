import { expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { finished } from 'node:stream/promises'
import { createDiskFixture, createFixture } from '@pluxel/test/fixtures'

it.each([
	{ mode: 'memory', create: createFixture },
	{ mode: 'disk', create: createDiskFixture },
])(
	'$mode fixtures expose callback writes and Promise reads over the same files',
	async ({ create }) => {
		await using fixture = await create({ 'value.txt': 'initial' })
		const path = fixture.getPath('value.txt')
		await new Promise<void>((resolve, reject) => {
			fixture.fs.writeFile(path, 'callback', (error) => (error ? reject(error) : resolve()))
		})
		expect(() => Reflect.apply(fixture.fs.writeFile, fixture.fs, [path, 'lost'])).toThrow(TypeError)
		await expect(fixture.fsp.readFile(path, 'utf8')).resolves.toBe('callback')
	},
)

it('isolates in-memory fixtures and matches native missing-parent behavior', async () => {
	await using first = await createFixture({ 'value.txt': 'first' })
	await using second = await createFixture({ 'value.txt': 'second' })
	const path = first.getPath('missing/file.txt')
	await expect(first.fsp.writeFile(path, 'text')).rejects.toMatchObject({ code: 'ENOENT' })
	const failed = first.fs.createWriteStream(path)
	const stopped = finished(failed)
	failed.end('text')
	await expect(stopped).rejects.toMatchObject({ code: 'ENOENT' })
	expect(first.fs.existsSync(first.getPath('missing'))).toBe(false)

	const copied = first.getPath('copy.txt')
	first.fs.cpSync(first.getPath('value.txt'), copied)
	await expect(first.fsp.readFile(copied, 'utf8')).resolves.toBe('first')
	const stream = first.fs.createWriteStream(copied)
	const written = finished(stream)
	stream.end('changed')
	await written
	await expect(first.fsp.readFile(copied, 'utf8')).resolves.toBe('changed')
	await expect(second.readFile('value.txt', 'utf8')).resolves.toBe('second')
	expect(existsSync(copied)).toBe(false)
})

it('creates readable native files under the requested temporary directory and disposes them idempotently', async () => {
	await using parent = await createDiskFixture({ 'parent.txt': 'keep' })
	const child = await createDiskFixture({ 'child.txt': 'disk' }, { tempDir: parent.path })
	const path = child.getPath('child.txt')
	expect(path.startsWith(parent.path)).toBe(true)
	expect(readFileSync(path, 'utf8')).toBe('disk')
	await child[Symbol.asyncDispose]()
	await child[Symbol.asyncDispose]()
	expect(existsSync(path)).toBe(false)
	expect(existsSync(parent.getPath('parent.txt'))).toBe(true)
})

it('rejects native storage options a fixture cannot own', async () => {
	await expect(
		Reflect.apply(createFixture, undefined, [{}, { tempDir: '/tmp/ignored' }]),
	).rejects.toThrow('tempDir')
	for (const create of [createFixture, createDiskFixture]) {
		await expect(Reflect.apply(create, undefined, [{}, { fs: {} }])).rejects.toThrow('fs')
	}
})
