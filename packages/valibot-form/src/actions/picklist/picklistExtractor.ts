// picklist/extractProps.ts
import type * as v from 'valibot'
import type { PicklistMetaOptions } from './type'
import { META_MAP } from '~/utils'

type Schema = v.PicklistSchema<any, any>
type PipedSchema<T extends v.BaseSchema<any, any, any>> = v.SchemaWithPipe<
	readonly [T, ...any]
>
type InputSchema = PipedSchema<Schema> | Schema

export function extractPicklistProps<T extends string | number = string>(
	schema: InputSchema,
): PicklistMetaOptions<T> {
	const meta: PicklistMetaOptions<T> = {}

	meta.options =
		schema.options ?? (schema as PipedSchema<Schema>).pipe[0].options

	const pipe = (schema as PipedSchema<Schema>).pipe
	if (!pipe) return meta

	// 从后往前，遇到第一个 array metadata 就用它（后者优先）
	for (let i = pipe.length - 1; i >= 0; i--) {
		const p = pipe[i]
		if (p.kind === 'metadata' && p.type === META_MAP.PICKLIST) {
			Object.assign(meta, p.metadata)
			break
		}
	}

	return meta
}
