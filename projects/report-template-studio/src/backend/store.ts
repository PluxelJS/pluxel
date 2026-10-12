import { createHash, randomUUID } from 'node:crypto'
import { searchWorkspace, type SearchOptions } from '../shared/search.js'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { fromBuffer, type Entry, type ZipFile } from 'yauzl'
import type {
	FileEntry,
	FileWrite,
	ProjectSummary,
	WorkspaceSnapshot,
	WorkspaceTree,
} from '../shared/contracts.js'
import {
	reportEntry,
	conflict,
	decodeText,
	MAX_ENTRIES,
	MAX_FILE,
	MAX_TOTAL,
	MAX_ARCHIVE,
	pathName,
	safePath,
	workspaceConfig,
} from './storage-validation.js'
import { workspaceSeed } from './seeds.js'
const MAX_CACHE_BYTES = 128 * 1024 * 1024
const MAX_CACHE_PROJECTS = 4
const statVersion = (stat: BigIntStats) =>
	`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.nlink}`
interface CachedFile {
	projectId: string
	stat: string
	bytes: Uint8Array
	version: string
	binary: boolean
}
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
interface Scan {
	tree: WorkspaceTree
	bytes: Map<string, Uint8Array>
}
async function atomic(path: string, bytes: Uint8Array | string) {
	await safePath(path)
	const temporary = join(dirname(path), `.studio-${randomUUID()}.tmp`)
	try {
		await writeFile(temporary, bytes, { flag: 'wx' })
		await rename(temporary, path)
	} finally {
		await rm(temporary, { force: true })
	}
}
async function exists(path: string) {
	try {
		return await lstat(await safePath(path))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}
function summary(scan: Scan): WorkspaceSnapshot {
	if (scan.tree.configError) throw new Error(scan.tree.configError)
	const files: Record<string, string> = Object.create(null)
	const assets: { path: string; size: number }[] = []
	for (const [path, bytes] of scan.bytes) {
		const text = decodeText(bytes)
		if (text === undefined) assets.push({ path, size: bytes.length })
		else files[path] = text
	}
	return {
		project: scan.tree.project,
		revision: scan.tree.revision,
		config: scan.tree.config,
		files,
		assets,
	}
}
async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array | null>> {
	if (bytes.length > MAX_ARCHIVE) throw new Error('Workspace ZIP exceeds 128 MiB')
	const archive = await new Promise<ZipFile>((accept, reject) =>
		fromBuffer(
			Buffer.from(bytes),
			{ lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
			(error, file) => (error ? reject(error) : accept(file!)),
		),
	)
	return new Promise((accept, reject) => {
		const files = new Map<string, Uint8Array | null>()
		let total = 0
		let failed = false
		function fail(error: unknown) {
			if (failed) return
			failed = true
			archive.close()
			reject(error)
		}
		archive.on('error', fail)
		archive.on('end', () => {
			if (!failed) accept(files)
		})
		archive.on('entry', (entry: Entry) => {
			void (async () => {
				const directory = entry.fileName.endsWith('/')
				const path = pathName(directory ? entry.fileName.slice(0, -1) : entry.fileName)
				const unixType = (entry.externalFileAttributes >>> 16) & 0xf000
				if (unixType && unixType !== 0x8000 && unixType !== 0x4000)
					throw new Error('ZIP links and special files are not allowed')
				if (files.has(path)) throw new Error('Duplicate ZIP path')
				if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted ZIP is not supported')
				if (
					files.size >= MAX_ENTRIES ||
					entry.uncompressedSize > MAX_FILE ||
					(total += entry.uncompressedSize) > MAX_TOTAL
				)
					throw new Error('Workspace ZIP exceeds file/count/size limits')
				if (directory) {
					if (entry.uncompressedSize) throw new Error('Invalid ZIP directory')
					files.set(path, null)
					archive.readEntry()
					return
				}
				const stream = await new Promise<import('node:stream').Readable>((ok, no) =>
					archive.openReadStream(entry, (error, entryStream) =>
						error ? no(error) : ok(entryStream!),
					),
				)
				const chunks: Buffer[] = []
				let count = 0
				for await (const chunk of stream) {
					count += chunk.length
					if (count > entry.uncompressedSize || count > MAX_FILE) {
						stream.destroy()
						throw new Error('ZIP entry exceeds declared size')
					}
					chunks.push(chunk)
				}
				if (count !== entry.uncompressedSize) throw new Error('Truncated ZIP entry')
				files.set(path, Buffer.concat(chunks))
				archive.readEntry()
			})().catch(fail)
		})
		archive.readEntry()
	})
}

/** Real workspace files are authoritative. Only recent project locations live in app data. */
export class WorkspaceStore {
	private queue: Promise<unknown> = Promise.resolve()
	private cachedFiles = new Map<string, CachedFile>()
	private cachedProjects = new Set<string>()
	private cachedBytes = 0
	private evictFile(path: string) {
		const cached = this.cachedFiles.get(path)
		if (cached) {
			this.cachedBytes -= cached.bytes.length
			this.cachedFiles.delete(path)
		}
	}
	private evictProject(id: string) {
		for (const [path, cached] of this.cachedFiles) if (cached.projectId === id) this.evictFile(path)
		this.cachedProjects.delete(id)
	}
	private cacheFile(path: string, cached: CachedFile) {
		this.evictFile(path)
		this.cachedFiles.set(path, cached)
		this.cachedBytes += cached.bytes.length
		while (this.cachedBytes > MAX_CACHE_BYTES || this.cachedFiles.size > MAX_ENTRIES)
			this.evictFile(this.cachedFiles.keys().next().value!)
	}
	private projects = new Map<string, ProjectSummary>()
	constructor(
		private readonly root: string,
		private readonly assetsRoot: string,
		private readonly seedInstructions: Record<string, string> = {},
		private readonly renameInputs?: (
			id: string,
			entries: { from: string; to: string }[],
		) => Promise<void>,
	) {}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.queue.then(operation)
		this.queue = task.catch(() => {})
		return task
	}
	private async registry() {
		await atomic(
			join(this.root, 'recent.json'),
			JSON.stringify([...this.projects.values()], null, 2),
		)
	}
	private project(id: string) {
		const value = this.projects.get(id)
		if (!value) throw Object.assign(new Error('Unknown workspace'), { code: 'ENOENT' })
		return value
	}
	async initialize() {
		return this.serial(async () => {
			await mkdir(await safePath(this.root), { recursive: true })
			const path = join(this.root, 'recent.json')
			if (!(await exists(path))) return
			const entries: unknown = JSON.parse(await readFile(path, 'utf8'))
			if (!Array.isArray(entries)) throw new Error('Invalid workspace registry')
			for (const entry of entries) {
				if (
					typeof entry?.id !== 'string' ||
					typeof entry?.root !== 'string' ||
					!isAbsolute(entry.root) ||
					typeof entry?.name !== 'string'
				)
					throw new Error('Invalid workspace registry entry')
				this.projects.set(entry.id, { id: entry.id, root: entry.root, name: entry.name })
			}
		})
	}
	async list() {
		return this.serial(async () => [...this.projects.values()])
	}
	private async scan(id: string): Promise<Scan> {
		const project = this.project(id)
		this.cachedProjects.delete(id)
		this.cachedProjects.add(id)
		while (this.cachedProjects.size > MAX_CACHE_PROJECTS)
			this.evictProject(this.cachedProjects.values().next().value!)
		const bytes = new Map<string, Uint8Array>()
		const entries: FileEntry[] = []
		let total = 0
		const observed = new Map<string, string>()
		const visit = async (relative: string): Promise<string> => {
			const directory = await safePath(join(project.root, relative))
			const before = await lstat(directory, { bigint: true })
			observed.set(directory, statVersion(before))
			if (!before.isDirectory()) throw new Error('Workspace root must be a directory')
			const children = await readdir(directory)
			children.sort()
			const versions: string[] = []
			for (const name of children) {
				const path = pathName(relative ? `${relative}/${name}` : name)
				const absolute = await safePath(join(project.root, path))
				const stat = await lstat(absolute, { bigint: true })
				const signature = statVersion(stat)
				observed.set(absolute, signature)
				if (entries.length >= MAX_ENTRIES) throw new Error('Workspace exceeds 5000 entries')
				if (stat.isDirectory()) {
					const entry: FileEntry = { path, kind: 'directory', size: 0, version: '' }
					entries.push(entry)
					entry.version = await visit(path)
					versions.push(`${path}:${entry.version}`)
				} else {
					if (!stat.isFile() || stat.nlink > 1n)
						throw new Error('Workspace links and special files are not supported')
					if (stat.size > MAX_FILE || (total += Number(stat.size)) > MAX_TOTAL)
						throw new Error('Workspace exceeds file/total size limit')
					let cached = this.cachedFiles.get(absolute)
					if (!cached || cached.stat !== signature) {
						const content = await readFile(absolute)
						const after = await lstat(absolute, { bigint: true })
						if (signature !== statVersion(after)) throw conflict()
						cached = {
							projectId: id,
							stat: signature,
							bytes: content,
							version: hash(content),
							binary: decodeText(content) === undefined,
						}
					}
					this.cacheFile(absolute, cached)
					const { bytes: content, version, binary } = cached
					entries.push({
						path,
						kind: 'file',
						size: content.length,
						version,
						binary,
					})
					bytes.set(path, content)
					versions.push(`${path}:${version}`)
				}
			}
			return hash(versions.join('\n'))
		}
		const revision = await visit('')
		// Recheck earlier files as well: editors can change them while later assets are read.
		for (const [path, before] of observed) {
			const checkedPath = await safePath(path)
			const after = await lstat(checkedPath, { bigint: true })
			if (before !== statVersion(after)) throw conflict()
		}
		const rawConfig = bytes.get('studio.json')
		let config = workspaceConfig(undefined, project.name)
		let configError: string | undefined
		try {
			config = workspaceConfig(
				rawConfig === undefined ? undefined : JSON.parse(Buffer.from(rawConfig).toString('utf8')),
				project.name,
			)
		} catch (error) {
			configError = `Invalid studio.json: ${error instanceof Error ? error.message : String(error)}`
		}
		return {
			tree: {
				project: { ...project, name: config.name },
				revision,
				entries,
				documents: entries
					.filter((item) => item.kind === 'file' && reportEntry(item.path))
					.map((item) => ({ entry: item.path, name: basename(dirname(item.path)) })),
				config,
				...(configError ? { configError } : {}),
			},
			bytes,
		}
	}
	private async currentProject(id: string) {
		const scanned = await this.scan(id)
		return scanned.tree.project
	}
	private async currentTree(id: string) {
		const scanned = await this.scan(id)
		return scanned.tree
	}
	async get(id: string) {
		return this.serial(() => this.currentProject(id))
	}
	async tree(id: string) {
		return this.serial(() => this.currentTree(id))
	}
	async open(root: string) {
		return this.serial(async () => {
			if (!isAbsolute(root))
				throw Object.assign(new Error('Workspace path must be absolute'), { code: 'INVALID_INPUT' })
			root = await safePath(resolve(root))
			const existing = [...this.projects.values()].find((project) => project.root === root)
			if (existing) return this.currentProject(existing.id)
			const value = { id: randomUUID(), root, name: basename(root) }
			this.projects.set(value.id, value)
			try {
				const current = await this.currentProject(value.id)
				this.projects.set(value.id, current)
				await this.registry()
				return current
			} catch (error) {
				this.projects.delete(value.id)
				throw error
			}
		})
	}
	async forget(id: string) {
		return this.serial(async () => {
			const value = this.project(id)
			this.projects.delete(id)
			this.evictProject(id)
			try {
				await this.registry()
			} catch (error) {
				this.projects.set(id, value)
				throw error
			}
		})
	}
	private async install(files: Map<string, Uint8Array | null>, name?: string) {
		const id = randomUUID()
		const parent = await safePath(join(this.root, 'projects'))
		await mkdir(parent, { recursive: true })
		const staging = join(parent, `.import-${id}`)
		const destination = join(parent, id)
		await mkdir(staging)
		try {
			for (const [path, bytes] of files) {
				const target = join(staging, pathName(path))
				if (bytes === null) await mkdir(target, { recursive: true })
				else {
					await mkdir(dirname(target), { recursive: true })
					await writeFile(target, bytes, { flag: 'wx' })
				}
			}
			const provisional = { id, root: staging, name: name || 'Imported workspace' }
			this.projects.set(id, provisional)
			const scanned = await this.scan(id)
			if (scanned.tree.configError) throw new Error(scanned.tree.configError)
			await rename(staging, destination)
			const project = { id, root: destination, name: scanned.tree.config.name }
			this.projects.set(id, project)
			await this.registry()
			return project
		} catch (error) {
			this.projects.delete(id)
			await rm(staging, { recursive: true, force: true })
			await rm(destination, { recursive: true, force: true })
			throw error
		}
	}
	async create(input: { name: string }) {
		if (!input.name?.trim() || input.name.length > 160) throw new Error('Invalid workspace name')
		return this.serial(async () =>
			this.install(
				new Map(
					Object.entries(await workspaceSeed(this.assetsRoot, input.name, this.seedInstructions)),
				),
			),
		)
	}
	async readFile(id: string, path: string) {
		return this.serial(async () => {
			pathName(path)
			const scan = await this.scan(id)
			const bytes = scan.bytes.get(path)
			if (!bytes) throw new Error('File not found')
			const content = decodeText(bytes)
			if (content === undefined) throw new Error('Cannot edit binary file as text')
			return { path, content, version: hash(bytes) }
		})
	}
	private async check(id: string, path: string, expectedVersion: string | null) {
		pathName(path)
		const scanned = await this.scan(id)
		const entry = scanned.tree.entries.find((candidate) => candidate.path === path)
		if ((entry?.version ?? null) !== expectedVersion) throw conflict()
		return entry
	}
	private async write(id: string, path: string, bytes: Uint8Array, expectedVersion: string | null) {
		if (bytes.length > MAX_FILE) throw new Error('File exceeds 64 MiB')
		const entry = await this.check(id, path, expectedVersion)
		if (entry?.kind === 'directory') throw new Error('Cannot replace directory with file')
		const target = await safePath(join(this.project(id).root, path))
		if (path === 'studio.json')
			workspaceConfig(JSON.parse(Buffer.from(bytes).toString('utf8')), this.project(id).name)
		await mkdir(dirname(target), { recursive: true })
		// Recheck after async directory creation so queued writes never replace a stale revision.
		await this.check(id, path, expectedVersion)
		await atomic(target, bytes)
		return hash(bytes)
	}
	async writeFile(id: string, input: FileWrite) {
		return this.serial(async () => ({
			path: input.path,
			content: input.content,
			version: await this.write(id, input.path, Buffer.from(input.content), input.expectedVersion),
		}))
	}
	async mkdir(id: string, path: string) {
		return this.serial(async () => {
			await this.check(id, path, null)
			await mkdir(await safePath(join(this.project(id).root, path)))
			return this.currentTree(id)
		})
	}
	async createReport(id: string, path: string) {
		return this.serial(async () => {
			await this.check(id, path, null)
			const target = await safePath(join(this.project(id).root, path))
			const name = basename(path)
			const entry = `${path}/${name}.ts`
			await mkdir(target)
			try {
				await writeFile(
					join(target, `${name}.ts`),
					`import * as v from 'valibot'\nimport { defineTypstDocument } from '@pluxel/typst/template'\n\nexport default defineTypstDocument({\n  template: './排版.typ',\n  schema: v.object({\n    title: v.optional(v.pipe(v.string(), v.title('标题')), '新报表'),\n    body: v.optional(v.pipe(v.string(), v.title('正文')), '在这里填写内容。'),\n  }),\n})\n`,
					{ flag: 'wx' },
				)
				await writeFile(
					join(target, '排版.typ'),
					'#let data = json("/inputs/data.json")\n#set page(paper: "a4", margin: 24mm)\n#align(center)[#text(size: 20pt, weight: "bold")[#data.title]]\n#parbreak()\n#data.body\n',
					{ flag: 'wx' },
				)
			} catch (error) {
				await rm(target, { recursive: true, force: true })
				throw error
			}
			return { entry, name }
		})
	}
	async rename(id: string, input: { path: string; to: string; expectedVersion: string }) {
		return this.serial(async () => {
			const entry = await this.check(id, input.path, input.expectedVersion)
			if (!entry) throw conflict()
			await this.check(id, input.to, null)
			const tree = await this.currentTree(id)
			const source = await safePath(join(this.project(id).root, input.path))
			const target = await safePath(join(this.project(id).root, input.to))
			const oldEntry = `${input.path}/${basename(input.path)}.ts`
			const ownReport =
				entry.kind === 'directory' && tree.documents.some((doc) => doc.entry === oldEntry)
			const renameEntry = ownReport && basename(input.path) !== basename(input.to)
			if (renameEntry) await this.check(id, `${input.path}/${basename(input.to)}.ts`, null)
			const mappings = tree.documents
				.filter((doc) => doc.entry === input.path || doc.entry.startsWith(input.path + '/'))
				.map((doc) => ({
					from: doc.entry,
					to:
						renameEntry && doc.entry === oldEntry
							? `${input.to}/${basename(input.to)}.ts`
							: input.to + doc.entry.slice(input.path.length),
				}))
			await rename(source, target)
			let renamedEntry = false
			try {
				if (renameEntry) {
					await rename(
						join(target, `${basename(input.path)}.ts`),
						join(target, `${basename(input.to)}.ts`),
					)
					renamedEntry = true
				}
				await this.renameInputs?.(id, mappings)
			} catch (error) {
				if (renamedEntry)
					await rename(
						join(target, `${basename(input.to)}.ts`),
						join(target, `${basename(input.path)}.ts`),
					)
				await rename(target, source)
				throw error
			}
			return this.currentTree(id)
		})
	}

	async remove(id: string, input: { path: string; expectedVersion: string }) {
		return this.serial(async () => {
			const entry = await this.check(id, input.path, input.expectedVersion)
			if (!entry) throw conflict()
			await rm(await safePath(join(this.project(id).root, input.path)), {
				recursive: entry.kind === 'directory',
			})
			return this.currentTree(id)
		})
	}
	async putAsset(
		id: string,
		path: string,
		bytes: Uint8Array,
		expectedVersion: string | null = null,
	) {
		return this.serial(async () => {
			await this.write(id, path, bytes, expectedVersion)
			return this.currentTree(id)
		})
	}
	async snapshot(id: string) {
		return this.serial(async () => summary(await this.scan(id)))
	}
	async materialize(id: string, target: string) {
		return this.serial(async () => {
			const scan = await this.scan(id)
			if (scan.tree.configError) throw new Error(scan.tree.configError)
			await mkdir(await safePath(target), { recursive: true })
			const contents = await readdir(target)
			if (contents.length > 0) throw new Error('Snapshot directory must be empty')
			for (const entry of scan.tree.entries) {
				const destination = await safePath(join(target, entry.path))
				if (entry.kind === 'directory') await mkdir(destination, { recursive: true })
				else {
					await mkdir(dirname(destination), { recursive: true })
					await writeFile(destination, scan.bytes.get(entry.path)!, { flag: 'wx' })
				}
			}
			return summary(scan)
		})
	}
	async export(id: string) {
		return this.serial(async () => {
			const scan = await this.scan(id)
			const files: Record<string, Uint8Array> = Object.create(null)
			for (const entry of scan.tree.entries)
				files[entry.path + (entry.kind === 'directory' ? '/' : '')] =
					scan.bytes.get(entry.path) ?? new Uint8Array()
			const archive = zipSync(files, { level: 6 })
			if (archive.length > MAX_ARCHIVE) throw new Error('Workspace ZIP exceeds 128 MiB')
			return archive
		})
	}
	async import(bytes: Uint8Array, name?: string) {
		const files = await unzip(bytes)
		return this.serial(() => this.install(files, name))
	}
	async search(id: string, options: SearchOptions) {
		return this.serial(async () => {
			const scan = await this.scan(id)
			return searchWorkspace(
				scan.tree.entries,
				(path) => {
					const bytes = scan.bytes.get(path)
					return bytes && decodeText(bytes)
				},
				options,
			)
		})
	}
}
