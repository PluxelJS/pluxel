import { pathToFileURL } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import type { OperationOptions } from 'nypm'
import { addDependency, ensureDependencyInstalled } from 'nypm'
import { normalize as normalizePath, resolve as resolvePath } from 'pathe'
import type { RemovalScope } from '../loader'
import type { EntryResolutionOk, ScanTaskOptions } from './ScanService'
import { isEntryOk } from './ScanService'
import {
	type NormalizedPackageSpecifier,
	normalizeSpecifier,
	type PackageSpecifierInput,
	tryNormalizeSpecifier,
} from './specifiers'
import {
	PackageStateStore,
	type PackageStatePayload,
	type PersistedPackageEntry,
} from './package/state-store'

const serviceName = 'packageService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: PackageService
	}
	interface Config {
		[serviceName]?: PackageServiceConfig
	}
}

export type PackageServiceErrorCode =
	| 'INVALID_SPEC'
	| 'INSTALL_FAILED'
	| 'RESOLUTION_FAILED'
	| 'IMPORT_FAILED'

export class PackageServiceError extends Error {
	override name = 'PackageServiceError'

	constructor(
		public readonly code: PackageServiceErrorCode,
		message: string,
		public readonly detail?: unknown,
	) {
		super(message)
	}
}

export type PackageInstallStatus = 'installed' | 'reused'

export interface PackageInstallResult {
	spec: NormalizedPackageSpecifier
	target: string
	status: PackageInstallStatus
}

export interface PackageLoadResult {
	spec: NormalizedPackageSpecifier
	resolution: EntryResolutionOk
	module: Record<string, unknown>
	moduleId: string
	isAnchor: boolean
	install?: PackageInstallResult
	loadedAt: number
}

export interface PackageLoadFailure {
	input: PackageSpecifierInput
	spec?: NormalizedPackageSpecifier
	error: unknown
}

export interface PackageBatchLoadResult {
	loaded: PackageLoadResult[]
	failures: PackageLoadFailure[]
}

export interface PackageSnapshotEntry {
	spec: NormalizedPackageSpecifier
	resolution: EntryResolutionOk
	moduleId: string
	isAnchor: boolean
	installStatus?: PackageInstallStatus
	loadedAt: number
}

export interface PackageSnapshot {
	generatedAt: string
	packages: PackageSnapshotEntry[]
}

export interface ModuleCacheEntry {
	name: string
	spec: NormalizedPackageSpecifier
	resolution: EntryResolutionOk
	moduleId: string
	module: Record<string, unknown>
	isAnchor: boolean
	loadedAt: number
}

export type PackageLoadDescriptor =
	| PackageSpecifierInput
	| {
			spec: PackageSpecifierInput
			options?: LoadPackageOptions
	  }

export interface PackageBatchLoadOptions {
	defaults?: LoadPackageOptions
	continueOnError?: boolean
}

export interface HydrateSnapshotOptions extends PackageBatchLoadOptions {
	assumeInstalled?: boolean
}

/** 安装选项：基于 nypm 的 OperationOptions，外加 force。 */
export interface InstallOptions extends OperationOptions {
	force?: boolean
}

/** 加载选项：在安装选项基础上扩展扫描、跳过安装等配置。 */
export interface LoadPackageOptions extends InstallOptions {
	scan?: ScanTaskOptions
	skipInstall?: boolean
	importFresh?: boolean
	resolvedEntry?: EntryResolutionOk
	injectIntoLoader?: boolean
}

export interface PackageServiceConfig {
	install?: InstallOptions
	scan?: ScanTaskOptions
	importFresh?: boolean
	state?: {
		file?: string
		debounceMs?: number
	}
}

interface ResolvedInstallOptions extends OperationOptions {
	force: boolean
	installPeerDependencies: boolean
	cwd: string
}

interface CachedModule {
	moduleId: string
	module: Record<string, unknown>
}

@Injectable({ key: serviceName })
export class PackageService {
	private readonly defaults: {
		install: ResolvedInstallOptions
		scan?: ScanTaskOptions
		importFresh: boolean
	}

	private readonly installLocks = new Map<string, Promise<PackageInstallResult>>()
	private readonly loadLocks = new Map<string, Promise<PackageLoadResult>>()
	private readonly moduleCache = new Map<string, CachedModule>()
	private readonly packageModuleIds = new Map<string, string>()
	private readonly loadedPackages = new Map<string, PackageLoadResult>()
	private readonly stateStore: PackageStateStore
	private readonly ready: Promise<void>
	private initialized = false

