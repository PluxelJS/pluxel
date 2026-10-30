import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as v from 'valibot'
import {
	createTypstSourceProject,
	type TypstSourceFiles,
	type TypstSourceResult,
} from '@pluxel/plugin-typst/source'
import { bodyPaths, components, dataPath, dataSchema, entry } from './model.ts'

const run = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
export class ReportError extends Error {
	constructor(readonly issues: readonly { code: string; message: string; path?: string }[]) {
		super(
			issues
				.map((issue) => `${issue.path ?? 'report'}: ${issue.code}: ${issue.message}`)
				.join('\n'),
		)
	}
}
export function accepted<T>(result: TypstSourceResult<T>): T {
	if (!result.ok) throw new ReportError(result.issues)
	return result.value
}

/** Read ordinary project files. Symlinks and special files are rejected rather than followed. */
async function readSnapshot(directory: string) {
	const status = await lstat(directory)
	if (!status.isDirectory())
		throw new ReportError([
			{
				code: 'INVALID_PATH',
				path: directory,
				message: 'Expected an ordinary directory, not a symbolic link.',
			},
		])
	const files: Record<string, string | Uint8Array> = {}
	const digest = createHash('sha256')
	async function visit(relative = ''): Promise<void> {
		const entries = await readdir(join(directory, relative), { withFileTypes: true })
		for (const item of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
			const path = relative ? `${relative}/${item.name}` : item.name
			if (item.isDirectory()) {
				await visit(path)
				continue
			}
			if (!item.isFile())
				throw new ReportError([
					{
						code: 'INVALID_PATH',
						path,
						message: 'Only ordinary files and directories are supported.',
					},
				])
			const bytes = await readFile(join(directory, path))
			digest.update(`${Buffer.byteLength(path)}:${path}:${bytes.byteLength}:`).update(bytes)
			files[path] = /\.(?:typ|json|md|svg|txt)$/.test(path)
				? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
				: new Uint8Array(bytes)
		}
	}
	await visit()
	return { directory: resolve(directory), diskRevision: digest.digest('hex'), files }
}

function lockPathFor(directory: string) {
	const destination = resolve(directory)
	return join(dirname(destination), `.${basename(destination)}.report-write.lock`)
}
async function locked<T>(directory: string, action: () => Promise<T>): Promise<T> {
	const path = lockPathFor(directory)
	const lock = await open(path, 'wx')
	try {
		return await action()
	} finally {
		try {
			await lock.close()
		} finally {
			await rm(path)
		}
	}
}
export function snapshot(directory: string) {
	return locked(directory, () => readSnapshot(directory))
}

async function writeFiles(directory: string, files: TypstSourceFiles) {
	// The public project boundary checks canonical paths before any writes occur.
	const checked = createTypstSourceProject({ files }).snapshot().files
	for (const [path, value] of Object.entries(checked)) {
		await mkdir(dirname(join(directory, path)), { recursive: true })
		await writeFile(join(directory, path), value, { flag: 'wx' })
	}
}

export async function initialize(directory: string) {
	const initial = await snapshot(join(packageRoot, 'workspace'))
	return locked(directory, async () => {
		await mkdir(directory)
		await writeFiles(directory, initial.files)
		return readSnapshot(directory)
	})
}
export async function checkout(directory: string, destination: string) {
	const current = await snapshot(directory)
	return locked(destination, async () => {
		await mkdir(destination)
		await writeFiles(destination, current.files)
		return readSnapshot(destination)
	})
}
export async function openWorkspace(directory: string) {
	const current = await snapshot(directory)
	return { ...current, project: createTypstSourceProject({ files: current.files, components }) }
}

/**
 * Local Linux consumer transaction. GNU mv's rename-exchange makes the complete tree
 * visible in one filesystem operation. All this consumer's writers use the sibling lock.
 * External editors must finish writing before commit; arbitrary noncooperating races
 * between the final hash check and rename are outside this local consumer's guarantee.
 */
export async function commit(
	directory: string,
	input: { baseRevision: string; files: TypstSourceFiles },
) {
	const destination = resolve(directory)
	const lockPath = lockPathFor(destination)
	const lock = await open(lockPath, 'wx')
	let staged: string | undefined
	let saved = false
	const cleanupWarnings: string[] = []
	let result: { saved: boolean; diskRevision: string; cleanupWarnings: string[] } | undefined
	try {
		const current = await readSnapshot(destination)
		if (current.diskRevision !== input.baseRevision)
			throw new ReportError([
				{
					code: 'CONFLICT',
					message: 'Project files changed. Read the current files before applying this edit.',
				},
			])
		staged = await mkdtemp(join(dirname(destination), `.${basename(destination)}.report-stage-`))
		await writeFiles(staged, input.files)
		const candidate = await readSnapshot(staged)
		if (candidate.diskRevision === current.diskRevision) {
			result = { saved: false, diskRevision: current.diskRevision, cleanupWarnings }
		} else {
			const beforeExchange = await readSnapshot(destination)
			if (beforeExchange.diskRevision !== input.baseRevision)
				throw new ReportError([
					{
						code: 'CONFLICT',
						message: 'Project files changed while staging. No file was replaced.',
					},
				])
			await run('mv', ['--exchange', '--no-copy', '-T', '--', staged, destination])
			saved = true
			result = { saved: true, diskRevision: candidate.diskRevision, cleanupWarnings }
		}
	} finally {
		try {
			if (staged)
				await rm(staged, { recursive: true, force: true }).catch((error: unknown) => {
					if (!saved) throw error
					cleanupWarnings.push(`Saved successfully; old tree cleanup failed: ${String(error)}`)
				})
		} finally {
			try {
				await lock.close()
			} finally {
				await rm(lockPath).catch((error: unknown) => {
					if (!saved) throw error
					cleanupWarnings.push(`Saved successfully; lock cleanup failed: ${String(error)}`)
				})
			}
		}
	}
	return result!
}

