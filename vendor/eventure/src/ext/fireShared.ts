import {
	IS_ASYNC,
	ORIGFUNC,
	isCapturedError,
	isPromiseLike,
} from '../core/listener'
import type {
	Awaitable,
	EventArgs,
	EventDescriptor,
	EventListener,
	EventResult,
} from '../types'

export type FireSyncRecord<D extends EventDescriptor> =
	| { type: 'success'; fn: EventListener<D>; result: EventResult<D> }
	| { type: 'error'; fn: EventListener<D>; error: unknown }
	| { type: 'async'; fn: EventListener<D>; promise: Awaitable<EventResult<D>> }

export type FireAsyncRecord<D extends EventDescriptor> =
	| {
			type: 'success'
			fn: EventListener<D>
			result: Awaited<EventResult<D>>
	  }
	| { type: 'error'; fn: EventListener<D>; error: unknown }

const unwrapCapturedAsync = <T>(value: T): T => {
	if (isCapturedError(value)) throw value.error
	return value
}

export function* fireFromListeners<D extends EventDescriptor>(
	listeners: EventListener<D>[],
	args: EventArgs<D>,
): Generator<FireSyncRecord<D>> {
	const len = listeners.length
	for (let i = 0; i < len; i++) {
		const fn = listeners[i]!
		const recordFn = ((fn as any)[ORIGFUNC] ?? fn) as EventListener<D>
		if ((fn as any)[IS_ASYNC] === true) {
			try {
				const promise = Promise.resolve(fn(...args)).then(
					unwrapCapturedAsync,
				) as Awaitable<EventResult<D>>
				yield { type: 'async', fn: recordFn, promise }
			} catch (error) {
				yield { type: 'error', fn: recordFn, error }
			}
			continue
		}
		try {
			const result = fn(...args)
			if (isCapturedError(result)) {
				yield { type: 'error', fn: recordFn, error: result.error }
				continue
			}
			if (isPromiseLike(result)) {
				yield {
					type: 'async',
					fn: recordFn,
					promise: Promise.resolve(result).then(
						unwrapCapturedAsync,
					) as Awaitable<EventResult<D>>,
				}
				continue
			}
			yield { type: 'success', fn: recordFn, result }
		} catch (error) {
			yield { type: 'error', fn: recordFn, error }
		}
	}
}

export async function* fireAsyncFromListeners<D extends EventDescriptor>(
	listeners: EventListener<D>[],
	args: EventArgs<D>,
): AsyncGenerator<FireAsyncRecord<D>> {
	const len = listeners.length
	for (let i = 0; i < len; i++) {
		const fn = listeners[i]!
		const recordFn = ((fn as any)[ORIGFUNC] ?? fn) as EventListener<D>
		try {
			const result = (await fn(...args)) as Awaited<EventResult<D>>
			if (isCapturedError(result)) {
				yield { type: 'error', fn: recordFn, error: result.error }
				continue
			}
			yield { type: 'success', fn: recordFn, result }
		} catch (error) {
			yield { type: 'error', fn: recordFn, error }
		}
	}
}
