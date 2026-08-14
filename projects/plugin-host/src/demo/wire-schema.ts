import type { StandardSchema } from '@pluxel/runtime/workbench/contract'

export function jsonObjectSchema<T extends object>(): StandardSchema<unknown, T> {
	return Object.freeze({
		'~standard': Object.freeze({
			version: 1 as const,
			vendor: 'pluxel-json-object',
			validate(value: unknown) {
				if (!value || typeof value !== 'object' || Array.isArray(value)) {
					return { issues: [{ message: 'Expected a JSON object' }] }
				}
				try {
					return { value: JSON.parse(JSON.stringify(value)) as T }
				} catch {
					return { issues: [{ message: 'Expected a JSON-serializable object' }] }
				}
			},
		}),
	})
}
