import type { StandardSchemaV1 } from '@standard-schema/spec'
import { safeParseStandardSchema } from './standardSchema'
import type { ConfigIssue, ConfigValidationErrors } from './types'

export type ConfigSchemaMap = Readonly<Record<string, StandardSchemaV1>>

function normalizeErrors(
	_configKey: string,
	issues: ConfigIssue[],
): Record<string, Array<{ message: string; path: string[] }>> {
	const fieldErrors: Record<string, Array<{ message: string; path: string[] }>> = {}
	for (const issue of issues) {
		const path = (issue.path ?? []).map(String).filter(Boolean)
		const key = path[0] ?? '_root'
		;(fieldErrors[key] ??= []).push({ message: issue.message, path })
	}
	return fieldErrors
}

export async function collectConfigDefaults(
	schemaMap: ConfigSchemaMap,
	options: { missingObjectDefault?: unknown } = {},
): Promise<Record<string, unknown>> {
	const entries = Object.entries(schemaMap)
	if (entries.length === 0) return {}

	const missingObjectDefault = options.missingObjectDefault
	const jobs: Array<Promise<[string, unknown]>> = []

	for (const [key, schema] of entries) {
		jobs.push(
			(async () => {
				const first = await safeParseStandardSchema(schema, undefined)
				if (first.success) return [key, first.output]
				if (missingObjectDefault !== undefined) {
					const second = await safeParseStandardSchema(schema, missingObjectDefault)
					return [key, second.success ? second.output : missingObjectDefault]
				}
				return [key, undefined]
			})(),
		)
	}

	const resolved = await Promise.all(jobs)
	const out: Record<string, unknown> = {}
	for (let i = 0; i < resolved.length; i++) {
		const [key, value] = resolved[i]!
		out[key] = value
	}
	return out
}

export async function validateConfigPatch(
	schemaMap: ConfigSchemaMap,
	patch: Record<string, unknown>,
): Promise<
	{ ok: true; output: Record<string, unknown> } | { ok: false; errors: ConfigValidationErrors }
> {
	const errors: ConfigValidationErrors = {}
	const output: Record<string, unknown> = Object.create(null)

	const entries = Object.entries(patch)
	if (entries.length === 0) return { ok: true, output }

	const jobs: Array<
		Promise<{ key: string; result: Awaited<ReturnType<typeof safeParseStandardSchema>> }>
	> = []
	for (const [configKey, payload] of entries) {
		const schema = schemaMap[configKey]
		if (!schema) {
			errors[configKey] = {
				_unknown: [{ message: `Unknown config key: ${configKey}`, path: [configKey] }],
			}
			continue
		}
		jobs.push(
			safeParseStandardSchema(schema, payload).then((result) => ({ key: configKey, result })),
		)
	}

	if (jobs.length === 0) return { ok: false, errors }

	const results = await Promise.all(jobs)
	for (const { key: configKey, result } of results) {
		if (result.success === false) {
			errors[configKey] = normalizeErrors(configKey, result.issues)
			continue
		}
		output[configKey] = result.output
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors }
	return { ok: true, output }
}

export async function normalizeConfigRecord(
	schemaMap: ConfigSchemaMap,
	raw: Readonly<Record<string, unknown>>,
	options: { missingObjectDefault?: unknown } = {},
): Promise<
	| { ok: true; snapshot: Record<string, unknown>; patch: Record<string, unknown> }
	| { ok: false; errors: ConfigValidationErrors }
> {
	const entries = Object.entries(schemaMap)
	if (entries.length === 0)
		return { ok: true, snapshot: Object.create(null), patch: Object.create(null) }

	const missingObjectDefault = options.missingObjectDefault
	const patch: Record<string, unknown> = Object.create(null)
	const snapshot: Record<string, unknown> = Object.create(null)
	const errors: ConfigValidationErrors = Object.create(null)

	const jobs: Array<
		Promise<{
			key: string
			cur: unknown
			result: Awaited<ReturnType<typeof safeParseStandardSchema>>
		}>
	> = []

	for (const [key, schema] of entries) {
		const cur = raw[key]
		jobs.push(
			(async () => {
				if (cur !== undefined) {
					return { key, cur, result: await safeParseStandardSchema(schema, cur) }
				}
				const first = await safeParseStandardSchema(schema, undefined)
				if (first.success) return { key, cur, result: first }
				if (missingObjectDefault !== undefined) {
					return { key, cur, result: await safeParseStandardSchema(schema, missingObjectDefault) }
				}
				return { key, cur, result: first }
			})(),
		)
	}

	const results = await Promise.all(jobs)
	for (const { key, cur, result } of results) {
		if (result.success === false) {
			errors[key] = normalizeErrors(key, result.issues)
			continue
		}
		snapshot[key] = result.output
		if (cur === undefined && result.output !== undefined) patch[key] = result.output
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors }
	return { ok: true, snapshot, patch }
}
