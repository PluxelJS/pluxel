import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context } from '@pluxel/runtime'
import { getDebugLogger } from '@pluxel/runtime/logger'
import {
	createCompiledManagementArtifact,
	type ManagementArtifactStore,
	resolveModuleIdBaseDir,
	findRuntimeModuleId,
} from '@pluxel/runtime/internal'
import { findNearestPackageRoot } from '@pluxel/runtime/shared'
import {
	MANAGEMENT_FEDERATION_EXPOSE,
	MANAGEMENT_FEDERATION_MANIFEST_FILE,
	MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE,
	MANAGEMENT_FEDERATION_SHARE_STRATEGY,
	managementFederationSharedPackages,
	sanitizeManagementOwnerName,
} from '@pluxel/runtime/management/federation'
import {
	RUNTIME_INTERNAL_API_BASE,
	runtimeManagementArtifactBasePath,
} from '@pluxel/runtime/web/paths'
import {
	buildManagementUiRemote,
	resolveManagementFederationShared,
	resolveManagementUiBuildSignature,
} from '@pluxel/rolldown/vite/management-ui'
import { validateManagementUiArtifact } from '@pluxel/rolldown/management/artifact'
import type { InlineConfig, ViteDevServer } from 'vite'
import {
	isParaglideGeneratedFile,
	resolveParaglideIntegration,
	type ResolvedParaglideIntegration,
} from '@pluxel/rolldown/vite/paraglide'
import { watch, type FSWatcher } from 'chokidar'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'

import { collectModuleGraphFiles } from './moduleGraph'

export type ManagementCompilerServiceConfig = {
	enabled?: boolean
	/**
	 * Disk cache directory for compiled management UI modules.
	 *
	 * Defaults to `.pluxel/management` under `process.cwd()`.
	 */
	cacheDir?: string
	/**
	 * How many compiled remote builds to keep per plugin on disk.
	 * Keep a few historical hashes so open tabs / inflight MF loads do not trip over
	 * freshly evicted artifacts during rapid rebuilds.
	 * @default 5
	 */
	cacheKeep?: number
	/**
	 * Maximum number of management UI remotes compiled concurrently.
	 * @default 2
	 */
	compileConcurrency?: number
	/**
	 * Override the shared package list exposed by the host runtime.
	 *
	 * Defaults to `@pluxel/runtime/web`'s `managementFederationSharedPackages`.
	 */
	sharedPackages?: string[]
	/**
	 * Explicit plugin package directories keyed by plugin name.
	 *
	 * Static hosts do not have a dynamic loader anchor table, so Vite/static
	 * integrations can provide these after loading the fixed catalog.
	 */
	pluginDirs?: Record<string, string>
	/** Extra Vite config merged into management UI remote builds. */
	vite?: InlineConfig
	/** Explicit cache key for behavior/options hidden inside user Vite plugin closures. */
	viteCacheKey?: string
}

export type ManagementCompilerViteServer = {
	config: Pick<ViteDevServer['config'], 'root'>
	moduleGraph?: Pick<ViteDevServer['moduleGraph'], 'getModuleByUrl'>
	transformRequest?: ViteDevServer['transformRequest']
}

export type ManagementCompilerServiceDeps = {
	store: ManagementArtifactStore
	viteServer?: ManagementCompilerViteServer
	enabled?: boolean
}

