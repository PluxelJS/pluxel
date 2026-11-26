import { createHash } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from 'fs-fixture'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { databaseSourceVitePlugin } from '../../src/vite/database-source.ts'

const declaration = `import { defineDatabase as defineSchema } from '@pluxel/services/pg'
export const database = defineSchema({ schema: {} }, /* trailing comma */)
`
const sql = 'CREATE TABLE items (id text PRIMARY KEY);'

async function sourceFixture(
	files: Record<string, string>,
	dialect: 'postgresql' | 'sqlite' = 'postgresql',
) {
	return createFixture({
		'package.json': JSON.stringify({ name: 'database-source-fixture', type: 'module' }),
		'node_modules/@pluxel/services/package.json': JSON.stringify({
			name: '@pluxel/services',
			type: 'module',
			exports: { './pg': './pg.js', './sqlite': './pg.js' },
		}),
		'node_modules/@pluxel/services/pg.js': 'export const defineDatabase = (input) => input',
		'drizzle/0000_initial.sql': sql,
		'drizzle/pluxel-migrations.json': JSON.stringify({ lineage: 'source-fixture' }),
		'drizzle/meta/_journal.json': JSON.stringify({
			dialect,
			entries: [{ idx: 0, tag: '0000_initial', when: 1, breakpoints: true }],
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

it.each(['postgresql', 'sqlite'] as const)(
	'updates the %s artifact when its migration SQL changes',
	async (dialect) => {
		const source = dialect === 'sqlite' ? declaration.replace('/pg', '/sqlite') : declaration
		await using fixture = await sourceFixture({ 'src/database.ts': source }, dialect)
		const server = await sourceServer(fixture.path)
		try {
			const transformedSource = async () => {
				const transformed = await server.transformRequest('/src/database.ts')
				return transformed?.code
			}
			expect(await transformedSource()).toContain(createHash('sha256').update(sql).digest('hex'))
			const changed = sql + '\n'
			await writeFile(join(fixture.path, 'drizzle/0000_initial.sql'), changed)
			await expect
				.poll(transformedSource)
				.toContain(createHash('sha256').update(changed).digest('hex'))
		} finally {
			await server.close()
		}
	},
)

it('uses a published plugin with an embedded migration artifact as delivered', async () => {
	await using fixture = await sourceFixture({
		'dist/index.mjs': `import { defineDatabase as defineSchema } from '@pluxel/services/pg'
export const database = defineSchema({ schema: {} }, { evolution: 'migrations', lineage: 'published', migrations: [{ sql: ['SELECT 1;'], hash: '${createHash('sha256').update('SELECT 1;').digest('hex')}', folderMillis: 1, bps: true }] })`,
	})
	const server = await sourceServer(fixture.path)
	try {
		const built = await server.transformRequest('/dist/index.mjs')
		expect(built?.code).toContain('published')
	} finally {
		await server.close()
	}
})

it('rejects a managed definition whose journal has no migrations', async () => {
	await using fixture = await sourceFixture({
		'src/database.ts': declaration,
		'drizzle/meta/_journal.json': JSON.stringify({ dialect: 'postgresql', entries: [] }),
	})
	await rm(join(fixture.path, 'drizzle/0000_initial.sql'))
	const server = await sourceServer(fixture.path)
	try {
		await expect(server.transformRequest('/src/database.ts')).rejects.toThrow(
			'at least one migration',
		)
	} finally {
		await server.close()
	}
})

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
