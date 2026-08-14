import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, type NodeModuleDeclaration } from '@pluxel/runtime'
import {
	createCompiledWorkbenchArtifact,
	findNearestPackageRoot,
	findRuntimeModuleId,
	readNodeModuleDeclaration,
	resolveModuleIdBaseDir,
	type NodeModuleSourceSubscription,
	type WorkbenchArtifactService,
} from '@pluxel/runtime/internal'
import {
	WORKBENCH_FEDERATION_EXPOSE,
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
	WORKBENCH_FEDERATION_SHARE_STRATEGY,
	workbenchFederationSharedPackages,
	sanitizeWorkbenchOwnerName,
} from '@pluxel/core/federation'
import {
	RUNTIME_INTERNAL_API_BASE,
	runtimeWorkbenchArtifactBasePath,
} from '@pluxel/runtime/web/paths'
import { validateWorkbenchUiArtifact } from '@pluxel/rolldown/workbench/artifact'
import type { ViteDevServer } from 'vite'
import {
	isParaglideGeneratedFile,
	resolveParaglideIntegration,
	type ResolvedParaglideIntegration,
} from '@pluxel/rolldown/vite/paraglide'
import { watch, type FSWatcher } from 'chokidar'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'

import { collectSourceGraphFiles } from '@pluxel/rolldown/vite/source-graph'
import {
	resolveNodeModuleBuildSignature,
	resolvePluginArtifactKey,
} from '@pluxel/rolldown/vite/declaration'

type PluginArtifactCompilerOptions = {
	/**
	 * Disk cache directory for compiled plugin artifacts.
	 *
	 * Defaults to `.pluxel/plugin-artifacts` under `process.cwd()`.
	 */
	cacheDir?: string
	/**
	 * How many compiled remote builds to keep per plugin on disk.
	 * Keep a few historical hashes so open tabs / inflight MF loads do not trip over
	 * freshly evicted artifacts during rapid rebuilds.
	 * Values below 1 are clamped to 1 because the active artifact is served from this cache.
	 * @default 5
	 */
	cacheKeep?: number
	/**
	 * Explicit plugin package directories keyed by plugin name.
	 *
	 * Static hosts do not have a dynamic loader anchor table, so Vite/static
	 * integrations can provide these after loading the fixed catalog.
	 */
	pluginDirs?: Record<string, string>
}

export type PluginArtifactCompilerViteServer = {
	config: Pick<ViteDevServer['config'], 'root'>
	environments?: ViteDevServer['environments']
}

export type PluginArtifactCompilerWorkbenchStore = Pick<
	WorkbenchArtifactService,
	| 'getCompiledModule'
	| 'commitCompiledModule'
	| 'markCompiling'
	| 'markCompileError'
	| 'removePlugin'
>

export type PluginArtifactCompilerDeps = {
	store?: PluginArtifactCompilerWorkbenchStore
	viteServer?: PluginArtifactCompilerViteServer
}

type PluginCompileEntry = {
	declarationKey: string
	owners: Set<string>
	pluginDir: string
	entryBaseDir: string
	entryPath: string
	contractFingerprint: string
	sourceFiles: string[]
	paraglide: ResolvedParaglideIntegration | null
	graphDirty: boolean
	active: boolean
	watcher?: FSWatcher | null
}

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

function hasIgnoredHashPathSegment(filePath: string): boolean {
	const segments = filePath.replaceAll('\\', '/').toLowerCase().split('/')
	return HASH_IGNORED_SEGMENTS.some((segment) => segments.includes(segment))
}

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

// Bump when federation build semantics change (invalidates sourceHash cache key).
const WORKBENCH_COMPILER_VERSION = 16
const ARTIFACT_BUILD_CONCURRENCY = 2
const ARTIFACT_CACHE_KEEP = 5

export class PluginArtifactCompiler {
	private readonly dbg: LogtapeLogger
	private readonly store?: PluginArtifactCompilerWorkbenchStore
	private readonly viteServer?: PluginArtifactCompilerViteServer
	private readonly cacheDir: string
	private readonly cacheKeep: number
	private readonly pluginDirs: ReadonlyMap<string, string>

