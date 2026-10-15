import { TypstError } from './errors.ts'

export interface TypstOperationOptions {
	readonly signal?: AbortSignal
	/** Includes queue time. Omitted means no per-call deadline. */
	readonly timeoutMs?: number
}

export function createTypstOperation(
	options: TypstOperationOptions,
	signals: readonly AbortSignal[],
): { signal: AbortSignal; dispose(): void } {
	if (!options || typeof options !== 'object')
		throw new TypstError('INVALID_INPUT', 'Typst operation options must be an object')
	if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
		throw new TypstError('INVALID_INPUT', 'signal must be an AbortSignal')
	if (
		options.timeoutMs !== undefined &&
		(!Number.isSafeInteger(options.timeoutMs) ||
			options.timeoutMs <= 0 ||
			options.timeoutMs > 2_147_483_647)
	)
		throw new TypstError('INVALID_INPUT', 'timeoutMs must be a positive integer at most 2147483647')
	const timeout = new AbortController()
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(
					() => timeout.abort(new DOMException('Typst operation timed out', 'TimeoutError')),
					options.timeoutMs,
				)
	return {
		signal: AbortSignal.any([
			...signals,
			timeout.signal,
			...(options.signal ? [options.signal] : []),
		]),
		dispose() {
			if (timer) clearTimeout(timer)
		},
	}
}
