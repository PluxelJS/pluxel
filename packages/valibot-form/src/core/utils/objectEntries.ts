import type { Schema } from '../schema'
import { isSchema, pipeRoot } from '../schemaStructure'

export interface ObjectEntry {
	readonly name: string
	readonly schema: Schema
	readonly duplicate?: true
}

function collect(
	schema: Schema,
	bucket: Map<string, ObjectEntry>,
	ancestors: Set<Schema>,
): boolean {
	if (!isSchema(schema) || ancestors.has(schema)) return false
	const current = pipeRoot(schema)
	if (current.type === 'object' || current.type === 'strict_object') {
		if (!current.entries) return false
		for (const [name, child] of Object.entries(current.entries)) {
			if (!isSchema(child)) return false
			const previous = bucket.get(name)
			bucket.set(name, previous ? { ...previous, duplicate: true } : { name, schema: child })
		}
		return true
	}
	if (current.type !== 'intersect' || !current.options) return false
	ancestors.add(schema)
	try {
		return current.options.every((option) => isSchema(option) && collect(option, bucket, ancestors))
	} finally {
		ancestors.delete(schema)
	}
}

/** Collect explicit entries from an object, strict object, or intersection of those schemas. */
export function collectObjectEntries(schema: Schema): ObjectEntry[] | undefined {
	const bucket = new Map<string, ObjectEntry>()
	return collect(schema, bucket, new Set()) ? Array.from(bucket.values()) : undefined
}