	private readonly entries = new Map<string, PluginCompileEntry>()
	private pendingPlugins = new Set<string>()
	private inflightPlugins = new Set<string>()
	private flushTimer: NodeJS.Timeout | null = null
	private flushPromise: Promise<void> | null = null
	private readonly compileTasks = new Map<string, Promise<boolean>>()
	private readonly nodeEntries = new Map<string, NodeModuleCompileEntry>()
	private readonly ownerWorkbenchDeclarations = new Map<string, string>()
	private activeNodeBuilds = 0
	private readonly nodeBuildWaiters: Array<() => void> = []

	constructor(
		public ctx: Context,
		deps: PluginArtifactCompilerDeps,
		options?: PluginArtifactCompilerOptions,
	) {
		this.store = deps.store
		this.viteServer = deps.viteServer
		this.cacheDir = options?.cacheDir ?? resolve(process.cwd(), '.pluxel/plugin-artifacts')
		this.cacheKeep = Math.max(1, Math.floor(options?.cacheKeep ?? ARTIFACT_CACHE_KEEP))
		this.pluginDirs = new Map(Object.entries(options?.pluginDirs ?? {}))
		this.dbg = this.ctx.logger.getDebugChannel('workbench:compile')
	}

	bindDeclaration(
		ctx: Context,
		config: { entryPath: string; declarationKey: string; contractFingerprint?: string },
	): () => void {
		const store = this.store
		if (!store) throw new Error('[runtime-dev] Workbench compiler is not attached')

		const ownerId = ctx.pluginInfo.id
		const pluginName = config.declarationKey
		const existing = this.entries.get(pluginName)
		if (existing) {
			if (existing.entryPath !== config.entryPath) {
				throw new Error(`[runtime-dev] Workbench declaration key collision: ${pluginName}`)
			}
			existing.contractFingerprint = config.contractFingerprint ?? ''
			existing.owners.add(ownerId)
			this.ownerWorkbenchDeclarations.set(ownerId, pluginName)
			void store.markCompiling(ownerId)
			this.enqueueCompile(pluginName)
			const guard = ctx.effects.defer(() => {
				existing.owners.delete(ownerId)
				if (this.ownerWorkbenchDeclarations.get(ownerId) === pluginName) {
					this.ownerWorkbenchDeclarations.delete(ownerId)
					void store.removePlugin(ownerId)
				}
				if (existing.owners.size > 0) return
				existing.active = false
				this.disposeWatcher(existing)
				this.pendingPlugins.delete(pluginName)
				if (this.entries.get(pluginName) === existing) this.entries.delete(pluginName)
			})
			return () => guard.dispose()
		}

		const configuredDir = this.pluginDirs.get(ownerId)
		let pluginDir = configuredDir ? (findNearestPackageRoot(configuredDir) ?? configuredDir) : null
		// Dynamic source modules may only be host-owned re-export wrappers. An absolute
		// declaration still belongs to the package that owns the browser source graph.
		if (!pluginDir && isAbsolute(config.entryPath)) {
			pluginDir = findNearestPackageRoot(config.entryPath) ?? dirname(config.entryPath)
		}
		pluginDir ??= this.findPluginDir(ctx, ownerId)
		if (!pluginDir) {
			pluginDir = this.findViteRootPluginDir(config.entryPath)
		}
		if (!pluginDir) throw new Error(`无法定位插件目录: ${ownerId}`)
		const entryBaseDir = this.findPluginEntryBaseDir(ctx, ownerId) ?? pluginDir

		const sourceFiles = this.collectSourceFiles(entryBaseDir, pluginDir, config.entryPath)
		const entry: PluginCompileEntry = {
			declarationKey: pluginName,
			owners: new Set([ownerId]),
			pluginDir,
			entryBaseDir,
			entryPath: config.entryPath,
			contractFingerprint: config.contractFingerprint ?? '',
			sourceFiles,
			paraglide: resolveParaglideIntegration(pluginDir),
			graphDirty: true,
			active: true,
			watcher: null,
		}
		this.ownerWorkbenchDeclarations.set(ownerId, pluginName)

		this.entries.set(pluginName, entry)
		this.setupWatcher(pluginName, entry)
		void store.markCompiling(ownerId).catch((error) => {
			this.ctx.logger.error('failed to mark workbench UI as compiling', {
				pluginName: ownerId,
				error,
			})
		})
		this.enqueueCompile(pluginName)

		const guard = ctx.effects.defer(() => {
			const stored = this.entries.get(pluginName)
			if (stored !== entry) return
			stored.owners.delete(ownerId)
			if (this.ownerWorkbenchDeclarations.get(ownerId) === pluginName) {
				this.ownerWorkbenchDeclarations.delete(ownerId)
				void store.removePlugin(ownerId)
			}
			if (stored.owners.size > 0) return
			stored.active = false
			this.disposeWatcher(stored)
			this.pendingPlugins.delete(pluginName)
			this.entries.delete(pluginName)
		})
		return () => guard.dispose()
	}

