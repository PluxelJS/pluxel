import { pathToFileURL } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import type { OperationOptions } from 'nypm'
import { addDependency, ensureDependencyInstalled } from 'nypm'
import { normalize as normalizePath, resolve as resolvePath } from 'pathe'
import type { RemovalScope } from '../loader'
import {
	type PackageStatePayload,
	PackageStateStore,
	type PackageStateStoreOptions,
	type PersistedPackageEntry,
} from './package/state-store'
import type { EntryResolution, EntryResolutionOk, ScanTaskOptions } from './ScanService'
import { isEntryOk } from './ScanService'
import {
	type NormalizedPackageSpecifier,
	normalizeSpecifier,
	type PackageSpecifierInput,
} from './specifiers'
import { loadWorkspaceInfo } from './scan/workspace'

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
	install?: PackageInstallResult | undefined
	loadedAt: number
}

export type PackageLoadIssueSource = 'load' | 'restore'

export interface PackageLoadIssue {
	spec: NormalizedPackageSpecifier
	source: PackageLoadIssueSource
	message: string
	error: unknown
	recordedAt: number
	moduleId?: string | undefined
}

/** 安装选项：基于 nypm 的 OperationOptions，外加 force。 */
export interface InstallOptions extends OperationOptions {
	force?: boolean
}

/** 加载选项只保留解析相关配置，行为用方法表达。 */
export interface LoadOptions {
	scan?: ScanTaskOptions
	resolvedEntry?: EntryResolutionOk
	/** 覆盖自动安装时的参数。 */
	install?: InstallOptions
}

export interface PackageServiceConfig {
	install?: InstallOptions
	scan?: ScanTaskOptions
	preferFreshImport?: boolean
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

interface LoadIntentConfig {
	autoInstall: boolean
	fresh?: boolean
}

@Injectable({ key: serviceName })
export class PackageService {
	private readonly defaults: {
		install: ResolvedInstallOptions
		scan?: ScanTaskOptions | undefined
		preferFreshImport: boolean
	}

	private readonly installLocks = new Map<string, Promise<PackageInstallResult>>()
	private readonly loadLocks = new Map<string, Promise<PackageLoadResult>>()
	private readonly moduleCache = new Map<string, CachedModule>()
	private readonly packageModuleIds = new Map<string, string>()
	private readonly loadedPackages = new Map<string, PackageLoadResult>()
	private readonly loadFailures = new Map<string, PackageLoadIssue>()
	private readonly stateStore: PackageStateStore
	private readonly ready: Promise<void>
	private readonly installDefaultsReady: Promise<void>
	private initialized = false

	constructor(
		private readonly ctx: Context,
		config: PackageServiceConfig = {},
	) {
		this.defaults = {
			install: resolveInstallDefaults(config.install, false, null),
			preferFreshImport: config.preferFreshImport ?? false,
		}
		if (config.scan) {
			this.defaults.scan = config.scan
		}
		const stateFile = resolveStateFilePath(config.state?.file)
		const stateOptions: PackageStateStoreOptions = {
			file: stateFile,
			onError: (error) => {
				this.ctx.logger?.warn({ error, stateFile }, '[PackageService] 持久化包状态失败')
			},
		}
		if (config.state?.debounceMs !== undefined) {
			stateOptions.debounceMs = config.state.debounceMs
		}
		this.stateStore = new PackageStateStore(stateOptions)
		this.installDefaultsReady = this.initializeInstallDefaults(config.install)
		this.ready = this.installDefaultsReady
			.then(() => this.initializeFromState())
			.catch((error) => {
				this.ctx.logger?.warn({ error }, '[PackageService] 恢复包状态失败')
			})
			.finally(() => {
				this.initialized = true
			})
	}

	private async initializeInstallDefaults(overrides?: InstallOptions) {
		const workspaceRoot = await this.detectWorkspaceRoot(overrides?.cwd)
		this.defaults.install = resolveInstallDefaults(overrides, Boolean(workspaceRoot), workspaceRoot)
	}