type PluginCompileEntry = {
	pluginName: string
	pluginDir: string
	entryBaseDir: string
	entryPath: string
	sourceFiles: string[]
	paraglide: ResolvedParaglideIntegration | null
	graphDirty: boolean
	active: boolean
	watcher?: FSWatcher | null
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

// Bump when federation build semantics change (invalidates sourceHash cache key).
const MANAGEMENT_COMPILER_VERSION = 15

export class ManagementCompilerService {
	private readonly enabled: boolean
	private readonly dbg: LogtapeLogger
	private readonly store: ManagementArtifactStore
	private readonly viteServer?: ManagementCompilerViteServer
	private readonly cacheDir: string
	private readonly cacheKeep: number
	private readonly compileConcurrency: number
	private readonly sharedPackages?: readonly string[]
	private readonly pluginDirs: ReadonlyMap<string, string>
	private readonly vite?: InlineConfig
	private readonly viteCacheKey?: string

	private readonly entries = new Map<string, PluginCompileEntry>()
	private pendingPlugins = new Set<string>()
	private inflightPlugins = new Set<string>()
	private flushTimer: NodeJS.Timeout | null = null
	private flushPromise: Promise<void> | null = null
	private readonly compileTasks = new Map<string, Promise<boolean>>()

	constructor(
		public ctx: Context,
		deps: ManagementCompilerServiceDeps,
		config?: ManagementCompilerServiceConfig,
	) {
		this.store = deps.store
		this.viteServer = deps.viteServer
		this.enabled = (deps.enabled ?? true) && config?.enabled !== false
		this.cacheDir = config?.cacheDir ?? resolve(process.cwd(), '.pluxel/management')
		this.cacheKeep = Math.max(0, Math.floor(config?.cacheKeep ?? 5))
		this.compileConcurrency = Math.max(1, Math.floor(config?.compileConcurrency ?? 2))
		this.sharedPackages = config?.sharedPackages
		this.pluginDirs = new Map(Object.entries(config?.pluginDirs ?? {}))
		this.vite = config?.vite
		this.viteCacheKey = config?.viteCacheKey
		const logger = (this.ctx as unknown as { logger?: unknown }).logger
		const fn =
			logger && typeof logger === 'object'
				? (logger as Record<string, unknown>).getDebugChannel
				: undefined
		this.dbg =
			typeof fn === 'function'
				? (fn as (t: string) => LogtapeLogger).call(logger, 'pluxel:management:compile')
				: getDebugLogger('pluxel:management:compile').with({
						name: 'management',
						context: this.ctx?.name ?? 'hmr',
					})
	}

	bindDeclaration(ctx: Context, config: { entryPath: string }): () => void {
		if (!this.enabled) return () => {}
		const store = this.store

		const pluginName = ctx.pluginInfo.id

		const existing = this.entries.get(pluginName)
		if (existing) {
			this.disposeWatcher(existing)
		}

		let pluginDir = this.findPluginDir(ctx, pluginName)
		if (!pluginDir && isAbsolute(config.entryPath)) {
			pluginDir = dirname(config.entryPath)
		}
		if (!pluginDir) {
			pluginDir = this.findViteRootPluginDir(config.entryPath)
		}
		if (!pluginDir) throw new Error(`无法定位插件目录: ${pluginName}`)
		const entryBaseDir = this.findPluginEntryBaseDir(ctx, pluginName) ?? pluginDir

		const sourceFiles = this.collectSourceFiles(entryBaseDir, pluginDir, config.entryPath)
		const entry: PluginCompileEntry = {
			pluginName,
			pluginDir,
			entryBaseDir,
			entryPath: config.entryPath,
			sourceFiles,
			paraglide: resolveParaglideIntegration(pluginDir),
			graphDirty: true,
			active: true,
			watcher: null,
		}

		this.entries.set(pluginName, entry)
		this.setupWatcher(pluginName, entry)
		this.enqueueCompile(pluginName)

		const guard = ctx.effects.defer(() => {
			const stored = this.entries.get(pluginName)
			if (stored !== entry) return
			stored.active = false
			this.disposeWatcher(stored)
			this.pendingPlugins.delete(pluginName)
			this.entries.delete(pluginName)
			void store.removePlugin(pluginName)
		})
		return () => guard.dispose()
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
	}

	async requestCompile(pluginName: string): Promise<void> {
		if (!this.enabled) return
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
				{ length: Math.min(this.compileConcurrency, Math.max(this.pendingPlugins.size, 1)) },
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
		const entry = this.entries.get(pluginName)
		if (!entry) return false

		this.dbg.debug('compile start {pluginName}', { pluginName })
		try {
			await this.refreshWatchFiles(entry)
			const sharedPackages = this.getSharedPackages()
			const sourceHash = await this.computeSourceHash(
				entry.sourceFiles,
				sharedPackages,
				entry.pluginDir,
				resolveManagementUiBuildSignature(this.vite, this.viteCacheKey),
			)
			const current = store.getCompiledModule(pluginName)
			if (current?.sourceHash === sourceHash) {
				await store.commitCompiledModule(current)
				this.dbg.debug('compile done {pluginName} (cached)', { pluginName })
				return true
			}
			await store.markCompiling?.(pluginName, {
				updatedAt: Date.now(),
				sourceHash: current?.sourceHash,
				compiledAt: current?.compiledAt,
			})

			const manifestFile = this.getManifestFilePath(pluginName, sourceHash)
			if (manifestFile && existsSync(manifestFile)) {
				const manifestStats = await stat(manifestFile).catch((): null => null)
				const cachedDir = this.getCachedModuleDirPath(pluginName, sourceHash)
				const validation = cachedDir
					? await validateManagementUiArtifact(cachedDir, pluginName)
					: { valid: false as const }
				if (manifestStats?.isFile() && validation.valid) {
					await store.commitCompiledModule(
						createCompiledManagementArtifact({
							pluginName,
							sourceHash,
							compiledAt: Math.floor(manifestStats.mtimeMs || Date.now()),
						}),
						{ artifactRoot: cachedDir },
					)
					if (this.cacheKeep > 0) void this.cleanupCacheDir(pluginName)
					this.dbg.debug('compile done {pluginName} (cached:disk)', { pluginName })
					return true
				}
			}

			const built = await this.buildFederatedRemote(entry, sharedPackages, sourceHash)
			await store.commitCompiledModule(
				createCompiledManagementArtifact({
					pluginName,
					sourceHash,
					compiledAt: built.compiledAt,
				}),
				{ artifactRoot: built.outDir },
			)
			if (this.cacheKeep > 0) void this.cleanupCacheDir(pluginName)
			this.dbg.debug('compile done {pluginName}', { pluginName })
			return true
		} catch (error) {
			const current = store.getCompiledModule(pluginName)
			await store.markCompileError?.(pluginName, error, {
				updatedAt: Date.now(),
				sourceHash: current?.sourceHash,
				compiledAt: current?.compiledAt,
			})
			this.ctx.logger.error('failed to compile {pluginName}', { pluginName, error })
			return false
		}
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
		return join(this.cacheDir, sanitizeManagementOwnerName(pluginName))
	}

	private getCachedModuleDirPath(pluginName: string, sourceHash: string): string | null {
		if (this.cacheKeep <= 0) return null
		return join(this.getPluginCacheDir(pluginName), sourceHash)
	}

	private getManifestFilePath(pluginName: string, sourceHash: string): string | null {
		const dir = this.getCachedModuleDirPath(pluginName, sourceHash)
		return dir ? join(dir, MANAGEMENT_FEDERATION_MANIFEST_FILE) : null
	}

	private async cleanupCacheDir(pluginName: string): Promise<void> {
		if (this.cacheKeep <= 0) return
		const dir = this.getPluginCacheDir(pluginName)
		const entries = await readdir(dir).catch((): string[] => [])
		if (entries.length === 0) return

		const builds: Array<{ path: string; mtime: number }> = []
		for (const name of entries) {
			const full = join(dir, name)
			const manifestFile = join(full, MANAGEMENT_FEDERATION_MANIFEST_FILE)
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
		sharedPackages: readonly string[],
		sourceHash: string,
	): Promise<{ compiledAt: number; outDir: string }> {
		const absoluteEntry = this.resolvePluginFile(entry.entryBaseDir, entry.entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) {
			throw new Error(`Entry file not found: ${absoluteEntry}`)
		}

		const outDir = this.getCachedModuleDirPath(entry.pluginName, sourceHash)
		if (!outDir) throw new Error('Management UI compiler cacheDir is disabled')

		await rm(outDir, { recursive: true, force: true }).catch((): undefined => undefined)
		await mkdir(outDir, { recursive: true })

		const publicPath = `${RUNTIME_INTERNAL_API_BASE}${runtimeManagementArtifactBasePath(entry.pluginName, sourceHash)}/`
		await buildManagementUiRemote({
			root: entry.pluginDir,
			pluginName: entry.pluginName,
			entryPath: absoluteEntry,
			outDir,
			publicPath,
			sharedPackages,
			minify: false,
			vite: this.vite,
			cacheKey: this.viteCacheKey,
		})
		const validation = await validateManagementUiArtifact(outDir, entry.pluginName)
		if (!validation.valid) {
			throw new Error(
				`Incomplete management UI artifact: ${'reason' in validation ? validation.reason : 'unknown validation failure'}`,
			)
		}

		const manifestFile = join(outDir, MANAGEMENT_FEDERATION_MANIFEST_FILE)
		const manifestContent = await readFile(manifestFile, 'utf-8').catch((): null => null)
		if (!manifestContent) {
			throw new Error(`Module federation manifest not found for ${entry.pluginName}`)
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

	private getSharedPackages(): readonly string[] {
		const configured = this.sharedPackages
		if (Array.isArray(configured) && configured.length > 0) return configured
		return managementFederationSharedPackages
	}

	private collectSourceFiles(entryBaseDir: string, pluginDir: string, entryPath: string): string[] {
		const entryFile = this.resolvePluginFile(entryBaseDir, entryPath)
		const paraglide = resolveParaglideIntegration(pluginDir)
		const sourceFiles = entryFile ? [entryFile] : []
		if (paraglide) sourceFiles.push(...paraglide.sourceRoots)
		return [...new Set(sourceFiles)]
	}

	private async computeSourceHash(
		files: string[],
		sharedPackages: readonly string[],
		baseDir?: string,
		uiBuildSignature?: string,
	): Promise<string> {
		const hash = createHash('sha256')
		hash.update(`compiler:${MANAGEMENT_COMPILER_VERSION}`)
		const sharedSignature = baseDir
			? resolveManagementFederationShared(baseDir, sharedPackages).signature
			: [...sharedPackages].join('|')
		hash.update(`shared:${sharedSignature}`)
		hash.update(`shareStrategy:${MANAGEMENT_FEDERATION_SHARE_STRATEGY}`)
		hash.update(`remoteEntry:${MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE}`)
		hash.update(`expose:${MANAGEMENT_FEDERATION_EXPOSE}`)
		if (uiBuildSignature) hash.update(`ui:${uiBuildSignature}`)
		const expanded = await this.expandHashTargets(files)
		expanded.sort()

		for (const file of expanded) {
			try {
				if (existsSync(file)) {
					const content = await readFile(file, 'utf-8')
					if (baseDir && file.startsWith(baseDir)) hash.update(relative(baseDir, file))
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
					if (HASH_IGNORED_SEGMENTS.some((segment) => fullPath.includes(segment))) continue
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
		const vite = this.viteServer
		if (!vite) return
		if (!vite.moduleGraph || !vite.transformRequest) return

		const absoluteEntry = this.resolvePluginFile(entry.entryBaseDir, entry.entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) return

		const root = vite.config.root
		let url = absoluteEntry
		if (url.startsWith(root)) url = url.slice(root.length)
		if (!url.startsWith('/')) url = '/' + url

		try {
			let rootModule = await vite.moduleGraph.getModuleByUrl(url)
			if (!rootModule || entry.graphDirty) {
				await vite.transformRequest(url)
				rootModule = await vite.moduleGraph.getModuleByUrl(url)
			}
			if (!rootModule) return

			const nextFiles = collectModuleGraphFiles(rootModule, {
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
			this.setupWatcher(entry.pluginName, entry)
		} catch {
			// Keep previous watcher/hash targets on failure.
		}
	}

	private isHashableSourceFile(filePath: string): boolean {
		const lower = filePath.toLowerCase()
		if (HASH_IGNORED_SEGMENTS.some((segment) => lower.includes(segment))) return false
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