	async watchNodeModule(
		declaration: NodeModuleDeclaration,
		onUpdate: (url: URL) => void | Promise<void>,
		onError: (error: unknown) => void,
	): Promise<NodeModuleSourceSubscription> {
		const descriptor = readNodeModuleDeclaration(declaration)
		const declarationFile = fileURLToPath(descriptor.moduleUrl)
		const entryPath = fileURLToPath(new URL(descriptor.entryPath, descriptor.moduleUrl))
		const root = resolve(this.viteServer?.config.root ?? process.cwd())
		const key =
			descriptor.artifactKey ??
			resolvePluginArtifactKey('node', root, declarationFile, descriptor.entryPath)
		const listener: NodeModuleListener = { onUpdate, onError }
		let entry = this.nodeEntries.get(key)
		if (entry && entry.entryPath !== entryPath) {
			throw new Error(`[runtime-dev] Node module declaration key collision: ${key}`)
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
			if (!url) throw new Error(`[runtime-dev] Node module build produced no artifact: ${key}`)
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

	dispose(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
		this.pendingPlugins.clear()
		for (const entry of this.entries.values()) {
			entry.active = false
			this.disposeWatcher(entry)
		}
		this.entries.clear()
		this.ownerWorkbenchDeclarations.clear()
		for (const entry of this.nodeEntries.values()) {
			entry.active = false
			this.disposeNodeWatcher(entry)
			entry.listeners.clear()
		}
		this.nodeEntries.clear()
	}

	private async compileNodeEntry(entry: NodeModuleCompileEntry, initial: boolean): Promise<void> {
		if (entry.compileTask) {
			entry.dirty = true
			return entry.compileTask
		}
		const task = this.performNodeCompile(entry, initial)
		entry.compileTask = task
		try {
			await task
		} finally {
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
		if (watcher) void watcher.close().catch((): undefined => undefined)
	}

	private async cleanupNodeCache(dir: string, currentHash: string): Promise<void> {
		const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
		const builds: Array<{ path: string; mtime: number }> = []
		for (const file of files) {
			if (!file.isFile() || file.name === `${currentHash}.mjs`) continue
			if (!/^[a-f\d]{16}\.mjs$/.test(file.name)) continue
			const path = join(dir, file.name)
			const info = await stat(path).catch((): null => null)
			if (info) builds.push({ path, mtime: info.mtimeMs })
		}
		builds.sort((a, b) => b.mtime - a.mtime)
		for (const stale of builds.slice(Math.max(0, this.cacheKeep - 1))) {
			await rm(stale.path, { force: true })
		}
	}

	private async computeNodeSourceHash(entry: NodeModuleCompileEntry): Promise<string> {
		const hash = createHash('sha256')
		hash.update('node-module-compiler:1')
		hash.update(entry.key)
		hash.update(
			resolveNodeModuleBuildSignature({
				minify: false,
			}),
		)
		const files = await this.expandHashTargets(entry.sourceFiles)
		for (const file of files.sort()) {
			hash.update(file)
			hash.update(await readFile(file).catch(() => Buffer.alloc(0)))
		}
		return hash.digest('hex').slice(0, 16)
	}

	private async withNodeBuildSlot<T>(build: () => Promise<T>): Promise<T> {
		if (this.activeNodeBuilds >= ARTIFACT_BUILD_CONCURRENCY) {
			await new Promise<void>((resolveSlot) => this.nodeBuildWaiters.push(resolveSlot))
		}
		this.activeNodeBuilds++
		try {
			return await build()
		} finally {
			this.activeNodeBuilds--
			this.nodeBuildWaiters.shift()?.()
		}
	}

	async requestCompile(pluginName: string): Promise<void> {
		const entry = this.entries.get(pluginName)
		if (!entry || !entry.active) return
		await this.compilePlugin(pluginName)
	}

	private enqueueCompile(pluginName: string): void {
		const entry = this.entries.get(pluginName)
		if (!entry || !entry.active) return
		this.pendingPlugins.add(pluginName)
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null
				void this.flushPending()
			}, 100)
		}
	}

