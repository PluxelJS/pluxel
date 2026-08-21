import type { Schema } from '../schema'
import { isDevelopmentEnvironment } from './environment'

export interface ObjectEntry {
	name: string
	schema: Schema
}

function isSchema(value: unknown): value is Schema {
	return (
		Boolean(value) && typeof value === 'object' && (value as { kind?: string }).kind === 'schema'
	)
}

function collectFromObject(schema: Schema, bucket: Map<string, Schema>): boolean {
	const entries = (schema as { entries?: Record<string, Schema> }).entries
	if (!entries) return false
	for (const [name, child] of Object.entries(entries)) {
		if (!isSchema(child)) continue
		if (bucket.has(name) && isDevelopmentEnvironment()) {
			console.warn(
				`[valibot-form] Intersection contains duplicate key "${name}". The latter definition will override the former.`,
			)
		}
		bucket.set(name, child)
	}
	return true
}

function collectFromIntersect(schema: Schema, bucket: Map<string, Schema>): boolean {
	const options = (schema as { options?: Schema[] }).options
	if (!options) return false
	for (const option of options) {
		if (!isSchema(option)) return false
		if (option.type === 'object') {
			if (!collectFromObject(option, bucket)) return false
			continue
		}
		if (option.type === 'intersect') {
			if (!collectFromIntersect(option, bucket)) return false
			continue
		}
		return false
	}
	return true
}

/**
 * Collects object-like entries (plain object or nested intersections of objects).
 *
 * Returns undefined when the schema cannot be treated as an object.
 */
export function collectObjectEntries(schema: Schema): ObjectEntry[] | undefined {
	if (!isSchema(schema)) return undefined
	const bucket = new Map<string, Schema>()

	if (schema.type === 'object') {
		if (!collectFromObject(schema, bucket)) return undefined
	} else if (schema.type === 'intersect') {
		if (!collectFromIntersect(schema, bucket)) return undefined
	} else {
		return undefined
	}

	return Array.from(bucket.entries()).map(([name, child]) => ({ name, schema: child }))
}
