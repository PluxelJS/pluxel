import type * as v from 'valibot'
import type { BooleanMetaOptions } from './type'
import { META_MAP } from '~/utils'

type BooleanSchema =
	| v.SchemaWithPipe<readonly [v.BooleanSchema<any>, ...any]>
	| v.BooleanSchema<any>

export function extractBooleanProps(schema: BooleanSchema): BooleanMetaOptions {
	const check: BooleanMetaOptions = {}
	if (!('pipe' in schema)) return check
	const arr = schema.pipe
	let i = arr.length

	while (i--) {
		const item = arr[i]
		if (item.kind === 'metadata' && item.type === META_MAP.BOOLEAN) {
			Object.assign(check, item.metadata)
		}
		if (item.kind !== 'validation') continue
	}

	return check
}
