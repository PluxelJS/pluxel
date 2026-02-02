import type { NormalizedPackageSpecifier } from './specifiers'
import type { ResolvedInstallOptions } from './internal-types'
import type { PackageRemovalResult, PackageUninstallResult } from './types'
import type { PackageInstaller, PackageLogFn } from './installer'

type BlockPackage = (name: string) => void

type InvalidatePackage = (name: string, options?: { resync?: boolean }) => void

export class PackageRemovalFlow {
	constructor(
		private readonly installer: PackageInstaller,
		private readonly logEvent: PackageLogFn,
		private readonly blockPackage: BlockPackage,
		private readonly invalidatePackage: InvalidatePackage,
		private readonly onSync: () => void,
	) {}

	async uninstallMany(specs: NormalizedPackageSpecifier[]): Promise<PackageUninstallResult[]> {
		if (!specs.length) return []
		const results: PackageUninstallResult[] = specs.map((spec) => ({
			spec,
			status: 'uninstalled',
		}))

		this.logEvent('info', 'uninstall:batch_start', {
			targets: specs.map((s) => s.target),
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
				this.blockPackage(spec.name)
				this.invalidatePackage(spec.name, { resync: false })
			} catch (error) {
				markFailed(spec, error)
				this.logEvent('warn', 'uninstall:invalidate_failed', {
					target: spec.target,
					error,
				})
			}
		}

		for (const entry of results) {
			const event = entry.status === 'failed' ? 'uninstall:failed' : 'uninstall:runtime_cleared'
			const level = entry.status === 'failed' ? 'error' : 'info'
			this.logEvent(level, event, {
				target: entry.spec.target,
				error: entry.error,
			})
		}

		return results
	}

	async removeMany(
		specs: NormalizedPackageSpecifier[],
		options: ResolvedInstallOptions,
	): Promise<PackageRemovalResult[]> {
		if (!specs.length) return []
		const results: PackageRemovalResult[] = specs.map((spec) => ({
			spec,
			status: 'removed',
		}))

		this.logEvent('info', 'remove:batch_start', {
			targets: specs.map((s) => s.target),
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
				this.blockPackage(spec.name)
				this.invalidatePackage(spec.name, { resync: false })
			} catch (error) {
				markFailed(spec, error)
				this.logEvent('warn', 'remove:invalidate_failed', {
					target: spec.target,
					error,
				})
			}
		}

		try {
			await this.installer.removeTargetsWithLogs(specs, options)
			this.installer.invalidateCache(options.cwd)
		} catch (error) {
			for (const spec of specs) {
				markFailed(spec, error)
			}
			this.logEvent('error', 'remove:batch_remove_failed', {
				targets: specs.map((s) => s.target),
				error,
			})
		}

		for (const entry of results) {
			const event = entry.status === 'failed' ? 'remove:failed' : 'remove:completed'
			const level = entry.status === 'failed' ? 'error' : 'info'
			this.logEvent(level, event, {
				target: entry.spec.target,
				error: entry.error,
			})
		}

		this.onSync()
		return results
	}
}
