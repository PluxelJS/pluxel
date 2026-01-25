import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ConfigIssue, SafeParseResult } from './types'

export type { StandardSchemaV1 }

function isThenable(value: unknown): value is PromiseLike<unknown> {
	if (!value) return false
	if (typeof value !== 'object' && typeof value !== 'function') return false
	return typeof (value as { then?: unknown }).then === 'function'
}

export function isStandardSchemaV1(schema: unknown): schema is StandardSchemaV1 {
	if (!schema || typeof schema !== 'object') return false
	const standard = (schema as { ['~standard']?: unknown })['~standard']
	if (!standard || typeof standard !== 'object') return false
	const std = standard as { version?: unknown; validate?: unknown }
	if (std.version !== 1) return false
	return typeof std.validate === 'function'
}

function standardIssuePath(issue: StandardSchemaV1.Issue): Array<string | number> {
	const out: Array<string | number> = []
	const raw = issue.path
	if (!Array.isArray(raw)) return out

	for (const step of raw) {
		if (typeof step === 'string' || typeof step === 'number') {
			out.push(step)
			continue
		}
		if (typeof step === 'symbol') {
			out.push(step.description ?? step.toString())
			continue
		}
		if (!step || typeof step !== 'object') continue
		const key = (step as { key?: unknown }).key
		if (typeof key === 'string' || typeof key === 'number') out.push(key)
		else if (typeof key === 'symbol') out.push(key.description ?? key.toString())
		else if (key != null) out.push(String(key))
	}
	return out
}

export async function safeParseStandardSchema(
	schema: StandardSchemaV1,
	input: unknown,
): Promise<SafeParseResult> {
	const validate = schema['~standard']?.validate
	if (typeof validate !== 'function') {
		return {
			success: false as const,
			issues: [{ message: 'Invalid schema: missing ~standard.validate', path: [] }],
		}
	}

	try {
		const res = validate(input)
		const resolved = (isThenable(res) ? await res : res) as StandardSchemaV1.Result<unknown>
		if (resolved && typeof resolved === 'object' && 'issues' in resolved && resolved.issues) {
			return {
				success: false as const,
				issues: (resolved.issues as readonly StandardSchemaV1.Issue[]).map(
					(issue): ConfigIssue => ({
						message: issue.message,
						path: standardIssuePath(issue),
					}),
				),
			}
		}
		if (resolved && typeof resolved === 'object' && 'value' in resolved) {
			return { success: true as const, output: (resolved as { value: unknown }).value }
		}
		return { success: true as const, output: undefined }
	} catch (error) {
		const message = (error as Error)?.message ?? String(error)
		return { success: false as const, issues: [{ message, path: [] }] }
	}
}
