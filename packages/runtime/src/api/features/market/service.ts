import type { Context as PlxContext } from '@pluxel/core'
import type { InferInput, InferOutput } from 'valibot'

import type {
	InstallOptions,
	PackageInstallStatus,
	PackageLoadIssue as ServiceIssue,
	PackageReloadResult,
} from '../../../services/runtime/package/PackageService'
import { PackageServiceError } from '../../../services/runtime/package/PackageService'
import {
	normalizeSpecifier,
	type NormalizedPackageSpecifier,
	type PackageSpecifierInput as ServiceSpecifierInput,
} from '../../../services/runtime/package/specifiers'
import type {
	PackageLoadIssueEntry,
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageSpecifierInput as PackageSpecifierInputSchema,
} from './schema'
import type {
	PackageBatchResult,
	PackageMutationAction,
	PackageMutationInput,
	PackageMutationOptions,
	PackageMutationResult,
} from '../../../web/protocol'

type IssueOutput = InferOutput<typeof PackageLoadIssueEntry>
type SpecInputValue = InferInput<typeof PackageSpecifierInputSchema>
type MutationResult = PackageMutationResult
type BatchMutationResult = PackageBatchResult
type InventoryEntry = InferOutput<typeof PackageInventoryEntry>
type InventoryFilter = InferInput<typeof PackageInventoryFilter>

type ParsedSpecInput = {
	input: SpecInputValue
	serviceInput: ServiceSpecifierInput
	normalized: NormalizedPackageSpecifier
}

type ParsedSpecs = {
	valid: ParsedSpecInput[]
	invalid: MutationResult[]
}

type MutationHandler = (
	pCtx: PlxContext,
	specInputs: SpecInputValue[],
	options: PackageMutationOptions,
) => Promise<BatchMutationResult>

const MUTATION_CONCURRENCY = 4

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

