import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type Context, getPluginInfo, Injectable } from '@pluxel/core'
import chokidar, { type FSWatcher } from 'chokidar'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import type {
	CompiledExtensionModule,
	ExtensionManifest,
	ExtensionManifestEvent,
	PluginExtensionConfig,
} from './types'

const serviceName = 'extensionService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: ExtensionService
	}
}

export interface ExtensionServiceConfig {
	outDir?: string
	enabled?: boolean
}

interface PluginExtensionEntry {
	config: PluginExtensionConfig
	sourceFiles: string[]
	lastCompiledAt?: number
	lastSourceHash?: string
	modulePath?: string
	moduleUrl?: string
	active: boolean
	watcher?: FSWatcher | null
}

const VENDOR_PACKAGES = [
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react-dom',
	'react-dom/client',
	'@mantine/core',
	'@mantine/hooks',
	'@mantine/modals',
	'@mantine/notifications',
] as const

const WATCHER_IGNORED_GLOBS = [
	'**/node_modules/**',
	'**/.git/**',
	'**/.turbo/**',
	'**/.pluxel/**',
	'**/dist/**',
	'**/build/**',
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
const MODULE_FILE_EXTENSION = '.mjs'
const MODULE_RETENTION_COUNT = 2
const MODULE_ENDPOINT_PREFIX = '/api/extensions/modules'
const MANIFEST_FILENAME = 'manifest.json'

@Injectable({ key: serviceName })
export class ExtensionService {
	private readonly entries = new Map<string, PluginExtensionEntry>()
	private readonly outDir: string
	private readonly manifestPath: string
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
		private ctx: Context,
		config?: ExtensionServiceConfig,
	) {
		this.outDir = config?.outDir ?? resolve(process.cwd(), '.pluxel/extensions')
		this.manifestPath = join(this.outDir, MANIFEST_FILENAME)

		this.ctx.registry.afterCommit(async (summary) => {
			await this.onAfterCommit(summary)
		})

		void this.restorePersistedManifest()
	}

	subscribeManifest(callback: (event: ExtensionManifestEvent) => void): () => void {
		this.manifestListeners.add(callback)
		return () => this.manifestListeners.delete(callback)
	}

	getManifest(): ExtensionManifest {
		return this.manifest
	}

	async getModuleSource(pluginName: string, sourceHash: string): Promise<string | null> {
		const file = this.getModuleFilePath(pluginName, sourceHash)
		if (existsSync(file)) {
			return readFile(file, 'utf-8')
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

	register(config: PluginExtensionConfig): () => void {
		if (!config.entryPath) {
			throw new Error(`Extension for ${config.pluginName} 必须提供 entryPath`)
		}

		const existing = this.entries.get(config.pluginName)
		if (existing) {
			this.disposeWatcher(existing)
		}

		const sourceFiles = this.collectSourceFiles(config)
		const entry: PluginExtensionEntry = {
			config,
			sourceFiles,
			active: true,
			watcher: null,
		}

		this.entries.set(config.pluginName, entry)
		this.setupWatcher(config.pluginName, entry)
		this.enqueueCompile(config.pluginName)

		return () => {
			const stored = this.entries.get(config.pluginName)
			if (!stored) return
			stored.active = false
			this.disposeWatcher(stored)
			this.pendingPlugins.delete(config.pluginName)
			this.entries.delete(config.pluginName)
			void this.handlePluginRemoval(config.pluginName, stored)
		}
	}

	invalidate(pluginName: string): void {
		const entry = this.entries.get(pluginName)
		if (!entry) return
		entry.active = true
		this.enqueueCompile(pluginName)
	}

	subscribe(cb: () => void): () => void {
		return () => {
			// no-op placeholder to preserve API compatibility
		}
	}

	hasPendingCompilation(): boolean {
		return this.pendingPlugins.size > 0
	}

	private notifyManifest(event: ExtensionManifestEvent): void {
		for (const listener of this.manifestListeners) {
			try {
				listener(event)
			} catch (error) {
				console.error('[ExtensionService] manifest listener failed', error)
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
		const start = Date.now()
		try {
			const sourceHash = await this.computeSourceHash(entry.sourceFiles)
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
				return true
			}

			const code = await this.generateBundle(entry.config)
			await mkdir(dirname(targetFile), { recursive: true })
			await writeFile(targetFile, code, 'utf-8')
			void this.cleanupOldModuleFiles(pluginName, MODULE_RETENTION_COUNT)
			entry.lastCompiledAt = Date.now()
			entry.lastSourceHash = sourceHash
			entry.modulePath = targetFile
			entry.moduleUrl = moduleUrl
			this.handleManifestUpdate(pluginName, entry)
			return true
		} catch (error) {
			console.error('[ExtensionService] failed to compile', pluginName, error)
			return false
		} finally {
			const duration = Date.now() - start
			this.ctx.logger.info('[Extension] compiled %s in %dms', pluginName, duration)
		}
	}

	private async onAfterCommit(summary: import('@pluxel/core').CommitSummary) {
		if (!this.pendingPlugins.size) return
		const runningPlugins = new Set<string>()
		for (const [id] of summary.container.services) {
			try {
				const info = getPluginInfo(id as Function)
				if (info?.name && this.pendingPlugins.has(info.name)) {
					runningPlugins.add(info.name)
				}
			} catch {}
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
			entry.watcher.close().catch(() => {})
			entry.watcher = null
		}
	}

	private async generateBundle(config: PluginExtensionConfig): Promise<string> {
		if (!config.entryPath) {
			throw new Error(`插件 ${config.pluginName} 必须提供 entryPath`)
		}
		return this.compileEntryModule(config.pluginName, config.entryPath)
	}

	private async compileEntryModule(pluginName: string, entryPath: string): Promise<string> {
		const hmr = this.ctx.hmrService
		if (!hmr) {
			throw new Error('HMRService not available')
		}

		// @ts-expect-error accessing private
		const vite = hmr.vite as import('vite').ViteDevServer
		if (!vite) {
			throw new Error('ViteDevServer not initialized')
		}

		const absoluteEntry = this.resolvePluginFile(pluginName, entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) {
			throw new Error(`Entry file not found: ${absoluteEntry}`)
		}

		const root = vite.config.root
		let url = absoluteEntry
		if (url.startsWith(root)) {
			url = url.slice(root.length)
		}
		if (!url.startsWith('/')) {
			url = '/' + url
		}

		// 将入口与本地依赖打成单文件，避免子模块继续各自 import react 导致出现多个 React 副本
		// （多 React 副本会让 hooks dispatcher 为 null，触发 “reading 'useMemo' of null”）
		const bundled = await bundlePluginEntry({
			entry: absoluteEntry,
			vite,
		})
		return normalizeJsxRuntime(transformVendorImports(bundled))
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
			await unlink(stale.path).catch(() => {})
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

	private handleManifestUpdate(pluginName: string, entry: PluginExtensionEntry | null): void {
		const previous = this.manifest.modules.find((mod) => mod.pluginName === pluginName)
		const nextModules = this.manifest.modules.filter((mod) => mod.pluginName !== pluginName).slice()

		if (entry && entry.moduleUrl && entry.lastSourceHash) {
			const moduleRecord: CompiledExtensionModule = {
				pluginName,
				moduleUrl: entry.moduleUrl,
				sourceHash: entry.lastSourceHash,
				compiledAt: entry.lastCompiledAt ?? Date.now(),
			}
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
			await unlink(entry.modulePath).catch(() => {})
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
			console.warn('[ExtensionService] failed to restore manifest', error)
		}
	}

	private persistManifest(): void {
		const snapshot = JSON.stringify(this.manifest, null, 2)
		void (async () => {
			try {
				await mkdir(this.outDir, { recursive: true })
				await writeFile(this.manifestPath, snapshot, 'utf-8')
			} catch (error) {
				console.warn('[ExtensionService] failed to persist manifest', error)
			}
		})()
	}

	private collectSourceFiles(config: PluginExtensionConfig): string[] {
		const targets = new Set<string>()
		const addTarget = (input: string | null) => {
			if (!input) return
			targets.add(input)
			const directory = dirname(input)
			if (directory && directory !== input) {
				targets.add(directory)
			}
		}

		const entryFile = this.resolvePluginFile(config.pluginName, config.entryPath)
		addTarget(entryFile)

		return Array.from(targets)
	}

	private async computeSourceHash(files: string[]): Promise<string> {
		const hash = createHash('sha256')
		const expanded = await this.expandHashTargets(files)
		expanded.sort()

		for (const file of expanded) {
			try {
				if (existsSync(file)) {
					const content = await readFile(file, 'utf-8')
					hash.update(file)
					hash.update(content)
				}
			} catch {}
		}

		return hash.digest('hex').slice(0, 16)
	}

	private async expandHashTargets(files: string[]): Promise<string[]> {
		const collected: string[] = []
		const visited = new Set<string>()

		for (const target of files) {
			if (!target) continue
			if (visited.has(target)) continue
			visited.add(target)
			const stats = await stat(target).catch(() => null)
			if (!stats) continue
			if (stats.isDirectory()) {
				const entries = await readdir(target)
				for (const entry of entries) {
					const fullPath = join(target, entry)
					if (HASH_IGNORED_SEGMENTS.some((segment) => fullPath.includes(segment))) {
						continue
					}
					const nestedStats = await stat(fullPath).catch(() => null)
					if (!nestedStats) continue
					if (nestedStats.isDirectory()) {
						files.push(fullPath)
					} else {
						collected.push(fullPath)
					}
				}
			} else {
				collected.push(target)
			}
		}

		return collected
	}

	private resolvePluginFile(
		pluginName: string,
		targetPath: string | null | undefined,
	): string | null {
		if (!targetPath) return null
		if (isAbsolute(targetPath)) {
			return targetPath
		}
		const pluginDir = this.findPluginDir(pluginName)
		if (!pluginDir) return null
		return resolve(pluginDir, targetPath)
	}

	private findPluginDir(pluginName: string): string | null {
		const registryPath = this.ctx.loader.registry.name2PathMap.get(pluginName)
		if (registryPath) {
			return dirname(registryPath)
		}

		const needle = pluginName.toLowerCase()
		const anchors = this.ctx.loader.pathAnchors
		for (const path of anchors) {
			if (path.toLowerCase().includes(needle)) {
				return dirname(path)
			}
		}
		return null
	}
}

function transformVendorImports(code: string): string {
	let result = code

	for (const pkg of VENDOR_PACKAGES) {
		const normalized = pkg.replace(/\//g, '_')
		const viteStaticImportPattern = new RegExp(
			`(from\\s*["'])/node_modules/\\.vite/deps/${escapeRegex(normalized)}\\.js(?:\\?[^"']*)?(["'])`,
			'g',
		)
		const viteDynamicImportPattern = new RegExp(
			`(import\\s*\\(\\s*["'])/node_modules/\\.vite/deps/${escapeRegex(normalized)}\\.js(?:\\?[^"']*)?(["']\\s*\\))`,
			'g',
		)
		result = result.replace(viteStaticImportPattern, `$1${pkg}$2`)
		result = result.replace(viteDynamicImportPattern, `$1${pkg}$2`)

		const patterns = [
			new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapeRegex(pkg)}["'];?`, 'g'),
			new RegExp(`import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*["']${escapeRegex(pkg)}["'];?`, 'g'),
			new RegExp(`import\\s+(\\w+)\\s*from\\s*["']${escapeRegex(pkg)}["'];?`, 'g'),
			new RegExp(
				`import\\s+(\\w+)\\s*,\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapeRegex(pkg)}["'];?`,
				'g',
			),
		]

		result = result.replace(patterns[0]!, (_, names: string) => {
			const destructure = rewriteVendorNamedImports(names, pkg)
			return destructure ? destructure : ''
		})

		result = result.replace(patterns[1]!, (_, name: string) => {
			return `const ${name} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		result = result.replace(patterns[3]!, (_, defaultName: string, namedImports: string) => {
			const named = rewriteVendorNamedImports(namedImports, pkg)
			const defaultLine = `const ${defaultName} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];`
			return named ? `${defaultLine}\n${named}` : defaultLine
		})

		result = result.replace(patterns[2]!, (_, name: string) => {
			return `const ${name} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];`
		})
	}

	const definePluginImport = new RegExp(
		[
			'import\\s+\\{\\s*definePluginUIModule\\s*\\}\\s*from\\s*["\']',
			'(?:',
			'@pluxel\\/hmr\\/web', // package entry
			'|\\/?src\\/web(?:\\/web)?\\.ts', // source path (with or without nested /web.ts)
			'|.*\\/web\\/web\\.ts', // relative paths used in tests
			')["\'];?',
		].join(''),
		'g',
	)

	result = result.replace(definePluginImport, 'const definePluginUIModule = (module) => module;')

	return result
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function bundlePluginEntry(options: {
	entry: string
	vite: import('vite').ViteDevServer
}): Promise<string> {
	const pool = getBundlePool()
	const { entry, vite } = options
	return pool.run({
		entry,
		root: vite.config.root,
		resolve: vite.config.resolve,
		vendors: Array.from(VENDOR_PACKAGES),
	})
}

let bundlePool: import('tinypool').default | null = null
function getBundlePool(): import('tinypool').default {
	if (bundlePool) return bundlePool
	// 延迟创建，避免未用时初始化线程
	const { default: Tinypool } = require('tinypool') as typeof import('tinypool')
	const worker = resolveWorkerPath()
	bundlePool = new Tinypool({
		filename: worker,
		maxThreads: Math.max(1, Math.min(4, require('os').cpus().length - 1)),
	})
	return bundlePool
}

function resolveWorkerPath(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url))
	const pkgRoot = resolve(currentDir, '../../..')
	const candidates = [
		pathToFileURL(resolve(pkgRoot, 'dist/bundle-worker.mjs')).href, // copied by tsdown
		pathToFileURL(join(currentDir, 'bundle-worker.mjs')).href, // same dir as compiled chunk
		pathToFileURL(resolve(pkgRoot, 'src/services/extension/bundle-worker.mjs')).href, // source fallback
	]
	for (const href of candidates) {
		try {
			if (existsSync(fileURLToPath(href))) {
				return href
			}
		} catch {}
	}
	return candidates[candidates.length - 1]!
}

function rewriteVendorNamedImports(names: string, pkg: string): string {
	const parts = names
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const match = part.match(/^([\\w$]+)\\s+as\\s+([\\w$]+)$/)
			if (match) {
				return `${match[1]}: ${match[2]}`
			}
			return part
		})

	if (!parts.length) return ''
	return `const { ${parts.join(', ')} } = window.__PLUXEL_VENDORS__["${pkg}"];`
}

function normalizeJsxRuntime(code: string): string {
	return code
		.replaceAll('react/jsx-dev-runtime', 'react/jsx-runtime')
		.replaceAll('react_jsx-dev-runtime', 'react_jsx-runtime')
		.replaceAll('jsxDevRuntime', 'jsxRuntime')
		.replaceAll('_jsxDEV', '_jsx')
		.replaceAll('jsxDEV', 'jsx')
}

function sanitizePluginName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
