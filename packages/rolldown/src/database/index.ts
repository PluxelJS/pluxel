import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'pathe'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import {
	databaseManifestFile,
	listMigrationSqlFiles,
	loadDatabaseArtifact,
	migrationChecksum,
	validDatabaseLineage,
	type DatabaseEvolutionArtifact,
	type DatabaseMigrationManifest,
} from './artifact.ts'
import { extractDatabaseDeclarations } from './declaration.ts'
import { runDrizzleKit } from './drizzle-kit.ts'

export type DatabaseToolOptions = Readonly<{
	root?: string
	schema?: string
	out?: string
	name?: string
}>

export type DatabaseRebaseOptions = DatabaseToolOptions & Readonly<{ lineage: string }>

export async function generateDatabaseMigrations(options: DatabaseToolOptions = {}): Promise<void> {
	const plan = await resolvePlan(options)
	assertMigrationWorkflow(plan)
	await mkdir(plan.out, { recursive: true })
	const manifestPath = join(plan.out, databaseManifestFile)
	if (existsSync(manifestPath)) await loadDatabaseArtifact(plan.out)
	const before = new Set(await listMigrationSqlFiles(plan.out))
	await runDrizzleKit('generate', plan, options.name ? ['--name', options.name] : [])
	await writeUpdatedManifest(plan.out, before)
}

