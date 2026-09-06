import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'pathe'
import {
	databaseManifestFile,
	listMigrationSqlFiles,
	loadDatabaseArtifact,
	migrationChecksum,
	type DatabaseBuildArtifact,
	type DatabaseEvolutionArtifact,
	type DatabaseMigrationManifest,
} from './artifact.ts'
import { runDrizzleKit } from './drizzle-kit.ts'

export type GeneratedResetDatabaseArtifact = Readonly<{
	migrationsDir: string
	artifact: DatabaseBuildArtifact
	cleanup: () => Promise<void>
}>

export async function generateResetDatabaseArtifact(options: {
	root: string
	schema: string
}): Promise<GeneratedResetDatabaseArtifact> {
	const root = resolve(options.root)
	const schema = resolve(root, options.schema)
	if (!existsSync(schema)) throw new Error(`[database] schema module not found: ${schema}`)
	const checkedManifest = join(root, 'drizzle', databaseManifestFile)
	if (existsSync(checkedManifest)) {
		throw new Error(
			'[database] reset-on-schema-change does not use a checked-in migration manifest; remove drizzle/pluxel-migrations.json or change evolution to "migrations"',
		)
	}
	const stagingParent = join(root, '.pluxel')
	await mkdir(stagingParent, { recursive: true })
	const stagingRoot = await mkdtemp(join(stagingParent, 'database-reset-'))
	const stagingOut = join(stagingRoot, 'drizzle')
	try {
		await runDrizzleKit(
			'generate',
			{ root, schema, out: stagingOut },
			['--name', 'baseline'],
			'capture',
		)
		const lineage = await resetLineageFromSnapshot(stagingOut)
		const migrations = await readGeneratedMigrations(stagingOut)
		if (migrations.length === 0) {
			throw new Error('[database] reset-on-schema-change database must define at least one table')
		}
		await rm(join(stagingOut, 'meta'), { recursive: true, force: true })
		await writeManifest(stagingOut, {
			version: 2,
			evolution: 'reset-on-schema-change',
			lineage,
			migrations,
		})
		return {
			migrationsDir: stagingOut,
			artifact: await loadDatabaseArtifact(stagingOut),
			cleanup: () => rm(stagingRoot, { recursive: true, force: true }),
		}
	} catch (error) {
		await rm(stagingRoot, { recursive: true, force: true })
		throw error
	}
}

async function readGeneratedMigrations(
	out: string,
): Promise<DatabaseMigrationManifest['migrations']> {
	const migrations: Array<{ id: string; file: string; checksum: string }> = []
	for (const file of await listMigrationSqlFiles(out)) {
		const contents = await readFile(join(out, file), 'utf8')
		const sql = contents.trim()
		if (!sql) throw new Error(`[database] generated migration ${file} is empty`)
		migrations.push({ id: basename(file, '.sql'), file, checksum: migrationChecksum(sql) })
	}
	return migrations
}

async function resetLineageFromSnapshot(out: string): Promise<string> {
	const meta = join(out, 'meta')
	const metaFiles = await readdir(meta)
	const snapshots = metaFiles.filter((file) => file.endsWith('_snapshot.json')).sort()
	if (snapshots.length !== 1) {
		throw new Error(
			`[database] reset baseline must generate exactly one schema snapshot, received ${snapshots.length}`,
		)
	}
	const snapshot = JSON.parse(await readFile(join(meta, snapshots[0]!), 'utf8')) as Record<
		string,
		unknown
	>
	const { id: _id, prevId: _prevId, ...schema } = snapshot
	const hash = createHash('sha256')
	hash.update('pluxel-database-reset-v1')
	hash.update(stableJson(schema))
	return `reset-${hash.digest('hex').slice(0, 40)}`
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

async function writeManifest(
	out: string,
	manifest: DatabaseMigrationManifest & Readonly<{ evolution: DatabaseEvolutionArtifact }>,
): Promise<void> {
	await writeFile(join(out, databaseManifestFile), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}
