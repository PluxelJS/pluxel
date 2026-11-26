import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rename, rmdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const testRequire = createRequire(require.resolve('@pluxel/test/package.json'))
const servicesRequire = createRequire(testRequire.resolve('@pluxel/services/package.json'))
const bin = fileURLToPath(new URL('../bin/pluxel.mjs', import.meta.url))

it.each(['postgresql', 'sqlite'] as const)(
	'generates, checks, and rebases %s through the public CLI',
	async (dialect) => {
		const sqlite = dialect === 'sqlite'
		const table = sqlite ? 'sqliteTable' : 'pgTable'
		const schema = (
			extra = '',
		) => `import { defineDatabase as defineSchema } from '@pluxel/services/${sqlite ? 'sqlite' : 'pg'}'
import { ${table}, text } from 'drizzle-orm/${sqlite ? 'sqlite' : 'pg'}-core'
export const items = ${table}('items', { id: text('id').primaryKey()${extra} })
export const database = defineSchema({ schema: { items } })
`
		await using fixture = await createDiskFixture({
			'package.json': JSON.stringify({
				name: 'pluxel-cli-database-fixture',
				type: 'module',
				devDependencies: { '@pluxel/cli': '*' },
			}),
			'node_modules/@pluxel/cli/package.json': JSON.stringify({
				name: '@pluxel/cli',
				type: 'module',
				bin: { pluxel: 'bin/pluxel.mjs' },
			}),
			'node_modules/@pluxel/cli/bin/pluxel.mjs': await readFile(bin, 'utf8'),
			'drizzle/README.md': 'Application migration notes',
			'src/database.ts': schema(),
			'src/example.ts': `export const example = "import { defineDatabase } from '@pluxel/services/pg'; defineDatabase({ schema: {} })"`,
		})
		const packages = resolve(fixture.path, 'node_modules/@pluxel')
		await mkdir(packages, { recursive: true })
		await Promise.all([
			symlink(fileURLToPath(new URL('../dist', import.meta.url)), resolve(packages, 'cli/dist')),
			symlink(
				dirname(require.resolve('@pluxel/rolldown/package.json')),
				resolve(packages, 'rolldown'),
			),
			symlink(
				dirname(testRequire.resolve('@pluxel/services/package.json')),
				resolve(packages, 'services'),
			),
			symlink(
				dirname(servicesRequire.resolve('drizzle-orm')),
				resolve(fixture.path, 'node_modules/drizzle-orm'),
			),
		])
		const env = { ...process.env }
		delete env.NODE_OPTIONS
		delete env.NODE_PATH
		const run = (...args: string[]) =>
			exec(process.execPath, [resolve(packages, 'cli/bin/pluxel.mjs'), 'database', ...args], {
				cwd: fixture.path,
				env,
				timeout: 30_000,
			})
		const manifestPath = resolve(fixture.path, 'drizzle/pluxel-migrations.json')
		const journalPath = resolve(fixture.path, 'drizzle/meta/_journal.json')
		const manifest = async () =>
			JSON.parse(await readFile(manifestPath, 'utf8')) as { lineage: string }
		const history = async () => {
			const journal = JSON.parse(
				await readFile(resolve(fixture.path, 'drizzle/meta/_journal.json'), 'utf8'),
			) as {
				entries: { tag: string; when: number }[]
			}
			return journal.entries
		}

		const sourceFile = resolve(fixture.path, 'src/database.ts')
		await writeFile(sourceFile, schema() + "\nthrow new Error('schema evaluation failed')")
		await expect(run('generate')).rejects.toThrow('schema evaluation failed')
		await expect(readFile(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
		await writeFile(sourceFile, schema())
		await run('generate', '--name', 'initial')
		expect(await manifest()).toEqual({ lineage: 'main' })
		await expect(readFile(resolve(fixture.path, 'drizzle/README.md'), 'utf8')).resolves.toBe(
			'Application migration notes',
		)
		const initial = await history()
		expect(initial).toHaveLength(1)
		await cp(resolve(fixture.path, 'drizzle'), resolve(fixture.path, 'release'), {
			recursive: true,
		})
		const wrongTables = sqlite
			? schema().replaceAll('sqliteTable', 'pgTable').replace('sqlite-core', 'pg-core')
			: schema().replaceAll('pgTable', 'sqliteTable').replace('pg-core', 'sqlite-core')
		await writeFile(sourceFile, wrongTables)
		await expect(run('check')).rejects.toThrow(`table "items" does not use the ${dialect} dialect`)
		await writeFile(sourceFile, schema())
		await run('check', '--against', 'release')

		await writeFile(resolve(fixture.path, 'src/database.ts'), schema(", value: text('value')"))
		await expect(run('check')).rejects.toThrow('schema source has unapplied drift')

		// A migration from a machine with a later clock cannot be followed by Kit's timestamp.
		const baselineJournal = await readFile(journalPath, 'utf8')
		const ahead = JSON.parse(baselineJournal)
		ahead.entries[0].when = Date.now() + 86_400_000
		const futureJournal = JSON.stringify(ahead)
		await writeFile(journalPath, futureJournal)
		const meta = resolve(fixture.path, 'drizzle/meta')
		const snapshots = await readdir(meta)
		await expect(run('generate', '--name', 'add_value')).rejects.toThrow(
			'strictly increasing timestamp',
		)
		expect(await readFile(journalPath, 'utf8')).toBe(futureJournal)
		expect(await readdir(meta)).toEqual(snapshots)
		await writeFile(journalPath, baselineJournal)

		const writers = await Promise.allSettled([
			run('generate', '--name', 'add_value'),
			run('generate', '--name', 'concurrent_value'),
		])
		expect(writers.some((writer) => writer.status === 'fulfilled')).toBe(true)
		const evolved = await history()
		expect(evolved).toHaveLength(2)
		expect(evolved[0]).toEqual(initial[0])
		await run('check', '--against', 'release')

		const migrationPath = resolve(fixture.path, 'drizzle', initial[0]!.tag + '.sql')
		const sql = await readFile(migrationPath, 'utf8')
		await writeFile(migrationPath, sql + '\n')
		await expect(run('check', '--against', 'release')).rejects.toThrow(
			'published migration history was rewritten',
		)
		await writeFile(migrationPath, sql)

		const original = await readFile(journalPath, 'utf8')
		expect(JSON.parse(original).dialect).toBe(dialect)
		await writeFile(
			journalPath,
			original.replace(`"${dialect}"`, sqlite ? '"postgresql"' : '"sqlite"'),
		)
		await expect(run('generate')).rejects.toThrow(`expected a ${dialect} migration journal`)
		await writeFile(journalPath, original)
		const renamed = resolve(fixture.path, 'drizzle/0000_renamed.sql')
		await rename(migrationPath, renamed)
		await writeFile(journalPath, original.replace(initial[0]!.tag, '0000_renamed'))
		await expect(run('check', '--against', 'release')).rejects.toThrow(
			'published migration history was rewritten',
		)
		await rename(renamed, migrationPath)
		await writeFile(journalPath, original)

		// A caller can use a migration directory with project files and notes in meta.
		await writeFile(resolve(fixture.path, 'drizzle/meta/_notes.md'), 'Keep this with the sources')
		const conflict = resolve(fixture.path, 'drizzle/0000_baseline.sql')
		await mkdir(conflict)
		await expect(run('rebase', '--lineage', 'release-2', '--name', 'baseline')).rejects.toThrow(
			'EEXIST',
		)
		expect(await history()).toEqual(evolved)
		expect(await readFile(migrationPath, 'utf8')).toBe(sql)
		await rmdir(conflict)
		await run('rebase', '--lineage', 'release-2', '--name', 'baseline')
		expect(await manifest()).toEqual({ lineage: 'release-2' })
		expect(await history()).toHaveLength(1)
		expect(await readFile(resolve(fixture.path, 'drizzle/README.md'), 'utf8')).toBe(
			'Application migration notes',
		)
		expect(await readFile(resolve(fixture.path, 'drizzle/meta/_notes.md'), 'utf8')).toBe(
			'Keep this with the sources',
		)
		await expect(readFile(migrationPath)).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(
			readFile(resolve(fixture.path, 'drizzle/meta/0001_snapshot.json')),
		).rejects.toMatchObject({ code: 'ENOENT' })
		// Older published reset baselines have a lineage and SQL, but no native journal.
		await mkdir(resolve(fixture.path, 'previous-reset'))
		await writeFile(
			resolve(fixture.path, 'previous-reset/pluxel-migrations.json'),
			JSON.stringify({
				version: 2,
				evolution: 'reset-on-schema-change',
				lineage: 'reset-previous',
				migrations: [],
			}),
		)
		await run('check', '--against', 'previous-reset')

		// An explicitly selected package root may itself contain the Drizzle history.
		for (const file of ['0000_baseline.sql', 'meta', 'pluxel-migrations.json']) {
			await rename(resolve(fixture.path, 'drizzle', file), resolve(fixture.path, file))
		}
		await run('rebase', '--out', '.', '--lineage', 'root-history', '--name', 'root')
		expect(await readFile(sourceFile, 'utf8')).toBe(schema(", value: text('value')"))
		await run('check', '--out', '.')
	},
	90_000,
)
