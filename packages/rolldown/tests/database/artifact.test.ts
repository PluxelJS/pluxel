import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import {
	findDatabasePackageRoot,
	readDatabaseHistory,
	writeDatabaseHistory,
} from '../../src/database/artifact.ts'
import {
	checkDatabaseMigrations,
	generateDatabaseMigrations,
	rebaseDatabaseMigrations,
} from '../../src/database/index.ts'
import { generateResetDatabaseHistory } from '../../src/database/reset-artifact.ts'
import { normalizeGeneratedOwnerReferences } from '../../src/database/drizzle-kit.ts'

describe('database migration artifact', () => {
	it('keeps generated same-owner foreign keys in the isolated owner schema', async () => {
		await using fixture = await createFixture({
			'drizzle/meta/0000_snapshot.json': JSON.stringify({
				tables: {
					'public.products': { name: 'products', schema: '' },
					'public.explicit': { name: 'explicit', schema: 'public' },
				},
			}),
			'drizzle/0000_initial.sql': [
				'ALTER TABLE "orders" ADD CONSTRAINT "local_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");',
				'--> statement-breakpoint',
				'ALTER TABLE "orders" ADD CONSTRAINT "external_fk" FOREIGN KEY ("external_id") REFERENCES "public"."external"("id");',
				'--> statement-breakpoint',
				'ALTER TABLE "orders" ADD CONSTRAINT "explicit_fk" FOREIGN KEY ("explicit_id") REFERENCES "public"."explicit"("id");',
			].join('\n'),
		})
		await normalizeGeneratedOwnerReferences(join(fixture.path, 'drizzle'), new Set())
		const sql = await readFile(join(fixture.path, 'drizzle/0000_initial.sql'), 'utf8')
		expect(sql).toContain('REFERENCES "products"("id")')
		expect(sql).toContain('REFERENCES "public"."external"("id")')
		expect(sql).toContain('REFERENCES "public"."explicit"("id")')
	})

	it('rejects an ambiguous public and owner foreign key target', async () => {
		await using fixture = await createFixture({
			'drizzle/meta/0000_snapshot.json': JSON.stringify({
				tables: {
					'public.owner_products': { name: 'products', schema: '' },
					'public.products': { name: 'products', schema: 'public' },
				},
			}),
			'drizzle/0000_initial.sql':
				'ALTER TABLE "orders" ADD CONSTRAINT "fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");',
		})
		await expect(
			normalizeGeneratedOwnerReferences(join(fixture.path, 'drizzle'), new Set()),
		).rejects.toThrow('ambiguous generated foreign key target')
	})

	it('locates a linked plugin package outside the application root', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-linked-package-test-'))
		const application = join(root, 'application')
		const linkedPlugin = join(root, 'linked-plugin')
		try {
			await Promise.all([
				mkdir(application, { recursive: true }),
				mkdir(join(linkedPlugin, 'src'), { recursive: true }),
			])
			await writeFile(join(linkedPlugin, 'package.json'), JSON.stringify({ type: 'module' }))

			expect(findDatabasePackageRoot(join(linkedPlugin, 'src/database.ts'), application)).toBe(
				linkedPlugin,
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('uses the native journal for order, raw bytes and Drizzle statement boundaries', async () => {
		const statements = ['CREATE TABLE items (id text PRIMARY KEY);\r\n', '\nSELECT 1;\n']
		const migration = statements.join('--> statement-breakpoint')
		await using fixture = await createFixture({
			'drizzle/alpha.sql': migration,
			'drizzle/zeta.sql': 'SELECT 0;',
			'drizzle/pluxel-migrations.json': JSON.stringify({ lineage: 'release-2026' }),
			'drizzle/meta/_journal.json': JSON.stringify({
				dialect: 'postgresql',
				entries: [
					{ idx: 0, tag: 'zeta', when: 2, breakpoints: true },
					{ idx: 1, tag: 'alpha', when: 3, breakpoints: true },
				],
			}),
		})
		const history = await readDatabaseHistory(join(fixture.path, 'drizzle'), 'postgresql')
		expect(history.lineage).toBe('release-2026')
		expect(history.tags).toEqual(['zeta', 'alpha'])
		expect(history.migrations[1]).toEqual({
			folderMillis: 3,
			hash: createHash('sha256').update(migration).digest('hex'),
			bps: true,
			sql: statements,
		})
		const projection = join(fixture.path, 'execution')
		await writeDatabaseHistory(projection, history)
		expect(await readFile(join(projection, 'alpha.sql'), 'utf8')).toBe(migration)
		expect(await readFile(join(projection, 'meta/_journal.json'), 'utf8')).toBe(
			history.journalSource,
		)
		const directory = join(fixture.path, 'drizzle')
		await expect(
			readDatabaseHistory(directory, 'postgresql', (file) => {
				if (file.endsWith('_journal.json'))
					writeFileSync(
						join(directory, 'pluxel-migrations.json'),
						JSON.stringify({ lineage: 'next' }),
					)
			}),
		).rejects.toThrow('lineage changed while reading')
	})

	it('requires a lineage, complete SQL coverage and unique increasing timestamps', async () => {
		const entries = [
			{ idx: 0, tag: 'first', when: 2, breakpoints: true },
			{ idx: 1, tag: 'next', when: 2, breakpoints: true },
		]
		await using fixture = await createFixture({
			'drizzle/pluxel-migrations.json': '{}',
			'drizzle/meta/_journal.json': JSON.stringify({ dialect: 'postgresql', entries }),
			'drizzle/first.sql': 'SELECT 1;',
		})
		const dir = join(fixture.path, 'drizzle')
		await expect(readDatabaseHistory(dir, 'postgresql')).rejects.toThrow('invalid database lineage')
		await writeFile(join(dir, 'pluxel-migrations.json'), JSON.stringify({ lineage: 'main' }))
		await expect(readDatabaseHistory(dir, 'postgresql')).rejects.toThrow(
			'strictly increasing timestamp',
		)
		entries[1]!.when = 3
		await writeFile(
			join(dir, 'meta/_journal.json'),
			JSON.stringify({ dialect: 'postgresql', entries }),
		)
		await expect(readDatabaseHistory(dir, 'postgresql')).rejects.toThrow('cover each SQL file')
	})

	it.each(['postgresql', 'sqlite'] as const)(
		'generates a stable reset lineage from a %s schema',
		async (dialect) => {
			const table = dialect === 'sqlite' ? 'sqliteTable' : 'pgTable'
			const core = dialect === 'sqlite' ? 'sqlite-core' : 'pg-core'
			const root = await mkdtemp(join(tmpdir(), 'pluxel-database-reset-test-'))
			const schema = join(root, 'src/database.ts')
			await mkdir(join(root, 'src'), { recursive: true })
			await mkdir(join(root, 'node_modules'), { recursive: true })
			await symlink(
				fileURLToPath(new URL('../../../services/node_modules/drizzle-orm/', import.meta.url)),
				join(root, 'node_modules/drizzle-orm'),
				'dir',
			)
			await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
			await writeFile(
				schema,
				[
					`import { ${table}, text } from 'drizzle-orm/${core}'`,
					`export const items = ${table}('items', { id: text('id').primaryKey() })`,
				].join('\n'),
				'utf8',
			)

			try {
				const first = await generateResetDatabaseHistory({ root, schema, dialect })
				const second = await generateResetDatabaseHistory({ root, schema, dialect })
				expect(first.lineage).toMatch(/^reset-[a-f0-9]{40}$/)
				expect(first.migrations[0]?.folderMillis).toBe(0)
				expect(second).toEqual(first)
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		},
		15_000,
	)

	it('changes the reset lineage when the physical schema changes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-reset-change-test-'))
		const schema = join(root, 'src/database.ts')
		await mkdir(join(root, 'src'), { recursive: true })
		await mkdir(join(root, 'node_modules'), { recursive: true })
		await symlink(
			fileURLToPath(new URL('../../../services/node_modules/drizzle-orm/', import.meta.url)),
			join(root, 'node_modules/drizzle-orm'),
			'dir',
		)
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
			const first = await generateResetDatabaseHistory({ root, schema, dialect: 'postgresql' })
			await writeFile(
				schema,
				[
					"import { pgTable, text } from 'drizzle-orm/pg-core'",
					"export const items = pgTable('items', { id: text('id').primaryKey(), value: text('value') })",
				].join('\n'),
				'utf8',
			)
			const second = await generateResetDatabaseHistory({ root, schema, dialect: 'postgresql' })
			expect(second.lineage).not.toBe(first.lineage)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 15_000)

	it('rejects a checked-in migration manifest for a reset database', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-reset-history-test-'))
		const schema = join(root, 'src/database.ts')
		try {
			await mkdir(join(root, 'src'), { recursive: true })
			await mkdir(join(root, 'drizzle'), { recursive: true })
			await writeFile(schema, 'export {}\n', 'utf8')
			await writeFile(join(root, 'drizzle/pluxel-migrations.json'), '{}\n', 'utf8')

			await expect(
				generateResetDatabaseHistory({ root, schema, dialect: 'postgresql' }),
			).rejects.toThrow('reset-on-schema-change does not use a checked-in migration manifest')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('keeps reset-on-schema-change out of the checked-in migration workflow', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-reset-tools-test-'))
		try {
			await mkdir(join(root, 'src'), { recursive: true })
			await writeFile(
				join(root, 'src/database.ts'),
				[
					'import { defineDatabase } from "@pluxel/services/pg"',
					'export const database = defineDatabase({ schema: {}, evolution: "reset-on-schema-change" })',
				].join('\n'),
				'utf8',
			)

			const options = { root, schema: 'src/database.ts' }
			await expect(generateDatabaseMigrations(options)).rejects.toThrow(
				'reset-on-schema-change has no checked-in migration history',
			)
			await expect(checkDatabaseMigrations(options)).rejects.toThrow(
				'reset-on-schema-change has no checked-in migration history',
			)
			await expect(rebaseDatabaseMigrations({ ...options, lineage: 'fresh' })).rejects.toThrow(
				'reset-on-schema-change has no checked-in migration history',
			)
			expect(existsSync(join(root, 'drizzle'))).toBe(false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