	private async flushPending(): Promise<void> {
		if (this.flushPromise) {
			await this.flushPromise
			return
		}

		const task = (async () => {
			const workers = Array.from(
				{
					length: Math.min(ARTIFACT_BUILD_CONCURRENCY, Math.max(this.pendingPlugins.size, 1)),
				},
				() => this.flushWorker(),
			)
			await Promise.all(workers)
		})()

		this.flushPromise = task
		try {
			await task
		} finally {
			if (this.flushPromise === task) this.flushPromise = null
		}
		if (this.pendingPlugins.size > 0) await this.flushPending()
	}

	private async compilePlugin(pluginName: string): Promise<boolean> {
		const existing = this.compileTasks.get(pluginName)
		if (existing) return existing
		const task = this.performCompile(pluginName)
		this.compileTasks.set(pluginName, task)
		try {
			return await task
		} finally {
			if (this.compileTasks.get(pluginName) === task) this.compileTasks.delete(pluginName)
		}
	}

	private async performCompile(pluginName: string): Promise<boolean> {
		const store = this.store
		if (!store) return false
		const entry = this.entries.get(pluginName)
		if (!entry) return false

		this.dbg.debug('compile start {pluginName}', { pluginName })
		try {
			await this.refreshWatchFiles(entry)
			const workbenchBuild = await import('@pluxel/rolldown/vite/workbench-ui')
			const sourceHash = await this.computeSourceHash({
				files: entry.sourceFiles,
				baseDir: entry.pluginDir,
				resolvedSharedSignature: workbenchBuild.resolveWorkbenchFederationShared(entry.pluginDir)
					.signature,
				contractFingerprint: entry.contractFingerprint,
			})
			const owners = this.activeWorkbenchOwners(entry)
			const currentOwner = owners[0]
			const current = currentOwner ? store.getCompiledModule(currentOwner) : undefined
			if (current?.sourceHash === sourceHash) {
				await this.commitWorkbenchOwners(
					entry,
					sourceHash,
					current.compiledAt,
					this.getCachedModuleDirPath(pluginName, sourceHash),
				)
				this.dbg.debug('compile done {pluginName} (cached)', { pluginName })
				return true
			}
			await Promise.all(
				this.activeWorkbenchOwners(entry).map((ownerId) =>
					store.markCompiling(ownerId, {
						updatedAt: Date.now(),
						sourceHash: store.getCompiledModule(ownerId)?.sourceHash,
						compiledAt: store.getCompiledModule(ownerId)?.compiledAt,
					}),
				),
			)

			const manifestFile = this.getManifestFilePath(pluginName, sourceHash)
			if (existsSync(manifestFile)) {
				const manifestStats = await stat(manifestFile).catch((): null => null)
				const cachedDir = this.getCachedModuleDirPath(pluginName, sourceHash)
				const validation = await validateWorkbenchUiArtifact(cachedDir, pluginName)
				if (manifestStats?.isFile() && validation.valid) {
					await this.commitWorkbenchOwners(
						entry,
						sourceHash,
						Math.floor(manifestStats.mtimeMs || Date.now()),
						cachedDir,
					)
					await this.cleanupCacheDir(pluginName)
					this.dbg.debug('compile done {pluginName} (cached:disk)', { pluginName })
					return true
				}
			}

			const built = await this.buildFederatedRemote(entry, sourceHash)
			await this.commitWorkbenchOwners(entry, sourceHash, built.compiledAt, built.outDir)
			await this.cleanupCacheDir(pluginName)
			this.dbg.debug('compile done {pluginName}', { pluginName })
			return true
		} catch (error) {
			await Promise.all(
				this.activeWorkbenchOwners(entry).map((ownerId) => {
					const current = store.getCompiledModule(ownerId)
					return store.markCompileError(ownerId, error, {
						updatedAt: Date.now(),
						sourceHash: current?.sourceHash,
						compiledAt: current?.compiledAt,
					})
				}),
			)
			this.ctx.logger.error('failed to compile {pluginName}', { pluginName, error })
			return false
		}
	}

