import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { type Context, getPluginInfo, Injectable } from '@pluxel/core'
import chokidar, { type FSWatcher } from 'chokidar'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import type {
	AggregatedPluginModule,
	ExtensionManifest,
	ExtensionPoint,
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
	compiledCode?: string
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
	'@tabler/icons-react',
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
const BUNDLE_FILENAME = 'bundle.mjs'

@Injectable({ key: serviceName })
export class ExtensionService {
	private readonly entries = new Map<string, PluginExtensionEntry>()
	private readonly outDir: string
	private readonly bundlePath: string
	private manifestVersion = 0
	private manifest: ExtensionManifest = {
		version: 0,
		bundleUrl: null,
		sourceHash: '',
		moduleCount: 0,
	}
	private pendingPlugins = new Set<string>()
	private flushTimer: NodeJS.Timeout | null = null
	private flushPromise: Promise<void> | null = null
	private manifestListeners = new Set<(version: number) => void>()

	constructor(
		private ctx: Context,
		config?: ExtensionServiceConfig,
	) {
		this.outDir = config?.outDir ?? resolve(process.cwd(), '.pluxel/extensions')
		this.bundlePath = join(this.outDir, BUNDLE_FILENAME)

		this.ctx.registry.afterCommit(async (summary) => {
			await this.onAfterCommit(summary)
		})
	}

	subscribeManifest(callback: (version: number) => void): () => void {
		this.manifestListeners.add(callback)
		return () => this.manifestListeners.delete(callback)
	}

	getManifest(): ExtensionManifest {
		return this.manifest
	}

	async getBundle(): Promise<string | null> {
		if (!existsSync(this.bundlePath)) return null
		return readFile(this.bundlePath, 'utf-8')
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
			void this.buildAggregateBundle()
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

	private notifyManifest(): void {
		for (const listener of this.manifestListeners) {
			try {
				listener(this.manifestVersion)
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
			let compiled = false

			for (const pluginName of queue) {
				const entry = this.entries.get(pluginName)
				if (!entry || !entry.active) {
					this.pendingPlugins.delete(pluginName)
					continue
				}
				if (runningPlugins && !runningPlugins.has(pluginName)) {
					continue
				}
				const success = await this.compilePlugin(pluginName)
				this.pendingPlugins.delete(pluginName)
				if (success) {
					compiled = true
				}
			}

			if (compiled) {
				await this.buildAggregateBundle()
			}
		})()

		this.flushPromise = task
		await task
		this.flushPromise = null
	}

	private async buildAggregateBundle(): Promise<void> {
		await mkdir(this.outDir, { recursive: true })
		const modules: AggregatedPluginModule[] = []

		for (const [pluginName, entry] of this.entries) {
			if (!entry.compiledCode) continue
			const points = new Set<ExtensionPoint>()
			for (const ui of entry.config.ui ?? []) {
				points.add(ui.point)
			}
			const routes = new Set<string>()
			for (const route of entry.config.routes ?? []) {
				routes.add(normalizeRoutePath(route.path) || '/')
			}
			modules.push({
				pluginName,
				code: entry.compiledCode,
				points: Array.from(points),
				routes: Array.from(routes),
				compiledAt: entry.lastCompiledAt ?? Date.now(),
				sourceHash: entry.lastSourceHash ?? '',
			})
		}

		const content = this.generateAggregateModule(modules)
		await writeFile(this.bundlePath, content, 'utf-8')
		const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
		this.manifestVersion += 1
		this.manifest = {
			version: this.manifestVersion,
			bundleUrl: '/api/extensions/bundle.mjs',
			sourceHash: hash,
			moduleCount: modules.length,
		}
		this.notifyManifest()
	}

	private generateAggregateModule(modules: AggregatedPluginModule[]): string {
		const payload = modules
			.map((module) => {
				return `{
  pluginName: ${JSON.stringify(module.pluginName)},
  code: ${JSON.stringify(module.code)},
  points: ${JSON.stringify(module.points)},
  routes: ${JSON.stringify(module.routes)},
  compiledAt: ${module.compiledAt},
  sourceHash: ${JSON.stringify(module.sourceHash)}
}`
			})
			.join(',\n')

		return `export const plugins = [\n${payload}\n];\nexport default plugins;\n`
	}

	private async compilePlugin(pluginName: string): Promise<boolean> {
		const entry = this.entries.get(pluginName)
		if (!entry) return false
		const start = Date.now()
		try {
			const code = await this.generateBundle(entry.config)
			entry.compiledCode = code
			entry.lastCompiledAt = Date.now()
			entry.lastSourceHash = await this.computeSourceHash(entry.sourceFiles)
			entry.isDirty = false
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

		const result = await vite.transformRequest(url)
		if (!result?.code) {
			throw new Error('Failed to compile entry module')
		}

		return transformVendorImports(result.code)
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
		const anchors = this.ctx.loader.pathAnchors
		for (const path of anchors) {
			if (path.includes(pluginName)) {
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
			const trimmed = names.trim()
			return `const {${trimmed}} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		result = result.replace(patterns[1]!, (_, name: string) => {
			return `const ${name} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		result = result.replace(patterns[3]!, (_, defaultName: string, namedImports: string) => {
			const trimmed = namedImports.trim()
			return `const ${defaultName} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];
const {${trimmed}} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		result = result.replace(patterns[2]!, (_, name: string) => {
			return `const ${name} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];`
		})
	}

	result = result.replace(
		/import\s+\{\s*definePluginUIModule\s*\}\s*from\s*["']\/src\/web\.ts["'];?/g,
		'const definePluginUIModule = (module) => module;',
	)

	return result
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeRoutePath(path: string | null | undefined): string {
	if (!path) return ''
	const trimmed = path.trim()
	if (!trimmed || trimmed === '/') return ''
	const segments = trimmed
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}
