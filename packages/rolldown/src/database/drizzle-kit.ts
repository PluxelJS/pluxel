import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'pathe'
import { listMigrationSqlFiles, type DatabaseDialect } from './artifact.ts'
import { scopeGeneratedPostgresSql, type PostgresSnapshot } from './postgres-sql.ts'

export type DrizzleKitPlan = Readonly<{
	root: string
	schema: string
	out: string
	dialect: DatabaseDialect
}>
type DrizzleKitOutput = 'inherit' | 'capture'

const MAX_CAPTURED_OUTPUT = 64 * 1024

export async function runDrizzleKit(
	command: 'generate' | 'check',
	plan: DrizzleKitPlan,
	extra: readonly string[] = [],
	output: DrizzleKitOutput = 'inherit',
): Promise<void> {
	const existingFiles =
		command === 'generate' && plan.dialect === 'postgresql'
			? new Set(await listMigrationSqlFiles(plan.out))
			: null
	const require = createRequire(import.meta.url)
	let binary: string
	try {
		binary = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs')
	} catch (error) {
		throw new Error(
			'[database] migration tooling requires drizzle-kit; install a compatible @pluxel/rolldown package',
			{ cause: error },
		)
	}
	const args =
		command === 'generate'
			? [
					binary,
					command,
					'--dialect',
					plan.dialect,
					'--schema',
					relative(plan.root, plan.schema),
					'--out',
					relative(plan.root, plan.out),
					...extra,
				]
			: [
					binary,
					command,
					'--dialect',
					plan.dialect,
					'--out',
					relative(plan.root, plan.out),
					...extra,
				]
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: plan.root,
			stdio: output === 'inherit' ? ['inherit', 'inherit', 'pipe'] : ['ignore', 'pipe', 'pipe'],
		})
		let diagnostics = ''
		const capture = (chunk: Buffer | string) => {
			if (diagnostics.length >= MAX_CAPTURED_OUTPUT) return
			diagnostics += String(chunk).slice(0, MAX_CAPTURED_OUTPUT - diagnostics.length)
		}
		child.stdout?.on('data', capture)
		let stderr = ''
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + String(chunk)).slice(-MAX_CAPTURED_OUTPUT)
			if (output === 'inherit') process.stderr.write(chunk)
			else capture(chunk)
		})
		child.once('error', reject)
		child.once('close', (code, signal) => {
			// Kit 0.31 logs caught schema evaluation errors and can still exit zero.
			const schemaError =
				command === 'generate' &&
				/^[\w.]*Error(?: \[[A-Z0-9_]+\])?:/m.test(stderr) &&
				/^\s+at /m.test(stderr)
			if (code === 0 && !schemaError) resolvePromise()
			else {
				const detail = (schemaError ? stderr : diagnostics).trim()
				reject(
					new Error(
						`[database] drizzle-kit ${command} failed (${signal ?? code})${detail ? `\n${detail}` : ''}`,
					),
				)
			}
		})
	})
	if (existingFiles) await normalizeGeneratedOwnerReferences(plan.out, existingFiles)
}

/** Normalize only SQL that Kit just generated. Applied migrations retain their exact bytes. */
export async function normalizeGeneratedOwnerReferences(
	out: string,
	existingFiles: ReadonlySet<string>,
): Promise<void> {
	const files = await listMigrationSqlFiles(out)
	const generated = files.filter((file) => !existingFiles.has(file))
	if (generated.length === 0) return
	const meta = join(out, 'meta')
	const metadata = await readdir(meta)
	const snapshots = metadata.filter((file) => file.endsWith('_snapshot.json'))
	snapshots.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
	const readSnapshot = async (file: string): Promise<PostgresSnapshot> =>
		JSON.parse(await readFile(join(meta, file), 'utf8'))

	for (const file of generated) {
		const index = snapshots.indexOf(`${file.split('_', 1)[0]}_snapshot.json`)
		if (index === -1)
			throw new Error(`[database] generated migration ${file} has no Drizzle schema snapshot`)
		const path = join(out, file)
		const [original, current, previous] = await Promise.all([
			readFile(path, 'utf8'),
			readSnapshot(snapshots[index]!),
			index > 0 ? readSnapshot(snapshots[index - 1]!) : undefined,
		])
		const normalized = await scopeGeneratedPostgresSql(original, path, current, previous)
		if (normalized !== original) await writeFile(path, normalized, 'utf8')
	}
}
