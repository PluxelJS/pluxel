// record/extractProps.ts
import type * as v from 'valibot'
import { META_MAP } from '~/utils'
import type { RecordMetaOptions, RecordMetaResult } from './type'

type Schema = v.RecordSchema<any, any, any>
type PipedSchema<T extends v.BaseSchema<any, any, any>> = v.SchemaWithPipe<readonly [T, ...any]>
type InputSchema = PipedSchema<Schema> | Schema

export function extractRecordProps<TKeyMeta = unknown, TValueMeta = unknown>(
	schema: InputSchema,
): RecordMetaResult<TKeyMeta, TValueMeta> {
	const meta: RecordMetaResult<TKeyMeta, TValueMeta> = {}

	const itemSchema = schema.value ?? (schema as PipedSchema<Schema>).pipe[0].value
	if (itemSchema) {
		const type = itemSchema.type // string, number, boolean
		meta.valueMode = type
	}

	const pipe = (schema as PipedSchema<Schema>).pipe
	if (!pipe) return meta

	// 从后往前，遇到第一个 array metadata 就用它（后者优先）
	for (let i = pipe.length - 1; i >= 0; i--) {
		const p = pipe[i]
		if (p.kind === 'metadata' && p.type === META_MAP.RECORD) {
			Object.assign(meta, p.metadata)
			break
		}
	}

	return meta
}