	private async detectWorkspaceRoot(preferredCwd?: string): Promise<string | null> {
		const roots = this.ctx.scanService?.defaultRoots ?? []
		const candidates = normalizeRoots([
			preferredCwd ?? process.cwd(),
			...roots,
		])
		for (const root of candidates) {
			try {
				const info = await loadWorkspaceInfo(root)
				if (info.isMonorepo) return info.root
			} catch {
				// ignore detection errors, fall through
			}
		}
		return null
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
	async install(
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
	 * 加载插件模块；若发现未安装会自动尝试安装一次。
	 */
	async load(input: PackageSpecifierInput, options: LoadOptions = {}): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		return this.loadWithIntent(spec, options, { autoInstall: true })
	}

	/**
	 * 仅从当前工作区加载，不触发安装；若未安装会直接抛错。
	 */
	async loadInstalled(
		input: PackageSpecifierInput,
		options: LoadOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		return this.loadWithIntent(spec, options, { autoInstall: false })
	}

	/**
	 * 强制重新导入模块，仍然具备自动安装能力。
	 */
	async reload(
		input: PackageSpecifierInput,
		options: LoadOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		return this.loadWithIntent(spec, options, { autoInstall: true, fresh: true })
	}

	private async loadWithIntent(
		spec: NormalizedPackageSpecifier,
		options: LoadOptions,
		intent: LoadIntentConfig,
	): Promise<PackageLoadResult> {
		const key = spec.key
		return this.runExclusive(this.loadLocks, key, async () => {
			try {
				const result = await this.executeLoad(spec, options, intent)
				this.clearLoadIssue(spec.name)
				return result
			} catch (error) {
				if (!intent.autoInstall || !shouldRetryInstall(error)) {
					this.recordLoadIssue(spec, error, 'load')
					throw error
				}
				const installOptions = this.resolveInstallOptions(options.install)
				const installResult = await this.performInstall(spec, installOptions)
				try {
					const result = await this.executeLoad(spec, options, intent, installResult)
					this.clearLoadIssue(spec.name)
					return result
				} catch (retryError) {
					this.recordLoadIssue(spec, retryError, 'load')
					throw retryError
				}
			}
		})
	}

	private async executeLoad(
		spec: NormalizedPackageSpecifier,
		options: LoadOptions,
		intent: LoadIntentConfig,
		installResult?: PackageInstallResult,
	): Promise<PackageLoadResult> {
		const resolution = options.resolvedEntry ?? (await this.resolveEntryForSpec(spec, options.scan))
		const moduleId = normalizePath(resolution.entry)
		this.ensurePackageModuleBinding(spec.name, moduleId)

		const shouldImportFresh = intent.fresh ?? this.defaults.preferFreshImport
		const cached = shouldImportFresh ? undefined : this.moduleCache.get(moduleId)
		const module = cached?.module ?? (await this.importModule(moduleId, shouldImportFresh))
		if (!cached || shouldImportFresh) {
			this.moduleCache.set(moduleId, { moduleId, module })
		}
		this.primeHmrModuleCache(spec, moduleId, module)

		const isAnchor = this.ctx.loader.replaceModule(moduleId, module)

		const result: PackageLoadResult = {
			spec,
			resolution,
			module,
			moduleId,
			isAnchor,
			loadedAt: Date.now(),
		}
		if (installResult) {
			result.install = installResult
		}
		this.loadedPackages.set(spec.name, result)
		this.schedulePersistSnapshot()
		return result
	}

	listLoadIssues(): PackageLoadIssue[] {
		if (!this.initialized) return []
		return Array.from(this.loadFailures.values())
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

	getPackageSpecByModuleId(moduleId: string): NormalizedPackageSpecifier | undefined {
		const normalized = normalizePath(moduleId)
		for (const record of this.loadedPackages.values()) {
			if (normalizePath(record.moduleId) === normalized) {
				return record.spec
			}
		}
		return undefined
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
				const module = await this.importModule(moduleId, this.defaults.preferFreshImport)
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
					loadedAt: Date.now(),
				}
				if (entry.installStatus) {
					record.install = { spec, target: spec.target, status: entry.installStatus }
				}
				this.loadedPackages.set(spec.name, record)
				this.clearLoadIssue(spec.name)
				mutated = true
			} catch (error) {
				this.ctx.logger?.warn({ error, spec }, '[PackageService] 恢复包失败，已跳过该条记录')
				this.recordLoadIssue(
					spec,
					error,
					'restore',
					entry.moduleId ?? entry.resolution.entry,
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
		this.stateStore.scheduleWrite(this.buildStatePayload())
	}

	private buildStatePayload(): PackageStatePayload {
		const packages: PersistedPackageEntry[] = []
		for (const record of this.loadedPackages.values()) {
			const entry: PersistedPackageEntry = {
				spec: record.spec,
				resolution: record.resolution,
				moduleId: record.moduleId,
				isAnchor: record.isAnchor,
				loadedAt: record.loadedAt,
			}
			if (record.install?.status) {
				entry.installStatus = record.install.status
			}
			packages.push(entry)
		}

		return {
			generatedAt: new Date().toISOString(),
			packages,
		}
	}

	private async performInstall(
		spec: NormalizedPackageSpecifier,
		options: ResolvedInstallOptions,
	): Promise<PackageInstallResult> {
		const { force, ...operationOptions } = options
		try {
			if (force || spec.version) {
				await addDependency(spec.target, operationOptions)
				const result: PackageInstallResult = { spec, target: spec.target, status: 'installed' }
				this.onPackageInstalled(result)
				return result
			}

			const existed = await ensureDependencyInstalled(spec.name, pickEnsureOptions(options))
			const result: PackageInstallResult = {
				spec,
				target: spec.target,
				status: existed === true ? 'reused' : 'installed',
			}
			if (result.status === 'installed') {
				this.onPackageInstalled(result)
			}
			return result
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

	private onPackageInstalled(result: PackageInstallResult) {
		this.ctx.scanService?.invalidateResolverCache()
		this.ctx.logger?.debug(
			{ name: result.spec.name, target: result.target },
			'[PackageService] 已清理解析缓存，等待重新扫描。',
		)
	}

	private async resolveEntryForSpec(
		spec: NormalizedPackageSpecifier,
		scanOverrides?: ScanTaskOptions,
	): Promise<EntryResolutionOk> {
		const request = this.mergeScanOptions(scanOverrides)
		const resolution = await this.ctx.scanService.resolveEntry(
			{ name: spec.name },
			request ?? {},
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
		const result: ResolvedInstallOptions = { ...base }

		result.cwd = overrides.cwd ?? base.cwd ?? process.cwd()
		result.force = overrides.force ?? base.force
		result.installPeerDependencies =
			overrides.installPeerDependencies ?? base.installPeerDependencies

		if (overrides.dev !== undefined) result.dev = overrides.dev
		if (overrides.workspace !== undefined) result.workspace = overrides.workspace
		if (overrides.env !== undefined) result.env = overrides.env
		if (overrides.silent !== undefined) result.silent = overrides.silent
		if (overrides.packageManager !== undefined) result.packageManager = overrides.packageManager
		if (overrides.global !== undefined) result.global = overrides.global
		if (overrides.dry !== undefined) result.dry = overrides.dry

		// 如果显式关闭 workspace 但当前目录是 monorepo，避免 pnpm 警告
		if (!result.workspace && base.workspace) {
			result.env = {
				...(result.env ?? {}),
				PNPM_IGNORE_WORKSPACE_ROOT_CHECK: 'true',
				npm_config_ignore_workspace_root_check: 'true',
			}
		}

		return result
	}

	private mergeScanOptions(overrides?: ScanTaskOptions): ScanTaskOptions | undefined {
		const base = this.defaults.scan
		if (!base) return overrides
		if (!overrides) return base

		const merged: ScanTaskOptions = {}
		if (overrides.roots !== undefined) merged.roots = overrides.roots
		else if (base.roots !== undefined) merged.roots = base.roots

		const mergedScan = base.scan
			? { ...base.scan, ...(overrides.scan ?? {}) }
			: overrides.scan ?? base.scan
		if (mergedScan !== undefined) {
			merged.scan = mergedScan
		}

		return merged
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

	private recordLoadIssue(
		spec: NormalizedPackageSpecifier,
		error: unknown,
		source: PackageLoadIssueSource,
		moduleId?: string,
	) {
		const message =
			error instanceof PackageServiceError
				? error.message
				: error instanceof Error
					? error.message
					: String(error)
		const issue: PackageLoadIssue = {
			spec,
			source,
			error,
			message,
			recordedAt: Date.now(),
		}
		if (moduleId) {
			issue.moduleId = moduleId
		}
		this.loadFailures.set(spec.name, issue)
	}

	private clearLoadIssue(name: string) {
		this.loadFailures.delete(name)
	}
}

function shouldRetryInstall(
	error: unknown,
): error is PackageServiceError & { detail: { resolution: EntryResolution } } {
	if (!(error instanceof PackageServiceError)) return false
	if (error.code !== 'RESOLUTION_FAILED') return false
	const resolution = (error.detail as { resolution?: EntryResolution } | undefined)?.resolution
	return Boolean(resolution && !isEntryOk(resolution) && resolution.code === 'MISSING_PACKAGE')
}

function resolveStateFilePath(file?: string): string {
	if (file) return resolvePath(file)
	return resolvePath(process.cwd(), '.pluxel', 'hmr', 'package-state.json')
}

function resolveInstallDefaults(
	options: InstallOptions = {},
	inWorkspace: boolean,
	workspaceRoot: string | null,
): ResolvedInstallOptions {
	const cwd = options.cwd ?? workspaceRoot ?? process.cwd()
	const resolved: ResolvedInstallOptions = {
		cwd,
		dev: options.dev ?? false,
		installPeerDependencies: options.installPeerDependencies ?? false,
		force: options.force ?? false,
		workspace: options.workspace ?? inWorkspace,
	}
	if (options.env !== undefined) resolved.env = options.env
	if (options.silent !== undefined) resolved.silent = options.silent
	if (options.packageManager !== undefined) resolved.packageManager = options.packageManager
	if (options.global !== undefined) resolved.global = options.global
	if (options.dry !== undefined) resolved.dry = options.dry
	if (!resolved.workspace && inWorkspace) {
		resolved.env = {
			...(resolved.env ?? {}),
			PNPM_IGNORE_WORKSPACE_ROOT_CHECK: 'true',
			npm_config_ignore_workspace_root_check: 'true',
		}
	}
	return resolved
}

function pickEnsureOptions(
	options: ResolvedInstallOptions,
): Pick<ResolvedInstallOptions, 'cwd' | 'dev' | 'workspace'> {
	const picked: Pick<ResolvedInstallOptions, 'cwd' | 'dev' | 'workspace'> = {
		cwd: options.cwd,
	}
	if (options.dev !== undefined) picked.dev = options.dev
	if (options.workspace !== undefined) picked.workspace = options.workspace
	return picked
}

function normalizeRoots(roots: string[]): string[] {
	const seen = new Set<string>()
	return roots.filter((r) => {
		const normalized = normalizePath(r)
		if (seen.has(normalized)) return false
		seen.add(normalized)
		return true
	})
}
