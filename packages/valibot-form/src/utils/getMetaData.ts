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
import type { MetaType, MetaTypeReturn } from './MetaType'

/**
 * Metadata action type.
 */
type MetadataAction = TitleAction<unknown, string> | DescriptionAction<unknown, string>

/**
 * Schema type.
 */
export type Schema =
	| BaseSchema<unknown, unknown, BaseIssue<unknown>>
	| BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
	| SchemaWithPipe<
			readonly [
				BaseSchema<unknown, unknown, BaseIssue<unknown>>,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
					| PipeItem<any, unknown, BaseIssue<unknown>> // eslint-disable-line @typescript-eslint/no-explicit-any
					| PipeItemAsync<any, unknown, BaseIssue<unknown>> // eslint-disable-line @typescript-eslint/no-explicit-any
					| MetadataAction
				)[],
			]
	  >

/**
 * Returns the last top-level value of a given metadata type from a schema
 * using a breadth-first search that starts with the last item in the pipeline.
 *
 * @param schema The schema to search.
 * @param type The metadata type.
 *
 * @returns The value, if any.
 *
 * @internal
 */
// @__NO_SIDE_EFFECTS__
export function getFormMeta<T extends MetaType>(
	schema: Schema,
	type: T,
): MetaTypeReturn<T> | undefined {
	if ('pipe' in schema === false) return
	const nestedSchemas: Schema[] = []
	for (let index = schema.pipe.length - 1; index >= 0; index--) {
		const item = schema.pipe[index]
		if (item.kind === 'schema' && 'pipe' in item) {
			nestedSchemas.push(item)
		} else if (item.kind === 'metadata' && item.type === type) {
			// @ts-expect-error
			return item.metadata
		}
	}
	for (const nestedSchema of nestedSchemas) {
		const result = getFormMeta(nestedSchema, type)
		if (result !== undefined) {
			return result
		}
	}
}
