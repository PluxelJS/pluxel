import type { PackageInstaller, PackageLogFn } from './installer'
import type { ResolvedInstallOptions } from './internal-types'
import type { NormalizedPackageSpecifier } from './specifiers'
import type { PackageInstallResult } from './types'

export class PackageInstallFlow {
	constructor(
		private readonly installer: PackageInstaller,
		private readonly logEvent: PackageLogFn,
		private readonly onPackageInstalled: (result: PackageInstallResult) => void,
		private readonly createError: (code: string, message: string, detail?: unknown) => Error,
	) {}

	async installOne(
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
				const existed = await this.installer.dependencyExists(spec.name, options)
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

			const [installResult] = await this.installer.installTargetsWithLogs([spec], options)
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
			throw this.createError('INSTALL_FAILED', `安装插件 "${spec.target}" 失败：${message}`, {
				cause: error,
				spec,
				options,
			})
		}
	}

	async installMany(
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
				const existed = await this.installer.dependencyExists(spec.name, options)
				if (existed) {
					statuses.push({ spec, target: spec.target, status: 'reused', installedAt: Date.now() })
					continue
				}
			}
			toInstall.push(spec)
		}

		if (toInstall.length) {
			try {
				const installed = await this.installer.installTargetsWithLogs(toInstall, options)
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
				throw this.createError('INSTALL_FAILED', `批量安装插件失败：${message}`, {
					cause: error,
					specs: toInstall,
					options,
				})
			}
		} else {
			this.logEvent('info', 'installMany:skip_install', {
				targets: specs.map((s) => s.target),
			})
		}

		return statuses
	}
}
