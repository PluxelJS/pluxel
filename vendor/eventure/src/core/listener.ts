import type { Logger } from '../logger'
import type { ErrorPolicy, ListenerWrapPolicy } from '../types'

export const IS_ASYNC = Symbol.for('eventure:is_async')
export const ORIGFUNC = Symbol.for('eventure:orig')
export const CAPTURED_ERROR = Symbol('eventure:captured_error')

export type WrapOptions = Required<ListenerWrapPolicy> & { logger: Logger }
export type CapturedError = {
	readonly [CAPTURED_ERROR]: true
	readonly error: unknown
}

export function isNativeAsync(fn: { constructor: { name: string } }): boolean {
	return fn.constructor.name === 'AsyncFunction'
}

export function isPromiseLike(x: unknown): x is Promise<unknown> {
	return x !== null && x !== undefined && typeof (x as any).then === 'function'
}

export function captureError(error: unknown): CapturedError {
	return { [CAPTURED_ERROR]: true, error }
}

export function isCapturedError(value: unknown): value is CapturedError {
	return (
		value !== null &&
		typeof value === 'object' &&
		(value as any)[CAPTURED_ERROR] === true
	)
}

export function onSyncError(
	err: unknown,
	policy: ErrorPolicy,
	logger: Logger,
): void {
	switch (policy) {
		case 'log':
			logger.error(err)
			return
		case 'throw':
			throw err
		case 'silent':
			break
	}
}

export function wrapListener<T extends (...args: any[]) => any>(
	listener: T,
	options: WrapOptions,
): T {
	if ((listener as any)[ORIGFUNC] !== undefined) return listener as any

	if (!options.captureRejections) return listener as any

	const nativeAsync = isNativeAsync(listener)
	if (!options.captureReturnedPromises && !nativeAsync) return listener as any

	return wrapCheckedListener(listener, options, nativeAsync)
}

function wrapCheckedListener<T extends (...args: any[]) => any>(
	listener: T,
	options: WrapOptions,
	nativeAsync: boolean,
): T {
	const wrapped = ((...args: Parameters<T>) => {
		try {
			const r = listener(...args)
			if (isPromiseLike(r)) {
				const promise =
					typeof (r as any).catch === 'function'
						? (r as any)
						: Promise.resolve(r)
				return promise.catch((err: unknown) => {
					if (options.errorPolicy === 'log') {
						options.logger.error(err)
						return captureError(err)
					}
					if (options.errorPolicy === 'throw') throw err
					return captureError(err)
				})
			}
			return r
		} catch (err) {
			if (options.errorPolicy === 'log') {
				options.logger.error(err)
				return captureError(err) as any
			}
			if (options.errorPolicy === 'throw') throw err
			return captureError(err) as any
		}
	}) as T

	Object.defineProperty(wrapped, ORIGFUNC, { value: listener, writable: false })
	Object.defineProperty(wrapped, IS_ASYNC, {
		value: nativeAsync,
		writable: false,
	})

	return wrapped
}

export function createWrapHelper(options: WrapOptions) {
	if (!options.captureRejections) {
		return function identity<T extends (...args: any[]) => any>(
			listener: T,
		): T {
			return listener
		}
	}

	if (!options.captureReturnedPromises) {
		return function wrapNativeAsync<T extends (...args: any[]) => any>(
			listener: T,
		): T {
			if ((listener as any)[ORIGFUNC] !== undefined) return listener as any
			const nativeAsync = isNativeAsync(listener)
			return nativeAsync
				? wrapCheckedListener(listener, options, true)
				: listener
		}
	}

	return function wrap<T extends (...args: any[]) => any>(listener: T): T {
		return wrapListener(listener, options)
	}
}

export function appendListenerCopy<T>(prev: T[] | undefined, listener: T): T[] {
	if (!prev || prev.length === 0) return [listener]
	const len = prev.length
	const next = new Array<T>(len + 1)
	for (let i = 0; i < len; i++) next[i] = prev[i]!
	next[len] = listener
	return next
}

export function prependListenerCopy<T>(
	prev: T[] | undefined,
	listener: T,
): T[] {
	if (!prev || prev.length === 0) return [listener]
	const len = prev.length
	const next = new Array<T>(len + 1)
	next[0] = listener
	for (let i = 0; i < len; i++) next[i + 1] = prev[i]!
	return next
}

export function copyWithoutIndex<T>(prev: T[], removeIndex: number): T[] {
	const len = prev.length
	const next = new Array<T>(len - 1)
	for (let i = 0, j = 0; i < len; i++) {
		if (i === removeIndex) continue
		next[j++] = prev[i]!
	}
	return next
}

export function insertListenerCopy<T>(
	prev: T[] | undefined,
	insertIndex: number,
	listener: T,
): T[] {
	if (!prev || prev.length === 0) return [listener]
	if (insertIndex <= 0) return prependListenerCopy(prev, listener)
	const len = prev.length
	if (insertIndex >= len) return appendListenerCopy(prev, listener)

	const next = new Array<T>(len + 1)
	for (let i = 0; i < insertIndex; i++) next[i] = prev[i]!
	next[insertIndex] = listener
	for (let i = insertIndex; i < len; i++) next[i + 1] = prev[i]!
	return next
}
