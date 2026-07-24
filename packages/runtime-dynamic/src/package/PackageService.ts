import { type Context as PluxelContext, Injectable } from '@pluxel/core'
import { loadWorkspaceInfo } from '@pluxel/rolldown/workspace/info'
import {
	isEntryOk,
	type EntryResolution,
	type EntryResolutionOk,
	type ScanTaskOptions,
} from '../scan/types'
import {
	createDebouncedTrigger,
	dedupeByName,
	normalizeRoots,
	resolveInstallDefaults,
	resolveStateFilePath,
} from './helpers'
import { getUnknownErrorStack, normalizeUnknownError, PackageServiceError } from './errors'
import { PackageInstallFlow } from './install-flow'
import { PackageInstaller } from './installer'
import { type LoadIntentConfig, PackageLoader } from './loader'
import { PackageInventoryService } from './inventory'
import { PackageLoadRuntime } from './load-runtime'
import { PackageMutationService } from './mutation'
import { PackageRemovalFlow } from './removal-flow'
import { PackageRuntime } from './runtime'
import {
	type NormalizedPackageSpecifier,
	type PackageSpecifierInput,
	tryNormalizeSpecifier,
} from './specifiers'
import { PackageState } from './state'
import {
	type PackageStatePayload,
	PackageStateStore,
	type PackageStateStoreOptions,
} from './state-store'
import type {
	InstallOptions,
	ListInstalledPackagesOptions,
	LoadOptions,
	PackageInstallResult,
	PackageInventoryEntry,
	PackageLoadIssue,
	PackageLoadIssueSource,
	PackageLoadResult,
	PackageReloadResult,
	PackageRemovalResult,
	ResolvedInstallOptions,
	PackageServiceConfig,
	PackageServiceErrorCode,
	PackagePolicy,
	PackageUninstallResult,
	RetryOptions,
} from './types'

export { PackageServiceError } from './errors'

export type {
	InstallOptions,
	ListInstalledPackagesOptions,
	LoadOptions,
	PackageInstallResult,
	PackageInstallStatus,
	PackageInventoryEntry,
	PackageLoadIssue,
	PackageLoadIssueSource,
	PackageLoadResult,
	PackageMetadata,
	PackageReloadResult,
	PackageRemovalResult,
	PackageServiceConfig,
	PackageServiceErrorCode,
	PackageUninstallResult,
	RetryOptions,
} from './types'

const serviceName = 'packageService' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: PackageService
		}
		interface Config {
			[serviceName]?: PackageServiceConfig
		}
	}
}

@Injectable({ key: serviceName })
export class PackageService {
	private readonly logName = 'package-manager'
	private readonly defaults: {
		install: ResolvedInstallOptions
		scan?: ScanTaskOptions | undefined
		preferFreshImport: boolean
	}
	private readonly policy: PackagePolicy

