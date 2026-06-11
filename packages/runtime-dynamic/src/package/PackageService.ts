import { type Context as PluxelContext, Injectable } from '@pluxel/core'
import { loadWorkspaceInfo } from '@pluxel/rolldown/workspace/info'
import {
	isEntryOk,
	type EntryResolution,
	type EntryResolutionOk,
	type ScanTaskOptions,
} from '../scan/types'
import {
	dedupeByName,
	isManagedPackageName,
	normalizeRoots,
	resolveInstallDefaults,
	resolveStateFilePath,
} from './helpers'
import { PackageInstallFlow } from './install-flow'
import { PackageInstaller } from './installer'
import type { ResolvedInstallOptions } from './internal-types'
import { type LoadIntentConfig, PackageLoader } from './loader'
import { KeyedLock } from './locks'
import { PackageRemovalFlow } from './removal-flow'
import { PackageRuntime } from './runtime'
import {
	type NormalizedPackageSpecifier,
	normalizeSpecifier,
	type PackageSpecifierInput,
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
	PackageServiceConfig,
	PackageServiceErrorCode,
	PackagePolicy,
	PackageUninstallResult,
	RetryOptions,
} from './types'
import { createDebouncedTrigger } from './util/debounce'
import { collectDeclaredPlugins } from './util/plugins'

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

function getErrorCause(value: unknown): unknown {
	if (!value || typeof value !== 'object') return undefined
	if (!('cause' in value)) return undefined
	return (value as { cause?: unknown }).cause
}

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

export class PackageServiceError extends Error {
	override name = 'PackageServiceError'
	public readonly cause: unknown

	constructor(
		public readonly code: PackageServiceErrorCode,
		message: string,
		public readonly detail?: unknown,
	) {
		super(message)
		const cause = getErrorCause(detail)
		this.cause = detail instanceof Error ? detail : cause instanceof Error ? cause : undefined
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

	private readonly installLock = new KeyedLock<PackageInstallResult>()
	private readonly installManyLock = new KeyedLock<PackageInstallResult[]>()
	private readonly loadLock = new KeyedLock<PackageLoadResult>()
	private readonly uninstallLock = new KeyedLock<void>()
	private readonly uninstallManyLock = new KeyedLock<PackageUninstallResult[]>()
	private readonly removeManyLock = new KeyedLock<PackageRemovalResult[]>()

	private readonly installer: PackageInstaller
	private readonly installFlow: PackageInstallFlow
	private readonly loader: PackageLoader
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
			fs: this.ctx.root.fs,
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
		this.state = new PackageState(this.stateStore, (error) => this.getErrorStack(error))
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
			(code, message, detail) =>
				new PackageServiceError(code as PackageServiceErrorCode, message, detail),
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
			(code, message, detail) =>
				new PackageServiceError(code as PackageServiceErrorCode, message, detail),
			shouldRetryInstall,
		)
		this.removalFlow = new PackageRemovalFlow(
			this.installer,
			(level, event, payload, message) => this.logEvent(level, event, payload, message),
			(name) => this.blockPackage(name),
			(name, options) => this.invalidatePackage(name, options),
			() => this.syncTrigger.trigger(),
		)
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

	/** Normalize package spec input or throw on invalid input. */
	normalizeSpecifier(input: PackageSpecifierInput): NormalizedPackageSpecifier {
		try {
			return normalizeSpecifier(input)
		} catch (error) {
			throw new PackageServiceError('INVALID_SPEC', '包名不能为空。', {
				input,
				cause: error,
			})
		}
	}

	/**
	 * Install a plugin package. If no explicit version and not forced, reuse existing dependency.
	 */
	async install(
		input: PackageSpecifierInput,
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		this.assertInstallPolicy(spec, overrides)
		this.unblockPackage(spec.name)
		const resolved = this.resolveInstallOptions(overrides)
		this.logEvent('info', 'install:scheduled', {
			target: spec.target,
			force: resolved.force,
		})
		return this.installLock.run(spec.key, () => this.installFlow.installOne(spec, resolved))
	}

