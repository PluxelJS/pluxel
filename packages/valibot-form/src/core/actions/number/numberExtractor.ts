import type * as v from 'valibot'
import { META_MAP } from '~/core/utils'
import type { NumberMetaOptions } from './type'

type PipedNumberSchema = v.SchemaWithPipe<readonly [v.NumberSchema<any>, ...any]>

/** —— 映射 valibot 官方自带 validation 的特殊 key —— **/
const validationKey = {
	min_value: 'min',
	max_value: 'max',
} as const

export function extractNumberProps(schema: PipedNumberSchema): NumberMetaOptions {
	const meta: NumberMetaOptions = { type: 'input', options: {} }

	const pipe = schema.pipe
	if (!pipe) return meta

	// 第一项必然为元素本身不需要查
	for (let i = pipe.length - 1; i > 0; i--) {
		const item = pipe[i]
		if (item.kind === 'metadata' && item.type === META_MAP.NUMBER) {
			Object.assign(meta, item.metadata)
			// 如果没有后续检查可换 break
			continue
		}

		if (item.kind !== 'validation') continue
		if (item.type === 'integer') {
			meta.options.integer = true
			continue
		}

		if (item.type in validationKey) {
			meta.options[validationKey[item.type as keyof typeof validationKey]] = item.requirement
		}
	}

	return meta
}