	private readonly installer: PackageInstaller
	private readonly installFlow: PackageInstallFlow
	private readonly inventory: PackageInventoryService
	private readonly loader: PackageLoader
	private readonly loadRuntime: PackageLoadRuntime
	private readonly mutations: PackageMutationService
	private readonly removalFlow: PackageRemovalFlow
	private readonly runtime: PackageRuntime
	private readonly stateStore: PackageStateStore
	private readonly state: PackageState
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
		public ctx: PluxelContext,
		config: PackageServiceConfig = {},
	) {
		this.defaults = {
			install: resolveInstallDefaults(config.install, false, null),
			preferFreshImport: config.preferFreshImport ?? false,
		}
		this.policy = config.policy ?? {}
		if (config.scan) {
			this.defaults.scan = config.scan
		}
		const stateFile = resolveStateFilePath(config.state?.file)
		const stateOptions: PackageStateStoreOptions = {
			storage: this.ctx.root.persistence.namespace('package-state'),
			file: stateFile,
			enabled: config.state?.enabled !== false,
			onError: (error) => {
				this.ctx.logger.warn('持久化包状态失败', { error, stateFile })
			},
		}
		if (config.state?.debounceMs !== undefined) {
			stateOptions.debounceMs = config.state.debounceMs
		}
		this.stateStore = new PackageStateStore(stateOptions)
		this.state = new PackageState(this.stateStore, getUnknownErrorStack)
		this.runtime = new PackageRuntime(this.ctx)
		this.installer = new PackageInstaller(
			this.ctx,
			(input) => this.normalizeSpecifier(input),
			(level, event, payload, message) => this.logEvent(level, event, payload, message),
			(result) => this.onPackageInstalled(result),
		)
		this.installFlow = new PackageInstallFlow(
			this.installer,
			(level, event, payload, message) => this.logEvent(level, event, payload, message),
			(result) => this.onPackageInstalled(result),
		)
		this.loader = new PackageLoader(
			this.ctx,
			this.state,
			this.runtime,
			() => ({ scan: this.defaults.scan, preferFreshImport: this.defaults.preferFreshImport }),
			(level, event, payload, message) => this.logEvent(level, event, payload, message),
			(spec, error, source, moduleId) => this.recordLoadIssue(spec, error, source, moduleId),
			(spec, options) => this.installFlow.installOne(spec, options),
			(overrides) => this.resolveInstallOptions(overrides),
			shouldRetryInstall,
		)
		this.removalFlow = new PackageRemovalFlow(
			this.installer,
			(level, event, payload, message) => this.logEvent(level, event, payload, message),
			(name) => this.blockPackage(name),
			(name, options) => this.invalidatePackage(name, options),
			() => this.syncTrigger(),
		)
		this.installDefaultsReady = this.initializeInstallDefaults(config.install)
		this.loadRuntime = new PackageLoadRuntime(
			this.ctx,
			this.state,
			this.runtime,
			this.loader,
			this.installFlow,
			this.installDefaultsReady,
			(input) => this.normalizeSpecifier(input),
			(inputs) => this.normalizeUniqueByName(inputs),
			(overrides) => this.resolveInstallOptions(overrides),
			(spec, overrides) => this.assertInstallPolicy(spec, overrides),
			(name) => this.unblockPackage(name),
			(spec, error, source, moduleId) => this.recordLoadIssue(spec, error, source, moduleId),
			() => this.initialized,
			() => this.syncTrigger(),
			(level, event, payload, message) => this.logEvent(level, event, payload, message),
		)
		this.inventory = new PackageInventoryService(
			this.state,
			this.installer,
			this.runtime,
			(overrides) => this.resolveInstallOptions(overrides),
			() => this.initialized,
		)
		this.mutations = new PackageMutationService(
			this.ctx,
			this.installFlow,
			this.removalFlow,
			this.loadRuntime,
			(input) => this.normalizeSpecifier(input),
			(inputs) => this.normalizeUniqueByName(inputs),
			(overrides) => this.resolveInstallOptions(overrides),
			(spec, overrides) => this.assertInstallPolicy(spec, overrides),
			(spec) => this.assertUninstallPolicy(spec),
			(name) => this.unblockPackage(name),
			(level, event, payload, message) => this.logEvent(level, event, payload, message),
		)
		this.ready = this.installDefaultsReady
			.then(() => this.initializeFromState())
			.catch((error): undefined => {
				this.logEvent('warn', 'init:restore_failed', { error })
				return undefined
			})
			.then(() => {
				this.initialized = true
				return this.syncTrackedPlugins()
			})
			.catch((error): undefined => {
				this.logEvent('warn', 'init:sync_failed', { error })
				return undefined
			})
			.finally(() => {
				this.initialized = true
			})
	}

	/** Normalize package spec input or throw on invalid input. */
	normalizeSpecifier(input: PackageSpecifierInput): NormalizedPackageSpecifier {
		const spec = tryNormalizeSpecifier(input)
		if (!spec) {
			throw new PackageServiceError('INVALID_SPEC', '包名不能为空。', { input })
		}
		return spec
	}

	/**
	 * Install a plugin package. If no explicit version and not forced, reuse existing dependency.
	 */
	async install(
		input: PackageSpecifierInput,
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult> {
		await this.ensureReady()
		return this.mutations.install(input, overrides)
	}

	/** Batch install packages with a single package manager call. */
	async installMany(
		inputs: PackageSpecifierInput[],
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult[]> {
		await this.ensureReady()
		return this.mutations.installMany(inputs, overrides)
	}

	/** Resolve entry for a package in scan context. */
	async resolveEntry(
		input: PackageSpecifierInput,
		options: ScanTaskOptions = {},
	): Promise<EntryResolutionOk> {
		await this.ensureReady()
		return this.loadRuntime.resolveEntry(input, options)
	}

	/**
	 * Load a package module and auto-install if missing.
	 */
	async load(input: PackageSpecifierInput, options: LoadOptions = {}): Promise<PackageLoadResult> {
		await this.ensureReady()
		return this.loadRuntime.load(input, options)
	}

	/**
	 * Load only from workspace without auto-install.
	 */
	async loadInstalled(
		input: PackageSpecifierInput,
		options: LoadOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		return this.loadRuntime.loadInstalled(input, options)
	}

	/**
	 * Uninstall a package: only clears runtime state, does not edit dependencies.
	 */
	async uninstall(input: PackageSpecifierInput): Promise<void> {
		await this.ensureReady()
		return this.mutations.uninstall(input)
	}

	/** Batch uninstall: runtime only. */
	async uninstallMany(inputs: PackageSpecifierInput[]): Promise<PackageUninstallResult[]> {
		await this.ensureReady()
		return this.mutations.uninstallMany(inputs)
	}

	/** Remove packages: runtime cleanup then remove dependencies. */
	async removePackages(
		inputs: PackageSpecifierInput[],
		overrides: InstallOptions = {},
	): Promise<PackageRemovalResult[]> {
		await this.ensureReady()
		return this.mutations.removePackages(inputs, overrides)
	}

	/** Force reload with fresh import. */
	async reload(
		input: PackageSpecifierInput,
		options: LoadOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		return this.loadRuntime.reload(input, options)
	}

	/** Batch reload, fresh by default. */
	async reloadMany(
		inputs: PackageSpecifierInput[],
		options: LoadOptions = {},
		intent: Partial<Pick<LoadIntentConfig, 'autoInstall' | 'fresh' | 'source'>> = {},
	): Promise<PackageReloadResult[]> {
		await this.ensureReady()
		return this.loadRuntime.reloadMany(inputs, options, intent)
	}

	/** Batch reinstall: clear runtime, force install, then fresh reload. */
	async reinstallMany(
		inputs: PackageSpecifierInput[],
		options: {
			install?: InstallOptions
			load?: LoadOptions
		} = {},
	): Promise<PackageReloadResult[]> {
		await this.ensureReady()
		return this.mutations.reinstallMany(inputs, options)
	}

	/** List installed packages including ones not loaded by loader. */
	async listInstalledPackages(
		options: ListInstalledPackagesOptions = {},
	): Promise<PackageInventoryEntry[]> {
		await this.ensureReady()
		return this.inventory.listInstalledPackages(options)
	}

	/** Retry recorded failures with optional reinstall. */
	async retryLoad(
		nameOrSpec: string | PackageSpecifierInput,
		options: RetryOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		return this.loadRuntime.retryLoad(nameOrSpec, options)
	}

	/** Retry all load issues. */
	async retryAllLoadIssues(options: RetryOptions = {}) {
		await this.ensureReady()
		return this.loadRuntime.retryAllLoadIssues(options)
	}

	listLoadIssues(): PackageLoadIssue[] {
		return this.inventory.listLoadIssues()
	}

	/** Drop runtime caches for a package. */
	invalidatePackage(name: string, options?: { resync?: boolean }) {
		this.loadRuntime.invalidatePackage(name, options)
		this.ctx.root.optionalPlugins.invalidate()
	}

	getPackageSpecByModuleId(moduleId: string): NormalizedPackageSpecifier | undefined {
		return this.inventory.getPackageSpecByModuleId(moduleId)
	}

	getDependencies(name: string): string[] {
		return this.inventory.getDependencies(name)
	}

	getDependents(name: string): string[] {
		return this.inventory.getDependents(name)
	}

	/** Scan declared plugins and auto-load missing managed packages. */
	async syncTrackedPlugins(): Promise<void> {
		await this.loadRuntime.syncTrackedPlugins()
	}

	private async initializeInstallDefaults(overrides?: InstallOptions) {
		const workspaceRoot = await this.detectWorkspaceRoot(overrides?.cwd)
		this.defaults.install = resolveInstallDefaults(overrides, Boolean(workspaceRoot), workspaceRoot)
	}

	private async detectWorkspaceRoot(preferredCwd?: string): Promise<string | null> {
		const roots = this.ctx.scanService.defaultRoots ?? []
		const candidates = normalizeRoots([preferredCwd ?? process.cwd(), ...roots])
		for (const root of candidates) {
			try {
				const info = await loadWorkspaceInfo(root)
				if (info.isMonorepo) return info.root
			} catch {
				// ignore detection errors
			}
		}
		return null
	}

	private async initializeFromState(): Promise<void> {
		let payload: PackageStatePayload | null = null
		try {
			payload = await this.stateStore.read()
		} catch (error) {
			this.ctx.logger.warn('读取包状态失败', { error })
			throw error
		}
		if (!payload) return

		this.state.disablePersistence()
		if (payload.blocked?.length) {
			payload.blocked.forEach((name) => {
				this.state.block(name)
			})
		}
		this.loadRuntime.restorePersistedIssues(payload)
		const mutated = await this.loadRuntime.restorePersistedPackages(payload.packages)
		this.state.enablePersistence()
		if (mutated) this.state.requestPersist()
	}

	private ensureReady(): Promise<void> {
		return this.ready
	}

	private onPackageInstalled(result: PackageInstallResult) {
		this.installer.invalidateCache()
		this.ctx.scanService.invalidateResolverCache({
			by: 'packageService',
			reason: 'install',
			targets: [result.target],
		})
		this.ctx.root.optionalPlugins.invalidate()
		this.ctx.logger.debug('已清理解析缓存，等待重新扫描。', {
			name: result.spec.name,
			target: result.target,
		})
		this.logEvent('info', 'install:scan_cache_cleared', {
			name: result.spec.name,
			target: result.target,
		})
	}

	private resolveInstallOptions(overrides: InstallOptions = {}): ResolvedInstallOptions {
		const base = this.defaults.install
		const result: ResolvedInstallOptions = {
			...base,
			cwd: overrides.cwd ?? base.cwd ?? process.cwd(),
			force: overrides.force ?? base.force,
			installPeerDependencies: overrides.installPeerDependencies ?? base.installPeerDependencies,
		}

		if (overrides.dev !== undefined) result.dev = overrides.dev
		if (overrides.workspace !== undefined) result.workspace = overrides.workspace
		if (overrides.env !== undefined) result.env = overrides.env
		if (overrides.silent !== undefined) result.silent = overrides.silent
		if (overrides.packageManager !== undefined) result.packageManager = overrides.packageManager
		if (overrides.global !== undefined) result.global = overrides.global
		if (overrides.dry !== undefined) result.dry = overrides.dry

		if (!result.workspace && base.workspace) {
			result.env = {
				...result.env,
				PNPM_IGNORE_WORKSPACE_ROOT_CHECK: 'true',
				npm_config_ignore_workspace_root_check: 'true',
			}
		}

		return result
	}

	private normalizeUniqueByName(inputs: PackageSpecifierInput[]): NormalizedPackageSpecifier[] {
		const specs = inputs.map((item) => this.normalizeSpecifier(item))
		return dedupeByName(specs)
	}

	private blockPackage(name: string) {
		this.state.block(name)
	}

	private unblockPackage(name: string) {
		this.state.unblock(name)
	}

	private recordLoadIssue(
		spec: NormalizedPackageSpecifier,
		error: unknown,
		source: PackageLoadIssueSource,
		moduleId?: string,
	) {
		const normalized = normalizeUnknownError(error)
		const issue: PackageLoadIssue = {
			spec,
			source,
			error: normalized.error,
			message: normalized.message,
			stack: normalized.stack,
			recordedAt: Date.now(),
		}
		if (moduleId) {
			issue.moduleId = moduleId
		}
		this.state.recordIssue(issue)
		this.logEvent('warn', 'load:issue_recorded', {
			name: spec.name,
			source,
			message: issue.message,
			moduleId,
		})
	}

	private logEvent(
		level: 'info' | 'warn' | 'error',
		event: string,
		payload: Record<string, unknown> = {},
		message?: string,
	) {
		const logger = this.ctx.logger
		if (!logger) return
		const baseMessage = message ?? 'PackageService {event}'
		const record = { name: this.logName, event, ...payload }
		if (level === 'info') {
			logger.info(baseMessage, record)
		} else if (level === 'warn') {
			logger.warn(baseMessage, record)
		} else {
			logger.error(baseMessage, record)
		}
	}

	private assertInstallPolicy(
		spec: NormalizedPackageSpecifier,
		overrides: InstallOptions | undefined,
	) {
		if (this.policy.allowInstall === false) {
			throw new PackageServiceError(
				'INSTALL_FAILED',
				'Runtime package install is disabled by policy.',
				{
					spec,
					policy: this.policy,
				},
			)
		}
		this.assertPackageSelectors(spec, 'INSTALL_FAILED')
		const registries = this.collectRequestedRegistries(overrides)
		if (registries.length > 0 && this.policy.allowedRegistries?.length) {
			const allowed = new Set(this.policy.allowedRegistries)
			const denied = registries.filter((item) => !allowed.has(item))
			if (denied.length > 0) {
				throw new PackageServiceError(
					'INSTALL_FAILED',
					`Registry blocked by package policy: ${denied.join(', ')}`,
					{ spec, policy: this.policy, registries: denied },
				)
			}
		}
	}

	private assertUninstallPolicy(spec: NormalizedPackageSpecifier) {
		if (this.policy.allowUninstall === false) {
			throw new PackageServiceError(
				'UNINSTALL_FAILED',
				'Runtime package removal is disabled by policy.',
				{ spec, policy: this.policy },
			)
		}
	}

	private assertPackageSelectors(spec: NormalizedPackageSpecifier, code: PackageServiceErrorCode) {
		const allowedScopes = this.policy.allowedScopes
		if (allowedScopes?.length) {
			const scope = spec.name.startsWith('@') ? spec.name.split('/')[0] : ''
			if (!allowedScopes.includes('*') && !allowedScopes.includes(scope)) {
				throw new PackageServiceError(code, `Package scope blocked by policy: ${spec.name}`, {
					spec,
					policy: this.policy,
				})
			}
		}
		if (
			this.policy.allowedTags?.length &&
			spec.tag &&
			!this.policy.allowedTags.includes(spec.tag)
		) {
			throw new PackageServiceError(code, `Package tag blocked by policy: ${spec.tag}`, {
				spec,
				policy: this.policy,
			})
		}
		const isPrerelease =
			(typeof spec.version === 'string' && spec.version.includes('-')) ||
			(spec.tag ? /^(alpha|beta|rc|next|canary|dev|experimental)/.test(spec.tag) : false)
		if (isPrerelease && this.policy.allowPrerelease === false) {
			throw new PackageServiceError(code, `Prerelease package blocked by policy: ${spec.target}`, {
				spec,
				policy: this.policy,
			})
		}
	}

	private collectRequestedRegistries(overrides: InstallOptions | undefined): string[] {
		if (!overrides) return []
		const registries = new Set<string>()
		const rawRegistry = (overrides as InstallOptions & { registry?: string }).registry
		if (typeof rawRegistry === 'string' && rawRegistry) registries.add(rawRegistry)
		const rawRegistries = (overrides as InstallOptions & { registries?: Record<string, string> })
			.registries
		if (rawRegistries && typeof rawRegistries === 'object') {
			for (const value of Object.values(rawRegistries)) {
				if (typeof value === 'string' && value) registries.add(value)
			}
		}
		return [...registries]
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