export async function applyMarketMutation(
	pCtx: PlxContext,
	input: PackageMutationInput,
): Promise<BatchMutationResult> {
	const action = input.action
	const specInputs = Array.isArray(input.specs) ? input.specs : []
	const options = input.options ?? {}
	if (!action) return buildBatchResult([], '操作不能为空')
	const handler = mutationHandlers[action]
	if (!handler) return buildBatchResult([], '未知操作')
	return handler(pCtx, specInputs, options)
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

const mutationHandlers: Record<PackageMutationAction, MutationHandler> = {
	install: async (pCtx, specInputs, options) => {
		if (!specInputs.length) return buildBatchResult([], '安装列表不能为空')
		const parsed = parseSpecInputs(specInputs)
		if (!parsed.valid.length) return buildBatchResult(parsed.invalid)
		const overrides: InstallOptions | undefined =
			options.force === undefined ? undefined : { force: options.force }
		try {
			const installResults = await pCtx.packageService.installMany(
				parsed.valid.map((entry) => entry.serviceInput),
				overrides,
			)
			const loadResults = await mapWithConcurrency(
				installResults,
				resolveConcurrency(installResults.length),
				async (installResult) => {
					try {
						const loadResult = await pCtx.packageService.load(installResult.spec)
						return buildMutationResult({
							ok: true,
							code: 'installed_and_loaded',
							spec: loadResult.spec,
							installStatus: installResult.status,
						})
					} catch (error) {
						return buildMutationResult({
							ok: false,
							code: 'load_failed',
							spec: installResult.spec,
							installStatus: installResult.status,
							error,
						})
					}
				},
			)
			return buildBatchResult([...parsed.invalid, ...loadResults])
		} catch (error) {
			const failures = parsed.valid.map((entry) =>
				buildMutationResult({
					ok: false,
					code: 'install_failed',
					spec: entry.normalized,
					error,
				}),
			)
			return buildBatchResult([...parsed.invalid, ...failures], error)
		}
	},
	uninstall: async (pCtx, specInputs) => {
		if (!specInputs.length) return buildBatchResult([], '卸载列表不能为空')
		const parsed = parseSpecInputs(specInputs)
		if (!parsed.valid.length) return buildBatchResult(parsed.invalid)
		try {
			const results = await pCtx.packageService.uninstallMany(
				parsed.valid.map((entry) => entry.serviceInput),
			)
			const mutations = results.map((entry) =>
				buildMutationResult({
					ok: entry.status !== 'failed',
					code: entry.status === 'failed' ? 'uninstall_failed' : 'uninstalled',
					spec: entry.spec,
					error: entry.error,
				}),
			)
			return buildBatchResult([...parsed.invalid, ...mutations])
		} catch (error) {
			const failures = parsed.valid.map((entry) =>
				buildMutationResult({
					ok: false,
					code: 'uninstall_failed',
					spec: entry.normalized,
					error,
				}),
			)
			return buildBatchResult([...parsed.invalid, ...failures], error)
		}
	},
	remove: async (pCtx, specInputs) => {
		if (!specInputs.length) return buildBatchResult([], '移除列表不能为空')
		const parsed = parseSpecInputs(specInputs)
		if (!parsed.valid.length) return buildBatchResult(parsed.invalid)
		try {
			const results = await pCtx.packageService.removePackages(
				parsed.valid.map((entry) => entry.serviceInput),
			)
			const mutations = results.map((entry) =>
				buildMutationResult({
					ok: entry.status !== 'failed',
					code: entry.status === 'failed' ? 'remove_failed' : 'removed',
					spec: entry.spec,
					error: entry.error,
				}),
			)
			return buildBatchResult([...parsed.invalid, ...mutations])
		} catch (error) {
			const failures = parsed.valid.map((entry) =>
				buildMutationResult({
					ok: false,
					code: 'remove_failed',
					spec: entry.normalized,
					error,
				}),
			)
			return buildBatchResult([...parsed.invalid, ...failures], error)
		}
	},
	reinstall: async (pCtx, specInputs, options) => {
		if (!specInputs.length) return buildBatchResult([], '重装列表不能为空')
		const parsed = parseSpecInputs(specInputs)
		if (!parsed.valid.length) return buildBatchResult(parsed.invalid)
		try {
			const results = await pCtx.packageService.reinstallMany(
				parsed.valid.map((entry) => entry.serviceInput),
				{ install: { force: options.force ?? true } },
			)
			const mutations = serializeReloadResults(results, 'reinstalled', 'reinstall_failed')
			return buildBatchResult([...parsed.invalid, ...mutations])
		} catch (error) {
			const failures = parsed.valid.map((entry) =>
				buildMutationResult({
					ok: false,
					code: 'reinstall_failed',
					spec: entry.normalized,
					error,
				}),
			)
			return buildBatchResult([...parsed.invalid, ...failures], error)
		}
	},
	reload: async (pCtx, specInputs, options) => {
		if (!specInputs.length) return buildBatchResult([], '重载列表不能为空')
		const parsed = parseSpecInputs(specInputs)
		if (!parsed.valid.length) return buildBatchResult(parsed.invalid)
		try {
			const results = await pCtx.packageService.reloadMany(
				parsed.valid.map((entry) => entry.serviceInput),
				{},
				{ fresh: options.fresh ?? true },
			)
			const mutations = serializeReloadResults(results, 'reloaded', 'reload_failed')
			return buildBatchResult([...parsed.invalid, ...mutations])
		} catch (error) {
			const failures = parsed.valid.map((entry) =>
				buildMutationResult({
					ok: false,
					code: 'reload_failed',
					spec: entry.normalized,
					error,
				}),
			)
			return buildBatchResult([...parsed.invalid, ...failures], error)
		}
	},
	retry: async (pCtx, specInputs, options) => {
		const retryOptions = {
			reinstall: options.reinstall ?? false,
			fresh: options.fresh ?? true,
		}
		if (!specInputs.length) {
			try {
				const results = await pCtx.packageService.retryAllLoadIssues(retryOptions)
				const mutations = results.map((record) =>
					buildMutationResult({
						ok: true,
						code: retryOptions.reinstall ? 'reinstalled_and_loaded' : 'retried',
						spec: record.spec,
						installStatus: record.install?.status,
					}),
				)
				return buildBatchResult(mutations)
			} catch (error) {
				return buildBatchResult([], error)
			}
		}
		const parsed = parseSpecInputs(specInputs)
		if (!parsed.valid.length) return buildBatchResult(parsed.invalid)
		const mutations = await mapWithConcurrency(
			parsed.valid,
			resolveConcurrency(parsed.valid.length),
			async (entry) => {
				try {
					const loadResult = await pCtx.packageService.retryLoad(entry.serviceInput, retryOptions)
					return buildMutationResult({
						ok: true,
						code: retryOptions.reinstall ? 'reinstalled_and_loaded' : 'retried',
						spec: loadResult.spec,
						installStatus: loadResult.install?.status,
					})
				} catch (error) {
					return buildMutationResult({
						ok: false,
						code: 'retry_failed',
						spec: entry.normalized,
						error,
					})
				}
			},
		)
		return buildBatchResult([...parsed.invalid, ...mutations])
	},
}

function parseSpecInputs(specInputs: SpecInputValue[]): ParsedSpecs {
	const valid: ParsedSpecInput[] = []
	const invalid: MutationResult[] = []
	for (const input of specInputs) {
		try {
			const serviceInput = toServiceSpecifierInput(input)
			const normalized = normalizeSpecifier(serviceInput)
			valid.push({ input, serviceInput, normalized })
		} catch (error) {
			invalid.push(
				buildMutationResult({
					ok: false,
					code: 'invalid_spec',
					error,
				}),
			)
		}
	}
	return { valid, invalid }
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

function buildBatchResult(mutations: MutationResult[], error?: unknown): BatchMutationResult {
	const resolvedError = formatUnknownError(error)
	return {
		__typename: 'PackageBatchMutationResult',
		ok: !resolvedError && mutations.every((item) => item.ok),
		results: mutations,
		error: resolvedError,
	}
}

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
		return target != null ? String(target) : (fallback ?? null)
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

function resolveConcurrency(size: number): number {
	return Math.max(1, Math.min(MUTATION_CONCURRENCY, size))
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!items.length) return []
	const results = new Array<R>(items.length)
	let cursor = 0
	const limit = Math.max(1, Math.min(concurrency, items.length))

	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const index = cursor
			if (index >= items.length) return
			cursor += 1
			results[index] = await mapper(items[index], index)
		}
	})
	await Promise.all(workers)
	return results
}
