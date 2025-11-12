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
	const meta: NumberMetaOptions = { variant: 'input' }

	const pipe = schema.pipe
	if (!pipe) return meta

	for (let i = pipe.length - 1; i > 0; i--) {
		const item = pipe[i]
		if (item.kind === 'metadata' && item.type === META_MAP.NUMBER) {
			Object.assign(meta, item.metadata)
			continue
		}

		if (item.kind !== 'validation') continue
		if (item.type === 'integer') {
			meta.integer = true
			continue
		}

		if (item.type in validationKey) {
			const key = validationKey[item.type as keyof typeof validationKey]
			meta[key] = item.requirement
		}
	}

	if (meta.variant === 'slider') {
		if (meta.min === undefined) meta.min = 0
		if (meta.max === undefined) meta.max = 100
		if (meta.step === undefined) meta.step = 1
	}

	return meta
}
