import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, getPluginInfo } from '@pluxel/core'
import { getDebugLogger } from '@pluxel/core/logger'
import type {
	BuiltinDocExtensionDef,
	BuiltinExtensionDef,
	CompiledExtensionModule,
	ExtensionManifest,
	ExtensionManifestEvent,
	ExtensionPoint,
	PluginExtensionConfig,
} from '@pluxel/hmr-web'
import { extensionVendorPackages } from '@pluxel/hmr-web'
import chokidar, { type FSWatcher } from 'chokidar'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'
import type { ResolveOptions } from 'vite'
import { collectModuleGraphFiles } from '../runtime-compile/bundler/moduleGraph'
import {
	looksLikeLegacyBrokenBundle,
	normalizeJsxRuntime,
	toBrowserBundleResolve,
	transformVendorImports,
} from './extensionBundleTransform'

export interface ExtensionServiceConfig {
	outDir?: string
	enabled?: boolean
	/**
	 * Packages provided by the host app (via `window.__PLUXEL_VENDORS__`).
	 *
	 * These are externalized from extension bundles and rewritten to global lookups.
	 */
	vendorPackages?: string[]
}

interface PluginExtensionEntry {
	pluginName: string
	pluginDir: string
	entryPath: string
	sourceFiles: string[]
	lastCompiledAt?: number
	lastSourceHash?: string
	modulePath?: string
	moduleUrl?: string
	active: boolean
	watcher?: FSWatcher | null
}

const WATCHER_IGNORED_GLOBS = [
	'**/node_modules/**',
	'**/.git/**',
	'**/.turbo/**',
	'**/.pluxel/**',
	'**/dist/**',
	'**/build/**',
	// editor/temp files
	'**/.*',
	'**/*.swp',
	'**/*.swo',
	'**/*.tmp',
	'**/*~',
] as const

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
const MODULE_FILE_EXTENSION = '.mjs'
const MODULE_RETENTION_COUNT = 2
const MODULE_ENDPOINT_PREFIX = '/api/extensions/modules'
const MANIFEST_FILENAME = 'manifest.json'

// Bump this when the bundling/rewriting logic changes, so clients don't reuse stale cached modules.
const EXTENSION_COMPILER_VERSION = 10

export class ExtensionService {
	private readonly entries = new Map<string, PluginExtensionEntry>()
	private readonly builtinByPlugin = new Map<string, Map<string, BuiltinExtensionDef>>()
	private readonly outDir: string
	private readonly manifestPath: string
	private readonly dbg: LogtapeLogger
	private readonly enabled: boolean
	private readonly vendorPackages: readonly string[]
	private manifestVersion = 0
	private manifest: ExtensionManifest = {
		version: 0,
		modules: [],
	}
	private pendingPlugins = new Set<string>()
	private flushTimer: NodeJS.Timeout | null = null
	private flushPromise: Promise<void> | null = null
	private manifestListeners = new Set<(event: ExtensionManifestEvent) => void>()

	constructor(
		public ctx: Context,
		config?: ExtensionServiceConfig,
	) {
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
		this.enabled = config?.enabled !== false
		this.outDir = config?.outDir ?? resolve(process.cwd(), '.pluxel/extensions')
		this.manifestPath = join(this.outDir, MANIFEST_FILENAME)
		this.vendorPackages = config?.vendorPackages?.length
			? config.vendorPackages
			: extensionVendorPackages

		this.ctx.events.on('afterCommit', async (summary) => {
			await this.onAfterCommit(summary)
		})

		if (this.enabled) {
			void this.restorePersistedManifest()
		}
	}

	subscribeManifest(callback: (event: ExtensionManifestEvent) => void): () => void {
		this.manifestListeners.add(callback)
		return () => this.manifestListeners.delete(callback)
	}

	getManifest(): ExtensionManifest {
		if (!this.enabled) return { version: 0, modules: [], builtins: [] }
		return {
			...this.manifest,
			builtins: this.getBuiltinsSnapshot(),
		}
	}

