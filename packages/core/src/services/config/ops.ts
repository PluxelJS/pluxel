import type { StandardSchemaV1 } from '@standard-schema/spec'
import { safeParseStandardSchema } from './standardSchema'
import type { ConfigIssue, ConfigValidationErrors } from './types'

type ConfigRecord = Record<string, unknown>

const EMPTY_OBJECT_DEFAULT = Object.freeze({})
const defaultsCache = new WeakMap<StandardSchemaV1, Map<unknown, Promise<ConfigRecord>>>()

function normalizeMissingObjectDefault(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value
	const proto = Object.getPrototypeOf(value)
	if (proto !== Object.prototype && proto !== null) return value
	return Object.keys(value as ConfigRecord).length === 0 ? EMPTY_OBJECT_DEFAULT : value
}

function objectOutput(value: unknown, label: string): ConfigRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`[pluxel/core] ${label} must produce an object`)
	}
	return { ...(value as ConfigRecord) }
}

function validationErrors(issues: readonly ConfigIssue[]): ConfigValidationErrors {
	const fields: Record<string, Array<{ message: string; path: string[] }>> = Object.create(null)
	for (const issue of issues) {
		const path = (issue.path ?? []).map(String)
		const key = path[0] ?? '_root'
		;(fields[key] ??= []).push({ message: issue.message, path })
	}
	return { _root: fields }
}

/** Resolve defaults from the Plugin's one complete object schema. */
export async function collectConfigDefaults(
	schema: StandardSchemaV1,
	options: { missingObjectDefault?: unknown } = {},
): Promise<ConfigRecord> {
	const missingObjectDefault = normalizeMissingObjectDefault(options.missingObjectDefault)
	let byDefault = defaultsCache.get(schema)
	if (!byDefault) {
		byDefault = new Map()
		defaultsCache.set(schema, byDefault)
	}
	const cached = byDefault.get(missingObjectDefault)
	if (cached) return await cached

	const compute = (async () => {
		const first = await safeParseStandardSchema(schema, undefined)
		if (first.success) return objectOutput(first.output, 'Plugin config schema')
		if (missingObjectDefault !== undefined) {
			const second = await safeParseStandardSchema(schema, missingObjectDefault)
			if (second.success) return objectOutput(second.output, 'Plugin config schema')
		}
		return {}
	})()
	byDefault.set(missingObjectDefault, compute)
	try {
		return await compute
	} catch (error) {
		byDefault.delete(missingObjectDefault)
		throw error
	}
}

/** Validate a complete Plugin config record with its one object schema. */
export async function validateConfigRecord(
	schema: StandardSchemaV1,
	input: Readonly<ConfigRecord>,
): Promise<{ ok: true; output: ConfigRecord } | { ok: false; errors: ConfigValidationErrors }> {
	const result = await safeParseStandardSchema(schema, input)
	if (result.success === false) return { ok: false, errors: validationErrors(result.issues) }
	return { ok: true, output: objectOutput(result.output, 'Plugin config schema') }
}
