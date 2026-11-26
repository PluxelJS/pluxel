import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { generateDatabaseMigrations } from '@pluxel/rolldown/database'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { createFixture } from 'fs-fixture'
import { expect, it, vi } from 'vitest'

it('runs generated enum, sequence and foreign key migrations in each owner schema', async () => {
	await using fixture = await createFixture({ 'package.json': '{"type":"module"}' })
	const modules = join(fixture.path, 'node_modules')
	await mkdir(join(modules, '@pluxel'), { recursive: true })
	await symlink(
		fileURLToPath(new URL('../node_modules/drizzle-orm', import.meta.url)),
		join(modules, 'drizzle-orm'),
	)
	await symlink(fileURLToPath(new URL('../', import.meta.url)), join(modules, '@pluxel/services'))
	const pg = await PGlite.create()
	const db = drizzle(pg)
	const out = join(fixture.path, 'drizzle')
	const generate = async (values?: string[]) => {
		const source = [
			"import { pgEnum, pgSequence, pgTable, integer, text } from 'drizzle-orm/pg-core'",
			"import { defineDatabase } from '@pluxel/services/pg'",
			values && `export const state = pgEnum('state', ${JSON.stringify(values)})`,
			values && "export const counter = pgSequence('counter')",
			"export const parents = pgTable('parents', { id: integer().primaryKey() })",
			`export const jobs = pgTable('jobs', { id: integer().primaryKey(), parent: integer().references(() => parents.id), title: text().default('public.example'), ${values ? "state: state().notNull().default('open')" : ''} })`,
			`export const definition = defineDatabase({ schema: { parents, jobs, ${values ? 'state, counter' : ''} } })`,
		]
			.filter(Boolean)
			.join('\n')
		await writeFile(join(fixture.path, 'database.ts'), source)
		await generateDatabaseMigrations({ root: fixture.path, schema: 'database.ts', name: 'jobs' })
		for (const owner of ['one', 'two']) {
			await pg.exec(`SET search_path TO ${owner}, pg_catalog`)
			await migrate(db, { migrationsFolder: out, migrationsSchema: owner })
		}
	}
	try {
		// Kit evaluates the fixture in its own Node process. Exercise this checkout's source export.
		vi.stubEnv(
			'NODE_OPTIONS',
			[process.env.NODE_OPTIONS, '--conditions=@pluxel/source'].filter(Boolean).join(' '),
		)
		await pg.exec('CREATE SCHEMA one; CREATE SCHEMA two;')
		await generate(['open', 'closed'])
		const first = await readFile(join(out, '0000_jobs.sql'))
		await pg.exec('INSERT INTO one.parents VALUES (3)')
		const inserted = await pg.query(
			'INSERT INTO one.jobs (id, parent) VALUES (1, 3) RETURNING title, state',
		)
		expect(inserted.rows).toEqual([{ title: 'public.example', state: 'open' }])
		await expect(pg.exec('INSERT INTO two.jobs (id, parent) VALUES (1, 3)')).rejects.toThrow(
			/foreign key/i,
		)
		const publicObjects = await pg.query(
			"SELECT to_regtype('public.state') AS state, to_regclass('public.counter') AS counter",
		)
		expect(publicObjects.rows).toEqual([{ state: null, counter: null }])
		await generate(['open', 'closed', 'archived'])
		await pg.exec("UPDATE one.jobs SET state = 'archived'")
		await generate(['open', 'archived'])
		const jobs = await pg.query('SELECT state FROM one.jobs')
		expect(jobs.rows).toEqual([{ state: 'archived' }])
		await generate()
		const removed = await pg.query(
			"SELECT to_regtype('one.state') AS state, to_regclass('two.counter') AS counter",
		)
		expect(removed.rows).toEqual([{ state: null, counter: null }])
		expect(await readFile(join(out, '0000_jobs.sql'))).toEqual(first)
	} finally {
		vi.unstubAllEnvs()
		await pg.close()
	}
}, 30_000)
