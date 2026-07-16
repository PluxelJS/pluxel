import { type Context as PluxelContext, Injectable } from '@pluxel/core'
import type { ResolverCacheInvalidatedEvent } from '@pluxel/core/services'
import { dirname, normalize, resolve as r } from 'pathe'
import {
	clearOxcResolveCache,
	type OxcResolver,
	getCachedResolver,
	getOxcResolveCache,
	hasNodeModulesPackageJson,
	resolveModulePath,
} from '@pluxel/runtime/internal'
import { EntryResolver } from './entry-resolver'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'
import { DEFAULT_SCAN_OPTIONS, resolveScanOptions } from './options'
import {
	mergeFocus,
	missingPackageResolution,
	type PackageSelector,
	selectorBareName,
	selectorFocusHints,
} from './selectors'
import { createScanCacheKey, normalizeScanInputs, resolveScanRoots } from './shared'
import { buildScanSnapshot, type ScanSnapshot } from './snapshot'
import {
	isPackageEntryOk,
	type EntryResolution,
	type EntryResolutionOk,
	type ResolvedScanOptions,
	type ScanTaskOptions,
	type ScanOptionsInput,
	type WorkspaceEntryInfo,
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
	ScanTaskOptions,
	WorkspaceEntryInfo,
} from './types'
export { isEntryOk, isPackageEntryOk } from './types'

export interface ScanServiceConfig {
	/** 默认扫描根目录，可传单个路径或路径数组。 */
	roots?: string | string[]
	/** 默认扫描选项，将与内置默认合并。 */
	options?: ScanOptionsInput
	/** ROOT used when resolving already installed packages. Defaults to process.cwd(). */
	installedBase?: string
	/** Override workspace scanning filesystem operations for hermetic tests. */
	fs?: WorkspaceFs
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
	public ctx: PluxelContext
	private defaults: ResolvedScanOptions
	private roots: string[]
	private readonly resolveCache = getOxcResolveCache(new Map())
	private scanFs: WorkspaceFs
	private installedBase: string
	private entryResolver: EntryResolver
	private readonly snapshotCache = new Map<string, Promise<ScanSnapshot>>()
	private installedResolver: OxcResolver
	private installedNodeModulesDir: string

	constructor(ctx: PluxelContext, config: ScanServiceConfig = {}) {
		this.ctx = ctx
		this.defaults = resolveScanOptions(DEFAULT_SCAN_OPTIONS, config.options)
		this.roots = normalizeScanInputs(config.roots ?? process.cwd())
		this.scanFs = config.fs ?? nodeWorkspaceFs
		this.installedBase = config.installedBase ?? process.cwd()
		this.entryResolver = new EntryResolver(this.resolveCache, this.scanFs)
		this.installedResolver = this.createInstalledResolver(this.installedBase)
		this.installedNodeModulesDir = this.resolveNodeModulesDir(this.installedBase)
	}

	/**
	 * Exposes the underlying OXC resolver resolve cache map for advanced integrations (e.g. HMR runner).
	 *
	 * Sharing this cache across long-lived services reduces duplicate work and keeps cache invalidation
	 * behavior consistent (`invalidateResolverCache()` clears this map).
	 */
	get resolverCache(): Map<string, unknown> {
		return this.resolveCache
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
		if (config.fs && config.fs !== this.scanFs) {
			this.scanFs = config.fs
			this.rebuildScanState()
			mutated = true
		}
		if (config.installedBase && config.installedBase !== this.installedBase) {
			this.installedBase = config.installedBase
			this.installedResolver = this.createInstalledResolver(this.installedBase)
			this.installedNodeModulesDir = this.resolveNodeModulesDir(this.installedBase)
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
		this.clearSnapshotCache()
		this.invalidateResolverCache({ by: 'scanService', reason: 'clearCaches' })
	}

	private rebuildScanState() {
		this.entryResolver = new EntryResolver(this.resolveCache, this.scanFs)
		this.clearSnapshotCache()
	}

	/**
	 * 仅清空模块解析缓存，适合在依赖安装/升级后调用。
	 */
	invalidateResolverCache(detail?: ResolverCacheInvalidatedEvent) {
		this.entryResolver.clear()
		clearOxcResolveCache(this.resolveCache)

		// Notify long-lived runtime services so they can drop derived resolution caches.
		this.ctx.internalEvent.resolverCacheInvalidated.emit(detail)
	}

	private snapshot(request: ScanTaskOptions = {}): Promise<ScanSnapshot> {
		const roots = resolveScanRoots(this.roots, request.roots)
		const options = resolveScanOptions(this.defaults, request.scan)
		const key = createScanCacheKey(roots, options)
		const cached = this.snapshotCache.get(key)
		if (cached) return cached

		const promise = buildScanSnapshot(roots, options, this.entryResolver, this.scanFs).catch(
			(err) => {
				this.snapshotCache.delete(key)
				throw err
			},
		)
		this.snapshotCache.set(key, promise)
		return promise
	}

	private clearSnapshotCache() {
		this.snapshotCache.clear()
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
						...baseScan,
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
		const resolved = this.resolveInstalledPackage(trimmed, conditions ?? this.defaults.conditions)
		return resolved ?? missingPackageResolution(trimmed)
	}

	private resolveInstalledFallback(
		selector: PackageSelector,
		conditions?: string[],
	): EntryResolution | undefined {
		const bare = selectorBareName(selector)
		if (!bare) return undefined
		return this.resolveInstalledPackage(bare, conditions)
	}

	private resolveInstalledPackage(
		bareName: string,
		conditions?: string[],
	): EntryResolutionOk | undefined {
		if (!hasNodeModulesPackageJson(this.installedNodeModulesDir, bareName)) return undefined

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
		return resolveModulePath(this.installedResolver, id, { conditions }) ?? undefined
	}

	private resolutionPlan(conditions?: string[]): Array<string[] | undefined> {
		if (conditions && conditions.length > 0) {
			return [conditions, undefined]
		}
		return [undefined]
	}

	private createInstalledResolver(baseDir: string): OxcResolver {
		return getCachedResolver(this.resolveCache, 'scan:installed-resolver', [baseDir], {
			limit: 8,
		})
	}

	private resolveNodeModulesDir(baseDir: string): string {
		return normalize(r(baseDir, 'node_modules'))
	}
}
