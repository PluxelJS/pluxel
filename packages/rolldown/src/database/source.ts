import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'pathe'
import {
	readDatabaseInputs,
	writeDatabaseInputs,
	requireDatabaseMigrations,
	type DatabaseBuildArtifact,
	type DatabaseEvolutionArtifact,
	type DatabaseDialect,
	type DatabaseInputs,
} from './artifact.ts'
import { generateResetDatabaseHistory } from './reset-artifact.ts'

export type DatabaseSourceArtifact = DatabaseInputs &
	Readonly<{
		artifact: DatabaseBuildArtifact
	}>

export async function resolveDatabaseArtifact(
	packageRoot: string,
	sourceFile: string,
	{ evolution, dialect }: { evolution: DatabaseEvolutionArtifact; dialect: DatabaseDialect },
	watch: (file: string) => void,
	publishSnapshots = false,
): Promise<DatabaseSourceArtifact> {
	const migrationsDir = join(packageRoot, 'drizzle')
	if (evolution === 'migrations' && !existsSync(migrationsDir)) {
		throw new Error(
			`[database] ${sourceFile} declares defineDatabase() but ${migrationsDir} is missing; run \`pluxel database generate\` in the package`,
		)
	}
	const inputs =
		evolution === 'reset-on-schema-change'
			? {
					history: await generateResetDatabaseHistory({
						root: packageRoot,
						schema: sourceFile,
						dialect,
					}),
					snapshots: [],
				}
			: await readDatabaseInputs(migrationsDir, dialect, watch, publishSnapshots)
	const history = requireDatabaseMigrations(inputs.history)
	return {
		artifact: { evolution, lineage: history.lineage, migrations: history.migrations },
		...inputs,
	}
}

export async function publishDatabaseArtifact(source: DatabaseSourceArtifact, target: string) {
	await mkdir(dirname(target), { recursive: true })
	const stagingRoot = await mkdtemp(join(dirname(target), '.pluxel-database-'))
	const staged = join(stagingRoot, 'migrations')
	const previous = `${stagingRoot}.previous`
	try {
		await writeDatabaseInputs(staged, source)
		if (!existsSync(target)) return await rename(staged, target)
		await rename(target, previous)
		try {
			await rename(staged, target)
		} catch (error) {
			await rename(previous, target)
			throw error
		}
		await rm(previous, { recursive: true, force: true })
	} finally {
		await rm(stagingRoot, { recursive: true, force: true })
	}
}
