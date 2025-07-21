import type * as v from 'valibot'
import { META_MAP } from '~/utils'
import type { PicklistMetaOptions } from './type'

type PicklistSchema =
	| v.SchemaWithPipe<readonly [v.PicklistSchema<any, any>, ...any]>
	| v.PicklistSchema<any, any>

export function extractPicklistProps(
	schema: PicklistSchema,
): PicklistMetaOptions {
	const check: PicklistMetaOptions = {
		type: 'select',
		props: { options: schema.options },
	}
	if (!('pipe' in schema)) return check
	const arr = schema.pipe
	let i = arr.length

	while (i--) {
		const item = arr[i]
		if (item.kind === 'metadata' && item.type === META_MAP.PICKLIST) {
			Object.assign(check, item.metadata)
		}
		// if (item.kind !== 'validation') continue
	}

	return check
}
