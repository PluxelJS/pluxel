import { pathToFileURL } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import { clearResolveCache, resolveModulePath } from 'exsolve'
import { dirname, isAbsolute, normalize, resolve as r } from 'pathe'
import { EntryResolver } from './scan/entry-resolver'
import { buildScanGraph } from './scan/graph-builder'
import { DEFAULT_SCAN_OPTIONS, resolveScanOptions } from './scan/options'
import type {
	EntryResolution,
	EntryResolutionOk,
	PackageNode,
	ResolvedScanOptions,
	ScanGraph,
	ScanOptionsInput,
} from './scan/types'

const serviceName = 'scanService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: ScanService
	}
	interface Config {
		[serviceName]?: ScanServiceConfig
	}
}

export type {
	EntryResolution,
	EntryResolutionOk,
	PackageNode,
	ScanDiagnostic,
	ScanGraph,
	ScanOptionsInput,
	ScanStats,
} from './scan/types'

export type PackageSelector = string | { name?: string | null; dir?: string | null }

export interface ScanServiceConfig {
	/** 默认扫描根目录，可传单个路径或路径数组。 */
	roots?: string | string[]
	/** 默认扫描选项，将与内置默认合并。 */
	options?: ScanOptionsInput
}

export interface ScanTaskOptions {
	/** 临时覆盖扫描根目录。 */
	roots?: string | string[]
	/** 临时覆盖扫描参数。 */
	scan?: ScanOptionsInput
}

/** 扫描结果快照，包含索引和原始数据。 */
export interface ScanSnapshot {
	graph: ScanGraph
	packages: PackageNode[]
	entries: string[]
	fallbackEntries: string[]
	byName: ReadonlyMap<string, PackageNode>
	byDir: ReadonlyMap<string, PackageNode>
	findPackage(selector: PackageSelector): PackageNode | undefined
	resolveEntry(selector: PackageSelector): EntryResolution | undefined
}

/**
 * 扫描工作区并解析包入口的核心服务。
 *
 * - 自动识别 pnpm / Yarn / npm workspaces 以及传统的 `packages/*` 结构。
 * - 内置缓存，避免重复构建扫描图，提高 CLI 与服务常驻模式的性能。
 * - 支持按需聚焦特定包、条件导出和 TS 回退文件收集。
 */
@Injectable({ key: serviceName })
export class ScanService {
	private defaults: ResolvedScanOptions
	private roots: string[]
	private readonly entryResolver = new EntryResolver()
	private readonly installedResolver = new InstalledPackageResolver()
	private readonly snapshotCache = new Map<string, Promise<ScanSnapshot>>()

	constructor(_ctx: Context, config: ScanServiceConfig = {}) {
		this.defaults = resolveScanOptions(DEFAULT_SCAN_OPTIONS, config.options)
		this.roots = normalizeInputs(config.roots ?? process.cwd())
	}

	/**
	 * 返回当前默认扫描根目录（已归一化且去重）。
	 */
	get defaultRoots(): string[] {
		return [...this.roots]
	}

	/**
	 * 以最小代价更新默认配置，支持同时替换根目录与扫描选项。
	 */
	updateConfig(config: ScanServiceConfig = {}) {
		let mutated = false
		if (config.options) {
			this.defaults = resolveScanOptions(this.defaults, config.options)
			mutated = true
		}
		if (config.roots) {
			this.roots = normalizeInputs(config.roots)
			mutated = true
		}
		if (mutated) this.clearCaches()
	}

	/**
	 * 仅更新默认扫描参数，常用于热更新配置。
	 */
	setDefaultOptions(overrides: ScanOptionsInput) {
		this.updateConfig({ options: overrides })
	}

	/**
	 * 重新指定默认扫描根目录。
	 */
	setRoots(roots: string | string[]) {
		this.roots = normalizeInputs(roots)
		this.clearCaches()
	}

	/**
	 * 手动清理缓存，下次调用会重新扫描磁盘。
	 */
	clearCaches() {
		this.snapshotCache.clear()
		this.entryResolver.clear()
		this.installedResolver.clear()
		clearResolveCache()
	}

	/**
	 * 构建（或复用缓存）扫描快照，包含包图、入口列表与索引。
	 */
	async snapshot(request: ScanTaskOptions = {}): Promise<ScanSnapshot> {
		const roots = resolveRoots(this.roots, request.roots)
		const options = resolveScanOptions(this.defaults, request.scan)
		const cacheKey = createCacheKey(roots, options)

		const cached = this.snapshotCache.get(cacheKey)
		if (cached) return cached

		const promise = this.buildSnapshot(roots, options).catch((err) => {
			this.snapshotCache.delete(cacheKey)
			throw err
		})
		this.snapshotCache.set(cacheKey, promise)
		return promise
	}

