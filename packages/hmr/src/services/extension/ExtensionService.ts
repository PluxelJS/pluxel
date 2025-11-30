// packages/hmr/src/services/extension/ExtensionService.ts

import { type Context, getPluginInfo, Injectable } from '@pluxel/core'
import chokidar, { type FSWatcher } from 'chokidar'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import type {
	CompiledExtensionBundle,
	ExtensionManifest,
	ExtensionPoint,
	PluginExtensionConfig,
	RouteExtension,
	UIExtension,
} from './types'

const serviceName = 'extensionService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: ExtensionService
	}
}

export interface ExtensionServiceConfig {
	/** 输出目录 */
	outDir?: string
	/** 是否启用 */
	enabled?: boolean
}

/**
 * 插件扩展注册信息（内部）
 */
interface PluginExtensionEntry {
	config: PluginExtensionConfig
	sourceFiles: string[]
	isDirty: boolean
	lastCompiledAt?: number
	lastSourceHash?: string
	active: boolean
	watcher?: FSWatcher | null
}

/**
 * 需要从全局 vendors 加载的包
 * 这些包不会被打包到插件 bundle 中
 */
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

const HASH_IGNORED_SEGMENTS = ['node_modules', '.git', '.turbo', '.pluxel', 'dist', 'build', '.next'] as const

/**
 * 转换编译后的代码，将 vendor 包的 import 替换为全局引用
 *
 * 例如：
 * - `import { Button } from "@mantine/core"` -> `const { Button } = window.__PLUXEL_VENDORS__["@mantine/core"]`
 * - `import * as React from "react"` -> `const React = window.__PLUXEL_VENDORS__["react"]`
 */
