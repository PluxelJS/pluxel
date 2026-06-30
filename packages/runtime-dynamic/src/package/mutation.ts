import type { Context } from '@pluxel/core'
import { formatUnknownErrorMessage, PackageServiceError } from './errors'
import { PackageInstallFlow } from './install-flow'
import { KeyedLock } from './keyed-lock'
import type { LoadIntentConfig } from './loader'
import type { PackageLoadRuntime } from './load-runtime'
import type { PackageRemovalFlow } from './removal-flow'
import type { NormalizedPackageSpecifier, PackageSpecifierInput } from './specifiers'
import type {
	InstallOptions,
	LoadOptions,
	PackageInstallResult,
	PackageReloadResult,
	PackageRemovalResult,
	PackageUninstallResult,
	ResolvedInstallOptions,
} from './types'

type AssertInstallPolicy = (
	spec: NormalizedPackageSpecifier,
	overrides: InstallOptions | undefined,
) => void

type NormalizeSpecifier = (input: PackageSpecifierInput) => NormalizedPackageSpecifier

type NormalizeUniqueByName = (inputs: PackageSpecifierInput[]) => NormalizedPackageSpecifier[]

type ResolveInstallOptions = (overrides?: InstallOptions) => ResolvedInstallOptions

export class PackageMutationService {
	private readonly installLock = new KeyedLock<PackageInstallResult>()
	private readonly installManyLock = new KeyedLock<PackageInstallResult[]>()
	private readonly uninstallLock = new KeyedLock<void>()
	private readonly uninstallManyLock = new KeyedLock<PackageUninstallResult[]>()
	private readonly removeManyLock = new KeyedLock<PackageRemovalResult[]>()

	constructor(
		private readonly ctx: Context,
		private readonly installFlow: PackageInstallFlow,
		private readonly removalFlow: PackageRemovalFlow,
		private readonly loadRuntime: PackageLoadRuntime,
		private readonly normalizeSpecifier: NormalizeSpecifier,
		private readonly normalizeUniqueByName: NormalizeUniqueByName,
		private readonly resolveInstallOptions: ResolveInstallOptions,
		private readonly assertInstallPolicy: AssertInstallPolicy,
		private readonly assertUninstallPolicy: (spec: NormalizedPackageSpecifier) => void,
		private readonly unblockPackage: (name: string) => void,
		private readonly logEvent: (
			level: 'info' | 'warn' | 'error',
			event: string,
			payload?: Record<string, unknown>,
			message?: string,
		) => void,
	) {}

	async install(
		input: PackageSpecifierInput,
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult> {
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

	async installMany(
		inputs: PackageSpecifierInput[],
		overrides: InstallOptions = {},
	): Promise<PackageInstallResult[]> {
		if (inputs.length === 0) return []
		const specs = inputs.map((item) => this.normalizeSpecifier(item))
		specs.forEach((spec) => this.assertInstallPolicy(spec, overrides))
		specs.forEach((spec) => {
			this.unblockPackage(spec.name)
		})
		const key = buildMultiKey(specs)
		const resolved = this.resolveInstallOptions(overrides)
		this.logEvent('info', 'installMany:scheduled', {
			targets: specs.map((s) => s.target),
			force: resolved.force,
		})
		return this.installManyLock.run(key, () => this.installFlow.installMany(specs, resolved))
	}

	async uninstall(input: PackageSpecifierInput): Promise<void> {
		const spec = this.normalizeSpecifier(input)
		this.assertUninstallPolicy(spec)
		return this.uninstallLock.run(spec.key, async () => {
			const [result] = await this.removalFlow.uninstallMany([spec])
			if (result.status === 'failed') {
				const message = formatUnknownErrorMessage(result.error)
				throw new PackageServiceError('UNINSTALL_FAILED', message, {
					cause: result.error,
					spec,
				})
			}
		})
	}

	async uninstallMany(inputs: PackageSpecifierInput[]): Promise<PackageUninstallResult[]> {
		if (inputs.length === 0) return []
		const specs = this.normalizeUniqueByName(inputs)
		specs.forEach((spec) => this.assertUninstallPolicy(spec))
		const key = buildMultiKey(specs)
		return this.uninstallManyLock.run(key, () => this.removalFlow.uninstallMany(specs))
	}

	async removePackages(
		inputs: PackageSpecifierInput[],
		overrides: InstallOptions = {},
	): Promise<PackageRemovalResult[]> {
		if (inputs.length === 0) return []
		const specs = this.normalizeUniqueByName(inputs)
		specs.forEach((spec) => this.assertUninstallPolicy(spec))
		const key = buildMultiKey(specs)
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

	async reinstallMany(
		inputs: PackageSpecifierInput[],
		options: {
			install?: InstallOptions
			load?: LoadOptions
		} = {},
	): Promise<PackageReloadResult[]> {
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
				this.loadRuntime.invalidatePackage(spec.name)
				const installResult = await this.installFlow.installOne(spec, installOptions)
				const record = await this.loadRuntime.loadWithIntent(
					spec,
					options.load ?? {},
					{ autoInstall: false, fresh: true, source: 'load' } satisfies LoadIntentConfig,
					installResult,
				)
				results.push({ spec, record })
			} catch (error) {
				results.push({ spec, error })
			}
		}

		return results
	}
}

function buildMultiKey(specs: NormalizedPackageSpecifier[]): string {
	return specs
		.map((s) => s.key)
		.sort()
		.join('|')
}
