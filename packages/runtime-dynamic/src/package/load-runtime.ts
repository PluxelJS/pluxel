import type { Context } from '@pluxel/core'
import type { EntryResolutionOk, ScanTaskOptions } from '../scan/types'
import { collectDeclaredPlugins, isManagedPackageName } from './helpers'
import { PackageInstallFlow } from './install-flow'
import { KeyedLock } from './keyed-lock'
import { type LoadIntentConfig, PackageLoader } from './loader'
import type { PackageRuntime } from './runtime'
import type { NormalizedPackageSpecifier, PackageSpecifierInput } from './specifiers'
import type { PackageState } from './state'
import type { PackageStatePayload, PersistedPackageEntry } from './state-store'
import type {
	InstallOptions,
	LoadOptions,
	PackageInstallResult,
	PackageLoadIssueSource,
	PackageLoadResult,
	PackageReloadResult,
	ResolvedInstallOptions,
	RetryOptions,
} from './types'

type AssertInstallPolicy = (
	spec: NormalizedPackageSpecifier,
	overrides: InstallOptions | undefined,
) => void

type NormalizeSpecifier = (input: PackageSpecifierInput) => NormalizedPackageSpecifier

type NormalizeUniqueByName = (inputs: PackageSpecifierInput[]) => NormalizedPackageSpecifier[]

type ResolveInstallOptions = (overrides?: InstallOptions) => ResolvedInstallOptions

type RecordLoadIssue = (
	spec: NormalizedPackageSpecifier,
	error: unknown,
	source: PackageLoadIssueSource,
	moduleId?: string,
) => void

export class PackageLoadRuntime {
	private readonly loadLock = new KeyedLock<PackageLoadResult>()

	constructor(
		private readonly ctx: Context,
		private readonly state: PackageState,
		private readonly runtime: PackageRuntime,
		private readonly loader: PackageLoader,
		private readonly installFlow: PackageInstallFlow,
		private readonly installDefaultsReady: Promise<void>,
		private readonly normalizeSpecifier: NormalizeSpecifier,
		private readonly normalizeUniqueByName: NormalizeUniqueByName,
		private readonly resolveInstallOptions: ResolveInstallOptions,
		private readonly assertInstallPolicy: AssertInstallPolicy,
		private readonly unblockPackage: (name: string) => void,
		private readonly recordLoadIssue: RecordLoadIssue,
		private readonly isInitialized: () => boolean,
		private readonly onSync: () => void,
		private readonly logEvent: (
			level: 'info' | 'warn' | 'error',
			event: string,
			payload?: Record<string, unknown>,
			message?: string,
		) => void,
	) {}

	async resolveEntry(
		input: PackageSpecifierInput,
		options: ScanTaskOptions = {},
	): Promise<EntryResolutionOk> {
		const spec = this.normalizeSpecifier(input)
		return this.loader.resolveEntryForSpec(spec, options)
	}

	async load(input: PackageSpecifierInput, options: LoadOptions = {}): Promise<PackageLoadResult> {
		const spec = this.normalizeSpecifier(input)
		this.assertInstallPolicy(spec, options.install)
		this.unblockPackage(spec.name)
		return this.loadWithIntent(spec, options, { autoInstall: true, source: 'load' })
	}

	async loadInstalled(
		input: PackageSpecifierInput,
		options: LoadOptions = {},
	): Promise<PackageLoadResult> {
		const spec = this.normalizeSpecifier(input)
		return this.loadWithIntent(spec, options, { autoInstall: false, source: 'load' })
	}

	async reload(
		input: PackageSpecifierInput,
		options: LoadOptions = {},
	): Promise<PackageLoadResult> {
		const spec = this.normalizeSpecifier(input)
		this.assertInstallPolicy(spec, options.install)
		return this.loadWithIntent(spec, options, {
			autoInstall: true,
			fresh: true,
			source: 'load',
		})
	}

	async reloadMany(
		inputs: PackageSpecifierInput[],
		options: LoadOptions = {},
		intent: Partial<Pick<LoadIntentConfig, 'autoInstall' | 'fresh' | 'source'>> = {},
	): Promise<PackageReloadResult[]> {
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

	async retryLoad(
		nameOrSpec: string | PackageSpecifierInput,
		options: RetryOptions = {},
	): Promise<PackageLoadResult> {
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

	async retryAllLoadIssues(options: RetryOptions = {}) {
		const issues = this.state.listIssues()
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

	invalidatePackage(name: string, options?: { resync?: boolean }) {
		const record = this.state.getLoaded(name)
		const failure = this.state.getIssue(name)
		const moduleId =
			record?.moduleId ??
			this.runtime.getModuleId(name) ??
			(failure?.moduleId ? this.runtime.normalizeModuleId(failure.moduleId) : undefined)

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
			this.onSync()
		}
		this.logEvent('info', 'invalidate', { name, scope: 'runtime', moduleId })
	}

	async restorePersistedPackages(entries: PersistedPackageEntry[]) {
		return this.loader.restorePersistedPackages(entries)
	}

	restorePersistedIssues(payload: PackageStatePayload) {
		this.loader.restorePersistedIssues(payload)
	}

	async syncTrackedPlugins(): Promise<void> {
		if (!this.isInitialized()) return
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

	loadWithIntent(
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
}
