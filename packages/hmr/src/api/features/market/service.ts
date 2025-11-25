import type { Context as PlxContext } from '@pluxel/core'
import type { InferInput, InferOutput } from 'valibot'

import type {
	InstallOptions,
	PackageInstallStatus,
	PackageLoadIssue as ServiceIssue,
	PackageReloadResult,
} from '../../../services/market/PackageService'
import { PackageServiceError } from '../../../services/market/PackageService'
import type {
	NormalizedPackageSpecifier,
	PackageSpecifierInput as ServiceSpecifierInput,
} from '../../../services/market/specifiers'
import {
	PackageLoadIssueEntry,
	PackageMutationResult,
	PackageBatchMutationResult,
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageSpecifierInput as PackageSpecifierInputSchema,
} from './schema'

type IssueOutput = InferOutput<typeof PackageLoadIssueEntry>
type SpecInputValue = InferInput<typeof PackageSpecifierInputSchema>
type MutationResult = InferOutput<typeof PackageMutationResult>
type BatchMutationResult = InferOutput<typeof PackageBatchMutationResult>
type InventoryEntry = InferOutput<typeof PackageInventoryEntry>
type InventoryFilter = InferInput<typeof PackageInventoryFilter>
type BatchResultBuilder = (mutations: MutationResult[], error?: unknown) => BatchMutationResult

export function listLoadIssues(pCtx: PlxContext): IssueOutput[] {
	return pCtx.packageService.listLoadIssues().map(serializeIssue)
}

export async function listPackageInventory(
	pCtx: PlxContext,
	filter?: InventoryFilter,
): Promise<InventoryEntry[]> {
	const entries = await pCtx.packageService.listInstalledPackages({
		includeUntracked: filter?.includeUntracked ?? false,
	})
	return entries.map((entry) => ({
		__typename: 'PackageInventoryEntry' as const,
		spec: serializeSpec(entry.spec),
		installedVersion: entry.installedVersion ?? null,
		requestedVersion: entry.requestedVersion ?? null,
		loaded: entry.loaded,
		moduleId: entry.moduleId ?? null,
		issues: entry.issues?.map(serializeIssue) ?? null,
	}))
}

export async function installPackage(
	pCtx: PlxContext,
	specInput: SpecInputValue,
	force?: boolean,
): Promise<MutationResult> {
	let installResult: Awaited<ReturnType<PlxContext['packageService']['install']>> | undefined
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const overrides: InstallOptions | undefined = force === undefined ? undefined : { force }
		installResult = await pCtx.packageService.install(serviceInput, overrides)
		const loadResult = await pCtx.packageService.load(serviceInput)
		return buildMutationResult({
			ok: true,
			code: 'installed_and_loaded',
			spec: loadResult.spec,
			installStatus: installResult.status,
		})
	} catch (error) {
		return buildMutationResult({
			ok: false,
			code: installResult ? 'load_failed' : 'install_failed',
			spec: installResult?.spec,
			installStatus: installResult?.status,
			error,
		})
	}
}

export async function installPackages(
	pCtx: PlxContext,
	specInputs: SpecInputValue[],
	force?: boolean,
): Promise<BatchMutationResult> {
	if (!specInputs?.length) {
		return {
			__typename: 'PackageBatchMutationResult',
			ok: false,
			results: [],
			error: '安装列表不能为空',
		}
	}
	const overrides: InstallOptions | undefined = force === undefined ? undefined : { force }
	try {
		const serviceInputs = specInputs.map(toServiceSpecifierInput)
		const installResults = await pCtx.packageService.installMany(serviceInputs, overrides)
		const results: MutationResult[] = []

		for (const installResult of installResults) {
			try {
				const loadResult = await pCtx.packageService.load(installResult.spec)
				results.push(
					buildMutationResult({
						ok: true,
						code: 'installed_and_loaded',
						spec: loadResult.spec,
						installStatus: installResult.status,
					}),
				)
			} catch (error) {
				results.push(
					buildMutationResult({
						ok: false,
						code: 'load_failed',
						spec: installResult.spec,
						installStatus: installResult.status,
						error,
					}),
				)
			}
		}

		return {
			__typename: 'PackageBatchMutationResult',
			ok: results.every((r) => r.ok),
			results,
			error: null,
		}
	} catch (error) {
		return buildBatchResult([], error)
	}
}

