import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator'
import { dirname, join, relative, resolve } from 'pathe'
import { validatePostgresMigrationSql } from './postgres-sql.ts'

export const databaseManifestFile = 'pluxel-migrations.json'

export type DatabaseDialect = 'postgresql' | 'sqlite'
export type DatabaseEvolutionArtifact = 'migrations' | 'reset-on-schema-change'

export type DatabaseBuildArtifact = Readonly<{
	evolution: DatabaseEvolutionArtifact
	lineage: string
	migrations: readonly MigrationMeta[]
}>

type JournalEntry = Readonly<{ idx: number; tag: string; when: number; breakpoints: boolean }>
export type DatabaseHistory = Awaited<ReturnType<typeof readDatabaseHistory>>

export async function readDatabaseHistory(
	migrationsDir: string,
	dialect: DatabaseDialect,
	watch?: (path: string) => void,
) {
	const manifestPath = join(migrationsDir, databaseManifestFile)
	watch?.(manifestPath)
	const lineage = await readDatabaseLineage(manifestPath, false)
	const history = await readDrizzleHistory(migrationsDir, dialect, watch)
	if ((await readDatabaseLineage(manifestPath, false)) !== lineage)
		throw new Error(
			`[database] lineage changed while reading ${migrationsDir}; retry with the completed migration files`,
		)
	return { dialect, lineage, ...history }
}

export async function checkPublishedHistory(
	directory: string,
	current: DatabaseHistory,
): Promise<void> {
	const lineage = await readDatabaseLineage(join(directory, databaseManifestFile), true)
	if (lineage !== current.lineage) return
	const previous = await readDrizzleHistory(directory, current.dialect)
	for (const [index, migration] of previous.migrations.entries()) {
		const next = current.migrations[index]
		if (
			previous.tags[index] !== current.tags[index] ||
			!next ||
			migration.folderMillis !== next.folderMillis ||
			migration.bps !== next.bps ||
			migration.hash !== next.hash
		) {
			throw new Error(
				`[database] published migration history was rewritten at ${previous.tags[index]} in lineage "${lineage}"`,
			)
		}
	}
}

export async function readDatabaseLineage(
	manifestPath: string,
	published: boolean,
): Promise<string> {
	const manifest = parseJson(manifestPath, await readFile(manifestPath, 'utf8')) as {
		lineage?: unknown
	} | null
	if (!validDatabaseLineage(manifest?.lineage)) {
		throw new Error(`[database] invalid database lineage in ${manifestPath}`)
	}
	if (!published && Object.keys(manifest).length !== 1) {
		throw new Error(
			`[database] ${manifestPath} must contain only "lineage"; convert the old migration manifest before building`,
		)
	}
	return manifest.lineage
}

async function readDrizzleHistory(
	migrationsDir: string,
	dialect: DatabaseDialect,
	watch?: (path: string) => void,
) {
	const journalPath = join(migrationsDir, 'meta', '_journal.json')
	watch?.(journalPath)
	const source = await readFile(journalPath, 'utf8')
	const journal = parseJson(journalPath, source) as {
		dialect?: string
		entries?: JournalEntry[]
	} | null
	if (journal?.dialect !== dialect || !Array.isArray(journal.entries)) {
		throw new Error(
			`[database] expected a ${dialect} migration journal in ${journalPath}, found ${String(journal?.dialect)}`,
		)
	}
	let lastWhen = -1
	const tags = journal.entries.map((entry, index) => {
		if (
			!entry ||
			entry.idx !== index ||
			!validMigrationTag(entry.tag) ||
			typeof entry.breakpoints !== 'boolean' ||
			!Number.isSafeInteger(entry.when) ||
			entry.when <= lastWhen
		) {
			throw new Error(
				`[database] invalid entry ${index} in ${journalPath}; expected its index, a file tag, breakpoints and a strictly increasing timestamp`,
			)
		}
		lastWhen = entry.when
		watch?.(join(migrationsDir, `${entry.tag}.sql`))
		return entry.tag
	})
	const files = await listMigrationSqlFiles(migrationsDir)
	const expected = tags.map((tag) => `${tag}.sql`).sort()
	if (expected.length !== files.length || expected.some((file, index) => file !== files[index])) {
		throw new Error(
			`[database] ${journalPath} must cover each SQL file in ${migrationsDir} exactly once`,
		)
	}

	const migrations = readMigrationFiles({ migrationsFolder: migrationsDir })
	// The native reader opens the journal again. Never pair its SQL with tags from a different generation.
	if ((await readFile(journalPath, 'utf8')) !== source) {
		throw new Error(
			`[database] journal changed while reading ${journalPath}; retry with the completed migration files`,
		)
	}
	for (const [index, migration] of migrations.entries()) {
		const file = join(migrationsDir, `${tags[index]}.sql`)
		if (!migration.sql.some((statement) => statement.trim())) {
			throw new Error(`[database] empty migration ${file}`)
		}
		if (dialect === 'postgresql') {
			for (const statement of migration.sql) await validatePostgresMigrationSql(statement, file)
		}
	}
	return { journalSource: source, tags, migrations }
}

