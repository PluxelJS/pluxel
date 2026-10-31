import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
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

type MigrationManifest = {
	lineage: string
	migrations: { file: string; checksum: string }[]
}

it('generates, checks, and rebases managed SQL through the public CLI and toolchain', async () => {
	const schema = (extra = '') => `import { defineDatabase } from '@pluxel/services/database'
import { pgTable, text } from 'drizzle-orm/pg-core'
export const items = pgTable('items', { id: text('id').primaryKey()${extra} })
export const database = defineDatabase({ schema: { items } })
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
		'src/database.ts': schema(),
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
	const manifest = async () => JSON.parse(await readFile(manifestPath, 'utf8')) as MigrationManifest

	await run('generate', '--name', 'initial')
	const initial = await manifest()
	expect(initial.lineage).toBe('main')
	expect(initial.migrations).toHaveLength(1)
	await run('check')

	await writeFile(resolve(fixture.path, 'src/database.ts'), schema(", value: text('value')"))
	await expect(run('check')).rejects.toThrow('schema source has unapplied drift')
	expect(await manifest()).toEqual(initial)
	await run('generate', '--name', 'add_value')
	const evolved = await manifest()
	expect(evolved.lineage).toBe('main')
	expect(evolved.migrations).toHaveLength(2)
	expect(evolved.migrations[0]).toEqual(initial.migrations[0])

	await run('rebase', '--lineage', 'release-2', '--name', 'baseline')
	const rebased = await manifest()
	expect(rebased.lineage).toBe('release-2')
	expect(rebased.migrations).toHaveLength(1)
	const migration = rebased.migrations[0]!
	const migrationPath = resolve(fixture.path, 'drizzle', migration.file)
	const sql = await readFile(migrationPath, 'utf8')
	expect(migration.checksum).toBe(createHash('sha256').update(sql.trim()).digest('hex'))
	await run('check')

	await writeFile(migrationPath, `${sql}\nALTER TABLE items ADD COLUMN tampered text;\n`)
	await expect(run('check')).rejects.toThrow('migration history was rewritten')
}, 90_000)
