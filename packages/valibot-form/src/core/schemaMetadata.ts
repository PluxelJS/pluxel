import type { Schema } from './schema'

export const FORM_METADATA_KEY = 'valibot-form' as const

export type StandardSchemaMetadata = Readonly<{
	title?: string
	description?: string
}>

/** Read Valibot's standard presentation metadata without executing the schema. */
export function readStandardSchemaMetadata(schema: Schema): StandardSchemaMetadata {
	const metadata: { title?: string; description?: string } = {}
	collectStandardSchemaMetadata(schema, metadata, new Set())
	return metadata
}

function collectStandardSchemaMetadata(
	schema: Schema,
	metadata: { title?: string; description?: string },
	seen: Set<Schema>,
): void {
	if (seen.has(schema) || (metadata.title !== undefined && metadata.description !== undefined)) {
		return
	}
	seen.add(schema)
	const value = schema as Schema & {
		readonly pipe?: readonly unknown[]
		readonly wrapped?: Schema
	}
	const nestedSchemas: Schema[] = []
	if (value.pipe) {
		for (let index = value.pipe.length - 1; index >= 0; index--) {
			const item = value.pipe[index]
			if (!item || typeof item !== 'object') continue
			const action = item as {
				kind?: unknown
				type?: unknown
				title?: unknown
				description?: unknown
				metadata?: unknown
			}
			if (action.kind === 'schema') {
				if (item !== schema) nestedSchemas.push(item as Schema)
				continue
			}
			if (action.kind !== 'metadata') continue
			if (
				metadata.title === undefined &&
				((action.type === 'title' && typeof action.title === 'string') ||
					action.type === 'metadata')
			) {
				const title =
					action.type === 'title'
						? action.title
						: (action.metadata as { title?: unknown } | null)?.title
				if (typeof title === 'string') metadata.title = title
			}
			if (
				metadata.description === undefined &&
				((action.type === 'description' && typeof action.description === 'string') ||
					action.type === 'metadata')
			) {
				const description =
					action.type === 'description'
						? action.description
						: (action.metadata as { description?: unknown } | null)?.description
				if (typeof description === 'string') metadata.description = description
			}
		}
	}
	for (const nested of nestedSchemas) {
		collectStandardSchemaMetadata(nested, metadata, seen)
	}
	if (value.wrapped) collectStandardSchemaMetadata(value.wrapped, metadata, seen)
}
