// string/extractProps.ts
import type * as v from 'valibot'
import type { StringMetaOptions } from './type'
import { META_MAP } from '~/utils'

type PipedStringSchema = v.SchemaWithPipe<
	readonly [v.StringSchema<any>, ...any]
>

/** —— valibot 官方自带 validation 的内部辨识 key 映射到 meta —— **/
const validationMap = {
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
	const meta: StringMetaOptions = {}

	const pipe = schema.pipe
	if (!pipe) return meta

	// 第一项必然为元素本身不需要查
	for (let i = pipe.length - 1; i > 0; i--) {
		const item = pipe[i]
		if (item.kind === 'metadata' && item.type === META_MAP.STRING) {
			Object.assign(meta, item.metadata)
			// 如果没有后续检查可换 break
			continue
		}

		if (item.kind !== 'validation') continue

		// 利用 in 操作符，自动收窄到 PropKey 或 FmtKey
		if (item.type in validationMap) {
			// 这里 TS 知道 propMap[item.type] 一定是 'minLength' | 'maxLength'
			meta[validationMap[item.type as keyof typeof validationMap]] =
				item.requirement
		} else if (item.type in fmtMap) {
			// 同理，fmtMap[...] 的值已受限于 StringCheck['format']
			meta.format = fmtMap[item.type as keyof typeof fmtMap]
		}
	}

	return meta
}