	/**
	 * 返回所有已解析入口（含 TS 回退），适合做预热或生成白名单。
	 */
	async scanEntries(request: ScanTaskOptions = {}): Promise<string[]> {
		const snapshot = await this.snapshot(request)
		const all = new Set<string>()
		for (const entry of snapshot.entries) all.add(entry)
		for (const file of snapshot.fallbackEntries) all.add(file)
		return Array.from(all)
	}

	/**
	 * 获取完整扫描图（roots / packages / diagnostics / stats）。
	 */
	async scanGraph(request: ScanTaskOptions = {}): Promise<ScanGraph> {
		const snapshot = await this.snapshot(request)
		return snapshot.graph
	}

	/**
	 * 按包名或目录解析入口，必要时自动回退到已安装依赖。
	 */
	async resolveEntry(
		selector: PackageSelector,
		request: ScanTaskOptions = {},
	): Promise<EntryResolution> {
		const focusHints = selectorFocusHints(selector)
		const overrides = request.scan ?? {}
		const finalScan =
			focusHints.length > 0
				? { ...overrides, focusPackages: mergeFocus(overrides.focusPackages, focusHints) }
				: overrides

		const snapshot = await this.snapshot({ roots: request.roots, scan: finalScan })
		const pkg = snapshot.findPackage(selector)
		if (pkg) return pkg.entry

		const fallback = this.resolveInstalledFallback(selector, snapshot.graph.options.conditions)
		return fallback ?? missingPackageResolution(selector)
	}

	/**
	 * 便捷入口：仅提供包名时的解析逻辑，自动修剪输入。
	 */
	async resolveEntryByName(name: string, request: ScanTaskOptions = {}): Promise<EntryResolution> {
		const trimmed = name.trim()
		if (!trimmed) {
			return {
				ok: false,
				dir: name,
				code: 'MISSING_PACKAGE',
				message: '包名为空，无法解析入口。',
			}
		}
		return this.resolveEntry({ name: trimmed }, request)
	}

	/**
	 * 直接解析 node_modules 中的已安装依赖入口，跳过工作区扫描。
	 */
	async resolveInstalledEntry(
		packageName: string,
		conditions?: string[],
	): Promise<EntryResolution> {
		const trimmed = packageName.trim()
		if (!trimmed) {
			return {
				ok: false,
				dir: packageName,
				code: 'MISSING_PACKAGE',
				message: '包名为空，无法解析入口。',
			}
		}
		const resolved = this.installedResolver.resolve(trimmed, conditions ?? this.defaults.conditions)
		return resolved ?? missingPackageResolution(trimmed)
	}

	private resolveInstalledFallback(
		selector: PackageSelector,
		conditions?: string[],
	): EntryResolution | undefined {
		const bare = selectorBareName(selector)
		if (!bare) return undefined
		return this.installedResolver.resolve(bare, conditions)
	}

	private async buildSnapshot(
		inputs: string[],
		options: ResolvedScanOptions,
	): Promise<ScanSnapshot> {
		const graph = await buildScanGraph(inputs, options, this.entryResolver)
		const byName = new Map<string, PackageNode>()
		const byDir = new Map<string, PackageNode>()

		for (const pkg of graph.packages) {
			const dirKey = normalizePackageDir(pkg.dir)
			if (dirKey && !byDir.has(dirKey)) byDir.set(dirKey, pkg)

			const nameKey = normalizePackageName(pkg.name)
			if (nameKey && !byName.has(nameKey)) byName.set(nameKey, pkg)
		}

		const findPackage = (selector: PackageSelector) => selectPackage(selector, byName, byDir)
		const resolve = (selector: PackageSelector) => findPackage(selector)?.entry

		return {
			graph,
			packages: graph.packages,
			entries: graph.entries,
			fallbackEntries: graph.fallbackEntries,
			byName,
			byDir,
			findPackage,
			resolveEntry: resolve,
		}
	}
}

export const isEntryOk = (entry: EntryResolution): entry is EntryResolutionOk => entry.ok
export const isPackageEntryOk = (
	pkg: PackageNode,
): pkg is PackageNode & { entry: EntryResolutionOk } => pkg.entry.ok

function normalizeInputs(input: string | string[]): string[] {
	const list = Array.isArray(input) ? input : [input]
	const out = new Set<string>()
	for (const raw of list) {
		const trimmed = typeof raw === 'string' ? raw.trim() : ''
		const candidate = trimmed || '.'
		const abs = isAbsolute(candidate) ? candidate : r(process.cwd(), candidate)
		out.add(normalize(abs))
	}
	if (out.size === 0) {
		return [normalize(r(process.cwd(), '.'))]
	}
	return Array.from(out).sort()
}

function createCacheKey(inputs: string[], options: ResolvedScanOptions): string {
	return JSON.stringify([[...inputs].sort(), options])
}

