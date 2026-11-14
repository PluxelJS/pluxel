import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Err, Ok, Result } from '@pluxel/core/better-result'
import { ScriptExecutionError, snapshotJson, type JsonValue } from './protocol'

/** Only the selected shared library's concrete Result instances cross this boundary. */
function isSharedResult(value: unknown): value is Result<unknown, unknown> {
	if (!value || typeof value !== 'object') return false
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Ok.prototype && prototype !== Err.prototype) return false
	const fields = Object.getOwnPropertyDescriptors(value)
	for (const key of Reflect.ownKeys(value))
		if (!('value' in Object.getOwnPropertyDescriptor(value, key)!))
			throw new ScriptExecutionError('result_not_serializable', 'Result accessors are unsupported')
	const branch = prototype === Ok.prototype ? 'ok' : 'error'
	const payload = branch === 'ok' ? 'value' : 'error'
	if (fields.status?.value !== branch || !fields[payload])
		throw new ScriptExecutionError('result_not_serializable', 'Invalid shared Result instance')
	return true
}

/**
 * Script return boundary only: native Result.codec owns the wire envelope. Payloads
 * retain the ordinary JSON contract; nested Results and arbitrary classes stay invalid.
 */
export function snapshotScriptResult(value: unknown): JsonValue {
	if (!isSharedResult(value)) return snapshotJson(value)
	let projectionFailure: ScriptExecutionError | undefined
	const jsonPayload = {
		'~standard': {
			version: 1 as const,
			vendor: 'pluxel-script-result',
			types: undefined as { input: unknown; output: JsonValue } | undefined,
			validate(input: unknown): StandardSchemaV1.Result<JsonValue> {
				try {
					return { value: snapshotJson(input) }
				} catch (error) {
					if (
						!(error instanceof ScriptExecutionError) ||
						!['result_not_serializable', 'result_too_large'].includes(error.code)
					)
						throw error
					projectionFailure = error
					return { issues: [{ message: error.message }] }
				}
			},
		},
	}
	const codec = Result.codec({
		serialize: { ok: jsonPayload, err: jsonPayload },
		deserialize: { ok: jsonPayload, err: jsonPayload },
	})
	const encoded = codec.serialize(value)
	if (encoded.isErr())
		throw (
			projectionFailure ??
			new ScriptExecutionError('result_not_serializable', encoded.error.message)
		)
	// Charge the complete native envelope as well as the selected payload.
	return snapshotJson(encoded.value)
}