	constructor(
		private readonly ctx: Context,
		config: PackageServiceConfig = {},
	) {
		this.defaults = {
			install: resolveInstallDefaults(config.install),
			scan: config.scan,
			importFresh: config.importFresh ?? false,
		}
		const stateFile = resolveStateFilePath(config.state?.file)
		this.stateStore = new PackageStateStore({
			file: stateFile,
			debounceMs: config.state?.debounceMs,
			onError: (error) => {
				this.ctx.logger?.warn(
					{ error, stateFile },
					'[PackageService] 持久化包状态失败',
				)
			},
		})
		this.ready = this.initializeFromState()
			.catch((error) => {
				this.ctx.logger?.warn({ error }, '[PackageService] 恢复包状态失败')
			})
			.finally(() => {
				this.initialized = true
			})
	}

	/** 统一整理包名/版本输入，非法输入会抛错。 */
	normalizeSpecifier(input: PackageSpecifierInput): NormalizedPackageSpecifier {
		try {
			return normalizeSpecifier(input)
		} catch (error) {
			throw new PackageServiceError('INVALID_SPEC', '包名不能为空。', { input, cause: error })
		}
	}

	/**
	 * 安装插件包；如果明确传入版本（或 force=true）则调用 addDependency，否则使用 ensureDependencyInstalled。
	 */
	async installPackage(
		input: PackageSpecifierInput,
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		const key = spec.key
		const resolved = this.resolveInstallOptions(overrides)
		return this.runExclusive(this.installLocks, key, () => this.performInstall(spec, resolved))
	}

