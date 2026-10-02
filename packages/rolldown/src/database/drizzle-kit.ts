import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'pathe'
import { listMigrationSqlFiles } from './artifact.ts'

export type DrizzleKitPlan = Readonly<{ root: string; schema: string; out: string }>
type DrizzleKitOutput = 'inherit' | 'capture'

const MAX_CAPTURED_OUTPUT = 64 * 1024

export async function runDrizzleKit(
	command: 'generate' | 'check',
	plan: DrizzleKitPlan,
	extra: readonly string[] = [],
	output: DrizzleKitOutput = 'inherit',
): Promise<void> {
	const existingFiles =
		command === 'generate' ? new Set(await listMigrationSqlFiles(plan.out)) : null
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
					'postgresql',
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
					'postgresql',
					'--out',
					relative(plan.root, plan.out),
					...extra,
				]
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: plan.root,
			stdio: output === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
		})
		let diagnostics = ''
		const capture = (chunk: Buffer | string) => {
			if (diagnostics.length >= MAX_CAPTURED_OUTPUT) return
			diagnostics += String(chunk).slice(0, MAX_CAPTURED_OUTPUT - diagnostics.length)
		}
		child.stdout?.on('data', capture)
		child.stderr?.on('data', capture)
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) resolvePromise()
			else {
				const detail = diagnostics.trim()
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

/** Drizzle Kit sometimes qualifies a pgTable() FK target as public even though the
 * corresponding CREATE TABLE is unqualified. Plugin migrations run in an isolated
 * owner schema; only targets declared as unqualified tables in this snapshot may
 * inherit that search path. Explicit public or other-schema targets stay intact. */
export async function normalizeGeneratedOwnerReferences(
	out: string,
	existingFiles: ReadonlySet<string>,
): Promise<void> {
	const generated = (await listMigrationSqlFiles(out)).filter((file) => !existingFiles.has(file))
	if (generated.length === 0) return
	const snapshots = (await readdir(join(out, 'meta')))
		.filter((file) => file.endsWith('_snapshot.json'))
		.sort()
	const latest = snapshots.at(-1)
	if (!latest) throw new Error('[database] generated migration has no Drizzle schema snapshot')
	const snapshot = JSON.parse(await readFile(join(out, 'meta', latest), 'utf8')) as {
		tables?: Record<string, { name?: unknown; schema?: unknown }>
	}
	const owned = new Set(
		Object.values(snapshot.tables ?? {})
			.filter((table) => table.schema === '' && typeof table.name === 'string')
			.map((table) => table.name as string),
	)
	const explicitPublic = new Set(
		Object.values(snapshot.tables ?? {})
			.filter((table) => table.schema === 'public' && typeof table.name === 'string')
			.map((table) => table.name as string),
	)
	for (const file of generated) {
		const path = join(out, file)
		const original = await readFile(path, 'utf8')
		const normalized = original
			.split('--> statement-breakpoint')
			.map((statement) =>
				/\bFOREIGN KEY\b/u.test(statement)
					? statement.replace(
							/\bREFERENCES(\s+)"public"\."([^"]+)"/gu,
							(full, spacing: string, table: string) => {
								if (owned.has(table) && explicitPublic.has(table))
									throw new Error(
										`[database] ambiguous generated foreign key target public.${table}: both owner and explicit public tables exist`,
									)
								return owned.has(table) ? `REFERENCES${spacing}"${table}"` : full
							},
						)
					: statement,
			)
			.join('--> statement-breakpoint')
		if (normalized !== original) await writeFile(path, normalized, 'utf8')
	}
}
