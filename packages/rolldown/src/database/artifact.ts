import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'pathe'

export const databaseManifestFile = 'pluxel-migrations.json'

export type DatabaseEvolutionArtifact = 'migrations' | 'reset-on-schema-change'

export type DatabaseMigrationArtifact = Readonly<{
	id: string
	checksum: string
	sql: string
}>

export type DatabaseBuildArtifact = Readonly<{
	evolution: DatabaseEvolutionArtifact
	lineage: string
	migrations: readonly DatabaseMigrationArtifact[]
}>

export type DatabaseMigrationManifest = Readonly<{
	version: 2
	evolution?: DatabaseEvolutionArtifact
	lineage: string
	migrations: readonly Readonly<{ id: string; file: string; checksum: string }>[]
}>

export async function loadDatabaseArtifactForSource(
	sourceFile: string,
	boundary: string,
): Promise<
	Readonly<{ packageRoot: string; migrationsDir: string; artifact: DatabaseBuildArtifact }>
> {
	const packageRoot = findDatabasePackageRoot(sourceFile, boundary)
	if (!packageRoot) {
		throw new Error(`[database] cannot locate package.json for ${sourceFile}`)
	}
	const migrationsDir = join(packageRoot, 'drizzle')
	if (!existsSync(migrationsDir)) {
		throw new Error(
			`[database] ${relative(boundary, sourceFile)} declares defineDatabase() but ${relative(
				boundary,
				migrationsDir,
			)} is missing; run \`pluxel database generate\` in the package`,
		)
	}
	return {
		packageRoot,
		migrationsDir,
		artifact: await loadDatabaseArtifact(migrationsDir),
	}
}

export async function loadDatabaseArtifact(migrationsDir: string): Promise<DatabaseBuildArtifact> {
	const manifestPath = join(migrationsDir, databaseManifestFile)
	let manifest: DatabaseMigrationManifest
	try {
		manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DatabaseMigrationManifest
	} catch (error) {
		throw new Error(`[database] cannot read migration manifest ${manifestPath}`, { cause: error })
	}
	validateManifest(manifest, manifestPath)
	const sqlFiles = await listMigrationSqlFiles(migrationsDir)
	const manifestFiles = manifest.migrations.map((entry) => entry.file).sort()
	if (sqlFiles.join('\n') !== manifestFiles.join('\n')) {
		throw new Error(
			`[database] migration manifest does not exactly cover SQL files in ${migrationsDir}`,
		)
	}

	const migrations: DatabaseMigrationArtifact[] = []
	for (const entry of manifest.migrations) {
		const sqlPath = join(migrationsDir, entry.file)
		const contents = await readFile(sqlPath, 'utf8')
		const source = contents.trim()
		if (!source) throw new Error(`[database] migration ${entry.file} is empty`)
		validateMigrationSql(source, sqlPath)
		const checksum = migrationChecksum(source)
		if (checksum !== entry.checksum) {
			throw new Error(
				`[database] migration history was rewritten: ${entry.file} (expected ${entry.checksum}, received ${checksum})`,
			)
		}
		migrations.push({ id: entry.id, checksum, sql: source })
	}
	return {
		evolution: manifest.evolution ?? 'migrations',
		lineage: manifest.lineage,
		migrations,
	}
}

export function migrationChecksum(sql: string): string {
	return createHash('sha256').update(sql.trim()).digest('hex')
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

function validateManifest(
	manifest: DatabaseMigrationManifest,
	manifestPath: string,
): asserts manifest is DatabaseMigrationManifest {
	if (
		!manifest ||
		manifest.version !== 2 ||
		(manifest.evolution !== undefined &&
			manifest.evolution !== 'migrations' &&
			manifest.evolution !== 'reset-on-schema-change') ||
		!validDatabaseLineage(manifest.lineage) ||
		!Array.isArray(manifest.migrations)
	) {
		throw new Error(`[database] invalid migration manifest ${manifestPath}`)
	}
	let previous = ''
	const files = new Set<string>()
	for (const entry of manifest.migrations) {
		if (
			!entry ||
			typeof entry.id !== 'string' ||
			!entry.id ||
			typeof entry.file !== 'string' ||
			!entry.file.endsWith('.sql') ||
			entry.file !== entry.file.split(/[\\/]/).at(-1) ||
			entry.id !== entry.file.slice(0, -'.sql'.length) ||
			!/^[a-f0-9]{64}$/.test(entry.checksum)
		) {
			throw new Error(`[database] invalid migration entry in ${manifestPath}`)
		}
		if (entry.id <= previous || files.has(entry.file)) {
			throw new Error(`[database] migrations must have unique ascending ids in ${manifestPath}`)
		}
		previous = entry.id
		files.add(entry.file)
	}
}

export function validDatabaseLineage(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

function validateMigrationSql(source: string, sqlPath: string): void {
	if (/\bpublic\s*\./i.test(source)) {
		throw new Error(`[database] migration must not reference the public schema: ${sqlPath}`)
	}
	if (/\bpluxel_[a-z0-9_]+\s*\./i.test(source)) {
		throw new Error(`[database] migration must not hard-code a physical plugin schema: ${sqlPath}`)
	}
}