	private async commitWorkbenchOwners(
		entry: PluginCompileEntry,
		sourceHash: string,
		compiledAt: number,
		artifactRoot: string,
	): Promise<void> {
		const store = this.store
		if (!store || !entry.active) return
		await Promise.all(
			this.activeWorkbenchOwners(entry).map((ownerId) =>
				store.commitCompiledModule(
					createCompiledWorkbenchArtifact({
						pluginName: ownerId,
						artifactName: entry.declarationKey,
						sourceHash,
						compiledAt,
					}),
					{ artifactRoot },
				),
			),
		)
	}

	private activeWorkbenchOwners(entry: PluginCompileEntry): string[] {
		return [...entry.owners].filter(
			(ownerId) => this.ownerWorkbenchDeclarations.get(ownerId) === entry.declarationKey,
		)
	}

	private async flushWorker(): Promise<void> {
		for (;;) {
			const pluginName = this.takeNextPendingPlugin()
			if (!pluginName) return
			const entry = this.entries.get(pluginName)
			if (!entry || !entry.active) {
				this.inflightPlugins.delete(pluginName)
				continue
			}

			try {
				await this.compilePlugin(pluginName)
			} finally {
				this.inflightPlugins.delete(pluginName)
			}
		}
	}

	private takeNextPendingPlugin(): string | null {
		for (const pluginName of this.pendingPlugins) {
			if (this.inflightPlugins.has(pluginName)) continue
			this.pendingPlugins.delete(pluginName)
			this.inflightPlugins.add(pluginName)
			return pluginName
		}
		return null
	}

	private getPluginCacheDir(pluginName: string): string {
		return join(this.cacheDir, sanitizeWorkbenchOwnerName(pluginName))
	}

	private getCachedModuleDirPath(pluginName: string, sourceHash: string): string {
		return join(this.getPluginCacheDir(pluginName), sourceHash)
	}

	private getManifestFilePath(pluginName: string, sourceHash: string): string {
		const dir = this.getCachedModuleDirPath(pluginName, sourceHash)
		return join(dir, WORKBENCH_FEDERATION_MANIFEST_FILE)
	}

	private async cleanupCacheDir(pluginName: string): Promise<void> {
		const dir = this.getPluginCacheDir(pluginName)
		const entries = await readdir(dir).catch((): string[] => [])
		if (entries.length === 0) return

		const builds: Array<{ path: string; mtime: number }> = []
		for (const name of entries) {
			if (!/^[a-f\d]{16}$/.test(name)) continue
			const full = join(dir, name)
			const manifestFile = join(full, WORKBENCH_FEDERATION_MANIFEST_FILE)
			const st = await stat(manifestFile).catch((): null => null)
			if (!st?.isFile()) continue
			builds.push({ path: full, mtime: st.mtimeMs ?? 0 })
		}

		builds.sort((a, b) => b.mtime - a.mtime)
		for (const stale of builds.slice(this.cacheKeep)) {
			await rm(stale.path, { recursive: true, force: true }).catch((): undefined => undefined)
		}
	}