/** Materialize the verified native inputs in a fresh directory without reopening the source. */
export async function writeDatabaseHistory(
	directory: string,
	history: DatabaseHistory,
): Promise<void> {
	await mkdir(join(directory, 'meta'), { recursive: true })
	for (const [index, tag] of history.tags.entries()) {
		if (!validMigrationTag(tag)) throw new Error('[database] invalid migration file tag')
		await writeFile(
			join(directory, `${tag}.sql`),
			history.migrations[index]!.sql.join('--> statement-breakpoint'),
			{ flag: 'wx' },
		)
	}
	await writeFile(join(directory, 'meta/_journal.json'), history.journalSource, { flag: 'wx' })
}

export function requireDatabaseMigrations(history: DatabaseHistory) {
	if (history.migrations.length === 0)
		throw new Error('[database] a database definition must carry at least one migration')
	return history
}

function validMigrationTag(tag: unknown): tag is string {
	return typeof tag === 'string' && tag.length > 0 && !/[\\/\0]/u.test(tag)
}

export type DatabaseInputs = Readonly<{
	history: DatabaseHistory
	snapshots: readonly { file: string; contents: Buffer }[]
}>

/** A checked-in Kit history and the schema snapshots needed for further generation. */
export async function readDatabaseInputs(
	directory: string,
	dialect: DatabaseDialect,
	watch?: (file: string) => void,
	includeSnapshots = true,
): Promise<DatabaseInputs> {
	const history = await readDatabaseHistory(directory, dialect, watch)
	const snapshots = []
	if (includeSnapshots) {
		const meta = join(directory, 'meta')
		for (const file of await readdir(meta)) {
			if (!file.endsWith('_snapshot.json')) continue
			const path = join(meta, file)
			watch?.(path)
			snapshots.push({ file, contents: await readFile(path) })
		}
		if ((await readFile(join(meta, '_journal.json'), 'utf8')) !== history.journalSource)
			throw new Error(
				`[database] journal changed while reading snapshots in ${meta}; retry with the completed migration files`,
			)
	}
	return { history, snapshots }
}

export async function writeDatabaseInputs(
	directory: string,
	{ history, snapshots }: DatabaseInputs,
) {
	await writeDatabaseHistory(directory, history)
	for (const { file, contents } of snapshots)
		await writeFile(join(directory, 'meta', file), contents, { flag: 'wx' })
	await writeDatabaseLineage(directory, history.lineage)
}

function parseJson(file: string, source: string): unknown {
	try {
		return JSON.parse(source)
	} catch (error) {
		throw new Error(`[database] invalid JSON in ${file}`, { cause: error })
	}
}

export async function writeDatabaseLineage(directory: string, lineage: string): Promise<void> {
	await writeFile(
		join(directory, databaseManifestFile),
		JSON.stringify({ lineage }, null, 2) + '\n',
		{ flag: 'wx' },
	)
}

export async function listMigrationSqlFiles(migrationsDir: string): Promise<string[]> {
	if (!existsSync(migrationsDir)) return []
	const entries = await readdir(migrationsDir, { withFileTypes: true })
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
		.map((entry) => entry.name)
		.sort()
}

export function findDatabasePackageRoot(sourceFile: string, boundary: string): string | undefined {
	const limit = resolve(boundary)
	const source = resolve(sourceFile)
	const enforceBoundary = !relative(limit, source).startsWith('..')
	let current = dirname(source)
	for (;;) {
		if (existsSync(join(current, 'package.json'))) return current
		if (enforceBoundary && current === limit) return undefined
		const parent = dirname(current)
		if (parent === current || (enforceBoundary && relative(limit, parent).startsWith('..'))) {
			return undefined
		}
		current = parent
	}
}

export function validDatabaseLineage(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}
