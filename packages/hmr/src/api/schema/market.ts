import * as v from 'valibot'

export const PackageIssueSource = v.picklist(['load', 'restore'])

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