	private async buildFederatedRemote(
		entry: PluginCompileEntry,
		sourceHash: string,
	): Promise<{ compiledAt: number; outDir: string }> {
		const absoluteEntry = this.resolvePluginFile(entry.entryBaseDir, entry.entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) {
			throw new Error(`Entry file not found: ${absoluteEntry}`)
		}

		const outDir = this.getCachedModuleDirPath(entry.declarationKey, sourceHash)

		const publicPath = `${RUNTIME_INTERNAL_API_BASE}${runtimeWorkbenchArtifactBasePath(entry.declarationKey, sourceHash)}/`
		const { buildWorkbenchUiRemote } = await import('@pluxel/rolldown/vite/workbench-ui')
		await buildWorkbenchUiRemote({
			root: entry.pluginDir,
			pluginName: entry.declarationKey,
			entryPath: absoluteEntry,
			outDir,
			publicPath,
			minify: false,
			sourcemap: true,
		})
		const validation = await validateWorkbenchUiArtifact(outDir, entry.declarationKey)
		if (!validation.valid) {
			throw new Error(
				`Incomplete workbench UI artifact: ${'reason' in validation ? validation.reason : 'unknown validation failure'}`,
			)
		}

		const manifestFile = join(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE)
		const manifestContent = await readFile(manifestFile, 'utf-8').catch((): null => null)
		if (!manifestContent) {
			throw new Error(`Module federation manifest not found for ${entry.declarationKey}`)
		}
		const manifestStat = await stat(manifestFile)
		return {
			compiledAt: Math.floor(manifestStat.mtimeMs || Date.now()),
			outDir,
		}
	}

	private setupWatcher(pluginName: string, entry: PluginCompileEntry): void {
		this.disposeWatcher(entry)
		const targets = [...new Set(entry.sourceFiles)]
		if (targets.length === 0) {
			entry.watcher = null
			return
		}
		const watcher = watch(targets, {
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			ignored: WATCHER_IGNORED_GLOBS,
		})
		const handleChange = () => {
			if (!entry.active) return
			entry.graphDirty = true
			this.enqueueCompile(pluginName)
		}
		watcher.on('change', handleChange)
		watcher.on('unlink', handleChange)
		watcher.on('add', handleChange)
		entry.watcher = watcher
	}

	private disposeWatcher(entry: PluginCompileEntry): void {
		if (entry.watcher) {
			entry.watcher.close().catch((): undefined => undefined)
			entry.watcher = null
		}
	}

	private collectSourceFiles(entryBaseDir: string, pluginDir: string, entryPath: string): string[] {
		const entryFile = this.resolvePluginFile(entryBaseDir, entryPath)
		const paraglide = resolveParaglideIntegration(pluginDir)
		const sourceFiles = entryFile ? [entryFile] : []
		if (paraglide) sourceFiles.push(...paraglide.sourceRoots)
		return [...new Set(sourceFiles)]
	}

	private async computeSourceHash(options: {
		files: string[]
		baseDir?: string
		resolvedSharedSignature?: string
		contractFingerprint?: string
	}): Promise<string> {
		const hash = createHash('sha256')
		hash.update(`compiler:${WORKBENCH_COMPILER_VERSION}`)
		hash.update(
			`shared:${options.resolvedSharedSignature ?? workbenchFederationSharedPackages.join('|')}`,
		)
		hash.update(`shareStrategy:${WORKBENCH_FEDERATION_SHARE_STRATEGY}`)
		hash.update(`remoteEntry:${WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE}`)
		hash.update(`expose:${WORKBENCH_FEDERATION_EXPOSE}`)
		hash.update(`contract:${options.contractFingerprint ?? ''}`)
		const expanded = await this.expandHashTargets(options.files)
		expanded.sort()

		for (const file of expanded) {
			try {
				if (existsSync(file)) {
					const content = await readFile(file, 'utf-8')
					if (options.baseDir && file.startsWith(options.baseDir))
						hash.update(relative(options.baseDir, file))
					else hash.update(file)
					hash.update(content)
				}
			} catch {
				// ignore transient fs errors while hashing
			}
		}

		return hash.digest('hex').slice(0, 16)
	}

	private async expandHashTargets(files: string[]): Promise<string[]> {
		const collected: string[] = []
		const visited = new Set<string>()

		const queue = [...files]
		for (const target of queue) {
			if (!target) continue
			if (visited.has(target)) continue
			visited.add(target)
			const stats = await stat(target).catch((): null => null)
			if (!stats) continue
			if (stats.isDirectory()) {
				const entries = await readdir(target)
				for (const entry of entries) {
					if (entry.startsWith('.')) continue
					if (
						entry.endsWith('~') ||
						entry.endsWith('.swp') ||
						entry.endsWith('.swo') ||
						entry.endsWith('.tmp')
					) {
						continue
					}
					const fullPath = join(target, entry)
					if (hasIgnoredHashPathSegment(fullPath)) continue
					const nestedStats = await stat(fullPath).catch((): null => null)
					if (!nestedStats) continue
					if (nestedStats.isDirectory()) queue.push(fullPath)
					else if (this.isHashableSourceFile(fullPath)) collected.push(fullPath)
				}
			} else if (this.isHashableSourceFile(target)) {
				collected.push(target)
			}
		}

		return collected
	}

