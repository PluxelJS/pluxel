import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import type { Context } from '@pluxel/core'
import { resolve as resolvePath } from 'pathe'

import type { EntryResolutionOk, ScanTaskOptions } from '../scan/ScanService'
import { isEntryOk } from '../scan/ScanService'
import { fromSnapshot as specFromSnapshot, type NormalizedPackageSpecifier } from './specifiers'
import { parseDependOn } from './helpers'
import type { PackageStatePayload, PersistedPackageEntry } from './state-store'
import type { ResolvedInstallOptions } from './internal-types'
import type { PackageRuntime } from './runtime'
import type { PackageState } from './state'
import type {
	InstallOptions,
	PackageInstallResult,
	PackageLoadIssueSource,
	PackageLoadResult,
} from './types'

export interface LoadIntentConfig {
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

type LogEvent = (
	level: 'info' | 'warn' | 'error',
	event: string,
	payload?: Record<string, unknown>,
	message?: string,
) => void

type CreateError = (code: string, message: string, detail?: unknown) => Error

type RecordLoadIssue = (
	spec: NormalizedPackageSpecifier,
	error: unknown,
	source: PackageLoadIssueSource,
	moduleId?: string,
) => void

type PerformInstall = (
	spec: NormalizedPackageSpecifier,
	options: ResolvedInstallOptions,
) => Promise<PackageInstallResult>

type ResolveInstallOptions = (overrides?: InstallOptions) => ResolvedInstallOptions

type ShouldRetryInstall = (error: unknown) => boolean

type DefaultsRef = () => { scan?: ScanTaskOptions; preferFreshImport: boolean }

export class PackageLoader {
	constructor(
		private readonly ctx: Context,
		private readonly state: PackageState,
		private readonly runtime: PackageRuntime,
		private readonly getDefaults: DefaultsRef,
		private readonly logEvent: LogEvent,
		private readonly recordLoadIssue: RecordLoadIssue,
		private readonly performInstall: PerformInstall,
		private readonly resolveInstallOptions: ResolveInstallOptions,
		private readonly createError: CreateError,
		private readonly shouldRetryInstall: ShouldRetryInstall,
	) {}

