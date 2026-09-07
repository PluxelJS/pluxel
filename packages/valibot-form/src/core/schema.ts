import type {
	BaseIssue,
	BaseSchema,
	BaseSchemaAsync,
	PipeItem,
	PipeItemAsync,
	SchemaWithPipe,
	SchemaWithPipeAsync,
} from 'valibot'
import { META_TYPES, type MetaType, type MetaValueMap, type MetadataAction } from './meta'
import { FORM_METADATA_KEY } from './schemaMetadata'

type PluxelMetadataAction = MetadataAction<Exclude<MetaType, 'form'>, unknown>

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
	return readMetaRecursive(schema, type, new Set())
}

function readMetaRecursive<T extends MetaType>(
	schema: Schema,
	type: T,
	seen: Set<Schema>,
): MetaValueMap[T] | undefined {
	if (seen.has(schema)) return undefined
	seen.add(schema)
	const nestedSchemas: Schema[] = []
	if ('pipe' in schema) {
		for (let index = schema.pipe.length - 1; index >= 0; index--) {
			const item = schema.pipe[index] as unknown as {
				kind: string
				type?: unknown
				metadata?: unknown
			}
			if (item.kind === 'schema' && item !== schema) {
				nestedSchemas.push(item as unknown as Schema)
			} else if (
				item.kind === 'metadata' &&
				type === META_TYPES.FORM &&
				item.type === 'metadata' &&
				item.metadata &&
				typeof item.metadata === 'object' &&
				FORM_METADATA_KEY in item.metadata
			) {
				const standard = item.metadata as Record<string, unknown>
				const presentation = standard[FORM_METADATA_KEY]
				if (presentation && typeof presentation === 'object' && !Array.isArray(presentation)) {
					return {
						...(presentation as MetaValueMap[typeof META_TYPES.FORM]),
						...(typeof standard.title === 'string' ? { title: standard.title } : {}),
						...(typeof standard.description === 'string'
							? { description: standard.description }
							: {}),
					} as MetaValueMap[T]
				}
			} else if (item.kind === 'metadata' && item.type === type && 'metadata' in item) {
				return (item as { metadata: MetaValueMap[T] }).metadata
			}
		}
	}
	for (const nestedSchema of nestedSchemas) {
		const result = readMetaRecursive(nestedSchema, type, seen)
		if (result !== undefined) {
			return result
		}
	}
	const wrapped = (schema as Schema & { wrapped?: Schema }).wrapped
	if (wrapped) return readMetaRecursive(wrapped, type, seen)
	return undefined
}