export async function rebaseDatabaseMigrations(options: DatabaseRebaseOptions): Promise<void> {
	const plan = await resolvePlan(options)
	assertMigrationWorkflow(plan)
	if (!validDatabaseLineage(options.lineage)) {
		throw new Error(
			'[database] lineage must start with an alphanumeric character and contain at most 64 letters, digits, dots, underscores, or hyphens',
		)
	}
	const current = await loadDatabaseArtifact(plan.out)
	if (current.lineage === options.lineage) {
		throw new Error(
			`[database] rebase lineage must differ from current lineage "${current.lineage}"`,
		)
	}

	await mkdir(dirname(plan.out), { recursive: true })
	const stagingRoot = await mkdtemp(join(dirname(plan.out), '.pluxel-database-rebase-'))
	const stagingOut = join(stagingRoot, 'drizzle')
	const backup = `${plan.out}.previous-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	try {
		await runDrizzleKit(
			'generate',
			{ ...plan, out: stagingOut },
			options.name ? ['--name', options.name] : [],
		)
		await writeUpdatedManifest(stagingOut, new Set(), options.lineage)
		const artifact = await loadDatabaseArtifact(stagingOut)
		if (artifact.migrations.length === 0) {
			throw new Error('[database] rebased database must carry at least one migration')
		}

		await rename(plan.out, backup)
		try {
			await rename(stagingOut, plan.out)
		} catch (error) {
			await rename(backup, plan.out)
			throw error
		}
		await rm(backup, { recursive: true, force: true })
	} finally {
		await rm(stagingRoot, { recursive: true, force: true })
	}
}

export async function checkDatabaseMigrations(options: DatabaseToolOptions = {}): Promise<void> {
	const plan = await resolvePlan(options)
	assertMigrationWorkflow(plan)
	const artifact = await loadDatabaseArtifact(plan.out)
	if (artifact.migrations.length === 0) {
		throw new Error('[database] a database definition must carry at least one migration')
	}
	await runDrizzleKit('check', plan)

	const tempRoot = await mkdtemp(join(tmpdir(), 'pluxel-database-check-'))
	const tempOut = join(tempRoot, 'drizzle')
	try {
		await cp(plan.out, tempOut, { recursive: true })
		const before = await listMigrationSqlFiles(tempOut)
		await runDrizzleKit('generate', { ...plan, out: tempOut })
		const after = await listMigrationSqlFiles(tempOut)
		if (before.join('\n') !== after.join('\n')) {
			const added = after.filter((file) => !before.includes(file))
			throw new Error(
				`[database] schema source has unapplied drift; generated ${added.join(', ') || 'a new migration'}`,
			)
		}
	} finally {
		await rm(tempRoot, { recursive: true, force: true })
	}
}

type ResolvedPlan = Readonly<{
	root: string
	schema: string
	out: string
	evolution: DatabaseEvolutionArtifact
}>

async function resolvePlan(options: DatabaseToolOptions): Promise<ResolvedPlan> {
	const root = resolve(options.root ?? process.cwd())
	const schema = options.schema ? resolve(root, options.schema) : await discoverDatabaseSchema(root)
	if (!existsSync(schema)) throw new Error(`[database] schema module not found: ${schema}`)
	const source = await readFile(schema, 'utf8')
	const ast = parseStandaloneWithLang(source, schema)
	if (!ast) throw new Error('[database] failed to parse database declaration module')
	const declarations = extractDatabaseDeclarations(ast, source, schema)
	if (declarations.length !== 1) {
		throw new Error('[database] expected exactly one module-level defineDatabase() declaration')
	}
	return {
		root,
		schema,
		out: resolve(root, options.out ?? 'drizzle'),
		evolution: declarations[0]!.evolution,
	}
}

function assertMigrationWorkflow(plan: ResolvedPlan): void {
	if (plan.evolution === 'migrations') return
	throw new Error(
		'[database] reset-on-schema-change has no checked-in migration history; edit the schema and run `pluxel build` instead',
	)
}

async function discoverDatabaseSchema(root: string): Promise<string> {
	const candidates: string[] = []
	const queue = [root]
	while (queue.length > 0) {
		const directory = queue.shift()!
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
				continue
			const path = join(directory, entry.name)
			if (entry.isDirectory()) {
				queue.push(path)
				continue
			}
			if (!/\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue
			const source = await readFile(path, 'utf8')
			if (source.includes('@pluxel/runtime/database') && /\bdefineDatabase\s*\(/.test(source)) {
				candidates.push(path)
			}
		}
	}
	if (candidates.length !== 1) {
		throw new Error(
			`[database] expected exactly one database definition under ${root}, found ${candidates.length}${
				candidates.length > 0
					? `: ${candidates.map((file) => relative(root, file)).join(', ')}`
					: ''
			}; pass --schema explicitly if discovery is ambiguous`,
		)
	}
	return candidates[0]!
}

async function writeUpdatedManifest(
	out: string,
	previousFiles: ReadonlySet<string>,
	lineage?: string,
): Promise<void> {
	const manifestPath = join(out, databaseManifestFile)
	const existing = existsSync(manifestPath)
		? (JSON.parse(await readFile(manifestPath, 'utf8')) as DatabaseMigrationManifest)
		: ({
				version: 2,
				evolution: 'migrations',
				lineage: lineage ?? 'main',
				migrations: [],
			} satisfies DatabaseMigrationManifest)
	if (lineage && existing.lineage !== lineage && existing.migrations.length > 0) {
		throw new Error('[database] lineage can only change through `pluxel database rebase`')
	}
	const known = new Set(existing.migrations.map((entry) => entry.file))
	const migrations = [...existing.migrations]
	for (const file of await listMigrationSqlFiles(out)) {
		if (known.has(file)) continue
		if (previousFiles.has(file)) {
			throw new Error(`[database] existing migration ${file} is not recorded in the manifest`)
		}
		const contents = await readFile(join(out, file), 'utf8')
		const sql = contents.trim()
		migrations.push({ id: basename(file, '.sql'), file, checksum: migrationChecksum(sql) })
	}
	migrations.sort((left, right) => left.id.localeCompare(right.id))
	await writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				version: 2,
				evolution: existing.evolution ?? 'migrations',
				lineage: lineage ?? existing.lineage,
				migrations,
			} satisfies DatabaseMigrationManifest,
			null,
			2,
		)}\n`,
		'utf8',
	)
	await loadDatabaseArtifact(out)
}
