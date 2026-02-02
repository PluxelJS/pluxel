import { pathToFileURL } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import { type ResolveOptions, resolveModulePath } from 'exsolve'
import { dirname, normalize } from 'pathe'
import { EntryResolver } from './entry-resolver'
import { DEFAULT_SCAN_OPTIONS, resolveScanOptions } from './options'
import { ModuleResolveCache } from './resolve-cache'
import {
	mergeFocus,
	missingPackageResolution,
	type PackageSelector,
	selectorBareName,
	selectorFocusHints,
} from './selectors'
import { normalizeScanInputs, resolveScanRoots } from './shared'
import { type ScanSnapshot, ScanSnapshotBuilder, ScanSnapshotCache } from './snapshot'
import type {
	EntryResolution,
	EntryResolutionOk,
	PackageNode,
	ResolvedScanOptions,
	ScanOptionsInput,
} from './types'

const serviceName = 'scanService' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: ScanService
		}
		interface Config {
			[serviceName]?: ScanServiceConfig
		}
	}
}

export type { PackageSelector } from './selectors'
export type { ScanSnapshot } from './snapshot'
export type {
	EntryResolution,
	EntryResolutionOk,
	PackageNode,
	ScanDiagnostic,
	ScanGraph,
	ScanOptionsInput,
	ScanStats,
} from './types'

export interface ScanServiceConfig {
	/** 默认扫描根目录，可传单个路径或路径数组。 */
	roots?: string | string[]
	/** 默认扫描选项，将与内置默认合并。 */
	options?: ScanOptionsInput
	/** ROOT used when resolving already installed packages. Defaults to process.cwd(). */
	installedBase?: string
}

export interface ScanTaskOptions {
	/** 临时覆盖扫描根目录。 */
	roots?: string | string[]
	/** 临时覆盖扫描参数。 */
	scan?: ScanOptionsInput
	/** 当为 true 时，仅返回工作区包，不回退到已安装依赖。 */
	workspaceOnly?: boolean
}

export interface WorkspaceEntryInfo {
	dir: string
	entry: string
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
	public ctx: Context
	private defaults: ResolvedScanOptions
	private roots: string[]
	private readonly resolveCache = new ModuleResolveCache()
	private readonly entryResolver = new EntryResolver(this.resolveCache)
	private readonly snapshotBuilder = new ScanSnapshotBuilder(this.entryResolver)
	private readonly snapshotCache = new ScanSnapshotCache(this.snapshotBuilder)
	private readonly installedResolver: InstalledPackageResolver

	constructor(ctx: Context, config: ScanServiceConfig = {}) {
		this.ctx = ctx
		this.defaults = resolveScanOptions(DEFAULT_SCAN_OPTIONS, config.options)
		this.roots = normalizeScanInputs(config.roots ?? process.cwd())
		this.installedResolver = new InstalledPackageResolver(
			this.resolveCache,
			config.installedBase ?? process.cwd(),
		)
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
			this.roots = normalizeScanInputs(config.roots)
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
		this.roots = normalizeScanInputs(roots)
		this.clearCaches()
	}

	/**
	 * 手动清理缓存，下次调用会重新扫描磁盘。
	 */
	clearCaches() {
		this.snapshotCache.clear()
		this.invalidateResolverCache()
	}

	/**
	 * 仅清空模块解析缓存，适合在依赖安装/升级后调用。
	 */
	invalidateResolverCache() {
		this.entryResolver.clear()
		this.resolveCache.clear()
	}

	private async snapshot(request: ScanTaskOptions = {}): Promise<ScanSnapshot> {
		const roots = resolveScanRoots(this.roots, request.roots)
		const options = resolveScanOptions(this.defaults, request.scan)
		return this.snapshotCache.get(roots, options)
	}

	/**
	 * 按包名或目录解析入口，必要时自动回退到已安装依赖。
	 */
	async resolveEntry(
		selector: PackageSelector,
		request: ScanTaskOptions = {},
	): Promise<EntryResolution> {
		const focusHints = selectorFocusHints(selector)
		const baseScan = request.scan
		const finalScan =
			focusHints.length > 0
				? {
						...(baseScan ?? {}),
						focusPackages: mergeFocus(baseScan?.focusPackages, focusHints),
					}
				: baseScan

		const snapshot = await this.snapshot({
			roots: request.roots,
			scan: finalScan,
		})
		const pkg = snapshot.findPackage(selector)
		if (pkg) return pkg.entry

		if (request.workspaceOnly) {
			return missingPackageResolution(selector)
		}

		const fallback = this.resolveInstalledFallback(selector, snapshot.graph.options.conditions)
		return fallback ?? missingPackageResolution(selector)
	}

	/**
	 * 便捷入口：仅提供包名时的解析逻辑，自动修剪输入。
	 */
	async resolveEntryByName(name: string, request: ScanTaskOptions = {}): Promise<EntryResolution> {
		const trimmed = selectorBareName(name)
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

	async listWorkspaceEntries(request: ScanTaskOptions = {}): Promise<WorkspaceEntryInfo[]> {
		const snapshot = await this.snapshot(request)
		const entries: WorkspaceEntryInfo[] = []
		for (const pkg of snapshot.packages) {
			if (isPackageEntryOk(pkg)) {
				entries.push({
					dir: pkg.dir,
					entry: pkg.entry.entry,
				})
			}
		}
		return entries
	}

	/**
	 * 直接解析 node_modules 中的已安装依赖入口，跳过工作区扫描。
	 */
	async resolveInstalledEntry(
		packageName: string,
		conditions?: string[],
	): Promise<EntryResolution> {
		const trimmed = selectorBareName(packageName)
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
}

export const isEntryOk = (entry: EntryResolution): entry is EntryResolutionOk => entry.ok
export const isPackageEntryOk = (
	pkg: PackageNode,
): pkg is PackageNode & { entry: EntryResolutionOk } => pkg.entry.ok

class InstalledPackageResolver {
	private readonly from: URL

	constructor(
		private readonly cache: ModuleResolveCache,
		baseDir: string = process.cwd(),
	) {
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

	private resolveWithConditions(id: string, conditions?: string[]): string | undefined {
		const options: ResolveOptions = {
			from: this.from,
			try: true,
			cache: this.cache.map,
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

function ensureDirectoryURL(input: string): URL {
	const normalized = normalize(input)
	const asDir = normalized.endsWith('/') ? normalized : `${normalized}/`
	return pathToFileURL(asDir)
}
