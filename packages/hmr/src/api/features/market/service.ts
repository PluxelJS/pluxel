import type { Context as PlxContext } from '@pluxel/core'
import type { InferInput, InferOutput } from 'valibot'

import type { RemovalScope } from '../../../services/loader'
import type {
	InstallOptions,
	PackageInstallStatus,
	PackageLoadIssue as ServiceIssue,
} from '../../../services/market/PackageService'
import type {
	NormalizedPackageSpecifier,
	PackageSpecifierInput as ServiceSpecifierInput,
} from '../../../services/market/specifiers'
import {
	PackageLoadIssueEntry,
	PackageMutationResult,
	PackageRemovalScope,
	PackageSpecifierInput as PackageSpecifierInputSchema,
} from './schema'

type IssueOutput = InferOutput<typeof PackageLoadIssueEntry>
type SpecInputValue = InferInput<typeof PackageSpecifierInputSchema>
type MutationResult = InferOutput<typeof PackageMutationResult>
type RemovalScopeInput = InferInput<typeof PackageRemovalScope>

export function listLoadIssues(pCtx: PlxContext): IssueOutput[] {
	return pCtx.packageService.listLoadIssues().map(serializeIssue)
}

export async function installPackage(
	pCtx: PlxContext,
	specInput: SpecInputValue,
	force?: boolean,
): Promise<MutationResult> {
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const overrides: InstallOptions | undefined = force === undefined ? undefined : { force }
		const installResult = await pCtx.packageService.install(serviceInput, overrides)
		return buildMutationResult({
			ok: true,
			code: installResult.status,
			spec: installResult.spec,
			installStatus: installResult.status,
		})
	} catch (error) {
		return buildMutationResult({
			ok: false,
			code: 'install_failed',
			error,
		})
	}
}

export async function uninstallPackage(
	pCtx: PlxContext,
	specInput: SpecInputValue,
	scope: RemovalScope,
): Promise<MutationResult> {
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const normalized = pCtx.packageService.normalizeSpecifier(serviceInput)
		pCtx.packageService.invalidatePackage(normalized.name, scope)
		return buildMutationResult({
			ok: true,
			code: 'uninstalled',
			spec: normalized,
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
	options: { force: boolean | undefined; scope: RemovalScope },
): Promise<MutationResult> {
	try {
		const serviceInput = toServiceSpecifierInput(specInput)
		const normalized = pCtx.packageService.normalizeSpecifier(serviceInput)
		pCtx.packageService.invalidatePackage(normalized.name, options.scope)
		const force = options.force ?? true
		const installResult = await pCtx.packageService.install(serviceInput, { force })
		await pCtx.packageService.reload(serviceInput)
		return buildMutationResult({
			ok: true,
			code: 'reinstalled',
			spec: installResult.spec,
			installStatus: installResult.status,
		})
	} catch (error) {
		return buildMutationResult({
			ok: false,
			code: 'reinstall_failed',
			error,
		})
	}
}

export function resolveRemovalScope(scope?: RemovalScopeInput | null): RemovalScope {
	return scope === 'persisted' ? 'persisted' : 'runtime'
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
		__typename: 'PackageLoadIssue',
		spec: serializeSpec(issue.spec),
		source: issue.source,
		message: issue.message,
		error: formatUnknownError(issue.error),
		moduleId: issue.moduleId ?? null,
		recordedAt: issue.recordedAt,
	}
}

function serializeSpec(spec: NormalizedPackageSpecifier) {
	return {
		__typename: 'PackageIssueSpec',
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

function formatUnknownError(error: unknown): string | null {
	if (error == null) return null
	if (error instanceof Error) return error.stack ?? error.message
	if (typeof error === 'string') return error
	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}
