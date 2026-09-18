import type { Context } from '@pluxel/core'
import { readNodeModuleDeclaration } from '../node/declaration'
import type { NodeModuleSourceSubscription } from '../node/internal'
import type { NodeModuleDeclaration } from '../node'
import { createHash } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectSourceGraphFiles } from '@pluxel/rolldown/vite/source-graph'
import {
	resolveNodeModuleArtifactKey,
	resolveNodeModuleBuildSignature,
} from '@pluxel/rolldown/vite/declaration'
import { watch, type FSWatcher } from 'chokidar'
import { join, resolve } from 'pathe'
import type { ViteDevServer } from 'vite'

export type NodeArtifactCompilerOptions = Readonly<{
	cacheDir?: string
	viteServer?: {
		config: Pick<ViteDevServer['config'], 'root'>
		environments?: ViteDevServer['environments']
		watcher?: Pick<ViteDevServer['watcher'], 'add'>
	}
}>
type NodeModuleListener = {
	onUpdate: (url: URL) => void | Promise<void>
	onError: (error: unknown) => void
}

type NodeModuleCompileEntry = {
	key: string
	entryPath: string
	sourceFiles: string[]
	listeners: Set<NodeModuleListener>
	watcher?: FSWatcher | null
	activeUrl?: URL
	active: boolean
	dirty: boolean
	compileTask?: Promise<void>
}

const WATCHER_IGNORED_GLOBS: string[] = [
	'**/node_modules/**',
	'**/.git/**',
	'**/.turbo/**',
	'**/.pluxel/**',
	'**/dist/**',
	'**/build/**',
	'**/.*',
	'**/*.swp',
	'**/*.swo',
	'**/*.tmp',
	'**/*~',
]

const HASH_IGNORED_SEGMENTS = [
	'node_modules',
	'.git',
	'.turbo',
	'.pluxel',
	'dist',
	'build',
	'.next',
] as const

const HASH_ALLOWED_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.css',
	'.scss',
	'.sass',
	'.less',
	'.json',
] as const

const NODE_ARTIFACT_BUILD_CONCURRENCY = 2

const ARTIFACT_CACHE_KEEP = 5
/** Shared Node source compiler used by standalone Host and Runtime development assemblies. */
export class NodeArtifactCompiler {
	private readonly nodeEntries = new Map<string, NodeModuleCompileEntry>()
	private activeNodeBuilds = 0
	private readonly nodeBuildWaiters: Array<() => void> = []
	private readonly compileTasks = new Set<Promise<void>>()
	private readonly watcherClosures = new Set<Promise<void>>()
	private closed = false
	private closeTask?: Promise<void>
	private readonly cacheDir: string
	private readonly viteServer: NodeArtifactCompilerOptions['viteServer']
	constructor(
		private readonly ctx: Context,
		options: NodeArtifactCompilerOptions = {},
	) {
		this.viteServer = options.viteServer
		this.cacheDir = resolve(options.cacheDir ?? resolve(process.cwd(), '.pluxel/plugin-artifacts'))
	}
	dispose(): Promise<void> {
		if (this.closeTask) return this.closeTask
		this.closed = true
		for (const entry of this.nodeEntries.values()) {
			entry.active = false
			this.disposeNodeWatcher(entry)
			entry.listeners.clear()
		}
		this.nodeEntries.clear()
		this.closeTask = (async () => {
			await Promise.allSettled(this.compileTasks)
			await Promise.all(this.watcherClosures)
		})()
		return this.closeTask
	}
	async watchNodeModule(
		declaration: NodeModuleDeclaration,
		onUpdate: (url: URL) => void | Promise<void>,
		onError: (error: unknown) => void,
	): Promise<NodeModuleSourceSubscription> {
		if (this.closed) throw new Error('[services/node/vite] Node artifact compiler is disposed')
		const descriptor = readNodeModuleDeclaration(declaration)
		const declarationFile = fileURLToPath(descriptor.moduleUrl)
		const entryPath = fileURLToPath(new URL(descriptor.entryPath, descriptor.moduleUrl))
		const root = resolve(this.viteServer?.config.root ?? process.cwd())
		const key =
			descriptor.artifactKey ??
			resolveNodeModuleArtifactKey(root, declarationFile, descriptor.entryPath)
		const listener: NodeModuleListener = { onUpdate, onError }
		let entry = this.nodeEntries.get(key)
		if (entry && entry.entryPath !== entryPath) {
			throw new Error(`[services/node/vite] Node module declaration key collision: ${key}`)
		}
		if (!entry) {
			entry = {
				key,
				entryPath,
				sourceFiles: [entryPath],
				listeners: new Set(),
				active: true,
				dirty: true,
				watcher: null,
			}
			this.nodeEntries.set(key, entry)
		}
		entry.listeners.add(listener)
		try {
			if (!entry.activeUrl) await this.compileNodeEntry(entry, true)
			const url = entry.activeUrl
			if (!entry.active || !url)
				throw new Error(`[services/node/vite] Node module build produced no artifact: ${key}`)
			let active = true
			return {
				url,
				dispose: async () => {
					if (!active) return
					active = false
					entry!.listeners.delete(listener)
					if (entry!.listeners.size > 0) return
					entry!.active = false
					this.disposeNodeWatcher(entry!)
					if (this.nodeEntries.get(key) === entry) this.nodeEntries.delete(key)
				},
			}
		} catch (error) {
			entry.listeners.delete(listener)
			if (entry.listeners.size === 0) {
				entry.active = false
				this.disposeNodeWatcher(entry)
				this.nodeEntries.delete(key)
			}
			throw error
		}
	}
	private async compileNodeEntry(entry: NodeModuleCompileEntry, initial: boolean): Promise<void> {
		if (entry.compileTask) return entry.compileTask
		const task = this.performNodeCompile(entry, initial)
		entry.compileTask = task
		this.compileTasks.add(task)
		try {
			await task
		} finally {
			this.compileTasks.delete(task)
			if (entry.compileTask === task) entry.compileTask = undefined
		}
	}