	/** Batch install packages with a single package manager call. */
	async installMany(
		inputs: PackageSpecifierInput[],
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult[]> {
		await this.ensureReady()
		if (inputs.length === 0) return []
		const specs = inputs.map((item) => this.normalizeSpecifier(item))
		specs.forEach((spec) => this.assertInstallPolicy(spec, overrides))
		specs.forEach((spec) => {
			this.unblockPackage(spec.name)
		})
		const key = this.buildMultiKey(specs)
		const resolved = this.resolveInstallOptions(overrides)
		this.logEvent('info', 'installMany:scheduled', {
			targets: specs.map((s) => s.target),
			force: resolved.force,
		})
		return this.installManyLock.run(key, () => this.installFlow.installMany(specs, resolved))
	}

	/** Resolve entry for a package in scan context. */
	async resolveEntry(
		input: PackageSpecifierInput,
		options: ScanTaskOptions = {},
	): Promise<EntryResolutionOk> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		return this.loader.resolveEntryForSpec(spec, options)
	}

	/**
	 * Load a package module and auto-install if missing.
	 */
	async load(input: PackageSpecifierInput, options: LoadOptions = {}): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		this.assertInstallPolicy(spec, options.install)
		this.unblockPackage(spec.name)
		return this.loadWithIntent(spec, options, { autoInstall: true, source: 'load' })
	}

	/**
	 * Load only from workspace without auto-install.
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
	 * Uninstall a package: only clears runtime state, does not edit dependencies.
	 */
	async uninstall(input: PackageSpecifierInput): Promise<void> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		this.assertUninstallPolicy(spec)
		return this.uninstallLock.run(spec.key, async () => {
			const [result] = await this.removalFlow.uninstallMany([spec])
			if (result.status === 'failed') {
				const message =
					result.error instanceof Error
						? result.error.message
						: result.error
							? String(result.error)
							: '未知错误'
				throw new PackageServiceError('UNINSTALL_FAILED', message, {
					cause: result.error,
					spec,
				})
			}
		})
	}

	/** Batch uninstall: runtime only. */
	async uninstallMany(inputs: PackageSpecifierInput[]): Promise<PackageUninstallResult[]> {
		await this.ensureReady()
		if (inputs.length === 0) return []
		const specs = this.normalizeUniqueByName(inputs)
		specs.forEach((spec) => this.assertUninstallPolicy(spec))
		const key = this.buildMultiKey(specs)
		return this.uninstallManyLock.run(key, () => this.removalFlow.uninstallMany(specs))
	}

	/** Remove packages: runtime cleanup then remove dependencies. */
	async removePackages(
		inputs: PackageSpecifierInput[],
		overrides: InstallOptions = {},
	): Promise<PackageRemovalResult[]> {
		await this.ensureReady()
		if (inputs.length === 0) return []
		const specs = this.normalizeUniqueByName(inputs)
		specs.forEach((spec) => this.assertUninstallPolicy(spec))
		const key = this.buildMultiKey(specs)
		const options = this.resolveInstallOptions(overrides)
		return this.removeManyLock.run(key, async () => {
			const result = await this.removalFlow.removeMany(specs, options)
			this.ctx.scanService.invalidateResolverCache({
				by: 'packageService',
				reason: 'remove',
				targets: specs.map((s) => s.target),
			})
			this.ctx.logger.debug('已清理解析缓存，等待重新扫描。', {
				targets: specs.map((s) => s.target),
			})
			this.logEvent('info', 'remove:scan_cache_cleared', {
				targets: specs.map((s) => s.target),
			})
			return result
		})
	}

	/** Force reload with fresh import. */
	async reload(
		input: PackageSpecifierInput,
		options: LoadOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec = this.normalizeSpecifier(input)
		this.assertInstallPolicy(spec, options.install)
		return this.loadWithIntent(spec, options, {
			autoInstall: true,
			fresh: true,
			source: 'load',
		})
	}

	/** Batch reload, fresh by default. */
	async reloadMany(
		inputs: PackageSpecifierInput[],
		options: LoadOptions = {},
		intent: Partial<Pick<LoadIntentConfig, 'autoInstall' | 'fresh' | 'source'>> = {},
	): Promise<PackageReloadResult[]> {
		await this.ensureReady()
		if (inputs.length === 0) return []
		const specs = this.normalizeUniqueByName(inputs)
		if ((intent.autoInstall ?? true) !== false) {
			specs.forEach((spec) => this.assertInstallPolicy(spec, options.install))
		}
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

	/** Batch reinstall: clear runtime, force install, then fresh reload. */
	async reinstallMany(
		inputs: PackageSpecifierInput[],
		options: {
			install?: InstallOptions
			load?: LoadOptions
		} = {},
	): Promise<PackageReloadResult[]> {
		await this.ensureReady()
		if (inputs.length === 0) return []
		const specs = this.normalizeUniqueByName(inputs)
		specs.forEach((spec) => {
			this.assertUninstallPolicy(spec)
			this.assertInstallPolicy(spec, options.install)
		})
		const installOptions = this.resolveInstallOptions({
			...options.install,
			force: options.install?.force ?? true,
		})
		const results: PackageReloadResult[] = []

		for (const spec of specs) {
			try {
				this.unblockPackage(spec.name)
				this.invalidatePackage(spec.name)
				const installResult = await this.installFlow.installOne(spec, installOptions)
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

	/** List installed packages including ones not loaded by loader. */
	async listInstalledPackages(
		options: ListInstalledPackagesOptions = {},
	): Promise<PackageInventoryEntry[]> {
		await this.ensureReady()
		const entries = new Map<string, PackageInventoryEntry>()
		const includeUntracked = options.includeUntracked ?? false
		const addOrMerge = (next: PackageInventoryEntry) => {
			const existing = entries.get(next.spec.name)
			if (!existing) {
				entries.set(next.spec.name, next)
				return
			}
			const merged: PackageInventoryEntry = {
				spec: existing.spec,
				installedVersion: next.installedVersion ?? existing.installedVersion,
				requestedVersion: next.requestedVersion ?? existing.requestedVersion,
				loaded: existing.loaded || next.loaded,
				moduleId: next.moduleId ?? existing.moduleId,
				issues: existing.issues ?? next.issues,
				blocked: next.blocked ?? existing.blocked,
			}
			entries.set(next.spec.name, merged)
		}

		for (const record of this.state.loadedEntries()) {
			addOrMerge({
				spec: record.spec,
				installedVersion: record.resolvedVersion ?? record.manifestVersion,
				requestedVersion: record.spec.version ?? record.spec.tag,
				loaded: true,
				moduleId: record.moduleId,
				blocked: this.state.isBlocked(record.spec.name),
				issues: this.state.getIssue(record.spec.name)
					? [this.state.getIssue(record.spec.name)!]
					: undefined,
			})
		}

		for (const issue of this.state.issueEntries()) {
			addOrMerge({
				spec: issue.spec,
				loaded: false,
				blocked: this.state.isBlocked(issue.spec.name),
				issues: [issue],
			})
		}

		const managedNames = new Set<string>([...this.state.loadedNames(), ...this.state.issueNames()])
		const installedDeps = await this.installer.readInstalledDependencies({
			options: this.resolveInstallOptions(),
		})
		for (const dep of installedDeps) {
			const managed = managedNames.has(dep.spec.name) || isManagedPackageName(dep.spec.name)
			if (!includeUntracked && !managed) continue
			addOrMerge({
				spec: dep.spec,
				installedVersion: dep.installedVersion,
				requestedVersion: dep.requestedVersion,
				loaded: this.state.hasLoaded(dep.spec.name),
				blocked: this.state.isBlocked(dep.spec.name),
			})
		}

		return [...entries.values()]
	}

	/** Retry recorded failures with optional reinstall. */
	async retryLoad(
		nameOrSpec: string | PackageSpecifierInput,
		options: RetryOptions = {},
	): Promise<PackageLoadResult> {
		await this.ensureReady()
		const spec =
			typeof nameOrSpec === 'string' && this.state.getIssue(nameOrSpec)
				? this.state.getIssue(nameOrSpec)!.spec
				: this.normalizeSpecifier(nameOrSpec)
		const reinstall = options.reinstall ?? false
		if (reinstall) {
			const installResult = await this.installFlow.installOne(
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

	/** Retry all load issues. */
	async retryAllLoadIssues(options: RetryOptions = {}) {
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
		return this.state.listIssues()
	}

	/** Drop runtime caches for a package. */
	invalidatePackage(name: string, options?: { resync?: boolean }) {
		const record = this.state.getLoaded(name)
		const failure = this.state.getIssue(name)
		const moduleId =
			record?.moduleId ??
			this.runtime.getModuleId(name) ??
			(failure?.moduleId ? this.normalizeModuleId(failure.moduleId) : undefined)

		if (record && moduleId) {
			this.runtime.dropHmrCacheForRecord(record)
		} else if (moduleId) {
			this.runtime.dropHmrCacheById(moduleId, name)
		}

		if (moduleId) {
			this.runtime.dropCachedModule(moduleId)
			this.ctx.loader.pruneModule(moduleId, 'runtime')
		} else {
			this.ctx.loader.prunePluginByName(name, 'runtime')
		}

		this.runtime.clearModuleId(name)
		this.state.clearRecord(name)
		this.state.clearIssue(name)
		this.state.removeDependentsOf(name)
		if (options?.resync !== false) {
			this.syncTrigger.trigger()
		}
		this.logEvent('info', 'invalidate', { name, scope: 'runtime', moduleId })
	}

	getPackageSpecByModuleId(moduleId: string): NormalizedPackageSpecifier | undefined {
		const normalized = this.normalizeModuleId(moduleId)
		for (const record of this.state.loadedEntries()) {
			if (this.normalizeModuleId(record.moduleId) === normalized) {
				return record.spec
			}
		}
		for (const issue of this.state.issueEntries()) {
			if (issue.moduleId && this.normalizeModuleId(issue.moduleId) === normalized) {
				return issue.spec
			}
		}
		return undefined
	}

	getDependencies(name: string): string[] {
		return this.state.getDependencies(name)
	}

	getDependents(name: string): string[] {
		return this.state.getDependents(name)
	}

	/** Scan declared plugins and auto-load missing managed packages. */
	async syncTrackedPlugins(): Promise<void> {
		if (!this.initialized) return
		await this.installDefaultsReady
		const roots = this.ctx.scanService.defaultRoots ?? [process.cwd()]
		const found = await collectDeclaredPlugins(roots)
		const toLoad: string[] = []
		for (const name of found) {
			if (!isManagedPackageName(name)) continue
			if (this.state.isBlocked(name)) continue
			if (this.state.hasLoaded(name)) continue
			toLoad.push(name)
		}
		if (toLoad.length === 0) return

		for (const name of toLoad) {
			try {
				await this.load(name)
			} catch (error) {
				this.ctx.logger.warn('同步加载插件失败', { name, error })
			}
		}
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
		this.loader.restorePersistedIssues(payload)
		const mutated = await this.loader.restorePersistedPackages(payload.packages)
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

	private buildMultiKey(specs: NormalizedPackageSpecifier[]): string {
		return specs
			.map((s) => s.key)
			.sort()
			.join('|')
	}

	private normalizeModuleId(moduleId: string): string {
		return this.runtime.normalizeModuleId(moduleId)
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
		const normalized = this.normalizeIssueError(error)
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

	private normalizeIssueError(error: unknown): {
		message: string
		error: unknown
		stack?: string
	} {
		const unwrapped = this.unwrapError(error)
		if (unwrapped instanceof Error) {
			return { message: unwrapped.message, error: unwrapped, stack: unwrapped.stack }
		}
		if (typeof unwrapped === 'string') {
			return { message: unwrapped, error: unwrapped }
		}
		if (unwrapped === undefined || unwrapped === null) {
			return { message: '未知错误', error: unwrapped }
		}
		try {
			return { message: JSON.stringify(unwrapped), error: unwrapped }
		} catch {
			return { message: String(unwrapped), error: unwrapped }
		}
	}

	private getErrorStack(error: unknown): string | undefined {
		const unwrapped = this.unwrapError(error)
		if (unwrapped instanceof Error) return unwrapped.stack ?? unwrapped.message
		if (typeof unwrapped === 'string') return unwrapped
		return undefined
	}

	private unwrapError(error: unknown): unknown {
		if (error instanceof PackageServiceError && error.cause) return error.cause
		const cause = getErrorCause(error)
		if (cause instanceof Error) return cause
		return error
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

	private async loadWithIntent(
		spec: NormalizedPackageSpecifier,
		options: LoadOptions,
		intent: LoadIntentConfig,
		installResult?: PackageInstallResult,
	): Promise<PackageLoadResult> {
		if (intent.autoInstall) this.assertInstallPolicy(spec, options.install)
		this.unblockPackage(spec.name)
		return this.loadLock.run(spec.key, () =>
			this.loader.loadWithIntent(spec, options, intent, installResult),
		)
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
