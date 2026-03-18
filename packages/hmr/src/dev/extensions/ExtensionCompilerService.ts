import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context } from '@pluxel/core'
import { getDebugLogger } from '@pluxel/core/logger'
import {
	looksLikeBrokenExtensionBundle,
	normalizeJsxRuntime,
	toBrowserBundleResolve,
	transformVendorImports,
	type ExtensionCompilerApi,
	type ExtensionModuleStore,
} from '@pluxel/runtime/internal'
import type { PluginExtensionConfig } from '@pluxel/runtime/web'
import { extensionVendorPackages } from '@pluxel/runtime/web/vendors'
import chokidar, { type FSWatcher } from 'chokidar'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'
import type { ResolveOptions } from 'vite'

import { collectModuleGraphFiles } from '../compile/bundler/moduleGraph'
import { BundlerService } from '../compile/bundler/BundlerService'
import { HMRService } from '../hmr/HMRService'

export type ExtensionCompilerServiceConfig = {
	enabled?: boolean
	/**
	 * Disk cache directory for compiled extension modules.
	 *
	 * Defaults to `.pluxel/extensions` under `process.cwd()`.
	 */
	cacheDir?: string
	/**
	 * How many compiled modules to keep per plugin on disk.
	 * @default 2
	 */
	cacheKeep?: number
	/**
	 * Override the vendor package list externalized from extension bundles.
	 *
	 * Defaults to `@pluxel/runtime/web`'s `extensionVendorPackages`.
	 */
	vendorPackages?: string[]
}

