import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'pathe'
import {
	databaseManifestFile,
	readDatabaseHistory,
	writeDatabaseLineage,
	type DatabaseDialect,
} from './artifact.ts'
import { runDrizzleKit } from './drizzle-kit.ts'

export async function generateResetDatabaseHistory(options: {
	root: string
	schema: string
	dialect: DatabaseDialect
}) {
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
			{ root, schema, dialect: options.dialect, out: stagingOut },
			['--name', 'baseline'],
			'capture',
		)
		const lineage = await prepareResetJournal(stagingOut)
		await writeDatabaseLineage(stagingOut, lineage)
		return await readDatabaseHistory(stagingOut, options.dialect)
	} finally {
		await rm(stagingRoot, { recursive: true, force: true })
	}
}

async function prepareResetJournal(out: string): Promise<string> {
	const meta = join(out, 'meta')
	const metaFiles = await readdir(meta)
	const snapshots = metaFiles.filter((file) => file.endsWith('_snapshot.json')).sort()
	if (snapshots.length !== 1) {
		throw new Error(
			`[database] reset baseline must generate exactly one schema snapshot, received ${snapshots.length}`,
		)
	}
	const snapshotPath = join(meta, snapshots[0]!)
	const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<string, unknown>
	const { id: _id, prevId: _prevId, ...schema } = snapshot
	const hash = createHash('sha256')
	hash.update('pluxel-database-reset-v1')
	hash.update(stableJson(schema))
	// A reset lineage has exactly one baseline. Keep its journal independent of build time.
	const journalPath = join(meta, '_journal.json')
	const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { when: number }[] }
	if (journal.entries.length !== 1) {
		throw new Error(
			'[database] reset-on-schema-change database must produce one baseline migration',
		)
	}
	journal.entries[0]!.when = 0
	await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf8')
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