export async function uninstallPackage(
	pCtx: PlxContext,
	specInput: SpecInputValue,
): Promise<MutationResult> {
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const [result] = await pCtx.packageService.uninstallMany([serviceInput])
		if (!result || result.status === 'failed') {
			throw result?.error ?? new Error('卸载失败')
		}
		return buildMutationResult({
			ok: true,
			code: 'uninstalled',
			spec: result.spec,
		})
	} catch (error) {
		return buildMutationResult({
			ok: false,
			code: 'uninstall_failed',
			error,
		})
	}
}

export async function reinstallPackage(
	pCtx: PlxContext,
	specInput: SpecInputValue,
	options: { force: boolean | undefined },
): Promise<MutationResult> {
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const [result] = await pCtx.packageService.reinstallMany([serviceInput], {
			install: { force: options.force ?? true },
		})
		if (!result || result.error || !result.record) {
			throw result?.error ?? new Error('重装失败')
		}
		return buildMutationResult({
			ok: true,
			code: 'reinstalled',
			spec: result.record.spec,
			installStatus: result.record.install?.status,
		})
	} catch (error) {
		return buildMutationResult({
			ok: false,
			code: 'reinstall_failed',
			error,
		})
	}
}

export async function retryPackage(
	pCtx: PlxContext,
	specInput: SpecInputValue,
	options: { reinstall?: boolean; fresh?: boolean },
): Promise<MutationResult> {
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const loadResult = await pCtx.packageService.retryLoad(serviceInput, {
			reinstall: options.reinstall ?? false,
			fresh: options.fresh ?? true,
		})
		return buildMutationResult({
			ok: true,
			code: options.reinstall ? 'reinstalled_and_loaded' : 'retried',
			spec: loadResult.spec,
			installStatus: loadResult.install?.status,
		})
	} catch (error) {
		return buildMutationResult({
			ok: false,
			code: 'retry_failed',
			error,
		})
	}
}

export async function retryFailedPackages(
	pCtx: PlxContext,
	options: { reinstall?: boolean; fresh?: boolean },
): Promise<BatchMutationResult> {
	try {
		const results = await pCtx.packageService.retryAllLoadIssues({
			reinstall: options.reinstall ?? false,
			fresh: options.fresh ?? true,
		})
		const mutations: MutationResult[] = results.map((record) =>
			buildMutationResult({
				ok: true,
				code: options.reinstall ? 'reinstalled_and_loaded' : 'retried',
				spec: record.spec,
				installStatus: record.install?.status,
			}),
		)
		return {
			__typename: 'PackageBatchMutationResult',
			ok: mutations.every((item) => item.ok),
			results: mutations,
			error: null,
		}
	} catch (error) {
		return buildBatchResult([], error)
	}
}

export async function uninstallPackages(
	pCtx: PlxContext,
	specInputs: SpecInputValue[],
): Promise<BatchMutationResult> {
	if (!specInputs?.length) {
		return buildBatchResult([], '卸载列表不能为空')
	}
	try {
		const serviceInputs = specInputs.map(toServiceSpecifierInput)
		const results = await pCtx.packageService.uninstallMany(serviceInputs)
		const mutations = results.map((entry) =>
			buildMutationResult({
				ok: entry.status !== 'failed',
				code: 'uninstalled',
				spec: entry.spec,
				error: entry.error,
			}),
		)
		return buildBatchResult(mutations)
	} catch (error) {
		return buildBatchResult([], error)
	}
}

export async function removePackage(
	pCtx: PlxContext,
	specInput: SpecInputValue,
	overrides?: InstallOptions,
): Promise<MutationResult> {
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const [result] = await pCtx.packageService.removePackages([serviceInput], overrides)
		if (!result || result.status === 'failed') {
			throw result?.error ?? new Error('移除失败')
		}
		return buildMutationResult({
			ok: true,
			code: 'removed',
			spec: result.spec,
		})
	} catch (error) {
		return buildMutationResult({
			ok: false,
			code: 'remove_failed',
			error,
		})
	}
}

export async function removePackages(
	pCtx: PlxContext,
	specInputs: SpecInputValue[],
	overrides?: InstallOptions,
): Promise<BatchMutationResult> {
	if (!specInputs?.length) {
		return buildBatchResult([], '移除列表不能为空')
	}
	try {
		const serviceInputs = specInputs.map(toServiceSpecifierInput)
		const results = await pCtx.packageService.removePackages(serviceInputs, overrides)
		const mutations = results.map((entry) =>
			buildMutationResult({
				ok: entry.status !== 'failed',
				code: 'removed',
				spec: entry.spec,
				error: entry.error,
			}),
		)
		return buildBatchResult(mutations)
	} catch (error) {
		return buildBatchResult([], error)
	}
}

