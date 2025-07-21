import type * as v from 'valibot'
import { META_MAP } from '~/utils'
import type { NumberMetaOptions } from './type'

type PipedNumberSchema =
	| v.SchemaWithPipe<readonly [v.NumberSchema<any>, ...any]>
	| v.NumberSchema<any>

/** —— 静态映射表（函数外） —— **/
const propMap = {
	min_value: 'min',
	max_value: 'max',
} as const

export function extractNumberProps(
	schema: PipedNumberSchema,
): NumberMetaOptions {
	const check: NumberMetaOptions = { type: 'input', options: {} }
	if (!('pipe' in schema)) return check
	const arr = schema.pipe
	let i = arr.length

	while (i--) {
		const item = arr[i]
		if (item.kind === 'metadata' && item.type === META_MAP.NUMBER) {
			Object.assign(check, item.metadata)
		}
		if (item.kind !== 'validation') continue

		if (item.type === 'integer') {
			check.options.integer = true
			continue
		}

		if (item.type in propMap) {
			check.options[propMap[item.type as keyof typeof propMap]] =
				item.requirement
		}
	}

	return check
}