	private async performNodeCompile(entry: NodeModuleCompileEntry, initial: boolean): Promise<void> {
		do {
			entry.dirty = false
			try {
				await this.refreshNodeSourceFiles(entry)
				const sourceHash = await this.computeNodeSourceHash(entry)
				const outDir = join(this.cacheDir, 'node', entry.key)
				const outFile = join(outDir, `${sourceHash}.mjs`)
				const { buildNodeModule, validateNodeModuleArtifact } =
					await import('@pluxel/rolldown/vite/node-module')
				let reusable = existsSync(outFile)
				if (reusable) {
					try {
						await validateNodeModuleArtifact(outFile, {
							root: resolve(this.viteServer?.config.root ?? process.cwd()),
							entryPath: entry.entryPath,
						})
					} catch {
						reusable = false
						await rm(outFile, { force: true })
					}
				}
				if (!reusable) {
					await this.withNodeBuildSlot(async () => {
						if (!entry.active) return
						await buildNodeModule({
							root: resolve(this.viteServer?.config.root ?? process.cwd()),
							entryPath: entry.entryPath,
							outFile,
							minify: false,
						})
					})
				}
				if (!entry.active) return
				const nextUrl = pathToFileURL(outFile)
				const previous = entry.activeUrl?.href
				entry.activeUrl = nextUrl
				this.setupNodeWatcher(entry)
				await this.cleanupNodeCache(outDir, sourceHash)
				if (previous && previous !== nextUrl.href) {
					await Promise.all(
						[...entry.listeners].map((listener) =>
							Promise.resolve(listener.onUpdate(nextUrl)).catch(listener.onError),
						),
					)
				}
			} catch (error) {
				if (initial && !entry.activeUrl) throw error
				this.ctx.logger.error('failed to rebuild Node module', {
					artifactKey: entry.key,
					consumers: entry.listeners.size,
					error,
				})
				for (const listener of entry.listeners) {
					try {
						listener.onError(error)
					} catch (listenerError) {
						this.ctx.logger.error('failed to report Node module rebuild error', {
							artifactKey: entry.key,
							listenerError,
						})
					}
				}
			}
		} while (entry.active && entry.dirty)
	}

	private async refreshNodeSourceFiles(entry: NodeModuleCompileEntry): Promise<void> {
		const environment = this.viteServer?.environments?.ssr
		if (!environment) return
		let url = entry.entryPath
		const root = resolve(environment.config.root)
		if (url.startsWith(root)) url = url.slice(root.length)
		if (!url.startsWith('/')) url = `/${url}`
		await environment.transformRequest(url)
		const rootModule = await environment.moduleGraph.getModuleByUrl(url)
		if (!rootModule) return
		const files = collectSourceGraphFiles(rootModule)
		if (files.length > 0) entry.sourceFiles = files
	}

