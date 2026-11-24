import type { Schema } from './schema'

export type SchemaRecord = Schema & {
	readonly kind: 'schema'
	readonly type: string
	readonly pipe?: readonly unknown[]
	readonly wrapped?: Schema
	readonly entries?: Readonly<Record<string, Schema>>
	readonly item?: Schema
	readonly items?: readonly Schema[]
	readonly rest?: Schema
	readonly value?: Schema
	readonly literal?: unknown
	readonly options?: readonly unknown[]
}

export function isSchema(value: unknown): value is SchemaRecord {
	return (
		Boolean(value) && typeof value === 'object' && (value as { kind?: string }).kind === 'schema'
	)
}

export function pipeRoot(schema: Schema): SchemaRecord {
	let current = schema as SchemaRecord
	const seen = new Set<Schema>()
	while (current.pipe && !seen.has(current)) {
		seen.add(current)
		const first = current.pipe[0]
		if (!isSchema(first) || first === current) break
		current = first
	}
	return current
}

type RawValidationActions = {
	readonly actions: Array<Record<string, unknown>>
	readonly transformed: boolean
}

export function collectRawValidationActions(
	schema: Schema,
	bucket: Array<Record<string, unknown>> = [],
	seen: Set<unknown> = new Set(),
): RawValidationActions {
	if (seen.has(schema)) return { actions: bucket, transformed: false }
	seen.add(schema)
	const current = schema as SchemaRecord

	if (current.pipe) {
		const first = current.pipe[0]
		if (isSchema(first)) {
			const nested = collectRawValidationActions(first, bucket, seen)
			if (nested.transformed) return nested
		}
		for (let index = 1; index < current.pipe.length; index++) {
			const item = current.pipe[index]
			if (!item || typeof item !== 'object') continue
			const action = item as Record<string, unknown>
			if (action.kind === 'transformation') {
				return { actions: bucket, transformed: true }
			}
			if (action.kind === 'validation') bucket.push(action)
			else if (isSchema(action)) {
				const nested = collectRawValidationActions(action, bucket, seen)
				if (nested.transformed) return nested
			}
		}
		return { actions: bucket, transformed: false }
	}

	if (current.wrapped && isSchema(current.wrapped)) {
		return collectRawValidationActions(current.wrapped, bucket, seen)
	}
	return { actions: bucket, transformed: false }
}
