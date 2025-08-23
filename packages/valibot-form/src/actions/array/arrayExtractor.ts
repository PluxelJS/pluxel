// array/arrayExtractor.ts
import type * as v from 'valibot'
import type { ArrayMetaOptions, ArrayMetaResult } from './type'
import { META_MAP } from '~/utils'
import { extractPicklistProps } from '../picklist'

type Schema = v.ArraySchema<any, any>
type PipedSchema<T extends v.BaseSchema<any, any, any>> = v.SchemaWithPipe<
	readonly [T, ...any]
>
type InputSchema = PipedSchema<Schema> | Schema

export function extractArrayProps<TItemMeta = unknown>(
	schema: InputSchema,
): ArrayMetaResult<TItemMeta> {
	const meta: ArrayMetaResult<TItemMeta> = {}

	const itemSchema = schema.item ?? (schema as PipedSchema<Schema>).pipe[0].item
	if (itemSchema) {
		const type = itemSchema.type // string, number, boolean, picklist
		if (type === 'picklist') {
			meta.picklist = extractPicklistProps(itemSchema) as any
		}
		meta.valueMode = type
	}

	const pipe = (schema as PipedSchema<Schema>).pipe
	if (!pipe) return meta

	// 从后往前，遇到第一个 array metadata 就用它（后者优先）
	for (let i = pipe.length - 1; i >= 0; i--) {
		const p = pipe[i]
		if (p.kind === 'metadata' && p.type === META_MAP.ARRAY) {
			Object.assign(meta, p.metadata)
			break
		}
	}

	return meta
}