	private setupNodeWatcher(entry: NodeModuleCompileEntry): void {
		this.disposeNodeWatcher(entry)
		if (!entry.active || entry.sourceFiles.length === 0) return
		const watcher = watch(entry.sourceFiles, {
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			ignored: WATCHER_IGNORED_GLOBS,
		})
		const invalidate = () => {
			if (!entry.active) return
			entry.dirty = true
			void this.compileNodeEntry(entry, false).catch((error) => {
				this.ctx.logger.error('failed to schedule Node module rebuild', {
					artifactKey: entry.key,
					error,
				})
			})
		}
		watcher.on('change', invalidate)
		watcher.on('unlink', invalidate)
		watcher.on('add', invalidate)
		entry.watcher = watcher
	}

	private disposeNodeWatcher(entry: NodeModuleCompileEntry): void {
		const watcher = entry.watcher
		entry.watcher = null
		if (watcher) {
			const task = watcher.close()
			this.watcherClosures.add(task)
			void task.then(
				() => this.watcherClosures.delete(task),
				(): undefined => undefined,
			)
		}
	}

	private async cleanupNodeCache(dir: string, currentHash: string): Promise<void> {
		const files = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => [])
		const builds: Array<{ path: string; mtime: number }> = []
		for (const file of files) {
			if (!file.isFile() || file.name === `${currentHash}.mjs`) continue
			if (!/^[a-f\d]{16}\.mjs$/.test(file.name)) continue
			const path = join(dir, file.name)
			const info = await stat(path).catch((): null => null)
			if (info) builds.push({ path, mtime: info.mtimeMs })
		}
		builds.sort((a, b) => b.mtime - a.mtime)
		for (const stale of builds.slice(Math.max(0, ARTIFACT_CACHE_KEEP - 1))) {
			await rm(stale.path, { force: true })
		}
	}

	private async computeNodeSourceHash(entry: NodeModuleCompileEntry): Promise<string> {
		const hash = createHash('sha256')
		hash.update('node-module-compiler:1')
		hash.update(entry.key)
		hash.update(resolveNodeModuleBuildSignature({ minify: false }))
		const files = await this.expandHashTargets(entry.sourceFiles)
		for (const file of files.sort()) {
			hash.update(file)
			hash.update(await readFile(file).catch(() => Buffer.alloc(0)))
		}
		return hash.digest('hex').slice(0, 16)
	}

	private async expandHashTargets(files: string[]): Promise<string[]> {
		const collected: string[] = []
		const visited = new Set<string>()
		const queue = [...files]
		for (const target of queue) {
			if (!target || visited.has(target)) continue
			visited.add(target)
			const info = await stat(target).catch((): null => null)
			if (!info) continue
			if (info.isDirectory()) {
				for (const entry of await readdir(target)) {
					if (entry.startsWith('.') || /(?:~|\.swp|\.swo|\.tmp)$/.test(entry)) continue
					const path = join(target, entry)
					if (hasIgnoredHashPathSegment(path)) continue
					const nested = await stat(path).catch((): null => null)
					if (!nested) continue
					if (nested.isDirectory()) queue.push(path)
					else if (isHashableSourceFile(path)) collected.push(path)
				}
			} else if (isHashableSourceFile(target)) {
				collected.push(target)
			}
		}
		return collected
	}

	private async withNodeBuildSlot<T>(build: () => Promise<T>): Promise<T> {
		if (this.activeNodeBuilds >= NODE_ARTIFACT_BUILD_CONCURRENCY) {
			await new Promise<void>((resolveSlot) => this.nodeBuildWaiters.push(resolveSlot))
		}
		this.activeNodeBuilds += 1
		try {
			return await build()
		} finally {
			this.activeNodeBuilds -= 1
			this.nodeBuildWaiters.shift()?.()
		}
	}
}

function hasIgnoredHashPathSegment(filePath: string): boolean {
	const segments = filePath.replaceAll('\\', '/').toLowerCase().split('/')
	return HASH_IGNORED_SEGMENTS.some((segment) => segments.includes(segment))
}

function isHashableSourceFile(filePath: string): boolean {
	const lower = filePath.toLowerCase()
	if (hasIgnoredHashPathSegment(lower)) return false
	if (
		lower.endsWith('.d.ts') ||
		lower.endsWith('.d.mts') ||
		lower.endsWith('.d.cts') ||
		lower.endsWith('.map')
	) {
		return false
	}
	return HASH_ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension))
}
