import type {
	BaseIssue,
	BaseSchema,
	BaseSchemaAsync,
	DescriptionAction,
	PipeItem,
	PipeItemAsync,
	SchemaWithPipe,
	SchemaWithPipeAsync,
	TitleAction,
} from 'valibot'
import type { MetaType, MetaValueMap } from './meta'

type MetadataAction = TitleAction<unknown, string> | DescriptionAction<unknown, string>

export type Schema =
	| BaseSchema<unknown, unknown, BaseIssue<unknown>>
	| BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
	| SchemaWithPipe<
			readonly [
				BaseSchema<unknown, unknown, BaseIssue<unknown>>,
				...(PipeItem<any, unknown, BaseIssue<unknown>> | MetadataAction)[],
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
					| MetadataAction
				)[],
			]
	  >

export function readMeta<T extends MetaType>(
	schema: Schema,
	type: T,
): MetaValueMap[T] | undefined {
	if (!('pipe' in schema)) return undefined
	const nestedSchemas: Schema[] = []
	for (let index = schema.pipe.length - 1; index >= 0; index--) {
		const item = schema.pipe[index]
		if (item.kind === 'schema' && 'pipe' in item) {
			nestedSchemas.push(item)
		} else if (item.kind === 'metadata' && item.type === type) {
			return item.metadata as MetaValueMap[T]
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