	/** 在扫描上下文中解析入口。 */
	async resolveEntry(
		input: PackageSpecifierInput,
		options: ScanTaskOptions = {},
	): Promise<EntryResolutionOk> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		return this.resolveEntryForSpec(spec, options)
	}

	/**
	 * 加载插件模块；默认会尝试安装，可通过 skipInstall 跳过，仅从本地加载。
	 */
	async loadPackage(
		input: PackageSpecifierInput,
		options: LoadPackageOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		const key = spec.key

		return this.runExclusive(this.loadLocks, key, async () => {
			const {
				skipInstall = false,
				importFresh,
				scan,
				resolvedEntry,
				injectIntoLoader,
				...installOverrides
			} = options
			const installOptions = this.resolveInstallOptions(installOverrides)
			let installResult: PackageInstallResult | undefined

			if (!skipInstall) {
				installResult = await this.performInstall(spec, installOptions)
			}

			const resolution = resolvedEntry ?? (await this.resolveEntryForSpec(spec, scan))
			const moduleId = normalizePath(resolution.entry)
			this.ensurePackageModuleBinding(spec.name, moduleId)

			const shouldImportFresh = importFresh ?? this.defaults.importFresh
			const cached = shouldImportFresh ? undefined : this.moduleCache.get(moduleId)
			const module = cached?.module ?? (await this.importModule(moduleId, shouldImportFresh))
			if (!cached || shouldImportFresh) {
				this.moduleCache.set(moduleId, { moduleId, module })
			}
			this.primeHmrModuleCache(spec, moduleId, module)

			const shouldInject = injectIntoLoader ?? true
			const isAnchor = shouldInject ? this.ctx.loader.replaceModule(moduleId, module) : false

			const result: PackageLoadResult = {
				spec,
				resolution,
				module,
				moduleId,
				isAnchor,
				install: installResult,
				loadedAt: Date.now(),
			}
			this.loadedPackages.set(spec.name, result)
			this.schedulePersistSnapshot()
			return result
		})
	}

	/**
	 * 便捷封装：假定包已安装，仅刷新加载。
	 */
	async loadInstalled(
		input: PackageSpecifierInput,
		options: Omit<LoadPackageOptions, 'skipInstall'> = {},
	): Promise<PackageLoadResult> {
		return this.loadPackage(input, { ...options, skipInstall: true })
	}

	/**
	 * 便捷封装：始终先安装再加载。
	 */
	async installAndLoad(
		input: PackageSpecifierInput,
		options: LoadPackageOptions = {},
	): Promise<PackageLoadResult> {
		return this.loadPackage(input, { ...options, skipInstall: false })
	}

	/**
	 * 批量加载，支持统一默认配置与按包覆写，可选择忽略失败继续。
	 */
	async loadMany(
		descriptors: Iterable<PackageLoadDescriptor>,
		options: PackageBatchLoadOptions = {},
	): Promise<PackageBatchLoadResult> {
		const results: PackageLoadResult[] = []
		const failures: PackageLoadFailure[] = []
		const defaults = options.defaults ?? {}
		const continueOnError = options.continueOnError ?? false

		for (const item of descriptors) {
			const descriptor = normalizeDescriptor(item)
			const mergedOptions = mergeLoadOptions(defaults, descriptor.options)
			const normalized = tryNormalizeSpecifier(descriptor.spec)
			try {
				const result = await this.loadPackage(descriptor.spec, mergedOptions)
				results.push(result)
			} catch (error) {
				failures.push({ input: descriptor.spec, spec: normalized, error })
				if (!continueOnError) {
					throw error
				}
			}
		}

		return { loaded: results, failures }
	}

	getLoaded(name: string): PackageLoadResult | undefined {
		if (!this.initialized) return undefined
		return this.loadedPackages.get(name)
	}

	listLoaded(): PackageLoadResult[] {
		if (!this.initialized) return []
		return Array.from(this.loadedPackages.values())
	}

	createSnapshot(): PackageSnapshot {
		const packages: PackageSnapshotEntry[] = []
		for (const record of this.loadedPackages.values()) {
			packages.push({
				spec: record.spec,
				resolution: record.resolution,
				moduleId: record.moduleId,
				isAnchor: record.isAnchor,
				installStatus: record.install?.status,
				loadedAt: record.loadedAt,
			})
		}
		return {
			generatedAt: new Date().toISOString(),
			packages,
		}
	}

	async hydrateSnapshot(
		snapshot: PackageSnapshot,
		options: HydrateSnapshotOptions = {},
	): Promise<PackageBatchLoadResult> {
		const assumeInstalled = options.assumeInstalled ?? true
		const baseDefaults = options.defaults ?? {}
		const defaults: LoadPackageOptions = {
			...baseDefaults,
		}
		if (assumeInstalled && defaults.skipInstall !== false) {
			defaults.skipInstall = true
		}

		const descriptors = snapshot.packages.map((pkg) => ({
			spec: pkg.spec,
			options: {
				resolvedEntry: pkg.resolution,
			},
		}))

		return this.loadMany(descriptors, {
			defaults,
			continueOnError: options.continueOnError,
		})
	}

	getModuleCacheEntries(): ModuleCacheEntry[] {
		if (!this.initialized) return []
		const entries: ModuleCacheEntry[] = []
		for (const [name, record] of this.loadedPackages) {
			entries.push({
				name,
				spec: record.spec,
				resolution: record.resolution,
				moduleId: record.moduleId,
				module: record.module,
				isAnchor: record.isAnchor,
				loadedAt: record.loadedAt,
			})
		}
		return entries
	}

	forEachCachedModule(visitor: (entry: ModuleCacheEntry) => void) {
		if (!this.initialized) return
		for (const [name, record] of this.loadedPackages) {
			visitor({
				name,
				spec: record.spec,
				resolution: record.resolution,
				moduleId: record.moduleId,
				module: record.module,
				isAnchor: record.isAnchor,
				loadedAt: record.loadedAt,
			})
		}
	}

	getCachedModule(moduleId: string): Record<string, unknown> | undefined {
		if (!this.initialized) return undefined
		return this.moduleCache.get(normalizePath(moduleId))?.module
	}

	/** 主动移除指定包的模块缓存，并可选择清理 loader 运行态。 */
	invalidatePackage(name: string, scope: RemovalScope = 'runtime') {
		const record = this.loadedPackages.get(name)
		const moduleId = record?.moduleId ?? this.packageModuleIds.get(name)
		if (!moduleId) return
		if (record) this.dropHmrModuleCacheForRecord(record)
		else this.ctx.hmrService.dropModuleCacheEntries([moduleId, name])
		this.moduleCache.delete(moduleId)
		this.packageModuleIds.delete(name)
		this.loadedPackages.delete(name)
		this.ctx.loader.pruneModule(moduleId, scope)
		this.schedulePersistSnapshot()
	}

	/** 移除指定模块 ID 的缓存，不操作 loader。 */
	invalidateModuleId(moduleId: string) {
		const normalized = normalizePath(moduleId)
		const record = this.findLoadedRecordByModuleId(normalized)
		if (record) this.dropHmrModuleCacheForRecord(record)
		else this.ctx.hmrService.dropModuleCacheEntries([normalized])
		this.moduleCache.delete(normalized)
		for (const [pkgName, id] of this.packageModuleIds) {
			if (id === normalized) {
				this.packageModuleIds.delete(pkgName)
				this.loadedPackages.delete(pkgName)
				break
			}
		}
		this.schedulePersistSnapshot()
	}

	/** 清空所有运行时缓存，可选是否通知 loader。 */
	clearCache({ prune = false, scope = 'runtime' }: { prune?: boolean; scope?: RemovalScope } = {}) {
		if (prune) {
			for (const moduleId of this.moduleCache.keys()) {
				this.ctx.loader.pruneModule(moduleId, scope)
			}
		}
		if (this.ctx.hmrService) {
			const ids = new Set<string>()
			for (const record of this.loadedPackages.values()) {
				for (const id of this.collectHmrModuleCacheIds(record.moduleId, record.spec)) {
					ids.add(id)
				}
			}
			this.ctx.hmrService.dropModuleCacheEntries(ids)
		}
		this.moduleCache.clear()
		this.packageModuleIds.clear()
		this.loadedPackages.clear()
		this.schedulePersistSnapshot()
	}

	/** 将外部包的执行结果灌入 HMR 的 moduleCache，避免重复实例化。 */
	private primeHmrModuleCache(
		spec: NormalizedPackageSpecifier,
		moduleId: string,
		module: Record<string, unknown>,
	) {
		const hmr = this.ctx.hmrService
		const normalized = normalizePath(moduleId)
		const ids = this.collectHmrModuleCacheIds(normalized, spec)
		const aliases = [...ids].filter((id) => id !== normalized)
		hmr.primeModuleCacheEntry({ id: normalized, exports: module, aliases })
	}

	/** 清理对应包的 HMR moduleCache 映射（主 ID + 各别名）。 */
	private dropHmrModuleCacheForRecord(record: PackageLoadResult) {
		const hmr = this.ctx.hmrService
		const ids = this.collectHmrModuleCacheIds(record.moduleId, record.spec)
		hmr.dropModuleCacheEntries(ids)
	}

	/** 汇总同一模块在 vite-node 中可能出现的 key 形态。 */
	private collectHmrModuleCacheIds(
		moduleId: string,
		spec: NormalizedPackageSpecifier,
	): Set<string> {
		const normalized = normalizePath(moduleId)
		const ids = new Set<string>([normalized])
		ids.add(spec.name)
		ids.add(spec.target)
		ids.add(spec.raw)
		try {
			ids.add(pathToFileURL(moduleId).href)
		} catch {
			// ignore invalid URL conversion
		}
		return ids
	}

	private findLoadedRecordByModuleId(moduleId: string): PackageLoadResult | undefined {
		for (const record of this.loadedPackages.values()) {
			if (record.moduleId === moduleId) return record
		}
		return undefined
	}

	private async initializeFromState(): Promise<void> {
		let payload: PackageStatePayload | null = null
		try {
			payload = await this.stateStore.read()
		} catch (error) {
			this.ctx.logger?.warn({ error }, '[PackageService] 读取包状态失败')
			throw error
		}
		if (!payload) return
		const mutated = await this.restorePersistedPackages(payload.packages)
		if (mutated) this.schedulePersistSnapshot()
	}

	private async restorePersistedPackages(entries: PersistedPackageEntry[]): Promise<boolean> {
		let mutated = false
		for (const entry of entries) {
			const spec = entry.spec
			try {
				const moduleId = normalizePath(entry.moduleId || entry.resolution.entry)
				const module = await this.importModule(moduleId, this.defaults.importFresh)
				this.ensurePackageModuleBinding(spec.name, moduleId)
				this.moduleCache.set(moduleId, { moduleId, module })
				this.primeHmrModuleCache(spec, moduleId, module)
				if (entry.isAnchor) {
					this.ctx.loader.replaceModule(moduleId, module)
				}
				const record: PackageLoadResult = {
					spec,
					resolution: entry.resolution,
					module,
					moduleId,
					isAnchor: entry.isAnchor,
					install: entry.installStatus
						? { spec, target: spec.target, status: entry.installStatus }
						: undefined,
					loadedAt: Date.now(),
				}
				this.loadedPackages.set(spec.name, record)
				mutated = true
			} catch (error) {
				this.ctx.logger?.warn(
					{ error, spec },
					'[PackageService] 恢复包失败，已跳过该条记录',
				)
				mutated = true
			}
		}
		return mutated
	}

	private ensureReady(): Promise<void> {
		return this.ready
	}

	private schedulePersistSnapshot() {
		if (!this.stateStore) return
		const snapshot = this.createSnapshot()
		this.stateStore.scheduleWrite(snapshot)
	}

	private async performInstall(
		spec: NormalizedPackageSpecifier,
		options: ResolvedInstallOptions,
	): Promise<PackageInstallResult> {
		const { force, ...operationOptions } = options
		try {
			if (force || spec.version) {
				await addDependency(spec.target, operationOptions)
				return { spec, target: spec.target, status: 'installed' }
			}

			const existed = await ensureDependencyInstalled(spec.name, pickEnsureOptions(options))
			return {
				spec,
				target: spec.target,
				status: existed === true ? 'reused' : 'installed',
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : '未知错误'
			throw new PackageServiceError(
				'INSTALL_FAILED',
				`安装插件 "${spec.target}" 失败：${message}`,
				{
					cause: error,
					spec,
					options,
				},
			)
		}
	}

	private async resolveEntryForSpec(
		spec: NormalizedPackageSpecifier,
		scanOverrides?: ScanTaskOptions,
	): Promise<EntryResolutionOk> {
		const resolution = await this.ctx.scanService.resolveEntry(
			{ name: spec.name },
			this.mergeScanOptions(scanOverrides),
		)
		if (!isEntryOk(resolution)) {
			throw new PackageServiceError('RESOLUTION_FAILED', resolution.message, { spec, resolution })
		}
		return resolution
	}

	private async importModule(
		moduleId: string,
		forceFresh: boolean,
	): Promise<Record<string, unknown>> {
		const url = pathToFileURL(moduleId)
		if (forceFresh) {
			url.searchParams.set('_ts', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
		}
		try {
			return await import(url.href)
		} catch (error) {
			throw new PackageServiceError('IMPORT_FAILED', `导入模块 "${moduleId}" 失败。`, {
				moduleId,
				cause: error,
			})
		}
	}

	private resolveInstallOptions(overrides: InstallOptions = {}): ResolvedInstallOptions {
		const base = this.defaults.install
		const { force, installPeerDependencies, ...rest } = overrides
		return {
			...base,
			...rest,
			cwd: rest.cwd ?? base.cwd ?? process.cwd(),
			force: force ?? base.force,
			installPeerDependencies: installPeerDependencies ?? base.installPeerDependencies,
		}
	}

	private mergeScanOptions(overrides?: ScanTaskOptions): ScanTaskOptions | undefined {
		const base = this.defaults.scan
		if (!base) return overrides
		if (!overrides) return base
		return {
			roots: overrides.roots ?? base.roots,
			scan: base.scan ? { ...base.scan, ...overrides.scan } : overrides.scan,
		}
	}

	private runExclusive<T>(
		store: Map<string, Promise<T>>,
		key: string,
		task: () => Promise<T>,
	): Promise<T> {
		const existing = store.get(key)
		if (existing) return existing
		const promise = task().finally(() => {
			store.delete(key)
		})
		store.set(key, promise)
		return promise
	}

	private ensurePackageModuleBinding(name: string, nextModuleId: string) {
		const normalized = normalizePath(nextModuleId)
		const current = this.packageModuleIds.get(name)
		if (current && current !== normalized) {
			this.moduleCache.delete(current)
			this.ctx.loader.pruneModule(current, 'runtime')
		}
		this.packageModuleIds.set(name, normalized)
	}
}

function resolveStateFilePath(file?: string): string {
	if (file) return resolvePath(file)
	return resolvePath(process.cwd(), '.pluxel', 'hmr', 'package-state.json')
}

function resolveInstallDefaults(options: InstallOptions = {}): ResolvedInstallOptions {
	return {
		cwd: options.cwd ?? process.cwd(),
		dev: options.dev ?? false,
		workspace: options.workspace,
		env: options.env,
		silent: options.silent,
		packageManager: options.packageManager,
		global: options.global,
		dry: options.dry,
		installPeerDependencies: options.installPeerDependencies ?? false,
		force: options.force ?? false,
	}
}

function pickEnsureOptions(
	options: ResolvedInstallOptions,
): Pick<ResolvedInstallOptions, 'cwd' | 'dev' | 'workspace'> {
	const { cwd, dev, workspace } = options
	return { cwd, dev, workspace }
}

function normalizeDescriptor(input: PackageLoadDescriptor): {
	spec: PackageSpecifierInput
	options?: LoadPackageOptions
} {
	if (isDescriptorObject(input)) {
		return input
	}
	return { spec: input }
}

function isDescriptorObject(
	value: PackageLoadDescriptor,
): value is { spec: PackageSpecifierInput; options?: LoadPackageOptions } {
	return typeof value === 'object' && value !== null && 'spec' in value
}

function mergeLoadOptions(
	defaults: LoadPackageOptions,
	overrides?: LoadPackageOptions,
): LoadPackageOptions {
	if (!overrides) return { ...defaults }
	const { scan, resolvedEntry, ...rest } = overrides
	return {
		...defaults,
		...rest,
		scan: scan ?? defaults.scan,
		resolvedEntry: resolvedEntry ?? defaults.resolvedEntry,
	}
}
