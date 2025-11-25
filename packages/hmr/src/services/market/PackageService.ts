import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { type Context, Injectable } from '@pluxel/core'
import type { OperationOptions, OperationResult } from 'nypm'
import { addDependency, removeDependency } from 'nypm'
import { readPackageJSON } from 'pkg-types'
import { normalize as normalizePath, resolve as resolvePath } from 'pathe'

import type { RemovalScope } from '../loader'
import {
	CURRENT_STATE_SCHEMA,
	type LegacyPackageStatePayload,
	type PackageStatePayload,
	PackageStateStore,
	type PackageStateStoreOptions,
	type PersistedLoadIssue,
	type PersistedPackageEntry,
} from './package/state-store'
import type { EntryResolution, EntryResolutionOk, ScanTaskOptions } from './ScanService'
import { isEntryOk } from './ScanService'
import {
	type NormalizedPackageSpecifier,
	type PackageSpecifierInput,
	type PackageSpecifierSnapshot,
	fromSnapshot as specFromSnapshot,
	normalizeSpecifier,
	toSnapshot as specToSnapshot,
} from './specifiers'
import { loadWorkspaceInfo } from './scan/workspace'
import { createDebouncedTrigger } from './util/debounce'
import { collectDeclaredPlugins } from './util/plugins'

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
	| 'UNINSTALL_FAILED'
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
	installedAt: number
}

export interface PackageMetadata {
	spec: NormalizedPackageSpecifier
	resolution: EntryResolutionOk
	dependOn: string[]
	manifestPath?: string
	manifestVersion?: string
	resolvedVersion?: string
}

export interface PackageLoadResult extends PackageMetadata {
	module: Record<string, unknown>
	moduleId: string
	isAnchor: boolean
	install?: PackageInstallResult | undefined
	loadedAt: number
}

export type PackageLoadIssueSource = 'load' | 'restore' | 'retry'

export interface PackageLoadIssue {
	spec: NormalizedPackageSpecifier
	source: PackageLoadIssueSource
	message: string
	error: unknown
	recordedAt: number
	moduleId?: string | undefined
}

export type PackageUninstallStatus = 'uninstalled' | 'runtime_only' | 'failed'

export interface PackageUninstallResult {
	spec: NormalizedPackageSpecifier
	scope: RemovalScope
	status: PackageUninstallStatus
	error?: unknown
}

export interface PackageReloadResult {
	spec: NormalizedPackageSpecifier
	record?: PackageLoadResult
	error?: unknown
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

export interface RetryOptions extends LoadOptions {
	/** 在重试之前先强制安装。 */
	reinstall?: boolean
	/** 是否强制跳过缓存导入。 */
	fresh?: boolean
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
	source: PackageLoadIssueSource
}

interface PackageManifestMeta {
	manifestPath?: string
	manifestVersion?: string
	resolvedVersion?: string
	dependOn: string[]
}

@Injectable({ key: serviceName })
export class PackageService {
	private readonly logName = 'package-manager'
	private readonly defaults: {
		install: ResolvedInstallOptions
		scan?: ScanTaskOptions | undefined
		preferFreshImport: boolean
	}

