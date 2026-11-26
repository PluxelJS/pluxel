import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHost } from '@pluxel/host'
import { createPluginSemanticsPlugin, pluginArtifactBuildPlugin } from '@pluxel/rolldown/plugins'
import { d1 } from '@pluxel/services/sqlite/d1'
import { migrateD1 } from '@pluxel/services/sqlite/d1/migrate'
import { libsql } from '@pluxel/services/sqlite/libsql'
import { createTestHost } from '@pluxel/test'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { Miniflare } from 'miniflare'
import { build, type Plugin } from 'vite'
import { expect, expectTypeOf, it } from 'vitest'

const first = [
	'CREATE TABLE items (id text PRIMARY KEY)',
	'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
	'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)',
	'INSERT INTO parent VALUES (1)',
	'INSERT INTO child VALUES (1, 1)',
].join('--> statement-breakpoint')
const second =
	"INSERT INTO items SELECT 'seed' WHERE ';PRAGMA foreign_keys=OFF;' IS NOT NULL /* PRAGMA foreign_keys=off */"
const tags = ['0000_items', '0001_seed', '0002_rebuild']

function journal(count: number) {
	return JSON.stringify({
		dialect: 'sqlite',
		entries: tags
			.slice(0, count)
			.map((tag, idx) => ({ idx, tag, when: idx + 1, breakpoints: true })),
	})
}

it('rejects configuring both libSQL and D1 for the Sqlite service', async () => {
	await expect(
		createHost({ services: [libsql({ directory: '.' }), d1({})] }),
	).rejects.toMatchObject({
		code: 'DUPLICATE_SERVICE',
	})
})

