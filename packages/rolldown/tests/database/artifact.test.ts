import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { loadDatabaseArtifact } from '../../src/database/artifact.ts'
import { generateResetDatabaseArtifact } from '../../src/database/reset-artifact.ts'

describe('database migration artifact', () => {
	it('loads an immutable lineage and checked migration history', async () => {
		const migration = 'CREATE TABLE items (id text PRIMARY KEY)'
		const checksum = createHash('sha256').update(migration).digest('hex')
		await using fixture = await createFixture({
			'drizzle/0000_initial.sql': migration,
			'drizzle/pluxel-migrations.json': JSON.stringify({
				version: 2,
				lineage: 'release-2026',
				migrations: [{ id: '0000_initial', file: '0000_initial.sql', checksum }],
			}),
		})

		await expect(loadDatabaseArtifact(`${fixture.path}/drizzle`)).resolves.toEqual({
			evolution: 'migrations',
			lineage: 'release-2026',
			migrations: [{ id: '0000_initial', checksum, sql: migration }],
		})
	})

	it('rejects manifests without an explicit lineage', async () => {
		await using fixture = await createFixture({
			'drizzle/pluxel-migrations.json': JSON.stringify({ version: 1, migrations: [] }),
		})
		await expect(loadDatabaseArtifact(`${fixture.path}/drizzle`)).rejects.toThrow(
			'invalid migration manifest',
		)
	})

	it('generates a stable reset lineage directly from the current schema', async () => {
		const root = await mkdtemp(join(process.cwd(), '.database-reset-test-'))
		const schema = join(root, 'src/database.ts')
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
		await writeFile(
			schema,
			[
				"import { pgTable, text } from 'drizzle-orm/pg-core'",
				"export const items = pgTable('items', { id: text('id').primaryKey() })",
			].join('\n'),
			'utf8',
		)

		try {
			const first = await generateResetDatabaseArtifact({ root, schema })
			const second = await generateResetDatabaseArtifact({ root, schema })
			try {
				expect(first.artifact.evolution).toBe('reset-on-schema-change')
				expect(first.artifact.lineage).toMatch(/^reset-[a-f0-9]{40}$/)
				expect(second.artifact.lineage).toBe(first.artifact.lineage)
				expect(second.artifact.migrations).toEqual(first.artifact.migrations)
				expect(existsSync(join(first.migrationsDir, 'meta'))).toBe(false)
				const manifest = JSON.parse(
					await readFile(join(first.migrationsDir, 'pluxel-migrations.json'), 'utf8'),
				) as { evolution: string; lineage: string }
				expect(manifest).toMatchObject({
					evolution: 'reset-on-schema-change',
					lineage: first.artifact.lineage,
				})
			} finally {
				await first.cleanup()
				await second.cleanup()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('changes the reset lineage when the physical schema changes', async () => {
		const root = await mkdtemp(join(process.cwd(), '.database-reset-change-test-'))
		const schema = join(root, 'src/database.ts')
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
		try {
			await writeFile(
				schema,
				[
					"import { pgTable, text } from 'drizzle-orm/pg-core'",
					"export const items = pgTable('items', { id: text('id').primaryKey() })",
				].join('\n'),
				'utf8',
			)
			const first = await generateResetDatabaseArtifact({ root, schema })
			await writeFile(
				schema,
				[
					"import { pgTable, text } from 'drizzle-orm/pg-core'",
					"export const items = pgTable('items', { id: text('id').primaryKey(), value: text('value') })",
				].join('\n'),
				'utf8',
			)
			const second = await generateResetDatabaseArtifact({ root, schema })
			try {
				expect(second.artifact.lineage).not.toBe(first.artifact.lineage)
			} finally {
				await first.cleanup()
				await second.cleanup()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
