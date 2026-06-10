import * as v from 'valibot'

export const PackageIssueSource = v.picklist(['load', 'restore', 'retry'])

export const PackageIssueSpec = v.object({
	__typename: v.literal('PackageIssueSpec'),
	key: v.string(),
	name: v.string(),
	version: v.nullable(v.string()),
	tag: v.nullable(v.string()),
	target: v.string(),
	raw: v.string(),
})

export const PackageLoadIssueEntry = v.object({
	__typename: v.literal('PackageLoadIssue'),
	id: v.string(),
	spec: PackageIssueSpec,
	source: PackageIssueSource,
	message: v.string(),
	error: v.nullable(v.string()),
	moduleId: v.nullable(v.string()),
	recordedAt: v.number(),
})

export type PackageLoadIssueOutput = v.InferOutput<typeof PackageLoadIssueEntry>

export const PackageSpecifierInput = v.object({
	raw: v.nullish(v.string()),
	name: v.nullish(v.string()),
	version: v.nullish(v.string()),
	tag: v.nullish(v.string()),
})

export const PackageInstallStatus = v.picklist(['installed', 'reused'])

export const PackageMutationResult = v.object({
	__typename: v.literal('PackageMutationResult'),
	id: v.string(),
	ok: v.boolean(),
	code: v.string(),
	spec: v.nullable(PackageIssueSpec),
	installStatus: v.nullable(PackageInstallStatus),
	error: v.nullable(v.string()),
})

export const PackageBatchMutationResult = v.object({
	__typename: v.literal('PackageBatchMutationResult'),
	ok: v.boolean(),
	results: v.array(PackageMutationResult),
	error: v.nullable(v.string()),
})

export const PackageInventoryEntry = v.object({
	__typename: v.literal('PackageInventoryEntry'),
	id: v.string(),
	spec: PackageIssueSpec,
	installedVersion: v.nullable(v.string()),
	requestedVersion: v.nullable(v.string()),
	loaded: v.boolean(),
	moduleId: v.nullable(v.string()),
	issues: v.nullable(v.array(PackageLoadIssueEntry)),
})

export const PackageInventoryFilter = v.object({
	includeUntracked: v.nullish(v.boolean()),
})

export const PackageManager = v.object({
	__typename: v.literal('PackageManager'),
})