it('uses the same SQLite plugin with a local file and a deployed D1 binding across Worker events', async () => {
	const source = (file: string) =>
		readFile(new URL(`./fixtures/sqlite-d1/${file}`, import.meta.url), 'utf8')
	await using fixture = await createDiskFixture(
		{
			'package.json': JSON.stringify({ name: 'd1-notes', type: 'module', exports: './notes.ts' }),
			'notes.ts': await source('notes.ts'),
			'worker.ts': await source('worker.ts'),
			'schema.ts': await source('schema.ts'),
			'drizzle/0000_items.sql': first,
			'drizzle/0001_seed.sql': second,
			'drizzle/pluxel-migrations.json': JSON.stringify({ lineage: 'notes' }),
			'drizzle/meta/_journal.json': journal(2),
		},
		{ tempDir: import.meta.dirname },
	)
	const root = fixture.path
	const servicesRoot = resolve(import.meta.dirname, '..')
	await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
	await symlink(servicesRoot, join(root, 'node_modules/@pluxel/services'), 'dir')
	const { Notes } = (await import(
		join(root, 'notes.ts')
	)) as typeof import('./fixtures/sqlite-d1/notes')
	await using localHost = await createTestHost({
		services: [libsql({ directory: join(root, 'data') })],
	})
	const instance = await localHost.start(Notes.nodeAddress())
	expect(await instance.supportsInteractiveTransactions()).toBe(true)
	const expected = [{ id: 'a' }, { id: 'b' }, { id: 'seed' }]
	const added = await instance.visit('/write')
	expectTypeOf(added).toEqualTypeOf<{ id: string }[]>()
	expect(added).toEqual(expected)
	await expect(instance.visit('/fail')).rejects.toThrow(/UNIQUE constraint/i)
	expect(await instance.visit('/read')).toEqual(expected)
	const result = await build({
		configFile: false,
		root,
		logLevel: 'silent',
		oxc: { decorator: { legacy: true } },
		resolve: { conditions: ['@pluxel/source', 'workerd', 'worker', 'browser', 'production'] },
		plugins: [
			createPluginSemanticsPlugin({ root }).plugin as unknown as Plugin,
			pluginArtifactBuildPlugin({ root }) as unknown as Plugin,
		],
		build: {
			write: false,
			target: 'esnext',
			lib: { entry: join(root, 'worker.ts'), formats: ['es'], fileName: () => 'worker.mjs' },
			rolldownOptions: {
				external: ['cloudflare:workers'],
				output: { codeSplitting: false },
			},
		},
	})
	const output = Array.isArray(result) ? result[0] : result
	if (!output || !('output' in output)) throw new Error('Expected the D1 Worker build output')
	const worker = output.output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry)
	if (worker?.type !== 'chunk') throw new Error('Expected a D1 Worker entry')
	expect(
		[...worker.imports, ...worker.dynamicImports].filter(
			(id) => id !== 'cloudflare:workers' && id !== worker.fileName,
		),
	).toEqual([])
	const runtime = new Miniflare({
		host: '127.0.0.1',
		port: 0,
		workers: [
			{
				config: {
					name: 'd1-notes',
					compatibilityDate: '2026-11-03',
					compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
					manifest: {
						mainModule: 'worker.mjs',
						modules: { 'worker.mjs': { type: 'esm', contents: worker.code } },
					},
					env: {
						DB: { type: 'd1', id: 'notes' },
						OTHER: { type: 'd1', id: 'other' },
						RESET: { type: 'd1', id: 'reset' },
					},
				},
			},
		],
	})
	try {
		await runtime.ready
		const request = (path: string) => runtime.dispatchFetch(`http://worker.test/${path}`)
		const binding = await runtime.getD1Database('DB')
		const reference = await request('owner')
		const owner = await reference.text()
		const migrationsFolder = join(root, 'drizzle')
		const options = { owner, migrationsFolder }
		const journalFile = join(migrationsFolder, 'meta/_journal.json')
		const nextFile = join(migrationsFolder, '0001_seed.sql')
		const manifest = join(migrationsFolder, 'pluxel-migrations.json')
		const initialFailure = await request('read')
		expect(initialFailure.status).toBe(409)
		expect(await initialFailure.text()).toContain('migrateD1')
		const metadata = await binding
			.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '__pluxel*'")
			.first()
		expect(metadata).toBeNull()
		await expect(migrateD1(binding, { ...options, owner: 'not a plugin address' })).rejects.toThrow(
			/plugin|reference|export/i,
		)

		await rm(nextFile)
		await writeFile(journalFile, journal(1))
		await migrateD1(binding, options)
		const pending = await request('read')
		expect(await pending.text()).toContain('1 of 2 migrations')

		await writeFile(journalFile, journal(2))
		await writeFile(nextFile, [second, second].join('--> statement-breakpoint'))
		await expect(migrateD1(binding, options)).rejects.toThrow(/UNIQUE constraint/i)
		expect(await binding.prepare('SELECT count(*) FROM items').first('count(*)')).toBe(0)
		expect(
			await binding.prepare('SELECT count(*) FROM __drizzle_migrations').first('count(*)'),
		).toBe(1)
		await writeFile(nextFile, second)
		// Replacing the release directory while D1 checks the journal must not change
		// the SQL passed to Drizzle after those network round trips.
		const replacedRelease = new Proxy(binding, {
			get(target, property) {
				if (property === 'batch')
					return async (...args: Parameters<typeof target.batch>) => {
						await writeFile(nextFile, "INSERT INTO items VALUES ('unexpected')")
						return target.batch(...args)
					}
				const value = Reflect.get(target, property)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
		await migrateD1(replacedRelease, options)
		await writeFile(nextFile, second)
		await migrateD1(binding, options)
		const linkedSql = join(root, 'outside-release.sql')
		await rename(nextFile, linkedSql)
		await symlink(linkedSql, nextFile)
		await expect(migrateD1(binding, options)).rejects.toThrow('must cover each SQL file')
		await rm(nextFile)
		await rename(linkedSql, nextFile)
		const transactions = await request('transactions')
		expect(await transactions.json()).toBe(false)
		const write = await request('write')
		expect(await write.json()).toEqual(expected)
		const failedBatch = await request('fail')
		expect(failedBatch.status).toBe(409)
		expect(await failedBatch.text()).toMatch(/UNIQUE constraint/i)
		const read = await request('read')
		expect(await read.json()).toEqual(expected)
		const fork = await request('fork')
		expect(fork.status).toBe(409)
		expect(await fork.text()).toContain('binding belongs')

		const rebuild = join(migrationsFolder, '0002_rebuild.sql')
		await writeFile(journalFile, journal(3))
		await writeFile(
			rebuild,
			[
				"SELECT ';'; /* quoted fake PRAGMA foreign_keys=OFF */ PRAGMA main.[foreign_keys]('off');",
				'CREATE TABLE new_parent (id INTEGER PRIMARY KEY)',
				'INSERT INTO new_parent SELECT * FROM parent',
				'DROP TABLE parent',
				'ALTER TABLE new_parent RENAME TO parent',
				'PRAGMA foreign_keys=ON',
			].join('--> statement-breakpoint'),
		)
		await expect(migrateD1(binding, options)).rejects.toThrow(
			'0002_rebuild.sql disables foreign keys',
		)
		expect(await binding.prepare('SELECT id, parent_id FROM child').first()).toEqual({
			id: 1,
			parent_id: 1,
		})
		expect(
			await binding.prepare('SELECT count(*) FROM __drizzle_migrations').first('count(*)'),
		).toBe(2)
		await rm(rebuild)
		await writeFile(journalFile, journal(2))
		await expect(migrateD1(binding, { ...options, owner: owner + '#fork=other' })).rejects.toThrow(
			'binding belongs',
		)
		await writeFile(nextFile, second + ' ')
		await expect(migrateD1(binding, options)).rejects.toThrow('immutable prefix')
		await writeFile(manifest, JSON.stringify({ lineage: 'rebased' }))
		await expect(migrateD1(binding, options)).rejects.toThrow('binding belongs')

		const other = await runtime.getD1Database('OTHER')
		await other.prepare('CREATE TABLE d1_migrations (name TEXT)').run()
		await expect(migrateD1(other, options)).rejects.toThrow('Wrangler')
		expect(
			await other.prepare("SELECT name FROM sqlite_schema WHERE name = 'items'").first(),
		).toBeNull()

		const reset = await runtime.getD1Database('RESET')
		await rm(nextFile)
		await writeFile(
			journalFile,
			JSON.stringify({
				dialect: 'sqlite',
				entries: [{ idx: 0, tag: tags[0], when: 0, breakpoints: true }],
			}),
		)
		const baseline = { ...options, evolution: 'reset-on-schema-change' as const }
		await migrateD1(reset, baseline)
		await reset.prepare("INSERT INTO items VALUES ('preserved')").run()
		await writeFile(join(migrationsFolder, '0000_items.sql'), first + '\n')
		await migrateD1(reset, baseline)
		expect(await reset.prepare('SELECT id FROM items').first('id')).toBe('preserved')
	} finally {
		await runtime.dispose()
	}
}, 60_000)
