import type * as v from 'valibot'
import { MetaType } from '~/utils'
import type { StringMetaOptions } from './type'

type PipedStringSchema =
	| v.SchemaWithPipe<readonly [v.StringSchema<any>, ...any]>
	| v.StringSchema<any>

/** —— 静态映射表（函数外） —— **/
const propMap = {
	min_length: 'minLength',
	min_value: 'minLength',
	max_length: 'maxLength',
	max_value: 'maxLength',
} as const

const fmtMap = {
	url: 'url',
	email: 'email',
	ip: 'ip',
	ipv4: 'ipv4',
	ipv6: 'ipv6',
	hex_color: 'hex_color',
} as const

export type fmtKey = keyof typeof fmtMap

export function extractStringProps(
	schema: PipedStringSchema,
): StringMetaOptions {
	const check: StringMetaOptions = {}
	if (!('pipe' in schema)) return check
	const arr = schema.pipe
	let i = arr.length

	while (i--) {
		const item = arr[i]
		if (item.kind === 'metadata' && item.type === MetaType.STRING) {
			Object.assign(check, item.metadata)
		}
		if (item.kind !== 'validation') continue

		// 利用 in 操作符，自动收窄到 PropKey 或 FmtKey
		if (item.type in propMap) {
			// 这里 TS 知道 propMap[item.type] 一定是 'minLength' | 'maxLength'
			check[propMap[item.type as keyof typeof propMap]] = item.requirement
		} else if (item.type in fmtMap) {
			// 同理，fmtMap[...] 的值已受限于 StringCheck['format']
			check.format = fmtMap[item.type as keyof typeof fmtMap]
		}
	}

	return check
}
