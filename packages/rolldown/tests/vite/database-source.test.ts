import { createHash } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from 'fs-fixture'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { databaseSourceVitePlugin } from '../../src/vite/database-source.ts'

const declaration = `import { defineDatabase } from '@pluxel/services/database'
export const database = defineDatabase({ schema: {} })
`
const sql = 'CREATE TABLE items (id text PRIMARY KEY);'

async function sourceFixture(files: Record<string, string>) {
	return createFixture({
		'package.json': JSON.stringify({ name: 'database-source-fixture', type: 'module' }),
		'node_modules/@pluxel/services/package.json': JSON.stringify({
			name: '@pluxel/services',
			type: 'module',
			exports: { './database': './database.js' },
		}),
		'node_modules/@pluxel/services/database.js': 'export const defineDatabase = (input) => input',
		'drizzle/0000_initial.sql': sql,
		'drizzle/pluxel-migrations.json': JSON.stringify({
			version: 2,
			lineage: 'source-fixture',
			migrations: [
				{
					id: '0000_initial',
					file: '0000_initial.sql',
					checksum: createHash('sha256').update(sql).digest('hex'),
				},
			],
		}),
		...files,
	})
}

async function sourceServer(root: string) {
	return createServer({
		root,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true },
		plugins: [databaseSourceVitePlugin({ root })],
	})
}

it('rejects concurrent declarations from two modules in one package', async () => {
	await using fixture = await sourceFixture({ 'src/a.ts': declaration, 'src/b.ts': declaration })
	const server = await sourceServer(fixture.path)
	try {
		const results = await Promise.allSettled([
			server.transformRequest('/src/a.ts'),
			server.transformRequest('/src/b.ts'),
		])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
			message: expect.stringContaining('declares databases in both'),
		})
	} finally {
		await server.close()
	}
})

it.each(['clear', 'delete'] as const)(
	'accepts a moved declaration after the previous module is %s',
	async (change) => {
		await using fixture = await sourceFixture({ 'src/a.ts': declaration })
		const server = await sourceServer(fixture.path)
		try {
			const previous = await server.transformRequest('/src/a.ts')
			expect(previous?.code).toContain('source-fixture')
			if (change === 'delete') {
				await rename(join(fixture.path, 'src/a.ts'), join(fixture.path, 'src/b.ts'))
			} else {
				await writeFile(join(fixture.path, 'src/a.ts'), 'export {}')
				await writeFile(join(fixture.path, 'src/b.ts'), declaration)
			}
			const moved = await server.transformRequest('/src/b.ts')
			expect(moved?.code).toContain('source-fixture')
		} finally {
			await server.close()
		}
	},
)

it('keeps competing replacements exclusive after the previous declaration was removed', async () => {
	await using fixture = await sourceFixture({ 'src/a.ts': declaration })
	const server = await sourceServer(fixture.path)
	try {
		await server.transformRequest('/src/a.ts')
		await writeFile(join(fixture.path, 'src/a.ts'), 'export {}')
		await Promise.all([
			writeFile(join(fixture.path, 'src/b.ts'), declaration),
			writeFile(join(fixture.path, 'src/c.ts'), declaration),
		])
		const results = await Promise.allSettled([
			server.transformRequest('/src/b.ts'),
			server.transformRequest('/src/c.ts'),
		])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
			message: expect.stringContaining('declares databases in both'),
		})
	} finally {
		await server.close()
	}
})
