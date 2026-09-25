import type { CommandFailure } from '@pluxel/commands'

class PiOutputError extends Error {
	constructor(
		readonly code: 'OUTPUT_ENCODING' | 'OUTPUT_LIMIT',
		message: string,
		cause?: unknown,
	) {
		super(message, { cause })
		this.name = 'PiOutputError'
	}
}

/** Only public failure fields cross into model-visible Pi tool text. */
export function formatToolFailure(failure: CommandFailure, limit: number): string {
	return formatToolOutput(
		{
			code: failure.code,
			message: failure.message,
			...('reason' in failure ? { reason: failure.reason } : {}),
			...('issues' in failure
				? {
						issues: failure.issues.map((issue) => ({
							...(issue.path ? { path: issue.path } : {}),
							...(issue.code ? { code: issue.code } : {}),
							message: issue.message,
						})),
					}
				: {}),
		},
		limit,
	)
}

export function formatToolOutput(value: unknown, limit: number): string {
	if (value === undefined) return boundedToolText('Command completed successfully.', limit)
	try {
		assertStrictJson(value)
		const text = typeof value === 'string' ? value : JSON.stringify(value)
		if (text === undefined) throw new TypeError('JSON serialization returned no text')
		return boundedToolText(text, limit)
	} catch (error) {
		if (error instanceof PiOutputError) throw error
		throw new PiOutputError(
			'OUTPUT_ENCODING',
			'Command output cannot be delivered as strict JSON',
			error,
		)
	}
}

function boundedToolText(text: string, limit: number): string {
	if (text.length > limit)
		throw new PiOutputError('OUTPUT_LIMIT', 'Command output exceeds the Pi tool result limit')
	return text
}

function assertStrictJson(value: unknown, seen = new WeakSet<object>()): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return
	if (typeof value === 'number' && Number.isFinite(value)) return
	if (typeof value !== 'object') throw new TypeError('Output contains a non-JSON value')
	if (seen.has(value)) throw new TypeError('Output contains a cycle')
	seen.add(value)
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype)
			throw new TypeError('Output array has a custom prototype')
		const ownKeys = Reflect.ownKeys(value)
		if (ownKeys.length !== value.length + 1)
			throw new TypeError('Output array has missing or extra properties')
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
				throw new TypeError('Output array contains a hole or accessor')
			assertStrictJson(descriptor.value, seen)
		}
	} else {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError('Output object has a custom prototype')
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string') throw new TypeError('Output object contains a symbol key')
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
				throw new TypeError('Output object contains a hidden property or accessor')
			assertStrictJson(descriptor.value, seen)
		}
	}
	seen.delete(value)
}