function transformVendorImports(code: string): string {
	let result = code

	for (const pkg of VENDOR_PACKAGES) {
		// 先将 Vite 处理后的 node_modules/.vite/deps 路径替换回包名
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

		// 匹配各种 import 形式
		const patterns = [
			// import { a, b } from "pkg"
			new RegExp(
				`import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapeRegex(pkg)}["'];?`,
				'g',
			),
			// import * as name from "pkg"
			new RegExp(
				`import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*["']${escapeRegex(pkg)}["'];?`,
				'g',
			),
			// import name from "pkg" (default import)
			new RegExp(
				`import\\s+(\\w+)\\s*from\\s*["']${escapeRegex(pkg)}["'];?`,
				'g',
			),
			// import name, { a, b } from "pkg" (default + named)
			new RegExp(
				`import\\s+(\\w+)\\s*,\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapeRegex(pkg)}["'];?`,
				'g',
			),
		]

		// 处理 named imports: import { a, b } from "pkg"
		result = result.replace(patterns[0]!, (_, names: string) => {
			const trimmed = names.trim()
			return `const {${trimmed}} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		// 处理 namespace imports: import * as name from "pkg"
		result = result.replace(patterns[1]!, (_, name: string) => {
			return `const ${name} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		// 处理 default + named imports: import name, { a, b } from "pkg"
		result = result.replace(patterns[3]!, (_, defaultName: string, namedImports: string) => {
			const trimmed = namedImports.trim()
			return `const ${defaultName} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];
const {${trimmed}} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		// 处理 default imports: import name from "pkg"
		// 注意：这个要放在最后，因为上面的 default + named 模式更具体
		result = result.replace(patterns[2]!, (_, name: string) => {
			return `const ${name} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];`
		})
	}

	return result
}

/**
 * 转义正则表达式特殊字符
 */
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

function encodePluginNameForUrl(name: string): string {
	try {
		return encodeURIComponent(name)
	} catch {
		return name
	}
}

/**
 * ExtensionService - 管理插件的前端 UI 扩展
 *
 * 职责：
 * 1. 接收插件的扩展注册
 * 2. 在 commit 后编译变化的插件 UI 代码为 mjs bundle
 * 3. 提供扩展清单给前端
 */
@Injectable({ key: serviceName })
export class ExtensionService {
	private readonly entries = new Map<string, PluginExtensionEntry>()
	private readonly outDir: string
	private manifestVersion = 0
	private isDirty = false
	private pendingPlugins = new Set<string>()
	private flushTimer: NodeJS.Timeout | null = null
	private flushPromise: Promise<void> | null = null
	private listeners = new Set<() => void>()

	constructor(
		private ctx: Context,
		config?: ExtensionServiceConfig,
	) {
		this.outDir = config?.outDir ?? resolve(process.cwd(), '.pluxel/extensions')

		// 监听插件 commit 事件
		this.ctx.registry.afterCommit(async (summary) => {
			await this.onAfterCommit(summary)
		})
	}

	/**
	 * 注册插件扩展
	 */
	register(config: PluginExtensionConfig): () => void {
		const existing = this.entries.get(config.pluginName)
		if (existing) {
			this.disposeWatcher(existing)
		}

		const sourceFiles = this.collectSourceFiles(config)
		const entry: PluginExtensionEntry = {
			config,
			sourceFiles,
			isDirty: true,
			lastCompiledAt: existing?.lastCompiledAt,
			lastSourceHash: existing?.lastSourceHash,
			active: true,
			watcher: null,
		}

		this.entries.set(config.pluginName, entry)
		this.setupWatcher(config.pluginName, entry)
		this.enqueueCompile(config.pluginName)

		return this.ctx.scope.collectEffect(() => {
			const stored = this.entries.get(config.pluginName)
			if (stored) {
				stored.active = false
				this.disposeWatcher(stored)
				this.pendingPlugins.delete(config.pluginName)
				stored.isDirty = false
				this.isDirty = this.pendingPlugins.size > 0
			}
		})
	}

	/**
	 * 更新插件扩展
	 */
	update(pluginName: string, partial: Partial<PluginExtensionConfig>): void {
		const entry = this.entries.get(pluginName)
		if (!entry) return

		entry.config = { ...entry.config, ...partial }
		entry.sourceFiles = this.collectSourceFiles(entry.config)
		entry.isDirty = true
		entry.active = true
		this.setupWatcher(pluginName, entry)
		this.enqueueCompile(pluginName)
	}

	/**
	 * 标记插件扩展需要重新编译
	 */
	invalidate(pluginName: string): void {
		const entry = this.entries.get(pluginName)
		if (entry) {
			entry.isDirty = true
			entry.active = true
			this.enqueueCompile(pluginName)
		}
	}

	/**
	 * 获取扩展清单
	 */
	getManifest(): ExtensionManifest {
		const bundles: CompiledExtensionBundle[] = []

		for (const [pluginName, entry] of this.entries) {
			if (!entry.lastCompiledAt) continue

			const points: ExtensionPoint[] = []
			const routes: string[] = []

			for (const ui of entry.config.ui ?? []) {
				if (!points.includes(ui.point)) {
					points.push(ui.point)
				}
			}

			for (const route of entry.config.routes ?? []) {
				routes.push(normalizeRoutePath(route.path) || '/')
			}

			bundles.push({
				pluginName,
				bundleUrl: `/api/extensions/${encodePluginNameForUrl(pluginName)}/bundle.mjs`,
				points,
				routes,
				compiledAt: entry.lastCompiledAt,
				sourceHash: entry.lastSourceHash ?? '',
			})
		}

		return {
			version: this.manifestVersion,
			bundles,
		}
	}

	/**
	 * 获取插件 bundle 内容
	 */
	async getBundle(pluginName: string): Promise<string | null> {
		const bundlePath = join(this.outDir, pluginName, 'bundle.mjs')
		if (!existsSync(bundlePath)) return null

		try {
			return await readFile(bundlePath, 'utf-8')
		} catch {
			return null
		}
	}

	/**
	 * 订阅变化
	 */
	subscribe(cb: () => void): () => void {
		this.listeners.add(cb)
		return () => this.listeners.delete(cb)
	}

	/**
	 * 是否有待编译的扩展
	 */
	hasPendingCompilation(): boolean {
		return this.pendingPlugins.size > 0
	}

	/**
	 * commit 后处理
	 */
	private async onAfterCommit(summary: import('@pluxel/core').CommitSummary) {
		if (!this.pendingPlugins.size) return

		const runningPlugins = new Set<string>()
		for (const [id] of summary.container.services) {
			try {
				const info = getPluginInfo(id as Function)
				if (info?.name && this.pendingPlugins.has(info.name)) {
					runningPlugins.add(info.name)
				}
			} catch {
				// 非插件类，忽略
			}
		}

		if (!runningPlugins.size) return
		await this.flushPending(runningPlugins)
	}

	/**
	 * 编译单个插件的扩展
	 */
	private async compilePlugin(pluginName: string): Promise<boolean> {
		const entry = this.entries.get(pluginName)
		if (!entry) return false

		const startTime = Date.now()

		try {
			// 确保输出目录存在
			const pluginOutDir = join(this.outDir, pluginName)
			await mkdir(pluginOutDir, { recursive: true })

			// 生成 bundle 代码
			const bundleCode = await this.generateBundle(entry.config)

			// 写入文件
			const bundlePath = join(pluginOutDir, 'bundle.mjs')
			await writeFile(bundlePath, bundleCode, 'utf-8')

			// 更新状态
			entry.isDirty = false
			entry.lastCompiledAt = Date.now()
			entry.lastSourceHash = await this.computeSourceHash(entry.sourceFiles)

			const duration = Date.now() - startTime
			this.ctx.logger.info('[Extension] compiled %s in %dms', pluginName, duration)
			return true
		} catch (error) {
			this.ctx.logger.error(error, '[Extension] failed to compile %s', pluginName)
			return false
		}
	}

	private enqueueCompile(pluginName: string): void {
		const entry = this.entries.get(pluginName)
		if (!entry) return
		entry.isDirty = true
		this.pendingPlugins.add(pluginName)
		this.isDirty = true
		this.scheduleFlush()
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.flushPromise || !this.pendingPlugins.size) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null
			void this.flushPending()
		}, 120)
	}

	private async flushPending(runningPlugins?: Set<string>): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
		if (this.flushPromise) {
			await this.flushPromise
			if (runningPlugins) {
				await this.flushPending(runningPlugins)
			}
			return
		}

		const task = (async () => {
			const allow = runningPlugins ?? this.getActivePluginNames()
			const queue = [...this.pendingPlugins]
			let compiled = false

			for (const pluginName of queue) {
				if (!allow.has(pluginName)) {
					if (!runningPlugins) {
						this.pendingPlugins.delete(pluginName)
					}
					continue
				}
				const entry = this.entries.get(pluginName)
				if (!entry || !entry.isDirty) {
					this.pendingPlugins.delete(pluginName)
					continue
				}

				const currentHash = await this.computeSourceHash(entry.sourceFiles)
				if (currentHash === entry.lastSourceHash) {
					entry.isDirty = false
					this.pendingPlugins.delete(pluginName)
					continue
				}

				const success = await this.compilePlugin(pluginName)
				this.pendingPlugins.delete(pluginName)
				if (success) {
					compiled = true
				}
			}

			this.isDirty = this.pendingPlugins.size > 0
			this.flushPromise = null

			if (compiled) {
				this.manifestVersion++
				this.notify()
			}

			if (this.pendingPlugins.size > 0) {
				this.scheduleFlush()
			}
		})()

		this.flushPromise = task
		await task
	}

	private getActivePluginNames(): Set<string> {
		const active = new Set<string>()
		for (const [name, entry] of this.entries) {
			if (entry.active) active.add(name)
		}
		return active
	}

	private setupWatcher(pluginName: string, entry: PluginExtensionEntry): void {
		this.disposeWatcher(entry)
		const targets = Array.from(new Set(entry.sourceFiles))
		if (targets.length === 0) {
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

	/**
	 * 生成 bundle 代码
	 */
	private async generateBundle(config: PluginExtensionConfig): Promise<string> {
		const { pluginName, ui = [], routes = [], entryPath } = config

		// 如果有入口文件，使用 HMRService 编译
		if (entryPath) {
			return this.compileEntryModule(pluginName, entryPath)
		}

		// 否则生成包装代码
		const imports: string[] = []
		const extensionDefs: string[] = []
		const routeDefs: string[] = []

		// 生成 UI 扩展
		for (let i = 0; i < ui.length; i++) {
			const ext = ui[i]!
			const varName = `Ext${i}`
			imports.push(`import ${varName} from '${ext.componentPath}';`)
			extensionDefs.push(`{
	point: '${ext.point}',
	priority: ${ext.priority ?? 0},
	requireRunning: ${ext.requireRunning ?? false},
	meta: ${JSON.stringify(ext.meta ?? {})},
	Component: ${varName},
}`)
		}

		// 生成路由扩展
		for (let i = 0; i < routes.length; i++) {
			const route = routes[i]!
			const varName = `Route${i}`
			imports.push(`import ${varName} from '${route.componentPath}';`)
			const normalizedPath = normalizeRoutePath(route.path) || '/'
			routeDefs.push(`{
	definition: ${JSON.stringify({
		path: normalizedPath,
		title: route.title,
		icon: route.icon,
		addToNav: route.addToNav,
		navPriority: route.navPriority,
	})},
	Component: ${varName},
}`)
		}

		return `// Auto-generated extension bundle for ${pluginName}
${imports.join('\n')}

export const extensions = [
${extensionDefs.map((d) => `  ${d}`).join(',\n')}
];

export const routes = [
${routeDefs.map((d) => `  ${d}`).join(',\n')}
];

export function setup() {
  console.log('[${pluginName}] UI extension loaded');
}
`
	}

	/**
	 * 使用 ViteDevServer 编译入口模块（生成浏览器兼容代码）
	 */
	private async compileEntryModule(pluginName: string, entryPath: string): Promise<string> {
		const hmr = this.ctx.hmrService
		if (!hmr) {
			throw new Error('HMRService not available')
		}

		const absoluteEntry = this.resolvePluginFile(pluginName, entryPath)
		if (!absoluteEntry || !existsSync(absoluteEntry)) {
			throw new Error(`Entry file not found: ${absoluteEntry}`)
		}

		// 使用 ViteDevServer.transformRequest 获取浏览器兼容代码
		// @ts-expect-error - 访问私有成员
		const vite = hmr.vite as import('vite').ViteDevServer
		if (!vite) {
			throw new Error('ViteDevServer not initialized')
		}

		// 将绝对路径转换为相对于 root 的 URL
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

		// 转换 vendor 包的 import 为全局引用
		return transformVendorImports(result.code)
	}

	/**
	 * 查找插件目录
	 */
	private findPluginDir(pluginName: string): string | null {
		// 从 loader 的 pathAnchors 中查找
		const anchors = this.ctx.loader.pathAnchors
		for (const path of anchors) {
			if (path.includes(pluginName)) {
				return dirname(path)
			}
		}
		return null
	}

	private resolvePluginFile(pluginName: string, targetPath: string | null | undefined): string | null {
		if (!targetPath) return null
		if (isAbsolute(targetPath)) {
			return targetPath
		}
		const pluginDir = this.findPluginDir(pluginName)
		if (!pluginDir) return null
		return resolve(pluginDir, targetPath)
	}

	/**
	 * 收集源文件列表
	 */
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

		if (config.entryPath) {
			const entryFile = this.resolvePluginFile(config.pluginName, config.entryPath)
			addTarget(entryFile)
		}

		for (const ui of config.ui ?? []) {
			const resolved = this.resolvePluginFile(config.pluginName, ui.componentPath)
			addTarget(resolved)
		}

		for (const route of config.routes ?? []) {
			const resolved = this.resolvePluginFile(config.pluginName, route.componentPath)
			addTarget(resolved)
		}

		return Array.from(targets)
	}

	/**
	 * 计算源文件 hash
	 */
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
			} catch {
				// ignore
			}
		}

		return hash.digest('hex').slice(0, 16)
	}

	private async expandHashTargets(files: string[]): Promise<string[]> {
		const collected: string[] = []
		const visited = new Set<string>()

		for (const target of files) {
			if (!target) continue
			const absolute = resolve(target)
			await this.collectHashableFiles(absolute, collected, visited)
		}

		return collected
	}

	private async collectHashableFiles(
		target: string,
		acc: string[],
		visited: Set<string>,
	): Promise<void> {
		if (visited.has(target)) return
		visited.add(target)

		try {
			const stats = await stat(target)
			if (stats.isDirectory()) {
				if (this.shouldIgnoreHashDir(target)) return
				const entries = await readdir(target)
				for (const entry of entries) {
					await this.collectHashableFiles(join(target, entry), acc, visited)
				}
				return
			}

			if (stats.isFile() && !this.shouldIgnoreHashFile(target)) {
				acc.push(target)
			}
		} catch {
			// ignore
		}
	}

	private shouldIgnoreHashDir(pathname: string): boolean {
		return this.pathContainsIgnoredSegment(pathname)
	}

	private shouldIgnoreHashFile(pathname: string): boolean {
		return this.pathContainsIgnoredSegment(pathname)
	}

	private pathContainsIgnoredSegment(pathname: string): boolean {
		const normalized = pathname.replace(/\\/g, '/')
		return HASH_IGNORED_SEGMENTS.some(
			(segment) => normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`),
		)
	}

	private notify(): void {
		for (const cb of this.listeners) {
			try {
				cb()
			} catch {}
		}
	}
}