	private async refreshWatchFiles(entry: PluginCompileEntry): Promise<void> {
		const environment = this.viteServer?.environments?.ssr
		if (!environment) return

		const absoluteEntry = this.resolvePluginFile(entry.entryBaseDir, entry.entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) return

		const root = environment.config.root
		let url = absoluteEntry
		if (url.startsWith(root)) url = url.slice(root.length)
		if (!url.startsWith('/')) url = '/' + url

		try {
			let rootModule = await environment.moduleGraph.getModuleByUrl(url)
			if (!rootModule || entry.graphDirty) {
				// Source graph collection is compiler metadata. Keep it in the SSR environment so UI
				// artifact discovery cannot enqueue partial batches in the browser dependency optimizer.
				await environment.transformRequest(url)
				rootModule = await environment.moduleGraph.getModuleByUrl(url)
			}
			if (!rootModule) return

			const nextFiles = collectSourceGraphFiles(rootModule, {
				include: (filePath) => this.isTrackedSourceFile(entry, filePath),
			})
			if (entry.paraglide) {
				for (const sourceRoot of entry.paraglide.sourceRoots) {
					if (!nextFiles.includes(sourceRoot)) nextFiles.push(sourceRoot)
				}
			}
			const nextSignature = nextFiles.join('\n')
			const prevSignature = entry.sourceFiles.join('\n')
			entry.graphDirty = false
			if (nextSignature === prevSignature) return

			entry.sourceFiles = nextFiles
			this.setupWatcher(entry.declarationKey, entry)
		} catch {
			// Keep previous watcher/hash targets on failure.
		}
	}

	private isHashableSourceFile(filePath: string): boolean {
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
		return HASH_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
	}

	private isTrackedSourceFile(entry: PluginCompileEntry, filePath: string): boolean {
		if (!this.isHashableSourceFile(filePath)) return false
		if (isParaglideGeneratedFile(entry.paraglide, filePath)) return false
		return true
	}

	private resolvePluginFile(
		pluginDir: string,
		targetPath: string | null | undefined,
	): string | null {
		if (!targetPath) return null
		if (isAbsolute(targetPath)) return targetPath
		return resolve(pluginDir, targetPath)
	}

	private findPluginDir(ctx: Context, pluginName: string): string | null {
		const configured = this.pluginDirs.get(pluginName)
		if (configured) return findNearestPackageRoot(configured) ?? configured

		const baseDir = this.findPluginEntryBaseDir(ctx, pluginName)
		if (baseDir) return findNearestPackageRoot(baseDir) ?? baseDir

		const loaderApi = (
			ctx as unknown as {
				loader?: {
					api?: {
						anchors?: { list?: () => Iterable<string> }
					}
				}
			}
		).loader?.api
		const needle = pluginName.toLowerCase()
		for (const path of loaderApi?.anchors?.list?.() ?? []) {
			if (path.toLowerCase().includes(needle) && isAbsolute(path)) {
				const pathBaseDir = dirname(path)
				return findNearestPackageRoot(pathBaseDir) ?? pathBaseDir
			}
		}
		return null
	}

	private findViteRootPluginDir(entryPath: string): string | null {
		const viteRoot = this.viteServer?.config.root
		if (!viteRoot) return null

		const root = isAbsolute(viteRoot) ? viteRoot : resolve(process.cwd(), viteRoot)
		const entry = this.resolvePluginFile(root, entryPath)
		if (!entry || !existsSync(entry)) return null
		return findNearestPackageRoot(root) ?? root
	}

	private findPluginEntryBaseDir(ctx: Context, pluginName: string): string | null {
		const registryPath = findRuntimeModuleId(ctx, pluginName)
		if (!registryPath) return null
		return resolveModuleIdBaseDir(registryPath)
	}
}
