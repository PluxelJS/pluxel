import { describe, expect, it } from 'vitest'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createDiskFixture, createFixture } from '@pluxel/test/fixtures'

describe('@pluxel/test/fixtures', () => {
	for (const create of [createFixture, createDiskFixture]) {
		it(`${create.name} separates callback fs from Promise fsp and rejects missing callbacks`, async () => {
			await using fixture = await create({ 'value.txt': 'initial' })
			const path = fixture.getPath('value.txt')
			await new Promise<void>((resolve, reject) => {
				fixture.fs.writeFile(path, 'callback', (error) => (error ? reject(error) : resolve()))
			})
			await expect(fixture.fsp.readFile(path, 'utf8')).resolves.toBe('callback')
			await fixture.fsp.writeFile(path, 'promise')
			await new Promise<void>((resolve, reject) => {
				fixture.fs.readFile(path, 'utf8', (error, data) => {
					if (error) return reject(error)
					expect(data).toBe('promise')
					resolve()
				})
			})
			// Exercise JavaScript consumers that do not receive TypeScript diagnostics.
			expect(() => Reflect.apply(fixture.fs.writeFile, fixture.fs, [path, 'lost'])).toThrow(
				TypeError,
			)
			expect(() => Reflect.apply(fixture.fs.readFile, fixture.fs, [path, 'utf8'])).toThrow(
				TypeError,
			)
			await expect(fixture.fsp.readFile(path, 'utf8')).resolves.toBe('promise')
			await expect(fixture.fsp.readFile(fixture.getPath('missing'), 'utf8')).rejects.toMatchObject({
				code: 'ENOENT',
			})
		})
	}

	it('rejects unsupported filesystem and temporary-directory overrides', async () => {
		await expect(
			Reflect.apply(createFixture, undefined, [{}, { tempDir: '/tmp/ignored' }]),
		).rejects.toThrow('tempDir')
		await expect(Reflect.apply(createFixture, undefined, [{}, { fs: {} }])).rejects.toThrow('fs')
		await expect(Reflect.apply(createDiskFixture, undefined, [{}, { fs: {} }])).rejects.toThrow(
			'fs',
		)
		await using parent = await createDiskFixture({})
		const fixture = await createDiskFixture({ 'child.txt': 'child' }, { tempDir: parent.path })
		const childPath = fixture.getPath('child.txt')
		expect(childPath.startsWith(parent.path)).toBe(true)
		await expect(fixture.fsp.readFile(childPath, 'utf8')).resolves.toBe('child')
		await fixture[Symbol.asyncDispose]()
		expect(existsSync(childPath)).toBe(false)
	})

	it('creates and idempotently disposes disk fixtures', async () => {
		let filePath = ''
		{
			await using fixture = await createDiskFixture({
				'plain.txt': 'disk-backed\n',
			})

			filePath = fixture.getPath('plain.txt')
			expect(fixture.fs.existsSync(filePath)).toBe(true)
			expect(filePath.startsWith(fixture.root)).toBe(true)
			await fixture.writeFile('written.txt', 'written through fixture\n')
			await expect(fixture.readFile('written.txt', 'utf8')).resolves.toBe(
				'written through fixture\n',
			)
			await expect(fixture.exists('written.txt')).resolves.toBe(true)

			await fixture[Symbol.asyncDispose]()
			expect(existsSync(filePath)).toBe(false)
		}

		expect(existsSync(filePath)).toBe(false)
	})

	it('creates isolated in-memory fixtures by default', async () => {
		let filePath = ''
		{
			await using fixture = await createFixture({
				'src/index.ts': 'export const answer = 42\n',
			})

			filePath = fixture.getPath('src/index.ts')
			expect(filePath.startsWith(fixture.root)).toBe(true)
			expect(fixture.tmpdir()).toBe(fixture.root)
			expect(fixture.fs.readFileSync(filePath, 'utf8')).toBe('export const answer = 42\n')
		}

		expect(existsSync(filePath)).toBe(false)
	})

	it('supports cpSync and createWriteStream inside the VFS root', async () => {
		await using fixture = await createFixture({
			'src/a.txt': 'alpha\n',
		})

		const source = fixture.getPath('src/a.txt')
		const copied = fixture.getPath('dist/a.txt')
		const streamed = fixture.getPath('dist/streamed.txt')

		fixture.fs.cpSync(source, copied)
		expect(fixture.fs.readFileSync(copied, 'utf8')).toBe('alpha\n')

		fixture.fs.mkdirSync(dirname(streamed), { recursive: true })
		await new Promise<void>((resolve, reject) => {
			const stream = fixture.fs.createWriteStream(streamed)
			stream.on('finish', () => resolve())
			stream.on('error', reject)
			stream.end('streamed\n')
		})

		expect(fixture.fs.readFileSync(streamed, 'utf8')).toBe('streamed\n')
	})

	it('matches node writeFile semantics for missing parent directories', async () => {
		await using fixture = await createFixture({})

		await expect(
			fixture.fsp.writeFile(fixture.getPath('missing/file.txt'), 'nope\n', 'utf8'),
		).rejects.toMatchObject({
			code: 'ENOENT',
		})
		expect(fixture.fs.existsSync(fixture.getPath('missing'))).toBe(false)
	})

	it('matches node createWriteStream semantics for missing parent directories', async () => {
		await using fixture = await createFixture({})

		await expect(
			new Promise<void>((resolve, reject) => {
				const stream = fixture.fs.createWriteStream(fixture.getPath('missing/file.txt'))
				stream.on('finish', () => resolve())
				stream.on('error', reject)
				stream.end('nope\n')
			}),
		).rejects.toMatchObject({
			code: 'ENOENT',
		})
		expect(fixture.fs.existsSync(fixture.getPath('missing'))).toBe(false)
	})
})