	async getModuleSource(pluginName: string, sourceHash: string): Promise<string | null> {
		if (!this.enabled) return null
		const file = this.getModuleFilePath(pluginName, sourceHash)
		if (existsSync(file)) {
			const code = await readFile(file, 'utf-8').catch(() => null)
			if (code && !looksLikeLegacyBrokenBundle(code)) {
				return code
			}
			// 老编译器产物可能存在非法语法（例如解构里出现 `as`），这里主动触发重新编译并让前端刷新 manifest
			await unlink(file).catch(() => undefined)
		}

		// 自愈：如果磁盘文件丢失，尝试重新编译，并在失败时清理掉陈旧清单
		const entry = this.entries.get(pluginName)
		if (entry) {
			await this.compilePlugin(pluginName)
			const nextHash = entry.lastSourceHash
			const nextPath = nextHash ? this.getModuleFilePath(pluginName, nextHash) : null
			if (nextPath && existsSync(nextPath)) {
				if (nextHash === sourceHash) {
					return readFile(nextPath, 'utf-8')
				}
				// 旧 hash：让前端重新拉最新 manifest
				return null
			}
		}

		this.removeManifestEntry(pluginName)
		return null
	}

	/**
	 * 注册插件 UI 扩展（自动从当前 Context 获取 pluginName）
	 */
	register(config: PluginExtensionConfig): () => void {
		if (!this.enabled) return () => undefined
		const pluginName = this.ctx.pluginInfo.id

		const existing = this.entries.get(pluginName)
		if (existing) {
			this.disposeWatcher(existing)
		}

		let pluginDir = this.findPluginDir(pluginName)
		// Builtins may not have a resolvable module id. Allow plugins to provide an absolute entryPath.
		if (!pluginDir && isAbsolute(config.entryPath)) {
			pluginDir = dirname(config.entryPath)
		}
		if (!pluginDir) throw new Error(`无法定位插件目录: ${pluginName}`)
		const sourceFiles = this.collectSourceFiles(pluginDir, config.entryPath)
		const entry: PluginExtensionEntry = {
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

		const guard = this.ctx.effects.defer(() => {
			const stored = this.entries.get(pluginName)
			if (!stored) return
			stored.active = false
			this.disposeWatcher(stored)
			this.pendingPlugins.delete(pluginName)
			this.entries.delete(pluginName)
			void this.handlePluginRemoval(pluginName, stored)
		})
		return () => guard.dispose()
	}

	/**
	 * Register a host-rendered (JSON-serializable) UI extension, without shipping a plugin UI module.
	 *
	 * Designed for markdown docs with builtin blocks that should not require `await import()`.
	 */
	registerBuiltin(def: Omit<BuiltinExtensionDef, 'pluginName'>): () => void {
		if (!this.enabled) return () => undefined
		const pluginName = this.ctx.pluginInfo.id
		const id = String(def.id ?? '').trim()
		const point = String(def.point ?? '').trim()
		const kind = String(def.kind ?? '').trim()
		if (!id) throw new Error('[ExtensionService] registerBuiltin: id required')
		if (!point) throw new Error('[ExtensionService] registerBuiltin: point required')
		if (!kind) throw new Error('[ExtensionService] registerBuiltin: kind required')
		const key = `${point}:${id}`

		const normalized: BuiltinExtensionDef = {
			...def,
			id,
			point: point as ExtensionPoint,
			kind: kind as BuiltinExtensionDef['kind'],
			pluginName,
		}
		try {
			// Builtins must be JSON-serializable so the manifest can be safely transported
			// and remain frontend-implementation-agnostic.
			JSON.stringify(normalized)
		} catch (_err) {
			throw new Error(
				`[ExtensionService] registerBuiltin: def must be JSON-serializable (id=${id}, point=${point}, kind=${kind})`,
			)
		}

		let bucket = this.builtinByPlugin.get(pluginName)
		if (!bucket) {
			bucket = new Map()
			this.builtinByPlugin.set(pluginName, bucket)
		}
		bucket.set(key, normalized)
		this.bumpManifestVersion('builtin')

		const guard = this.ctx.effects.defer(() => {
			const current = this.builtinByPlugin.get(pluginName)
			if (!current) return
			const existing = current.get(key)
			if (existing !== normalized) return
			current.delete(key)
			if (current.size === 0) this.builtinByPlugin.delete(pluginName)
			this.bumpManifestVersion('builtin')
		})
		return () => guard.dispose()
	}

	doc<P extends ExtensionPoint = 'plugin:tabs'>(
		input: Omit<BuiltinDocExtensionDef<P>, 'kind' | 'pluginName' | 'point'> & { point?: P },
	): () => void {
		const { point, ...rest } = input
		return this.registerBuiltin({
			kind: 'doc',
			point: (point ?? ('plugin:tabs' as P)) as P,
			...(rest as unknown as Record<string, unknown>),
		})
	}

	invalidate(pluginName: string): void {
		const entry = this.entries.get(pluginName)
		if (!entry) return
		entry.active = true
		this.enqueueCompile(pluginName)
	}

	subscribe(_cb: () => void): () => void {
		// no-op placeholder to preserve API compatibility
		return () => undefined
	}

	hasPendingCompilation(): boolean {
		return this.pendingPlugins.size > 0
	}

	private notifyManifest(event: ExtensionManifestEvent): void {
		for (const listener of this.manifestListeners) {
			try {
				listener(event)
			} catch (error) {
				this.ctx.logger.error('manifest listener failed', { error })
			}
		}
	}

	private enqueueCompile(pluginName: string): void {
		const entry = this.entries.get(pluginName)
		if (!entry) return
		this.pendingPlugins.add(pluginName)
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null
				void this.flushPending()
			}, 100)
		}
	}

	private async flushPending(runningPlugins?: Set<string>): Promise<void> {
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
				if (runningPlugins && !runningPlugins.has(pluginName)) {
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
		const entry = this.entries.get(pluginName)
		if (!entry) return false

		this.dbg.debug('compile start {pluginName}', { pluginName })
		try {
			await this.refreshWatchFiles(entry)
			const sourceHash = await this.computeSourceHash(entry.sourceFiles, entry.pluginDir)
			const targetFile = this.getModuleFilePath(pluginName, sourceHash)
			const moduleUrl = this.getModuleUrl(pluginName, sourceHash)

			if (existsSync(targetFile)) {
				const stats = await stat(targetFile).catch(() => null)
				entry.lastCompiledAt = stats ? Math.floor(stats.mtimeMs) : Date.now()
				entry.lastSourceHash = sourceHash
				entry.modulePath = targetFile
				entry.moduleUrl = moduleUrl
				void this.cleanupOldModuleFiles(pluginName, MODULE_RETENTION_COUNT)
				this.handleManifestUpdate(pluginName, entry)
				this.dbg.debug('compile done {pluginName} (cached)', { pluginName })
				return true
			}

			const code = await this.generateBundle(entry, entry.entryPath)
			await mkdir(dirname(targetFile), { recursive: true })
			await writeFile(targetFile, code, 'utf-8')
			void this.cleanupOldModuleFiles(pluginName, MODULE_RETENTION_COUNT)
			entry.lastCompiledAt = Date.now()
			entry.lastSourceHash = sourceHash
			entry.modulePath = targetFile
			entry.moduleUrl = moduleUrl
			this.handleManifestUpdate(pluginName, entry)
			this.dbg.debug('compile done {pluginName}', { pluginName })
			return true
		} catch (error) {
			this.ctx.logger.error('failed to compile {pluginName}', { pluginName, error })
			return false
		}
	}

	private async onAfterCommit(summary: import('@pluxel/core').CommitSummary) {
		if (!this.pendingPlugins.size) return
		const runningPlugins = new Set<string>()
		for (const [id] of summary.container.services) {
			try {
				const info = getPluginInfo(id as unknown as (...args: never[]) => unknown)
				if (this.pendingPlugins.has(info.id)) {
					runningPlugins.add(info.id)
				}
			} catch {
				// ignore non-plugin service ids
			}
		}
		if (!runningPlugins.size) return
		await this.flushPending(runningPlugins)
	}

	private setupWatcher(pluginName: string, entry: PluginExtensionEntry): void {
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

	private disposeWatcher(entry: PluginExtensionEntry): void {
		if (entry.watcher) {
			entry.watcher.close().catch(() => undefined)
			entry.watcher = null
		}
	}

	private async generateBundle(entry: PluginExtensionEntry, entryPath: string): Promise<string> {
		return this.compileEntryModule(entry, entryPath)
	}

	private async compileEntryModule(
		entry: PluginExtensionEntry,
		entryPath: string,
	): Promise<string> {
		const hmr = this.ctx.root.hmrService
		if (!hmr) {
			throw new Error('HMRService not available')
		}

		// @ts-expect-error accessing private
		const vite = hmr.vite as import('vite').ViteDevServer
		if (!vite) {
			throw new Error('ViteDevServer not initialized')
		}

		const absoluteEntry = this.resolvePluginFile(entry.pluginDir, entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) {
			throw new Error(`Entry file not found: ${absoluteEntry}`)
		}

		// 将入口与本地依赖打成单文件，避免子模块继续各自 import react 导致出现多个 React 副本
		// （多 React 副本会让 hooks dispatcher 为 null，触发 “reading 'useMemo' of null”）
		//
		// Important: do NOT forward HMR-only resolve conditions like `@pluxel/source` into the browser bundle.
		// Otherwise Vite may resolve `@pluxel/*` to TS source entries (macros, server-only deps) and break bundling.
		const resolveForBrowserBundle = toBrowserBundleResolve(vite.config.resolve as ResolveOptions)
		const bundled = (
			await this.ctx.bundlerService.bundle({
				label: entry.pluginName,
				target: 'browser',
				entry: absoluteEntry,
				root: vite.config.root,
				resolve: resolveForBrowserBundle,
				external: Array.from(this.vendorPackages),
			})
		).code
		return normalizeJsxRuntime(transformVendorImports(bundled, this.vendorPackages))
	}

	private async cleanupOldModuleFiles(pluginName: string, keep: number): Promise<void> {
		if (keep <= 0) return
		const dir = this.getPluginOutDir(pluginName)
		const entries = await readdir(dir).catch(() => [])
		if (!entries.length) return

		const modules: Array<{ path: string; mtime: number }> = []
		for (const name of entries) {
			if (!name.endsWith(MODULE_FILE_EXTENSION)) continue
			const fullPath = join(dir, name)
			const stats = await stat(fullPath).catch(() => null)
			if (!stats?.isFile()) continue
			modules.push({ path: fullPath, mtime: stats.mtimeMs })
		}

		modules.sort((a, b) => b.mtime - a.mtime)
		for (const stale of modules.slice(keep)) {
			await unlink(stale.path).catch(() => undefined)
		}
	}

	private removeManifestEntry(pluginName: string): void {
		const nextModules = this.manifest.modules.filter((mod) => mod.pluginName !== pluginName)
		if (nextModules.length === this.manifest.modules.length) return
		this.manifestVersion += 1
		this.manifest = { version: this.manifestVersion, modules: nextModules }
		this.persistManifest()
		this.notifyManifest({
			type: 'remove',
			version: this.manifestVersion,
			pluginName,
		})
	}

	private getBuiltinsSnapshot(): BuiltinExtensionDef[] {
		const list: BuiltinExtensionDef[] = []
		for (const bucket of this.builtinByPlugin.values()) {
			for (const def of bucket.values()) {
				list.push(def)
			}
		}
		list.sort((a, b) => {
			const pn = a.pluginName.localeCompare(b.pluginName)
			if (pn !== 0) return pn
			const pt = String(a.point).localeCompare(String(b.point))
			if (pt !== 0) return pt
			return String(a.id).localeCompare(String(b.id))
		})
		return list
	}

	private bumpManifestVersion(_reason: 'builtin'): void {
		// Builtins are runtime-only; we still bump the global manifest version to trigger a client sync.
		this.manifestVersion += 1
		this.manifest = { version: this.manifestVersion, modules: this.manifest.modules }
		this.persistManifest()
		this.notifyManifest({ type: 'sync', version: this.manifestVersion })
	}

	private handleManifestUpdate(pluginName: string, entry: PluginExtensionEntry | null): void {
		const previous = this.manifest.modules.find((mod) => mod.pluginName === pluginName)
		const nextModules = this.manifest.modules.filter((mod) => mod.pluginName !== pluginName).slice()

		if (entry?.moduleUrl && entry.lastSourceHash) {
			const moduleRecord: CompiledExtensionModule = {
				pluginName,
				moduleUrl: entry.moduleUrl,
				sourceHash: entry.lastSourceHash,
				compiledAt: entry.lastCompiledAt ?? Date.now(),
			}
			// manifest 的“有效变更”只取决于 moduleUrl/sourceHash。
			// compiledAt 只是调试字段，不应导致版本抖动（会让前端无限刷新/重复 import）。
			if (
				previous &&
				previous.sourceHash === moduleRecord.sourceHash &&
				previous.moduleUrl === moduleRecord.moduleUrl
			) {
				return
			}
			nextModules.push(moduleRecord)
			nextModules.sort((a, b) => a.pluginName.localeCompare(b.pluginName))

			this.manifestVersion += 1
			this.manifest = { version: this.manifestVersion, modules: nextModules }
			this.persistManifest()
			this.notifyManifest({
				type: 'update',
				version: this.manifestVersion,
				pluginName,
				sourceHash: moduleRecord.sourceHash,
				moduleUrl: moduleRecord.moduleUrl,
				compiledAt: moduleRecord.compiledAt,
			})
			return
		}

		if (!previous) {
			return
		}

		this.manifestVersion += 1
		this.manifest = { version: this.manifestVersion, modules: nextModules }
		this.persistManifest()
		this.notifyManifest({
			type: 'remove',
			version: this.manifestVersion,
			pluginName,
		})
	}

	private async handlePluginRemoval(
		pluginName: string,
		entry: PluginExtensionEntry | null,
	): Promise<void> {
		if (entry?.modulePath && existsSync(entry.modulePath)) {
			await unlink(entry.modulePath).catch(() => undefined)
		}
		this.handleManifestUpdate(pluginName, null)
	}

	private getPluginOutDir(pluginName: string): string {
		return join(this.outDir, sanitizePluginName(pluginName))
	}

	private getModuleFilePath(pluginName: string, sourceHash: string): string {
		return join(this.getPluginOutDir(pluginName), `${sourceHash}${MODULE_FILE_EXTENSION}`)
	}

	private getModuleUrl(pluginName: string, sourceHash: string): string {
		const encodedName = encodeURIComponent(pluginName)
		return `${MODULE_ENDPOINT_PREFIX}/${encodedName}/${sourceHash}${MODULE_FILE_EXTENSION}`
	}

	private async restorePersistedManifest(): Promise<void> {
		if (!existsSync(this.manifestPath)) return
		try {
			const raw = await readFile(this.manifestPath, 'utf-8')
			const parsed = JSON.parse(raw) as Partial<ExtensionManifest>
			if (!parsed || !Array.isArray(parsed.modules)) {
				return
			}
			const restored: CompiledExtensionModule[] = []
			for (const module of parsed.modules) {
				if (
					!module ||
					typeof module.pluginName !== 'string' ||
					typeof module.moduleUrl !== 'string' ||
					typeof module.sourceHash !== 'string'
				) {
					continue
				}
				const filePath = this.getModuleFilePath(module.pluginName, module.sourceHash)
				if (!existsSync(filePath)) {
					continue
				}
				const stats = await stat(filePath).catch(() => null)
				restored.push({
					pluginName: module.pluginName,
					moduleUrl: module.moduleUrl,
					sourceHash: module.sourceHash,
					compiledAt: module.compiledAt ?? (stats ? Math.floor(stats.mtimeMs) : Date.now()),
				})
			}
			this.manifestVersion = typeof parsed.version === 'number' ? parsed.version : 0
			this.manifest = {
				version: this.manifestVersion,
				modules: restored,
			}
		} catch (error) {
			this.ctx.logger.warn('failed to restore manifest', { error })
		}
	}

	private persistManifest(): void {
		const snapshot = JSON.stringify(this.manifest, null, 2)
		void (async () => {
			try {
				await mkdir(this.outDir, { recursive: true })
				await writeFile(this.manifestPath, snapshot, 'utf-8')
			} catch (error) {
				this.ctx.logger.warn('failed to persist manifest', { error })
			}
		})()
	}

	private collectSourceFiles(pluginDir: string, entryPath: string): string[] {
		const entryFile = this.resolvePluginFile(pluginDir, entryPath)
		return entryFile ? [entryFile] : []
	}

	private async computeSourceHash(files: string[], baseDir?: string): Promise<string> {
		const hash = createHash('sha256')
		hash.update(`compiler:${EXTENSION_COMPILER_VERSION}`)
		hash.update(`vendors:${Array.from(this.vendorPackages).join('|')}`)
		const expanded = await this.expandHashTargets(files)
		expanded.sort()

		for (const file of expanded) {
			try {
				if (existsSync(file)) {
					const content = await readFile(file, 'utf-8')
					if (baseDir && file.startsWith(baseDir)) {
						hash.update(relative(baseDir, file))
					} else {
						hash.update(file)
					}
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
			const stats = await stat(target).catch(() => null)
			if (!stats) continue
			if (stats.isDirectory()) {
				const entries = await readdir(target)
				for (const entry of entries) {
					// ignore dotfiles and typical editor temps
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
					if (HASH_IGNORED_SEGMENTS.some((segment) => fullPath.includes(segment))) {
						continue
					}
					const nestedStats = await stat(fullPath).catch(() => null)
					if (!nestedStats) continue
					if (nestedStats.isDirectory()) {
						queue.push(fullPath)
					} else {
						// Only hash relevant source-ish files.
						// Avoid spurious rebuilds from unrelated files.
						const lower = entry.toLowerCase()
						if (lower.endsWith('.d.ts') || lower.endsWith('.map')) continue
						if (!HASH_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
						collected.push(fullPath)
					}
				}
			} else {
				const lower = target.toLowerCase()
				if (lower.endsWith('.d.ts') || lower.endsWith('.map')) continue
				if (!HASH_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
				collected.push(target)
			}
		}

		return collected
	}

	private async refreshWatchFiles(entry: PluginExtensionEntry): Promise<void> {
		const hmr = this.ctx.root.hmrService
		// @ts-expect-error accessing private
		const vite = hmr?.vite as import('vite').ViteDevServer | undefined
		if (!vite) return

		const absoluteEntry = this.resolvePluginFile(entry.pluginDir, entry.entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) return

		const root = vite.config.root
		let url = absoluteEntry
		if (url.startsWith(root)) {
			url = url.slice(root.length)
		}
		if (!url.startsWith('/')) {
			url = '/' + url
		}

		try {
			// Ensure module graph populated for this entry
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
		if (lower.endsWith('.d.ts') || lower.endsWith('.map')) return false
		return HASH_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
	}

	private resolvePluginFile(
		pluginDir: string,
		targetPath: string | null | undefined,
	): string | null {
		if (!targetPath) return null
		if (isAbsolute(targetPath)) {
			return targetPath
		}
		return resolve(pluginDir, targetPath)
	}

	private findPluginDir(pluginName: string): string | null {
		const registryPath = this.ctx.loader.api.registry.findModuleIdByName(pluginName)
		if (registryPath) {
			return dirname(registryPath)
		}

		const needle = pluginName.toLowerCase()
		for (const path of this.ctx.loader.api.anchors.list()) {
			if (path.toLowerCase().includes(needle)) {
				return dirname(path)
			}
		}
		return null
	}
}

function sanitizePluginName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