	private readonly installLocks = new Map<string, Promise<PackageInstallResult>>()
	private readonly loadLocks = new Map<string, Promise<PackageLoadResult>>()
	private readonly uninstallLocks = new Map<string, Promise<void>>()
	private readonly moduleCache = new Map<string, CachedModule>()
	private readonly packageModuleIds = new Map<string, string>()
	private readonly loadedPackages = new Map<string, PackageLoadResult>()
	private readonly dependencyIndex = new Map<string, Set<string>>()
	private readonly loadFailures = new Map<string, PackageLoadIssue>()
	private readonly multiInstallLocks = new Map<string, Promise<PackageInstallResult[]>>()
	private readonly multiUninstallLocks = new Map<string, Promise<PackageUninstallResult[]>>()
	private readonly stateStore: PackageStateStore
	private readonly ready: Promise<void>
	private readonly installDefaultsReady: Promise<void>
	private readonly syncTrigger = createDebouncedTrigger({
		delayMs: 300,
		run: () =>
			this.syncTrackedPlugins().catch((error) => {
				this.logEvent('warn', 'syncTrackedPlugins:failed', { error })
			}),
	})
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
			.then(() => this.syncTrackedPlugins())
			.catch((error) => {
				this.logEvent('warn', 'init:restore_failed', { error })
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
	 * 安装插件包；如果明确传入版本（或 force=true）则直接执行安装，否则会先检查本地是否已存在。
	 */
	async install(
		input: PackageSpecifierInput,
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		const key = spec.key
		const resolved = this.resolveInstallOptions(overrides)
		this.logEvent('info', 'install:scheduled', {
			target: spec.target,
			force: resolved.force,
		})
		return this.runExclusive(this.installLocks, key, () => this.performInstall(spec, resolved))
	}

	/** 批量安装插件包，一次调用包管理器。 */
	async installMany(
		inputs: PackageSpecifierInput[],
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult[]> {
		await this.ensureReady()
		if (!inputs.length) return []
		const specs = inputs.map((item) => this.normalizeSpecifier(item))
		const key = specs
			.map((s) => s.key)
			.slice()
			.sort()
			.join('|')
		const resolved = this.resolveInstallOptions(overrides)
		this.logEvent('info', 'installMany:scheduled', {
			targets: specs.map((s) => s.target),
			force: resolved.force,
		})
		return this.runExclusive(this.multiInstallLocks, key, () =>
			this.performInstallMany(specs, resolved),
		)
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
		return this.loadWithIntent(spec, options, { autoInstall: true, source: 'load' })
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
		return this.loadWithIntent(spec, options, { autoInstall: false, source: 'load' })
	}

	/**
	 * 卸载插件：先清理运行态占用，再调用包管理器移除依赖（persisted）。
	 */
	async uninstall(
		input: PackageSpecifierInput,
		scope: RemovalScope = 'persisted',
	): Promise<void> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		const key = spec.key
		const options = this.resolveInstallOptions()
		return this.runExclusive(this.uninstallLocks, key, async () => {
			const [result] = await this.performUninstallBatch([spec], scope, options)
			if (result.status === 'failed') {
				const message =
					result.error instanceof Error
						? result.error.message
						: result.error
							? String(result.error)
							: '未知错误'
				throw new PackageServiceError('UNINSTALL_FAILED', message, { cause: result.error, spec })
			}
		})
	}

	/** 批量卸载：清理运行态后，持久化范围内一次执行包管理器卸载。 */
	async uninstallMany(
		inputs: PackageSpecifierInput[],
		scope: RemovalScope = 'persisted',
	): Promise<PackageUninstallResult[]> {
		await this.ensureReady()
		if (!inputs.length) return []
		const specs = this.normalizeUniqueByName(inputs)
		const key = specs
			.map((s) => s.key)
			.slice()
			.sort()
			.join('|')
		const options = this.resolveInstallOptions()
		return this.runExclusive(this.multiUninstallLocks, key, () =>
			this.performUninstallBatch(specs, scope, options),
		)
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
		return this.loadWithIntent(spec, options, {
			autoInstall: true,
			fresh: true,
			source: 'load',
		})
	}

	/** 批量重载：默认 fresh 导入，允许自动安装缺失的包。 */
	async reloadMany(
		inputs: PackageSpecifierInput[],
		options: LoadOptions = {},
		intent: Partial<Pick<LoadIntentConfig, 'autoInstall' | 'fresh' | 'source'>> = {},
	): Promise<PackageReloadResult[]> {
		await this.ensureReady()
		if (!inputs.length) return []
		const specs = this.normalizeUniqueByName(inputs)
		const results: PackageReloadResult[] = []
		for (const spec of specs) {
			try {
				const record = await this.loadWithIntent(spec, options, {
					autoInstall: intent.autoInstall ?? true,
					fresh: intent.fresh ?? true,
					source: intent.source ?? 'load',
				})
				results.push({ spec, record })
			} catch (error) {
				results.push({ spec, error })
			}
		}
		return results
	}

	/** 批量重装：先清理 scope，再强制安装并 fresh 重载。 */
	async reinstallMany(
		inputs: PackageSpecifierInput[],
		options: {
			scope?: RemovalScope
			install?: InstallOptions
			load?: LoadOptions
		} = {},
	): Promise<PackageReloadResult[]> {
		await this.ensureReady()
		if (!inputs.length) return []
		const specs = this.normalizeUniqueByName(inputs)
		const scope = options.scope ?? 'persisted'
		const installOptions = this.resolveInstallOptions({
			...options.install,
			force: options.install?.force ?? true,
		})
		const results: PackageReloadResult[] = []

		for (const spec of specs) {
			try {
				this.invalidatePackage(spec.name, scope)
				const installResult = await this.performInstall(spec, installOptions)
				const record = await this.loadWithIntent(
					spec,
					options.load ?? {},
					{ autoInstall: false, fresh: true, source: 'load' },
					installResult,
				)
				results.push({ spec, record })
			} catch (error) {
				results.push({ spec, error })
			}
		}

		return results
	}

	/**
	 * 对记录的失败进行重试，可选自动重新安装。
	 */
	async retryLoad(
		nameOrSpec: string | PackageSpecifierInput,
		options: RetryOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec =
			typeof nameOrSpec === 'string' && this.loadFailures.has(nameOrSpec)
				? this.loadFailures.get(nameOrSpec)!.spec
				: this.normalizeSpecifier(nameOrSpec)
		const reinstall = options.reinstall ?? false
		if (reinstall) {
			const installResult = await this.performInstall(
				spec,
				this.resolveInstallOptions(options.install),
			)
			return this.loadWithIntent(
				spec,
				options,
				{ autoInstall: false, fresh: options.fresh ?? true, source: 'retry' },
				installResult,
			)
		}
		return this.loadWithIntent(spec, options, {
			autoInstall: true,
			fresh: options.fresh ?? true,
			source: 'retry',
		})
	}

	/**
	 * 依次重试所有失败项，便于批量恢复。
	 */
	async retryAllLoadIssues(options: RetryOptions = {}): Promise<PackageLoadResult[]> {
		await this.ensureReady()
		const issues = this.listLoadIssues()
		const results: PackageLoadResult[] = []
		for (const issue of issues) {
			try {
				const result = await this.retryLoad(issue.spec, options)
				results.push(result)
			} catch (error) {
				this.recordLoadIssue(issue.spec, error, 'retry', issue.moduleId)
			}
		}
		return results
	}

	listLoadIssues(): PackageLoadIssue[] {
		if (!this.initialized) return []
		return Array.from(this.loadFailures.values())
	}

	/** 主动移除指定包的模块缓存，并可选择清理 loader 运行态。 */
	invalidatePackage(name: string, scope: RemovalScope = 'runtime') {
		const record = this.loadedPackages.get(name)
		const failure = this.loadFailures.get(name)
		const moduleId =
			record?.moduleId ??
			this.packageModuleIds.get(name) ??
			(failure?.moduleId ? normalizePath(failure.moduleId) : undefined)

		if (record && moduleId) {
			this.dropHmrModuleCacheForRecord(record)
			this.untrackDependencies(record)
		} else if (moduleId) {
			this.ctx.hmrService.dropModuleCacheEntries([moduleId, name])
		}

		if (moduleId) {
			this.moduleCache.delete(moduleId)
			this.ctx.loader.pruneModule(moduleId, scope)
		} else {
			this.ctx.loader.prunePluginByName(name, scope)
		}

		this.packageModuleIds.delete(name)
		this.loadedPackages.delete(name)
		this.clearLoadIssue(name)
		this.removeDependentsOf(name)
		this.schedulePersistSnapshot()
		this.syncTrigger.trigger()
		this.logEvent('info', 'invalidate', { name, scope, moduleId })
	}

	getPackageSpecByModuleId(moduleId: string): NormalizedPackageSpecifier | undefined {
		const normalized = normalizePath(moduleId)
		for (const record of this.loadedPackages.values()) {
			if (normalizePath(record.moduleId) === normalized) {
				return record.spec
			}
		}
		for (const issue of this.loadFailures.values()) {
			if (issue.moduleId && normalizePath(issue.moduleId) === normalized) {
				return issue.spec
			}
		}
		return undefined
	}

	getDependencies(name: string): string[] {
		const record = this.loadedPackages.get(name)
		return record ? [...record.dependOn] : []
	}

	getDependents(name: string): string[] {
		const set = this.dependencyIndex.get(name)
		return set ? Array.from(set) : []
	}

	/** 扫描已声明的插件依赖（pluxel-plugin*），确保被加载并持久化。 */
	async syncTrackedPlugins(): Promise<void> {
		if (!this.initialized) return
		await this.installDefaultsReady
		const roots = this.ctx.scanService?.defaultRoots ?? [process.cwd()]
		const found = await collectDeclaredPlugins(roots)
		const toLoad: string[] = []
		for (const name of found) {
			if (this.loadedPackages.has(name)) continue
			toLoad.push(name)
		}
		if (!toLoad.length) return

		for (const name of toLoad) {
			try {
				await this.load(name)
			} catch (error) {
				this.ctx.logger?.warn({ name, error }, '[PackageService] 同步加载插件失败')
			}
		}
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

	private async initializeFromState(): Promise<void> {
		let payload: PackageStatePayload | LegacyPackageStatePayload | null = null
		try {
			payload = await this.stateStore.read()
		} catch (error) {
			this.ctx.logger?.warn({ error }, '[PackageService] 读取包状态失败')
			throw error
		}
		const normalized = normalizeStatePayload(payload)
		if (!normalized) return
		this.restorePersistedIssues(normalized)
		const mutated = await this.restorePersistedPackages(normalized.packages)
		if (mutated) this.schedulePersistSnapshot()
	}

	private restorePersistedIssues(payload: PackageStatePayload) {
		for (const issue of payload.issues ?? []) {
			try {
				const spec = specFromSnapshot(issue.spec)
				this.loadFailures.set(spec.name, {
					spec,
					message: issue.message,
					source: issue.source,
					moduleId: issue.moduleId,
					recordedAt: issue.recordedAt,
					error: new Error(issue.message),
				})
			} catch {
				// ignore malformed issue entries
			}
		}
	}

	private async restorePersistedPackages(entries: PersistedPackageEntry[]): Promise<boolean> {
		let mutated = false
		for (const entry of entries) {
			const spec = specFromSnapshot(entry.spec)
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
					dependOn: entry.dependOn ?? [],
					manifestPath: entry.manifestPath,
					manifestVersion: entry.manifestVersion,
					resolvedVersion: entry.resolvedVersion ?? entry.manifestVersion,
					loadedAt: entry.loadedAt,
				}
				if (entry.install) {
					record.install = {
						spec,
						target: spec.target,
						status: entry.install.status,
						installedAt: entry.install.at,
					}
				}
				this.registerRecord(record)
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
				spec: specToSnapshot(record.spec),
				resolution: record.resolution,
				moduleId: record.moduleId,
				isAnchor: record.isAnchor,
				loadedAt: record.loadedAt,
				dependOn: record.dependOn ?? [],
				manifestPath: record.manifestPath,
				manifestVersion: record.manifestVersion,
				resolvedVersion: record.resolvedVersion,
			}
			if (record.install) {
				entry.install = { status: record.install.status, at: record.install.installedAt }
			}
			packages.push(entry)
		}

		const issues: PersistedLoadIssue[] = []
		for (const issue of this.loadFailures.values()) {
			issues.push({
				spec: specToSnapshot(issue.spec),
				source: issue.source,
				message: issue.message,
				moduleId: issue.moduleId,
				recordedAt: issue.recordedAt,
			})
		}

		return {
			schema: CURRENT_STATE_SCHEMA,
			generatedAt: new Date().toISOString(),
			packages,
			issues,
		}
	}

	private async performInstall(
		spec: NormalizedPackageSpecifier,
		options: ResolvedInstallOptions,
	): Promise<PackageInstallResult> {
		const { force } = options
		this.logEvent('info', 'install:start', {
			target: spec.target,
			force,
		})
		try {
			if (!force && !spec.version) {
				const existed = await this.dependencyExists(spec.name, options)
				if (existed) {
					const reuseResult: PackageInstallResult = {
						spec,
						target: spec.target,
						status: 'reused',
						installedAt: Date.now(),
					}
					this.logEvent('info', 'install:completed', {
						target: spec.target,
						status: reuseResult.status,
					})
					return reuseResult
				}
			}

			const [installResult] = await this.installTargetsWithLogs([spec], options)
			if (installResult.status === 'installed' && !options.dry) {
				this.onPackageInstalled(installResult)
			}
			this.logEvent('info', 'install:completed', {
				target: spec.target,
				status: installResult.status,
			})
			return installResult
		} catch (error) {
			const message = error instanceof Error ? error.message : '未知错误'
			this.logEvent('error', 'install:failed', {
				target: spec.target,
				message,
			})
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

	private async performInstallMany(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<PackageInstallResult[]> {
		const statuses: PackageInstallResult[] = []
		const { force } = options
		const toInstall: NormalizedPackageSpecifier[] = []
		const seen = new Set<string>()

		for (const spec of specs) {
			if (seen.has(spec.target)) continue
			seen.add(spec.target)

			if (!force && !spec.version) {
				const existed = await this.dependencyExists(spec.name, options)
				if (existed) {
					statuses.push({ spec, target: spec.target, status: 'reused', installedAt: Date.now() })
					continue
				}
			}
			toInstall.push(spec)
		}

		if (toInstall.length) {
			try {
				const installed = await this.installTargetsWithLogs(toInstall, options)
				for (const record of installed) {
					statuses.push(record)
					if (record.status === 'installed' && !options.dry) {
						this.onPackageInstalled(record)
					}
				}
				this.logEvent('info', 'installMany:completed', {
					targets: toInstall.map((s) => s.target),
					count: toInstall.length,
					force,
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : '未知错误'
				this.logEvent('error', 'installMany:failed', {
					targets: toInstall.map((s) => s.target),
					message,
				})
				throw new PackageServiceError(
					'INSTALL_FAILED',
					`批量安装插件失败：${message}`,
					{
						cause: error,
						specs: toInstall,
						options,
					},
				)
			}
		} else {
			this.logEvent('info', 'installMany:skip_install', {
				targets: specs.map((s) => s.target),
			})
		}

		return statuses
	}

	private async performUninstallBatch(
		specs: NormalizedPackageSpecifier[],
		scope: RemovalScope,
		options: ResolvedInstallOptions,
	): Promise<PackageUninstallResult[]> {
		if (!specs.length) return []
		const results: PackageUninstallResult[] = specs.map((spec) => ({
			spec,
			scope,
			status: scope === 'runtime' ? 'runtime_only' : 'uninstalled',
		}))

		this.logEvent('info', 'uninstall:batch_start', {
			targets: specs.map((s) => s.target),
			scope,
		})

		const markFailed = (spec: NormalizedPackageSpecifier, error: unknown) => {
			const entry = results.find((item) => item.spec.key === spec.key)
			if (entry) {
				entry.status = 'failed'
				entry.error = error
			}
		}

		for (const spec of specs) {
			try {
				this.invalidatePackage(spec.name, scope)
			} catch (error) {
				markFailed(spec, error)
				this.logEvent('warn', 'uninstall:invalidate_failed', {
					target: spec.target,
					scope,
					error,
				})
			}
		}

		if (scope !== 'runtime') {
			try {
				await this.removeTargetsWithLogs(specs, options)
			} catch (error) {
				for (const spec of specs) {
					markFailed(spec, error)
				}
				this.logEvent('error', 'uninstall:batch_remove_failed', {
					targets: specs.map((s) => s.target),
					scope,
					error,
				})
			}
		}

		for (const entry of results) {
			const event =
				entry.status === 'failed'
					? 'uninstall:failed'
					: entry.scope === 'runtime'
						? 'uninstall:runtime_cleared'
						: 'uninstall:completed'
			const level = entry.status === 'failed' ? 'error' : 'info'
			this.logEvent(level, event, {
				target: entry.spec.target,
				scope: entry.scope,
				error: entry.error,
			})
		}

		return results
	}

	private async dependencyExists(
		name: string,
		options: ResolvedInstallOptions,
	): Promise<boolean> {
		const cwd = options.cwd ?? process.cwd()
		const resolver = createRequire(cwd.endsWith('/') ? cwd : `${cwd}/`)
		try {
			const resolved = resolver.resolve(name)
			return normalizePath(resolved).startsWith(normalizePath(cwd))
		} catch {
			return false
		}
	}

	private async installTargetsWithLogs(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<PackageInstallResult[]> {
		if (!specs.length) return []
		const targets = specs.map((s) => s.target)
		const opOptions: OperationOptions = { ...options, silent: options.silent ?? false }
		const opResult = await addDependency(targets as any, opOptions)
		if (opResult?.exec) {
			this.logEvent('info', 'install:pm_command', {
				targets,
				command: opResult.exec.command,
				args: opResult.exec.args,
				commandLine: `${opResult.exec.command} ${opResult.exec.args.join(' ')}`,
				cwd: options.cwd,
			})
		}

		const installedAt = Date.now()
		const results: PackageInstallResult[] = specs.map((spec) => ({
			spec,
			target: spec.target,
			status: 'installed',
			installedAt,
		}))

		if (options.installPeerDependencies && !options.dry) {
			await this.installPeerDependencies(specs, options)
		}

		return results
	}

	private async removeTargetsWithLogs(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<void> {
		if (!specs.length) return
		// pnpm remove 不接受版本号，统一用 name 去删除，避免 “no such dependency found”
		const targets = Array.from(new Set(specs.map((s) => s.name)))
		const opOptions: OperationOptions = { ...options, silent: options.silent ?? false }
		try {
			const opResult = await removeDependency(targets as any, opOptions)
			if (opResult?.exec) {
				this.logEvent('info', 'uninstall:pm_command', {
					targets,
					command: opResult.exec.command,
					args: opResult.exec.args,
					commandLine: `${opResult.exec.command} ${opResult.exec.args.join(' ')}`,
					cwd: options.cwd,
				})
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (
				message.includes('ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS') ||
				message.includes('no such dependency found') ||
				message.includes('Cannot remove')
			) {
				this.logEvent('warn', 'uninstall:skip_missing', { targets, message })
				return
			}
			throw error
		}
	}

	private async installPeerDependencies(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<void> {
		if (options.dry) return
		const cwd = options.cwd ?? process.cwd()
		const existingPkg = await this.readPackageJsonSafe(cwd)
		const peerDeps: string[] = []
		const peerDevDeps: string[] = []

		for (const spec of specs) {
			const pkg = await this.readPackageJsonSafe(spec.name, cwd)
			if (!pkg?.peerDependencies || pkg.name !== spec.name) continue
			for (const [peer, version] of Object.entries<string>(pkg.peerDependencies ?? {})) {
				if (pkg.peerDependenciesMeta?.[peer]?.optional) continue
				if (existingPkg.dependencies?.[peer] || existingPkg.devDependencies?.[peer]) continue
				const entry = `${peer}@${version}`
				if (pkg.peerDependenciesMeta?.[peer]?.dev) peerDevDeps.push(entry)
				else peerDeps.push(entry)
			}
		}

		const unique = (list: string[]) => Array.from(new Set(list))
		const installPeerGroup = async (list: string[], dev: boolean) => {
			if (!list.length) return
			const specsToInstall = unique(list).map((raw) => this.normalizeSpecifier(raw))
			const installed = await this.installTargetsWithLogs(specsToInstall, {
				...options,
				dev,
				installPeerDependencies: false,
			})
			installed.forEach((r) => this.onPackageInstalled(r))
		}

		if (peerDeps.length) {
			await installPeerGroup(peerDeps, false)
		}
		if (peerDevDeps.length) {
			await installPeerGroup(peerDevDeps, true)
		}
	}

	private async readPackageJsonSafe(pathOrName: string, cwd?: string): Promise<any> {
		try {
			return await readPackageJSON(pathOrName, cwd ? { url: cwd } : undefined)
		} catch {
			return {}
		}
	}

	private onPackageInstalled(result: PackageInstallResult) {
		this.ctx.scanService?.invalidateResolverCache()
		this.ctx.logger?.debug(
			{ name: result.spec.name, target: result.target },
			'[PackageService] 已清理解析缓存，等待重新扫描。',
		)
		this.logEvent('info', 'install:scan_cache_cleared', {
			name: result.spec.name,
			target: result.target,
		})
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

	private normalizeUniqueByName(inputs: PackageSpecifierInput[]): NormalizedPackageSpecifier[] {
		const specs = inputs.map((item) => this.normalizeSpecifier(item))
		return dedupeByName(specs)
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
		this.schedulePersistSnapshot()
		this.logEvent('warn', 'load:issue_recorded', {
			name: spec.name,
			source,
			message,
			moduleId,
		})
	}

	private clearLoadIssue(name: string) {
		if (this.loadFailures.delete(name)) {
			this.schedulePersistSnapshot()
		}
	}

	private logEvent(
		level: 'info' | 'warn' | 'error',
		event: string,
		payload: Record<string, unknown> = {},
		message?: string,
	) {
		const logger = this.ctx.logger
		if (!logger) return
		const baseMessage = message ?? `[PackageService] ${event}`
		const record = { name: this.logName, event, ...payload }
		if (level === 'info') {
			logger.info(record, baseMessage)
		} else if (level === 'warn') {
			logger.warn(record, baseMessage)
		} else {
			logger.error(record, baseMessage)
		}
	}

	private async loadWithIntent(
		spec: NormalizedPackageSpecifier,
		options: LoadOptions,
		intent: LoadIntentConfig,
		installResult?: PackageInstallResult,
	): Promise<PackageLoadResult> {
		const key = spec.key
		return this.runExclusive(this.loadLocks, key, async () => {
			this.logEvent('info', 'load:start', {
				name: spec.name,
				autoInstall: intent.autoInstall,
				fresh: intent.fresh,
				source: intent.source,
			})
			try {
				const result = await this.executeLoad(spec, options, intent, installResult)
				this.clearLoadIssue(spec.name)
				this.logEvent('info', 'load:success', {
					name: spec.name,
					moduleId: result.moduleId,
					autoInstalled: Boolean(result.install),
					source: intent.source,
				})
				return result
			} catch (error) {
				if (!intent.autoInstall || !shouldRetryInstall(error)) {
					this.recordLoadIssue(spec, error, intent.source)
					throw error
				}
				const installOptions = this.resolveInstallOptions(options.install)
				const nextInstallResult = await this.performInstall(spec, installOptions)
				try {
					const result = await this.executeLoad(spec, options, intent, nextInstallResult)
					this.clearLoadIssue(spec.name)
					this.logEvent('info', 'load:success_after_install', {
						name: spec.name,
						moduleId: result.moduleId,
					})
					return result
				} catch (retryError) {
					this.recordLoadIssue(spec, retryError, intent.source)
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
		const manifestMeta = await this.readManifestMeta(resolution.dir)
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
			dependOn: manifestMeta.dependOn,
			manifestPath: manifestMeta.manifestPath,
			manifestVersion: manifestMeta.manifestVersion,
			resolvedVersion: manifestMeta.resolvedVersion ?? manifestMeta.manifestVersion,
		}
		if (installResult) {
			result.install = installResult
		}
		this.registerRecord(result)
		return result
	}

	private registerRecord(record: PackageLoadResult) {
		const previous = this.loadedPackages.get(record.spec.name)
		if (previous) {
			this.untrackDependencies(previous)
		}
		this.trackDependencies(record)
		this.loadedPackages.set(record.spec.name, record)
		this.schedulePersistSnapshot()
	}

	private trackDependencies(record: PackageMetadata) {
		for (const dep of record.dependOn ?? []) {
			const trimmed = dep.trim()
			if (!trimmed) continue
			const set = this.dependencyIndex.get(trimmed) ?? new Set<string>()
			set.add(record.spec.name)
			this.dependencyIndex.set(trimmed, set)
		}
	}

	private untrackDependencies(record: PackageMetadata) {
		for (const dep of record.dependOn ?? []) {
			const trimmed = dep.trim()
			if (!trimmed) continue
			const set = this.dependencyIndex.get(trimmed)
			if (!set) continue
			set.delete(record.spec.name)
			if (!set.size) this.dependencyIndex.delete(trimmed)
		}
	}

	private removeDependentsOf(name: string) {
		for (const [dep, set] of this.dependencyIndex.entries()) {
			set.delete(name)
			if (!set.size) {
				this.dependencyIndex.delete(dep)
			}
		}
	}

	private async readManifestMeta(dir: string): Promise<PackageManifestMeta> {
		const manifestPath = resolvePath(dir, 'package.json')
		try {
			const raw = await readFile(manifestPath, 'utf-8')
			const json = JSON.parse(raw) as any
			const version = typeof json?.version === 'string' ? json.version : undefined
			const dependOn = parseDependOn(json?.pluxel?.dependOn)
			return {
				manifestPath,
				manifestVersion: version,
				resolvedVersion: version,
				dependOn,
			}
		} catch (error) {
			this.logEvent('warn', 'manifest:unreadable', { manifestPath, error })
			return { manifestPath, dependOn: [] }
		}
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

function dedupeByName(specs: NormalizedPackageSpecifier[]): NormalizedPackageSpecifier[] {
	const map = new Map<string, NormalizedPackageSpecifier>()
	for (const spec of specs) {
		if (!map.has(spec.name)) {
			map.set(spec.name, spec)
		}
	}
	return Array.from(map.values())
}

function parseDependOn(value: unknown): string[] {
	if (!value) return []
	const collect = Array.isArray(value) ? value : [value]
	const normalized: string[] = []
	for (const item of collect) {
		if (typeof item !== 'string') continue
		const trimmed = item.trim()
		if (!trimmed) continue
		if (!normalized.includes(trimmed)) normalized.push(trimmed)
	}
	return normalized
}

function normalizeStatePayload(
	payload: PackageStatePayload | LegacyPackageStatePayload | null,
): PackageStatePayload | null {
	if (!payload) return null
	if ('schema' in payload && payload.schema === CURRENT_STATE_SCHEMA) {
		return payload as PackageStatePayload
	}
	// 兼容旧格式：没有 issues / dependOn 等字段
	const legacy = payload as LegacyPackageStatePayload
	const packages: PersistedPackageEntry[] =
		legacy.packages?.map((item) => {
			const base: PersistedPackageEntry = {
				spec: item.spec as PackageSpecifierSnapshot,
				resolution: item.resolution,
				moduleId: item.moduleId,
				isAnchor: item.isAnchor,
				loadedAt: item.loadedAt,
				manifestPath: undefined,
				manifestVersion: undefined,
				resolvedVersion: undefined,
				dependOn: [],
			}
			if (item.installStatus) {
				base.install = { status: item.installStatus, at: item.loadedAt }
			}
			return base
		}) ?? []

	return {
		schema: CURRENT_STATE_SCHEMA,
		generatedAt: legacy.generatedAt,
		packages,
		issues: [],
	}
}