	async loadWithIntent(
		spec: NormalizedPackageSpecifier,
		options: { scan?: ScanTaskOptions; resolvedEntry?: EntryResolutionOk; install?: InstallOptions },
		intent: LoadIntentConfig,
		installResult?: PackageInstallResult,
	): Promise<PackageLoadResult> {
		this.logEvent('info', 'load:start', {
			name: spec.name,
			autoInstall: intent.autoInstall,
			fresh: intent.fresh,
			source: intent.source,
		})
		try {
			const result = await this.executeLoad(spec, options, intent, installResult)
			this.state.clearIssue(spec.name)
			this.logEvent('info', 'load:success', {
				name: spec.name,
				moduleId: result.moduleId,
				autoInstalled: Boolean(result.install),
				source: intent.source,
			})
			return result
		} catch (error) {
			if (!intent.autoInstall || !this.shouldRetryInstall(error)) {
				this.recordLoadIssue(spec, error, intent.source)
				throw error
			}
			const installOptions = this.resolveInstallOptions(options.install)
			const nextInstallResult = await this.performInstall(spec, installOptions)
			try {
				const result = await this.executeLoad(spec, options, intent, nextInstallResult)
				this.state.clearIssue(spec.name)
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
	}

	restorePersistedIssues(payload: PackageStatePayload) {
		for (const issue of payload.issues ?? []) {
			try {
				const spec = specFromSnapshot(issue.spec)
				const restoredError = new Error(issue.message)
				if (issue.stack) restoredError.stack = issue.stack
				this.state.recordIssue({
					spec,
					message: issue.message,
					source: issue.source,
					moduleId: issue.moduleId,
					recordedAt: issue.recordedAt,
					error: restoredError,
					stack: issue.stack,
				})
			} catch {
				// ignore malformed issue entries
			}
		}
	}

	async restorePersistedPackages(entries: PersistedPackageEntry[]) {
		let mutated = false
		for (const entry of entries) {
			const spec = specFromSnapshot(entry.spec)
			try {
				const moduleId = this.runtime.normalizeModuleId(entry.moduleId || entry.resolution.entry)
				const module = await this.importModule(moduleId, this.getDefaults().preferFreshImport)
				this.runtime.bindModuleId(spec.name, moduleId)
				this.runtime.setCachedModule(moduleId, module)
				this.runtime.primeHmrModuleCache(spec, moduleId, module)
				if (entry.isAnchor) {
					await this.ctx.loader.replaceModule(moduleId, module)
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
					this.state.registerRecord(record)
					this.state.clearIssue(spec.name)
					mutated = true
				} catch (error) {
					this.ctx.logger.warn('恢复包失败，已跳过该条记录', { spec, error })
					this.recordLoadIssue(spec, error, 'restore', entry.moduleId ?? entry.resolution.entry)
					mutated = true
				}
			}
			return mutated
		}

	private async executeLoad(
		spec: NormalizedPackageSpecifier,
		options: { scan?: ScanTaskOptions; resolvedEntry?: EntryResolutionOk },
		intent: LoadIntentConfig,
		installResult?: PackageInstallResult,
	): Promise<PackageLoadResult> {
		const resolution = options.resolvedEntry ?? (await this.resolveEntryForSpec(spec, options.scan))
		const moduleId = this.runtime.normalizeModuleId(resolution.entry)
		const manifestMeta = await this.readManifestMeta(resolution.dir)
		this.runtime.bindModuleId(spec.name, moduleId)

		const shouldImportFresh = intent.fresh ?? this.getDefaults().preferFreshImport
		const cached = shouldImportFresh ? undefined : this.runtime.getCachedModule(moduleId)
		const module = cached?.module ?? (await this.importModule(moduleId, shouldImportFresh))
		if (!cached || shouldImportFresh) {
			this.runtime.setCachedModule(moduleId, module)
		}
		this.runtime.primeHmrModuleCache(spec, moduleId, module)

		const isAnchor = await this.ctx.loader.replaceModule(moduleId, module)

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
		this.state.registerRecord(result)
		return result
	}

	async resolveEntryForSpec(
		spec: NormalizedPackageSpecifier,
		scanOverrides?: ScanTaskOptions,
	): Promise<EntryResolutionOk> {
		const request = this.mergeScanOptions(scanOverrides)
		const resolution = await this.ctx.scanService.resolveEntry({ name: spec.name }, request ?? {})
		if (!isEntryOk(resolution)) {
			throw this.createError('RESOLUTION_FAILED', resolution.message, { spec, resolution })
		}
		return resolution
	}

	private mergeScanOptions(overrides?: ScanTaskOptions): ScanTaskOptions | undefined {
		const base = this.getDefaults().scan
		if (!base) return overrides
		if (!overrides) return base

		const merged: ScanTaskOptions = {}
		if (overrides.roots !== undefined) merged.roots = overrides.roots
		else if (base.roots !== undefined) merged.roots = base.roots

		const mergedScan = base.scan
			? { ...base.scan, ...(overrides.scan ?? {}) }
			: (overrides.scan ?? base.scan)
		if (mergedScan !== undefined) {
			merged.scan = mergedScan
		}

		if (overrides.workspaceOnly !== undefined) merged.workspaceOnly = overrides.workspaceOnly
		else if (base.workspaceOnly !== undefined) merged.workspaceOnly = base.workspaceOnly

		return merged
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
				this.ctx.logger.error('导入模块失败 {moduleId}', { moduleId, error })

				if (error instanceof Error) {
					throw error
				}
				const message = typeof error === 'string' ? error : error != null ? String(error) : '未知错误'
				const wrapped = new Error(message)
				if (
					error &&
				typeof error === 'object' &&
				'stack' in (error as any) &&
				typeof (error as any).stack === 'string'
			) {
					wrapped.stack = (error as any).stack
				}
				throw wrapped
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

}
