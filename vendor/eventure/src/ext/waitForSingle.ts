import type {
	EventArgs,
	EventDescriptor,
	EventListener,
	Unsubscribe,
} from '../types'
import type { WrapFn } from './limitSingle'

type RegisterWaitListener<D extends EventDescriptor> = (
	listener: EventListener<D>,
) => Unsubscribe

export interface CancellablePromise<T> extends Promise<T> {
	cancel: () => void
}

export interface WaitForSingleOptions<D extends EventDescriptor> {
	timeout?: number
	signal?: AbortSignal
	filter?: (...args: EventArgs<D>) => boolean
}

export function assertValidWaitForTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return
	if (!Number.isFinite(timeout) || timeout < 0) {
		throw new RangeError('timeout must be a non-negative finite number')
	}
}

const normalizeRejection = (reason: unknown) =>
	reason instanceof Error ? reason : new Error(String(reason))

const waitForMessage = (
	label: string | undefined,
	action: 'timeout' | 'aborted' | 'cancelled',
	timeout?: number,
) => {
	const prefix =
		label === undefined || label.length === 0 ? 'waitFor' : `waitFor '${label}'`
	return timeout === undefined
		? `${prefix} ${action}`
		: `${prefix} ${action} after ${timeout}ms`
}

export function waitForSingle<D extends EventDescriptor>(
	wrap: WrapFn,
	register: RegisterWaitListener<D>,
	options: WaitForSingleOptions<D> = {},
	label?: string,
): CancellablePromise<EventArgs<D>> {
	const { signal, filter } = options
	const { timeout } = options
	assertValidWaitForTimeout(timeout)
	let offRef: Unsubscribe | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let abortListener: (() => void) | null = null
	let settled = false

	const cleanup = () => {
		if (settled) return
		settled = true
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
		if (offRef !== null) {
			const off = offRef
			offRef = null
			off()
		}
		if (abortListener !== null && signal !== undefined) {
			signal.removeEventListener('abort', abortListener)
			abortListener = null
		}
	}

	let rejectRef!: (e: unknown) => void

	const p = new Promise<EventArgs<D>>((resolve, reject) => {
		rejectRef = reject

		if (timeout !== undefined) {
			timer = setTimeout(() => {
				cleanup()
				reject(new Error(waitForMessage(label, 'timeout', timeout)))
			}, timeout)
		}

		if (signal !== undefined) {
			if (signal.aborted) {
				cleanup()
				reject(new Error(waitForMessage(label, 'aborted')))
				return
			}
			abortListener = () => {
				cleanup()
				reject(new Error(waitForMessage(label, 'aborted')))
			}
			signal.addEventListener('abort', abortListener, { once: true })
		}

		if (filter === undefined) {
			const handler = wrap(((...args: EventArgs<D>) => {
				if (settled) return
				cleanup()
				resolve(args)
			}) as EventListener<D>)
			offRef = register(handler)
			return
		}

		const handler = wrap(((...args: EventArgs<D>) => {
			if (settled) return
			let matched: boolean
			try {
				matched = filter(...args)
			} catch (error) {
				cleanup()
				reject(normalizeRejection(error))
				return
			}
			if (!matched) return
			cleanup()
			resolve(args)
		}) as EventListener<D>)
		offRef = register(handler)
	}) as CancellablePromise<EventArgs<D>>

	p.cancel = () => {
		if (settled) return
		cleanup()
		rejectRef(new Error(waitForMessage(label, 'cancelled')))
	}

	return p
}
