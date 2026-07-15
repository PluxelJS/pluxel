import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import type { Context } from '@pluxel/core'
import { PLUXEL_CONDITION_HMR } from '@pluxel/runtime/shared'
import { isNotNullOrUndefined, type Maybe } from 'option-t/maybe'
import { createErr, createOk, isOk, type Result } from 'option-t/plain_result'
import { resolve as resolvePath } from 'pathe'

import {
	type EntryResolutionErr,
	isEntryOk,
	type EntryResolutionOk,
	type ScanOptionsInput,
	type ScanTaskOptions,
} from '../scan/types'
import { PackageServiceError, toError } from './errors'
import { parsePluginPackages } from './helpers'
import type { PackageRuntime } from './runtime'
import { type NormalizedPackageSpecifier, tryFromSnapshot } from './specifiers'
import type { PackageState } from './state'
import type { PackageStatePayload, PersistedPackageEntry } from './state-store'
import type {
	InstallOptions,
	PackageInstallResult,
	PackageLoadIssueSource,
	PackageLoadResult,
	PluginPackageDependencies,
	ResolvedInstallOptions,
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
	pluginPackages: PluginPackageDependencies
}

type LogEvent = (
	level: 'info' | 'warn' | 'error',
	event: string,
	payload?: Record<string, unknown>,
	message?: string,
) => void

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
		private readonly shouldRetryInstall: ShouldRetryInstall,
	) {}

	async loadWithIntent(
		spec: NormalizedPackageSpecifier,
		options: {
			scan?: ScanTaskOptions
			resolvedEntry?: EntryResolutionOk
			install?: InstallOptions
		},
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
			const spec = tryFromSnapshot(issue.spec)
			if (!spec) {
				this.logEvent('warn', 'restore:issue_skipped', {
					reason: 'invalid_spec_snapshot',
					spec: issue.spec,
				})
				continue
			}
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
		}
	}

	async restorePersistedPackages(entries: PersistedPackageEntry[]) {
		let mutated = false
		for (const entry of entries) {
			const spec = tryFromSnapshot(entry.spec)
			if (!spec) {
				this.logEvent('warn', 'restore:package_skipped', {
					reason: 'invalid_spec_snapshot',
					spec: entry.spec,
				})
				mutated = true
				continue
			}
			try {
				const moduleId = this.runtime.normalizeModuleId(entry.moduleId || entry.resolution.entry)
				const module = await this.importModule(moduleId, this.getDefaults().preferFreshImport)
				this.runtime.bindModuleId(spec.name, moduleId)
				this.runtime.setCachedModule(moduleId, module)
				this.runtime.primeHmrModuleCache(spec, moduleId, module)
				if (entry.isAnchor) await this.ctx.loader.replaceModule(moduleId, module)
				const record: PackageLoadResult = {
					spec,
					resolution: entry.resolution,
					module,
					moduleId,
					isAnchor: entry.isAnchor,
					pluginPackages: entry.pluginPackages ?? {},
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

		const { isAnchor } = await this.ctx.loader.replaceModule(moduleId, module)

		const result: PackageLoadResult = {
			spec,
			resolution,
			module,
			moduleId,
			isAnchor,
			loadedAt: Date.now(),
			pluginPackages: manifestMeta.pluginPackages,
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
		const result = await this.resolveEntryForSpecResult(spec, scanOverrides)
		if (isOk(result)) return result.val
		throw new PackageServiceError('RESOLUTION_FAILED', result.err.message, {
			spec,
			resolution: result.err,
		})
	}

	async resolveEntryForSpecResult(
		spec: NormalizedPackageSpecifier,
		scanOverrides?: ScanTaskOptions,
	): Promise<Result<EntryResolutionOk, EntryResolutionErr>> {
		const request = this.mergeScanOptions(scanOverrides)
		const resolution = await this.ctx.scanService.resolveEntry({ name: spec.name }, request ?? {})
		if (!isEntryOk(resolution)) {
			return createErr(resolution)
		}
		return createOk(resolution)
	}

	private mergeScanOptions(overrides?: ScanTaskOptions): Maybe<ScanTaskOptions> {
		const base = sanitizePackageScanOptions(this.getDefaults().scan)
		const cleanOverrides = sanitizePackageScanOptions(overrides)
		if (!base) return cleanOverrides
		if (!cleanOverrides) return base

		const merged: ScanTaskOptions = {}
		if (cleanOverrides.roots !== undefined) merged.roots = cleanOverrides.roots
		else if (base.roots !== undefined) merged.roots = base.roots

		const mergedScan = base.scan
			? { ...base.scan, ...cleanOverrides.scan }
			: (cleanOverrides.scan ?? base.scan)
		if (mergedScan !== undefined) {
			merged.scan = mergedScan
		}

		if (cleanOverrides.workspaceOnly !== undefined)
			merged.workspaceOnly = cleanOverrides.workspaceOnly
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
			return await import(/* @vite-ignore */ url.href)
		} catch (error) {
			this.ctx.logger.error('导入模块失败 {moduleId}', { moduleId, error })
			throw toError(error)
		}
	}

	private async readManifestMeta(dir: string): Promise<PackageManifestMeta> {
		const manifestPath = resolvePath(dir, 'package.json')
		try {
			const raw = await readFile(manifestPath, 'utf-8')
			const json: unknown = JSON.parse(raw)
			const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined
			const version = typeof root?.version === 'string' ? root.version : undefined
			const pluxelValue = root?.pluxel
			const pluxel =
				pluxelValue && typeof pluxelValue === 'object'
					? (pluxelValue as Record<string, unknown>)
					: undefined
			const pluginPackages = parsePluginPackages(pluxel?.pluginPackages)
			return {
				manifestPath,
				manifestVersion: version,
				resolvedVersion: version,
				pluginPackages,
			}
		} catch (error) {
			this.logEvent('warn', 'manifest:unreadable', { manifestPath, error })
			return { manifestPath, pluginPackages: {} }
		}
	}
}

function sanitizePackageScanOptions(input?: ScanTaskOptions): Maybe<ScanTaskOptions> {
	if (!input) return undefined

	const scan = sanitizePackageScanInput(input.scan)
	const out: ScanTaskOptions = {}
	if (input.roots !== undefined) out.roots = input.roots
	if (isNotNullOrUndefined(scan)) out.scan = scan
	if (input.workspaceOnly !== undefined) out.workspaceOnly = input.workspaceOnly
	return Object.keys(out).length > 0 ? out : undefined
}

function sanitizePackageScanInput(input?: ScanOptionsInput): Maybe<ScanOptionsInput> {
	if (!input) return undefined

	const { preferHmrExports: _preferHmrExports, conditions, ...rest } = input
	const out: ScanOptionsInput = { ...rest }
	if (conditions !== undefined) {
		const filtered = conditions.filter((condition) => condition !== PLUXEL_CONDITION_HMR)
		if (filtered.length > 0) out.conditions = filtered
	}
	return Object.keys(out).length > 0 ? out : undefined
}