function resolveRoots(defaultRoots: string[], override?: string | string[]): string[] {
	if (!override) return defaultRoots
	return normalizeInputs(override)
}

function selectPackage(
	selector: PackageSelector,
	byName: Map<string, PackageNode>,
	byDir: Map<string, PackageNode>,
): PackageNode | undefined {
	if (typeof selector === 'string') {
		const nameKey = normalizePackageName(selector)
		if (nameKey) {
			const match = byName.get(nameKey)
			if (match) return match
		}
		const dirKey = normalizePackageDir(selector)
		if (dirKey) {
			const match = byDir.get(dirKey)
			if (match) return match
		}
		return undefined
	}

	const nameKey = normalizePackageName(selector.name)
	if (nameKey) {
		const match = byName.get(nameKey)
		if (match) return match
	}

	const dirKey = normalizePackageDir(selector.dir)
	if (dirKey) {
		const match = byDir.get(dirKey)
		if (match) return match
	}

	return undefined
}

function normalizePackageName(value?: string | null): string | undefined {
	if (!value) return undefined
	const trimmed = value.trim()
	return trimmed ? trimmed.toLowerCase() : undefined
}

function normalizePackageDir(value?: string | null): string | undefined {
	if (!value) return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	const abs = isAbsolute(trimmed) ? trimmed : r(process.cwd(), trimmed)
	return normalize(abs).toLowerCase()
}

function selectorFocusHints(selector: PackageSelector): string[] {
	const focus = new Set<string>()
	if (typeof selector === 'string') {
		const nameHint = normalizePackageName(selector)
		if (nameHint) focus.add(nameHint)
		const dirHint = normalizePackageDir(selector)
		if (dirHint) focus.add(dirHint)
		return [...focus]
	}

	const nameHint = normalizePackageName(selector.name)
	if (nameHint) focus.add(nameHint)
	const dirHint = normalizePackageDir(selector.dir)
	if (dirHint) focus.add(dirHint)
	return [...focus]
}

function mergeFocus(existing: string[] | undefined, additions: string[]): string[] {
	const merged = new Set(existing ?? [])
	for (const hint of additions) {
		const trimmed = hint.trim()
		if (trimmed) merged.add(trimmed)
	}
	return [...merged]
}

function missingPackageResolution(selector: PackageSelector): EntryResolution {
	const label = selectorLabel(selector)
	return {
		ok: false,
		dir: label ?? '',
		code: 'MISSING_PACKAGE',
		message: label ? `未在扫描范围内找到包 "${label}"。` : '未在扫描范围内找到目标包。',
	}
}

function selectorLabel(selector: PackageSelector): string | undefined {
	if (typeof selector === 'string') {
		const trimmed = selector.trim()
		return trimmed || undefined
	}
	const name = selector.name?.toString().trim()
	if (name) return name
	const dir = selector.dir?.toString().trim()
	return dir || undefined
}

class InstalledPackageResolver {
	private readonly from: URL

	constructor(baseDir: string = process.cwd()) {
		this.from = ensureDirectoryURL(baseDir)
	}

	resolve(bareName: string, conditions?: string[]): EntryResolutionOk | undefined {
		for (const variant of this.resolutionPlan(conditions)) {
			const entryPath = this.resolveWithConditions(bareName, variant)
			if (!entryPath) continue

			let manifestPath = this.resolveWithConditions(`${bareName}/package.json`, variant)
			if (!manifestPath && variant) {
				manifestPath = this.resolveWithConditions(`${bareName}/package.json`)
			}

			const pkgDir = manifestPath ? dirname(manifestPath) : dirname(entryPath)
			return {
				ok: true,
				dir: normalize(pkgDir),
				entry: normalize(entryPath),
				source: 'exports',
				tried: [],
			}
		}
		return undefined
	}

	clear() {
		// no-op: resolution cache lives in exsolve global state, cleared by ScanService.
	}

	private resolveWithConditions(id: string, conditions?: string[]): string | undefined {
		const options: { from: URL; try: true; conditions?: string[] } = {
			from: this.from,
			try: true,
		}
		if (conditions && conditions.length > 0) {
			options.conditions = [...conditions]
		}
		return resolveModulePath(id, options)
	}

	private resolutionPlan(conditions?: string[]): Array<string[] | undefined> {
		if (conditions && conditions.length > 0) {
			return [conditions, undefined]
		}
		return [undefined]
	}
}

function selectorBareName(selector: PackageSelector): string | undefined {
	if (typeof selector === 'string') {
		const trimmed = selector.trim()
		return trimmed || undefined
	}
	const value = selector.name
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}

function ensureDirectoryURL(input: string): URL {
	const normalized = normalize(input)
	const asDir = normalized.endsWith('/') ? normalized : `${normalized}/`
	return pathToFileURL(asDir)
}
