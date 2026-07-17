export function jsonObjectSchema<T extends object>() {
	return Object.freeze({
		'~standard': Object.freeze({
			version: 1 as const,
			vendor: 'pluxel-json-object',
			validate(value: unknown) {
				if (!value || typeof value !== 'object' || Array.isArray(value)) {
					return { issues: [{ message: 'Expected a JSON object' }] }
				}
				try {
					const cloned = JSON.parse(JSON.stringify(value)) as T
					return { value: cloned }
				} catch {
					return { issues: [{ message: 'Expected a JSON-serializable object' }] }
				}
			},
		}),
	})
}
