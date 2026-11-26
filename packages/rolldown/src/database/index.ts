import { tmpdir } from 'node:os'
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'pathe'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import {
	checkPublishedHistory,
	databaseManifestFile,
	listMigrationSqlFiles,
	readDatabaseInputs,
	readDatabaseLineage,
	requireDatabaseMigrations,
	writeDatabaseInputs,
	writeDatabaseLineage,
	validDatabaseLineage,
	type DatabaseEvolutionArtifact,
	type DatabaseDialect,
	type DatabaseInputs,
} from './artifact.ts'
import { extractDatabaseDeclarations, mayDeclareDatabase } from './declaration.ts'
import { runDrizzleKit } from './drizzle-kit.ts'

export { readDatabaseHistory, writeDatabaseHistory } from './artifact.ts'

export type DatabaseToolOptions = Readonly<{
	root?: string
	schema?: string
	out?: string
	name?: string
}>

export type DatabaseCheckOptions = DatabaseToolOptions & Readonly<{ against?: string }>

export type DatabaseRebaseOptions = DatabaseToolOptions & Readonly<{ lineage: string }>

export async function generateDatabaseMigrations(options: DatabaseToolOptions = {}): Promise<void> {
	const plan = await resolvePlan(options)
	assertMigrationWorkflow(plan)
	const manifestPath = join(plan.out, databaseManifestFile)
	let current: DatabaseInputs | undefined
	if (existsSync(manifestPath)) {
		current = await readDatabaseInputs(plan.out, plan.dialect)
	} else {
		const files = await listMigrationSqlFiles(plan.out)
		if (files.length > 0 || existsSync(join(plan.out, 'meta', '_journal.json'))) {
			throw new Error(
				`[database] existing Drizzle history requires an explicit lineage in ${manifestPath}`,
			)
		}
	}
	await generateHistory(plan, options.name, current?.history.lineage ?? 'main', current)
}

export async function rebaseDatabaseMigrations(options: DatabaseRebaseOptions): Promise<void> {
	const plan = await resolvePlan(options)
	assertMigrationWorkflow(plan)
	if (!validDatabaseLineage(options.lineage)) {
		throw new Error(
			'[database] lineage must start with an alphanumeric character and contain at most 64 letters, digits, dots, underscores, or hyphens',
		)
	}
	const current = await readDatabaseInputs(plan.out, plan.dialect)
	if (current.history.lineage === options.lineage) {
		throw new Error(
			`[database] rebase lineage must differ from current lineage "${options.lineage}"`,
		)
	}
	await generateHistory(plan, options.name, options.lineage, current)
}

async function generateHistory(
	plan: ResolvedPlan,
	name: string | undefined,
	lineage: string,
	current?: DatabaseInputs,
): Promise<void> {
	await mkdir(dirname(plan.out), { recursive: true })
	const stagingRoot = await mkdtemp(join(dirname(plan.out), '.pluxel-database-'))
	const staged = join(stagingRoot, 'drizzle')
	try {
		const append = current?.history.lineage === lineage
		if (append) await writeDatabaseInputs(staged, current)
		await runDrizzleKit(
			'generate',
			{ ...plan, out: staged },
			name ? ['--name', name] : [],
			append ? 'inherit' : 'capture',
		)
		if (!append) await writeDatabaseLineage(staged, lineage)
		const next = await readDatabaseInputs(staged, plan.dialect)
		requireDatabaseMigrations(next.history)
		if (!current && !existsSync(plan.out)) await rename(staged, plan.out)
		else await installHistory(staged, plan.out, `${stagingRoot}.previous`, current, next)
	} finally {
		await rm(stagingRoot, { recursive: true, force: true })
	}
}

function migrationDataFiles({ history, snapshots }: DatabaseInputs) {
	return [
		...snapshots.map(({ file }) => join('meta', file)),
		...history.tags.map((tag) => `${tag}.sql`),
	]
}

// Work only on Drizzle's files, even for `--out .`. Claim the journal before updating an
// existing history so two commands cannot overwrite one another's generation.
async function installHistory(
	staged: string,
	out: string,
	backup: string,
	current: DatabaseInputs | undefined,
	next: DatabaseInputs,
) {
	const append = current?.history.lineage === next.history.lineage
	const oldFiles = new Set(current ? migrationDataFiles(current) : [])
	const files = migrationDataFiles(next).filter((file) => !append || !oldFiles.has(file))
	if (append && files.length === 0) return
	const journal = join('meta', '_journal.json')
	const saved: string[] = []
	const created: string[] = []
	const save = async (file: string) => {
		await rename(join(out, file), join(backup, file))
		saved.push(file)
	}
	await mkdir(join(out, 'meta'), { recursive: true })
	try {
		if (current) {
			await mkdir(join(backup, 'meta'), { recursive: true })
			await save(journal)
			if (
				(await readFile(join(backup, journal), 'utf8')) !== current.history.journalSource ||
				(await readDatabaseLineage(join(out, databaseManifestFile), false)) !==
					current.history.lineage
			)
				throw new Error(
					'[database] migration history changed while generating; retry with the current history',
				)
			if (!append) {
				await save(databaseManifestFile)
				for (const file of oldFiles) await save(file)
			}
		}
		if (!current) files.push(journal, databaseManifestFile)
		else if (!append) files.push(databaseManifestFile)
		for (const file of files) {
			const target = join(out, file)
			await copyFile(join(staged, file), target, constants.COPYFILE_EXCL)
			created.push(target)
		}
		if (current) await rename(join(staged, journal), join(out, journal))
	} catch (error) {
		for (const file of created.toReversed()) await rm(file, { force: true })
		for (const file of saved.toReversed()) await rename(join(backup, file), join(out, file))
		await rm(backup, { recursive: true, force: true })
		throw error
	}
	await rm(backup, { recursive: true, force: true })
}

export async function checkDatabaseMigrations(options: DatabaseCheckOptions = {}): Promise<void> {
	const plan = await resolvePlan(options)
	assertMigrationWorkflow(plan)
	const current = await readDatabaseInputs(plan.out, plan.dialect)
	requireDatabaseMigrations(current.history)
	if (options.against !== undefined)
		await checkPublishedHistory(resolve(plan.root, options.against), current.history)
	const tempRoot = await mkdtemp(join(tmpdir(), 'pluxel-database-check-'))
	const stagedPlan = { ...plan, out: join(tempRoot, 'drizzle') }
	try {
		await writeDatabaseInputs(stagedPlan.out, current)
		await runDrizzleKit('check', stagedPlan)
		await runDrizzleKit('generate', stagedPlan)
		const before = new Set(current.history.tags.map((tag) => `${tag}.sql`))
		const after = await listMigrationSqlFiles(stagedPlan.out)
		const added = after.filter((file) => !before.has(file))
		if (added.length > 0 || after.length !== before.size) {
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
	dialect: DatabaseDialect
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
		dialect: declarations[0]!.dialect,
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
			if (!mayDeclareDatabase(source)) continue
			const ast = parseStandaloneWithLang(source, path)
			if (!ast) throw new Error(`[database] failed to parse database declaration module: ${path}`)
			if (extractDatabaseDeclarations(ast, source, path).length > 0) candidates.push(path)
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
