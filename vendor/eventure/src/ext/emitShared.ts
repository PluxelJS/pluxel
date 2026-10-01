import { ORIGFUNC, isCapturedError, isPromiseLike } from '../core/listener'
import type {
	EventArgs,
	EventDescriptor,
	EventListener,
	EventResult,
	EmitSettledRecord,
} from '../types'

export async function emitAllFromListeners<D extends EventDescriptor>(
	listeners: EventListener<D>[] | undefined,
	args: EventArgs<D>,
): Promise<Awaited<EventResult<D>>[]> {
	if (!listeners || listeners.length === 0) return []

	const len = listeners.length
	const results = new Array<Awaited<EventResult<D>>>(len)
	let pending: Promise<void>[] | null = null

	for (let i = 0; i < len; i++) {
		const fn = listeners[i] as any
		try {
			const r = fn(...args)
			if (isCapturedError(r)) {
				if (pending !== null) void Promise.allSettled(pending)
				throw r.error
			}
			if (isPromiseLike(r)) {
				pending ??= []
				pending.push(
					Promise.resolve(r).then((v: any) => {
						if (isCapturedError(v)) throw v.error
						return void (results[i] = v)
					}),
				)
				continue
			}
			results[i] = r
		} catch (err) {
			if (pending !== null) void Promise.allSettled(pending)
			throw err
		}
	}

	if (pending !== null) await Promise.all(pending)
	return results
}

export async function emitSettledFromListeners<D extends EventDescriptor>(
	listeners: EventListener<D>[] | undefined,
	args: EventArgs<D>,
): Promise<EmitSettledRecord<EventListener<D>, Awaited<EventResult<D>>>[]> {
	if (!listeners || listeners.length === 0) return []

	const len = listeners.length
	const results = new Array<
		EmitSettledRecord<EventListener<D>, Awaited<EventResult<D>>>
	>(len)
	let pending: Promise<void>[] | null = null

	for (let i = 0; i < len; i++) {
		const fn = listeners[i]!
		const recordFn = ((fn as any)[ORIGFUNC] ?? fn) as EventListener<D>
		try {
			const r = (fn as any)(...args)
			if (isCapturedError(r)) {
				results[i] = { fn: recordFn, status: 'rejected', reason: r.error }
				continue
			}
			if (isPromiseLike(r)) {
				pending ??= []
				pending.push(
					Promise.resolve(r).then(
						(v: any) => {
							if (isCapturedError(v)) {
								return void (results[i] = {
									fn: recordFn,
									status: 'rejected',
									reason: v.error,
								})
							}
							return void (results[i] = {
								fn: recordFn,
								status: 'fulfilled',
								value: v,
							})
						},
						(reason: unknown) => {
							return void (results[i] = {
								fn: recordFn,
								status: 'rejected',
								reason,
							})
						},
					),
				)
				continue
			}
			results[i] = { fn: recordFn, status: 'fulfilled', value: r }
		} catch (reason) {
			results[i] = { fn: recordFn, status: 'rejected', reason }
		}
	}

	if (pending !== null) await Promise.all(pending)
	return results
}
