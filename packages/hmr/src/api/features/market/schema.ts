import * as v from 'valibot'

export const PackageIssueSource = v.picklist(['load', 'restore', 'retry'])

export const PackageIssueSpec = v.object({
	__typename: v.literal('PackageIssueSpec'),
	name: v.string(),
	version: v.nullish(v.string()),
	tag: v.nullish(v.string()),
	target: v.string(),
	raw: v.string(),
})

export const PackageLoadIssueEntry = v.object({
	__typename: v.literal('PackageLoadIssue'),
	spec: PackageIssueSpec,
	source: PackageIssueSource,
	message: v.string(),
	error: v.nullish(v.string()),
	moduleId: v.nullish(v.string()),
	recordedAt: v.number(),
})

export type PackageLoadIssueOutput = v.InferOutput<typeof PackageLoadIssueEntry>

export const PackageSpecifierInput = v.object({
	raw: v.nullish(v.string()),
	name: v.nullish(v.string()),
	version: v.nullish(v.string()),
	tag: v.nullish(v.string()),
})

export const PackageRemovalScope = v.picklist(['runtime', 'persisted'])

export const PackageInstallStatus = v.picklist(['installed', 'reused'])

export const PackageMutationResult = v.object({
	__typename: v.literal('PackageMutationResult'),
	ok: v.boolean(),
	code: v.string(),
	spec: v.nullish(PackageIssueSpec),
	installStatus: v.nullish(PackageInstallStatus),
	error: v.nullish(v.string()),
})

export const PackageBatchMutationResult = v.object({
	__typename: v.literal('PackageBatchMutationResult'),
	ok: v.boolean(),
	results: v.array(PackageMutationResult),
	error: v.nullish(v.string()),
})