export async function reinstallPackages(
	pCtx: PlxContext,
	specInputs: SpecInputValue[],
	options: { force: boolean | undefined },
): Promise<BatchMutationResult> {
	if (!specInputs?.length) {
		return buildBatchResult([], '重装列表不能为空')
	}
	try {
		const serviceInputs = specInputs.map(toServiceSpecifierInput)
		const results = await pCtx.packageService.reinstallMany(serviceInputs, {
			install: { force: options.force ?? true },
		})
		const mutations = serializeReloadResults(
			results,
			'reloaded',
			'reload_failed',
		)
		return buildBatchResult(mutations)
	} catch (error) {
		return buildBatchResult([], error)
	}
}

export async function reloadPackages(
	pCtx: PlxContext,
	specInputs: SpecInputValue[],
	options: { fresh?: boolean },
): Promise<BatchMutationResult> {
	if (!specInputs?.length) {
		return buildBatchResult([], '重载列表不能为空')
	}
	try {
		const serviceInputs = specInputs.map(toServiceSpecifierInput)
		const results = await pCtx.packageService.reloadMany(serviceInputs, {}, { fresh: options.fresh ?? true })
		const mutations = serializeReloadResults(results, 'reloaded', 'reload_failed')
		return buildBatchResult(mutations)
	} catch (error) {
		return buildBatchResult([], error)
	}
}

export function toServiceSpecifierInput(input: SpecInputValue): ServiceSpecifierInput {
	const raw = input.raw?.trim()
	if (raw) return raw

	const name = input.name?.trim()
	if (!name) {
		throw new Error('包名不能为空。')
	}

	const version = input.version?.trim()
	if (version) {
		return { name, version }
	}

	const tag = input.tag?.trim()
	if (tag) {
		return { name, tag }
	}

	return { name }
}

function serializeIssue(issue: ServiceIssue): IssueOutput {
	return {
		__typename: 'PackageLoadIssue' as const,
		spec: serializeSpec(issue.spec),
		source: issue.source,
		message: issue.message,
		error: formatUnknownError(issue.error, issue.stack),
		moduleId: issue.moduleId ?? null,
		recordedAt: issue.recordedAt,
	}
}

function serializeSpec(spec: NormalizedPackageSpecifier) {
	return {
		__typename: 'PackageIssueSpec' as const,
		name: spec.name,
		version: spec.version ?? null,
		tag: spec.tag ?? null,
		target: spec.target,
		raw: spec.raw,
	}
}

interface MutationResultConfig {
	ok: boolean
	code: string
	spec?: NormalizedPackageSpecifier | undefined
	installStatus?: PackageInstallStatus | undefined
	error?: unknown
}

function buildMutationResult(config: MutationResultConfig): MutationResult {
	return {
		__typename: 'PackageMutationResult',
		ok: config.ok,
		code: config.code,
		spec: config.spec ? serializeSpec(config.spec) : null,
		installStatus: config.installStatus ?? null,
		error: formatUnknownError(config.error),
	}
}

const buildBatchResult: BatchResultBuilder = (mutations, error) => ({
	__typename: 'PackageBatchMutationResult',
	ok: mutations.every((item) => item.ok),
	results: mutations,
	error: formatUnknownError(error),
})

function serializeReloadResults(
	results: PackageReloadResult[],
	successCode: string,
	failureCode: string,
): MutationResult[] {
	return results.map((entry) =>
		entry.record
			? buildMutationResult({
					ok: true,
					code: successCode,
					spec: entry.record.spec,
					installStatus: entry.record.install?.status,
				})
			: buildMutationResult({
					ok: false,
					code: failureCode,
					spec: entry.spec,
					error: entry.error,
				}),
	)
}

function formatUnknownError(error: unknown, fallback?: string): string | null {
	if (error == null && !fallback) return null
	const target = unwrapError(error) ?? fallback
	if (target instanceof Error) return target.stack ?? target.message ?? fallback ?? null
	if (typeof target === 'string') return target
	try {
		return JSON.stringify(target)
	} catch {
		return target != null ? String(target) : fallback ?? null
	}
}

function unwrapError(error: unknown): unknown {
	if (error instanceof PackageServiceError && error.cause) return error.cause
	if (error && typeof error === 'object' && 'cause' in (error as any)) {
		const cause = (error as any).cause
		if (cause) return cause
	}
	return error
}
