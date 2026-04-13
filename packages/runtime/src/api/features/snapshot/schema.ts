import * as v from 'valibot'

export const BuildSnapshotResult = v.object({
	__typename: v.literal('BuildSnapshotResult'),
	ok: v.boolean(),
	path: v.nullish(v.string()),
	error: v.nullish(v.string()),
})
