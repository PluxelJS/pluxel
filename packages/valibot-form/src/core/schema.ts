import type {
	BaseIssue,
	BaseSchema,
	BaseSchemaAsync,
	PipeItem,
	PipeItemAsync,
	SchemaWithPipe,
	SchemaWithPipeAsync,
} from 'valibot'
import type { MetaType, MetaValueMap, MetadataAction } from './meta'

type PluxelMetadataAction = MetadataAction<MetaType, unknown>

export type Schema =
	| BaseSchema<unknown, unknown, BaseIssue<unknown>>
	| BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
	| SchemaWithPipe<
			readonly [
				BaseSchema<unknown, unknown, BaseIssue<unknown>>,
				...(PipeItem<any, unknown, BaseIssue<unknown>> | PluxelMetadataAction)[],
			]
	  >
	| SchemaWithPipeAsync<
			readonly [
				(
					| BaseSchema<unknown, unknown, BaseIssue<unknown>>
					| BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
				),
				...(
					| PipeItem<any, unknown, BaseIssue<unknown>>
					| PipeItemAsync<any, unknown, BaseIssue<unknown>>
					| PluxelMetadataAction
				)[],
			]
	  >

export function readMeta<T extends MetaType>(schema: Schema, type: T): MetaValueMap[T] | undefined {
	if (!('pipe' in schema)) return undefined
	const nestedSchemas: Schema[] = []
	for (let index = schema.pipe.length - 1; index >= 0; index--) {
		const item = schema.pipe[index]
		if (item.kind === 'schema' && 'pipe' in item) {
			nestedSchemas.push(item)
		} else if (item.kind === 'metadata' && item.type === type && 'metadata' in item) {
			return (item as unknown as MetadataAction<T, unknown>).metadata as MetaValueMap[T]
		}
	}
	for (const nestedSchema of nestedSchemas) {
		const result = readMeta(nestedSchema, type)
		if (result !== undefined) {
			return result
		}
	}
	return undefined
}
