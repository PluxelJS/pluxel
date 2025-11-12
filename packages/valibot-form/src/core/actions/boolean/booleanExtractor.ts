import type * as v from 'valibot'
import { META_MAP } from '~/core/utils'
import type { BooleanMetaOptions } from './type'

type BooleanSchema = v.SchemaWithPipe<readonly [v.BooleanSchema<any>, ...any]>

export function extractBooleanProps(schema: BooleanSchema): BooleanMetaOptions {
	const meta: BooleanMetaOptions = { variant: 'switch' }

	const pipe = schema.pipe
	if (!pipe) return meta

	// 第一项必然为元素本身不需要查
	for (let i = pipe.length - 1; i > 0; i--) {
		const item = pipe[i]
		if (item.kind === 'metadata' && item.type === META_MAP.BOOLEAN) {
			Object.assign(meta, item.metadata)
			// 如果没有后续检查可换 break
			break
		}
	}

	return meta
}