/** Saving drafts is independent of syntax/data validation and compilation. */
export async function check(directory: string) {
	const current = await openWorkspace(directory)
	const diagnostics: { code: string; message: string; path?: string; severity?: string }[] = [
		...current.project.diagnostics(),
	]
	try {
		const text = current.files[dataPath]
		if (typeof text !== 'string') throw new Error('Missing JSON data file')
		const data = v.safeParse(dataSchema, JSON.parse(text))
		if (!data.success)
			for (const issue of data.issues)
				diagnostics.push({
					code: 'INVALID_DATA',
					path: dataPath,
					severity: 'error',
					message: issue.message,
				})
	} catch (error) {
		diagnostics.push({
			code: 'INVALID_DATA',
			path: dataPath,
			severity: 'error',
			message: String(error),
		})
	}
	return {
		diskRevision: current.diskRevision,
		valid: !diagnostics.some((issue) => issue.severity === 'error'),
		diagnostics,
		files: bodyPaths.map((path) => {
			const projection = current.project.open(path)
			return {
				path,
				editable: projection.editable,
				nodes: projection.document.content?.length ?? 0,
			}
		}),
	}
}

/** Compile all snapshots through one constructor-injected plugin and one retained session. */
export async function renderSnapshots(
	snapshots: readonly TypstSourceFiles[],
	fonts: string[],
	output?: string,
) {
	if (snapshots.length === 0 || fonts.length === 0)
		throw new Error('At least one snapshot and an explicit font path are required.')
	const job = output ? resolve(output) : await mkdtemp(join(await ensureArtifacts(), 'render-'))
	if (output) await mkdir(job, { recursive: true })
	const requests: { root: string; sourceRevision: string }[] = []
	for (let index = 0; index < snapshots.length; index++) {
		const root = join(job, `snapshot-${index + 1}`)
		await mkdir(root)
		await writeFiles(root, snapshots[index]!)
		const stagedSnapshot = await snapshot(root)
		requests.push({ root, sourceRevision: stagedSnapshot.diskRevision })
	}
	await writeFile(join(job, 'requests.json'), json(requests))
	const { createHost } = await import('@pluxel/host')
	const { pluginNodeAddressOf } = await import('@pluxel/core')
	const { FontsPlugin } = await import('@pluxel/plugin-fonts')
	const { TypstPlugin } = await import('@pluxel/plugin-typst')
	const { nodeModules } = await import('@pluxel/services/node')
	const { ReportRenderPlugin } = await import('./index.ts')
	const host = await createHost({
		plugins: [FontsPlugin, TypstPlugin, ReportRenderPlugin],
		services: [
			nodeModules({
				root: resolve(
					dirname(fileURLToPath(import.meta.resolve('@pluxel/plugin-typst/package.json'))),
					'dist/artifacts/node',
				),
			}),
		],
		configRecords: {
			initial: [
				{
					owner: pluginNodeAddressOf(FontsPlugin),
					config: { files: fonts, maxFontBytes: 64 * 1024 * 1024 },
				},
				{ owner: pluginNodeAddressOf(ReportRenderPlugin), config: { job, entry } },
			],
		},
		state: { initial: { autoStart: [pluginNodeAddressOf(ReportRenderPlugin)] } },
	})
	try {
		const report = await host.start()
		if (
			report.reconciliation.length > 0 ||
			(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
		)
			throw new Error('Report consumer failed to start', { cause: report })
		return {
			job,
			results: JSON.parse(await readFile(join(job, 'compile.json'), 'utf8')) as CompileReceipt[],
		}
	} finally {
		await host.close()
	}
}
export interface CompileReceipt {
	ok: boolean
	sourceRevision: string
	sessionId: string
	revision?: number
	lastSuccessfulRevision?: number
	pages?: number
	pdfBytes?: number
	diagnostics?: unknown[]
	message?: string
}
async function ensureArtifacts() {
	const path = join(packageRoot, '.artifacts')
	await mkdir(path, { recursive: true })
	return path
}
export async function render(directory: string, fonts: string[], output?: string) {
	const current = await snapshot(directory)
	return renderSnapshots([current.files], fonts, output)
}