type PluginCompileEntry = {
	pluginName: string
	pluginDir: string
	entryPath: string
	sourceFiles: string[]
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

// Bump when bundling/rewriting logic changes (invalidates sourceHash cacheKey).
const EXTENSION_COMPILER_VERSION = 10

export class ExtensionCompilerService implements ExtensionCompilerApi {
	private readonly enabled: boolean
	private readonly dbg: LogtapeLogger
	private store: ExtensionModuleStore | null = null
	private readonly hmr: HMRService
	private readonly bundler: BundlerService
	private readonly cacheDir: string
	private readonly cacheKeep: number

	private readonly entries = new Map<string, PluginCompileEntry>()
	private pendingPlugins = new Set<string>()
	private flushTimer: NodeJS.Timeout | null = null
	private flushPromise: Promise<void> | null = null

	constructor(
		public ctx: Context,
		deps: {
			hmr: HMRService
			bundler: BundlerService
			enabled?: boolean
		},
		config?: ExtensionCompilerServiceConfig,
	) {
		this.hmr = deps.hmr
		this.bundler = deps.bundler
		this.enabled = (deps.enabled ?? true) && config?.enabled !== false
		this.cacheDir = config?.cacheDir ?? resolve(process.cwd(), '.pluxel/extensions')
		this.cacheKeep = Math.max(0, Math.floor(config?.cacheKeep ?? 2))
		const logger = (this.ctx as unknown as { logger?: unknown }).logger
		const fn =
			logger && typeof logger === 'object'
				? (logger as Record<string, unknown>).getDebugChannel
				: undefined
		this.dbg =
			typeof fn === 'function'
				? (fn as (t: string) => LogtapeLogger).call(logger, 'pluxel:ext:compile')
				: getDebugLogger('pluxel:ext:compile').with({
						name: 'extensions',
						context: this.ctx?.name ?? 'hmr',
					})
	}

	attachStore(store: ExtensionModuleStore): void {
		this.store = store
	}

	bindModule(ctx: Context, config: PluginExtensionConfig): () => void {
		if (!this.enabled) return () => undefined
		const store = this.store
		if (!store) return () => undefined

		const pluginName = ctx.pluginInfo.id

		const existing = this.entries.get(pluginName)
		if (existing) {
			this.disposeWatcher(existing)
		}

		let pluginDir = this.findPluginDir(ctx, pluginName)
		if (!pluginDir && isAbsolute(config.entryPath)) {
			pluginDir = dirname(config.entryPath)
		}
		if (!pluginDir) throw new Error(`无法定位插件目录: ${pluginName}`)

		const sourceFiles = this.collectSourceFiles(pluginDir, config.entryPath)
		const entry: PluginCompileEntry = {
			pluginName,
			pluginDir,
			entryPath: config.entryPath,
			sourceFiles,
			active: true,
			watcher: null,
		}

		this.entries.set(pluginName, entry)
		this.setupWatcher(pluginName, entry)
		this.enqueueCompile(pluginName)

		const guard = ctx.effects.defer(() => {
			const stored = this.entries.get(pluginName)
			if (!stored) return
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
			const queue = [...this.pendingPlugins]
			for (const pluginName of queue) {
				const entry = this.entries.get(pluginName)
				if (!entry || !entry.active) {
					this.pendingPlugins.delete(pluginName)
					continue
				}
				await this.compilePlugin(pluginName)
				this.pendingPlugins.delete(pluginName)
			}
		})()

		this.flushPromise = task
		await task
		this.flushPromise = null
	}

	private async compilePlugin(pluginName: string): Promise<boolean> {
		const store = this.store
		if (!store) return false
		const entry = this.entries.get(pluginName)
		if (!entry) return false

		this.dbg.debug('compile start {pluginName}', { pluginName })
		try {
			await this.refreshWatchFiles(entry)
			const vendorPackages = this.getVendorPackages()
			const sourceHash = await this.computeSourceHash(
				entry.sourceFiles,
				vendorPackages,
				entry.pluginDir,
			)
			const current = store.getCompiledModule(pluginName)
			if (current?.sourceHash === sourceHash) {
				this.dbg.debug('compile done {pluginName} (cached)', { pluginName })
				return true
			}

			const cachedFile = this.getCachedModuleFilePath(pluginName, sourceHash)
			if (cachedFile && existsSync(cachedFile)) {
				const [cachedCode, cachedStats] = await Promise.all([
					readFile(cachedFile, 'utf-8').catch((): null => null),
					stat(cachedFile).catch((): null => null),
				])
				if (cachedCode && !looksLikeBrokenExtensionBundle(cachedCode)) {
					const compiledAt =
						cachedStats?.mtimeMs !== undefined ? Math.floor(cachedStats.mtimeMs) : Date.now()
					await store.commitCompiledModule(pluginName, sourceHash, cachedCode, compiledAt)
					if (this.cacheKeep > 0) void this.cleanupCacheDir(pluginName)
					this.dbg.debug('compile done {pluginName} (cached:disk)', { pluginName })
					return true
				}
				// Invalid cache entry: delete and fall through to recompile.
				await rm(cachedFile, { force: true }).catch((): undefined => undefined)
			}

			const code = await this.bundleEntry(entry, vendorPackages)
			if (looksLikeBrokenExtensionBundle(code)) {
				this.ctx.logger.error('compiled extension bundle looks invalid; skipping cache', {
					pluginName,
					sourceHash,
				})
				return false
			}
			await store.commitCompiledModule(pluginName, sourceHash, code)
			if (cachedFile && this.cacheKeep > 0) {
				await this.writeCachedModule(cachedFile, code).catch((): undefined => undefined)
				void this.cleanupCacheDir(pluginName)
			}
			this.dbg.debug('compile done {pluginName}', { pluginName })
			return true
		} catch (error) {
			this.ctx.logger.error('failed to compile {pluginName}', { pluginName, error })
			return false
		}
	}

	private getCachedModuleFilePath(pluginName: string, sourceHash: string): string | null {
		if (this.cacheKeep <= 0) return null
		const dir = join(this.cacheDir, sanitizePluginName(pluginName))
		return join(dir, `${sourceHash}.mjs`)
	}

	private async writeCachedModule(path: string, code: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, code, 'utf-8')
	}

	private async cleanupCacheDir(pluginName: string): Promise<void> {
		if (this.cacheKeep <= 0) return
		const dir = join(this.cacheDir, sanitizePluginName(pluginName))
		const entries = await readdir(dir).catch((): string[] => [])
		if (!entries.length) return

		const modules: Array<{ path: string; mtime: number }> = []
		for (const name of entries) {
			if (!name.endsWith('.mjs')) continue
			const full = join(dir, name)
			const st = await stat(full).catch((): null => null)
			if (!st?.isFile()) continue
			modules.push({ path: full, mtime: st.mtimeMs ?? 0 })
		}

		modules.sort((a, b) => b.mtime - a.mtime)
		for (const stale of modules.slice(this.cacheKeep)) {
			await rm(stale.path, { force: true }).catch((): undefined => undefined)
		}
	}

	private async bundleEntry(
		entry: PluginCompileEntry,
		vendorPackages: readonly string[],
	): Promise<string> {
		const vite = this.hmr.vite
		if (!vite) throw new Error('ViteDevServer not initialized')

		const absoluteEntry = this.resolvePluginFile(entry.pluginDir, entry.entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) {
			throw new Error(`Entry file not found: ${absoluteEntry}`)
		}

		const resolveForBrowserBundle = toBrowserBundleResolve(vite.config.resolve as ResolveOptions)
		const bundled = (
			await this.bundler.bundle({
				label: entry.pluginName,
				target: 'browser',
				entry: absoluteEntry,
				root: vite.config.root,
				resolve: resolveForBrowserBundle,
				external: Array.from(vendorPackages),
			})
		).code

		return normalizeJsxRuntime(transformVendorImports(bundled, vendorPackages))
	}

	private setupWatcher(pluginName: string, entry: PluginCompileEntry): void {
		this.disposeWatcher(entry)
		const targets = Array.from(new Set(entry.sourceFiles))
		if (!targets.length) {
			entry.watcher = null
			return
		}
		const watcher = chokidar.watch(targets, {
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			ignored: WATCHER_IGNORED_GLOBS,
		})
		const handleChange = () => {
			if (!entry.active) return
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

	private getVendorPackages(): readonly string[] {
		const configured = (this.ctx.config as any)?.extensionCompiler?.vendorPackages
		return Array.isArray(configured) && configured.length ? configured : extensionVendorPackages
	}

	private collectSourceFiles(pluginDir: string, entryPath: string): string[] {
		const entryFile = this.resolvePluginFile(pluginDir, entryPath)
		return entryFile ? [entryFile] : []
	}

	private async computeSourceHash(
		files: string[],
		vendorPackages: readonly string[],
		baseDir?: string,
	): Promise<string> {
		const hash = createHash('sha256')
		hash.update(`compiler:${EXTENSION_COMPILER_VERSION}`)
		hash.update(`vendors:${Array.from(vendorPackages).join('|')}`)
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

		const queue = files.slice()
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
		const vite = this.hmr.vite
		if (!vite) return

		const absoluteEntry = this.resolvePluginFile(entry.pluginDir, entry.entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) return

		const root = vite.config.root
		let url = absoluteEntry
		if (url.startsWith(root)) url = url.slice(root.length)
		if (!url.startsWith('/')) url = '/' + url

		try {
			await vite.transformRequest(url)
			const rootModule = await vite.moduleGraph.getModuleByUrl(url)
			if (!rootModule) return

			const nextFiles = collectModuleGraphFiles(rootModule, {
				include: (filePath) => this.isHashableSourceFile(filePath),
			})
			const nextSignature = nextFiles.join('\n')
			const prevSignature = entry.sourceFiles.join('\n')
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

	private resolvePluginFile(
		pluginDir: string,
		targetPath: string | null | undefined,
	): string | null {
		if (!targetPath) return null
		if (isAbsolute(targetPath)) return targetPath
		return resolve(pluginDir, targetPath)
	}

	private findPluginDir(ctx: Context, pluginName: string): string | null {
		const registryPath = ctx.loader.api.registry.findModuleIdByName(pluginName)
		if (registryPath) return dirname(registryPath)

		const needle = pluginName.toLowerCase()
		for (const path of ctx.loader.api.anchors.list()) {
			if (path.toLowerCase().includes(needle)) return dirname(path)
		}
		return null
	}
}

function sanitizePluginName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
