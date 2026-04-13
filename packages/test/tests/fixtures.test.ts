import { describe, expect, it } from 'vitest'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createDiskFixture, createFixture } from '@pluxel/test/fixtures'

describe('@pluxel/test/fixtures', () => {
	it('creates fixtures on disk when requested explicitly', async () => {
		let filePath = ''
		{
			await using fixture = await createDiskFixture({
				'plain.txt': 'disk-backed\n',
			})

			filePath = fixture.getPath('plain.txt')
			expect(fixture.fs.existsSync(filePath)).toBe(true)
			expect(filePath.startsWith(fixture.root)).toBe(true)
		}

		expect(realPathExists(filePath)).toBe(false)
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

		expect(realPathExists(filePath)).toBe(false)
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

function realPathExists(path: string) {
	return existsSync(path)
}
